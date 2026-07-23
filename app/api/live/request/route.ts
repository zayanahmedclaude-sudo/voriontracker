import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, err, ok } from '@/lib/api';
import { ensureLiveKitRoom, getLiveKitRoomName } from '@/lib/livekit';
import { canAccessLiveMonitor, normalizeRole } from '@/lib/roles';

export const dynamic = 'force-dynamic';

const REQUEST_TTL_SECONDS = 120;
const VIEWER_IDLE_SECONDS = 90;

async function ensureLiveViewRequestTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS live_view_requests (
      id text PRIMARY KEY,
      employee_id uuid NOT NULL,
      attendance_id uuid NOT NULL,
      requested_by uuid NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamptz NOT NULL DEFAULT NOW(),
      accepted_at timestamptz,
      last_viewer_at timestamptz,
      stopped_at timestamptz,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS live_view_requests_employee_status_idx
    ON live_view_requests(employee_id, status, expires_at)
  `;
}

async function getActiveAttendance(employeeId: string) {
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
  return attendance;
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canAccessLiveMonitor(normalizeRole(user.role))) return err('Forbidden', 403);

  const { employeeId } = await req.json();
  if (!employeeId) return err('employeeId is required', 400);

  await ensureLiveViewRequestTable();

  const attendance = await getActiveAttendance(employeeId);
  if (!attendance) return err('Employee is not currently online', 404);

  const [existing] = await sql`
    SELECT id
    FROM live_view_requests
    WHERE employee_id = ${attendance.employee_id}
      AND attendance_id = ${attendance.id}
      AND status IN ('pending', 'active')
      AND expires_at > NOW()
      AND stopped_at IS NULL
    ORDER BY requested_at DESC
    LIMIT 1
  `;

  const requestId = existing?.id || crypto.randomUUID();
  const roomName = getLiveKitRoomName(attendance.employee_id, attendance.id);
  await ensureLiveKitRoom(roomName);

  if (existing) {
    await sql`
      UPDATE live_view_requests
      SET requested_by = ${user.sub},
          requested_at = NOW(),
          expires_at = NOW() + (${REQUEST_TTL_SECONDS} || ' seconds')::interval,
          updated_at = NOW()
      WHERE id = ${requestId}
    `;
  } else {
    await sql`
      INSERT INTO live_view_requests (
        id,
        employee_id,
        attendance_id,
        requested_by,
        status,
        expires_at
      )
      VALUES (
        ${requestId},
        ${attendance.employee_id},
        ${attendance.id},
        ${user.sub},
        'pending',
        NOW() + (${REQUEST_TTL_SECONDS} || ' seconds')::interval
      )
    `;
  }

  return ok({
    requestId,
    employeeId: attendance.employee_id,
    employeeName: attendance.full_name,
    sessionId: attendance.id,
    roomName,
    expiresIn: REQUEST_TTL_SECONDS,
  });
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  await ensureLiveViewRequestTable();
  const { searchParams } = new URL(req.url);
  const requestId = searchParams.get('requestId');

  if (requestId) {
    if (!canAccessLiveMonitor(normalizeRole(user.role))) return err('Forbidden', 403);
    const [request] = await sql`
      SELECT id, employee_id, attendance_id, status, requested_at, accepted_at, last_viewer_at, expires_at, stopped_at
      FROM live_view_requests
      WHERE id = ${requestId}
        AND requested_by = ${user.sub}
      LIMIT 1
    `;
    if (!request) return err('Live view request not found', 404);
    return ok({ request });
  }

  const [attendance] = await sql`
    SELECT id, employee_id
    FROM attendance
    WHERE employee_id = ${user.sub}
      AND check_out IS NULL
    ORDER BY check_in DESC
    LIMIT 1
  `;

  if (!attendance) return ok({ request: null });

  const [request] = await sql`
    SELECT id, employee_id, attendance_id, status, requested_at, accepted_at, last_viewer_at, expires_at
    FROM live_view_requests
    WHERE employee_id = ${user.sub}
      AND attendance_id = ${attendance.id}
      AND status IN ('pending', 'active')
      AND stopped_at IS NULL
      AND expires_at > NOW()
      AND (
        last_viewer_at IS NULL
        OR last_viewer_at > NOW() - (${VIEWER_IDLE_SECONDS} || ' seconds')::interval
      )
    ORDER BY requested_at DESC
    LIMIT 1
  `;

  return ok({ request: request || null });
}

export async function PATCH(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  const { requestId, action } = await req.json();
  if (!requestId) return err('requestId is required', 400);

  await ensureLiveViewRequestTable();

  if (action === 'accept') {
    const [request] = await sql`
      UPDATE live_view_requests
      SET status = 'active',
          accepted_at = COALESCE(accepted_at, NOW()),
          updated_at = NOW()
      WHERE id = ${requestId}
        AND employee_id = ${user.sub}
        AND status IN ('pending', 'active')
        AND stopped_at IS NULL
      RETURNING id
    `;
    if (!request) return err('Live view request not found', 404);
    return ok({ ok: true });
  }

  if (action === 'viewer_heartbeat') {
    if (!canAccessLiveMonitor(normalizeRole(user.role))) return err('Forbidden', 403);
    const [request] = await sql`
      UPDATE live_view_requests
      SET last_viewer_at = NOW(),
          expires_at = GREATEST(expires_at, NOW() + (${REQUEST_TTL_SECONDS} || ' seconds')::interval),
          updated_at = NOW()
      WHERE id = ${requestId}
        AND requested_by = ${user.sub}
        AND status IN ('pending', 'active')
        AND stopped_at IS NULL
      RETURNING id
    `;
    if (!request) return err('Live view request not found', 404);
    return ok({ ok: true });
  }

  if (action === 'stop') {
    const isAdmin = canAccessLiveMonitor(normalizeRole(user.role));
    const [request] = await sql`
      UPDATE live_view_requests
      SET status = 'stopped',
          stopped_at = NOW(),
          updated_at = NOW()
      WHERE id = ${requestId}
        AND stopped_at IS NULL
        AND (
          requested_by = ${user.sub}
          OR employee_id = ${user.sub}
          OR ${isAdmin}
        )
      RETURNING id
    `;
    if (!request) return ok({ ok: true, alreadyStopped: true });
    return ok({ ok: true });
  }

  return err('Invalid action', 400);
}
