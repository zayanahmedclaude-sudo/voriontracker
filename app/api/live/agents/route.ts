import { NextRequest } from 'next/server';
import { getExistingColumns, queryRows } from '@/lib/db';
import { requireAuth, err, ok } from '@/lib/api';
import { canAccessLiveMonitor, normalizeRole } from '@/lib/roles';
import { LIVE_HEARTBEAT_STALE_SECONDS } from '@/lib/status';
import { ensureRoleFeatureSchema } from '@/lib/schema';

export const dynamic = 'force-dynamic';
const LIVE_HEARTBEAT_STALE_MS = LIVE_HEARTBEAT_STALE_SECONDS * 1000;

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canAccessLiveMonitor(normalizeRole(user.role))) return err('Forbidden', 403);
  await ensureRoleFeatureSchema();

  const screenshotColumns = await getExistingColumns('screenshots', ['thumbnail_url', 'blob_url', 'file_url']);
  const urlParts = ['thumbnail_url', 'blob_url', 'file_url']
    .filter((column) => screenshotColumns.has(column))
    .map((column) => `s.${column}`);
  const latestScreenshotUrlExpression = urlParts.length ? `COALESCE(${urlParts.join(', ')})` : 'NULL';

  const rows = await queryRows(`
    WITH active_attendance AS (
      SELECT DISTINCT ON (a.employee_id)
        a.employee_id,
        a.id AS attendance_id,
        a.check_in
      FROM attendance a
      WHERE a.check_out IS NULL
      ORDER BY a.employee_id, a.check_in DESC
    ),
    latest_screenshots AS (
      SELECT DISTINCT ON (s.employee_id)
        s.employee_id,
        ${latestScreenshotUrlExpression} AS last_screenshot_url,
        s.captured_at
      FROM screenshots s
      ORDER BY s.employee_id, s.captured_at DESC
    )
    SELECT
      p.id AS employee_id,
      p.full_name AS employee_name,
      aa.attendance_id,
      es.current_status,
      es.current_app,
      es.last_activity,
      ls.last_screenshot_url,
      ls.captured_at AS last_screenshot_at
    FROM public.profiles p
    LEFT JOIN active_attendance aa ON aa.employee_id = p.id
    LEFT JOIN employee_status es ON es.employee_id = p.id
    LEFT JOIN latest_screenshots ls ON ls.employee_id = p.id
    WHERE p.role = 'employee'
      AND COALESCE(p.account_status, 'active') <> 'terminated'
    ORDER BY p.full_name
  `);

  return ok(
    rows.map((row: any) => {
      const lastSeen = row.last_activity || row.last_screenshot_at || null;
      const rawStatus = String(row.current_status || 'offline').toLowerCase();
      const isRealtimeStatus = ['active', 'working', 'idle', 'on_break', 'break'].includes(rawStatus);
      const isStale = !row.last_activity || (Date.now() - new Date(row.last_activity).getTime()) > LIVE_HEARTBEAT_STALE_MS;
      const online = Boolean(row.attendance_id) && isRealtimeStatus && !isStale;

      return {
        employeeId: row.employee_id,
        name: row.employee_name,
        status: online ? (row.current_status || 'offline') : 'offline',
        online,
        activeApp: online ? (row.current_app || undefined) : undefined,
        lastSeen,
        lastUrl: row.last_screenshot_url || undefined,
      };
    }),
  );
}
