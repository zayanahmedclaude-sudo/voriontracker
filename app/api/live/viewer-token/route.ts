import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, err, ok } from '@/lib/api';
import { createLiveKitToken, getLiveKitRoomName } from '@/lib/livekit';
import { canAccessLiveMonitor, normalizeRole } from '@/lib/roles';

export const dynamic = 'force-dynamic';

const VIEWER_TOKEN_COOLDOWN_MS = 10000;

const globalForLiveKitViewerTokens = globalThis as typeof globalThis & {
  __vorionLiveKitViewerTokenCooldowns?: Map<string, number>;
};

const viewerTokenCooldowns =
  globalForLiveKitViewerTokens.__vorionLiveKitViewerTokenCooldowns ||
  new Map<string, number>();

globalForLiveKitViewerTokens.__vorionLiveKitViewerTokenCooldowns = viewerTokenCooldowns;

function rateLimitResponse(retryAfterMs: number) {
  return NextResponse.json(
    {
      error: `LiveKit is cooling down. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`,
      retryAfterMs,
    },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
      },
    },
  );
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canAccessLiveMonitor(normalizeRole(user.role))) return err('Forbidden', 403);

  const { employeeId, requestId } = await req.json();
  if (!employeeId) return err('employeeId is required', 400);
  if (!requestId) return err('requestId is required', 400);

  const [attendance] = await sql`
    SELECT a.id, a.employee_id, p.full_name
    FROM attendance a
    JOIN public.profiles p ON p.id = a.employee_id
    WHERE a.employee_id = ${employeeId}
      AND COALESCE(p.account_status, 'active') <> 'terminated'
      AND a.check_out IS NULL
    ORDER BY a.check_in DESC
    LIMIT 1
  `;

  if (!attendance) {
    return err('Employee is not currently streaming', 404);
  }

  try {
    const roomName = getLiveKitRoomName(attendance.employee_id, attendance.id);
    const [liveRequest] = await sql`
      UPDATE live_view_requests
      SET last_viewer_at = NOW(),
          expires_at = GREATEST(expires_at, NOW() + INTERVAL '120 seconds'),
          updated_at = NOW()
      WHERE id = ${requestId}
        AND employee_id = ${attendance.employee_id}
        AND attendance_id = ${attendance.id}
        AND requested_by = ${user.sub}
        AND status IN ('pending', 'active')
        AND stopped_at IS NULL
        AND expires_at > NOW()
      RETURNING id
    `;
    if (!liveRequest) {
      return err('Live view request is no longer active', 404);
    }

    const cooldownKey = `${user.sub}:${attendance.employee_id}:${attendance.id}`;
    const now = Date.now();
    const retryAfter = viewerTokenCooldowns.get(cooldownKey) || 0;
    if (retryAfter > now) {
      return rateLimitResponse(retryAfter - now);
    }
    viewerTokenCooldowns.set(cooldownKey, now + VIEWER_TOKEN_COOLDOWN_MS);

    const token = await createLiveKitToken({
      identity: `viewer-${user.sub}-${attendance.employee_id}-${attendance.id}`,
      roomName,
      canPublish: false,
      canSubscribe: true,
      metadata: JSON.stringify({ viewerId: user.sub, employeeId, role: user.role }),
      name: user.name,
    });

    return ok({
      ...token,
      employeeId: attendance.employee_id,
      employeeName: attendance.full_name,
      sessionId: attendance.id,
    });
  } catch (error: any) {
    console.error('[live/viewer-token] failed', error?.stack || error);
    return err(error?.message || 'Failed to create viewer token', 500);
  }
}
