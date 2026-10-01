import { NextRequest } from 'next/server';
import { getExistingColumns, queryRows } from '@/lib/db';
import { requireAuth, err, ok } from '@/lib/api';
import { LIVE_MONITORED_ROLES, canAccessLiveMonitor, normalizeRole } from '@/lib/roles';
import { LIVE_HEARTBEAT_STALE_SECONDS } from '@/lib/status';
import { ensureMonitoringSchema, ensureRoleFeatureSchema } from '@/lib/schema';
import { BUSINESS_TIME_ZONE, isWithinForcedCheckoutWindow } from '@/lib/shifts';

export const dynamic = 'force-dynamic';
const LIVE_HEARTBEAT_STALE_MS = LIVE_HEARTBEAT_STALE_SECONDS * 1000;

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canAccessLiveMonitor(normalizeRole(user.role))) return err('Forbidden', 403);
  await ensureRoleFeatureSchema();
  await ensureMonitoringSchema();

  const screenshotColumns = await getExistingColumns('screenshots', ['thumbnail_url', 'file_url']);
  const urlParts = ['thumbnail_url', 'file_url']
    .filter((column) => screenshotColumns.has(column))
    .map((column) => `s.${column}`);
  const latestScreenshotUrlExpression = urlParts.length ? `COALESCE(${urlParts.join(', ')})` : 'NULL';

  // Per-employee LATERAL lookups use the (employee_id, time) indexes instead of
  // sorting the entire screenshots/attendance tables on every refresh.
  const rows = await queryRows(`
    SELECT
      p.id AS employee_id,
      p.full_name AS employee_name,
      p.department_id,
      d.name AS department_name,
      aa.attendance_id,
      es.current_status,
      es.current_app,
      es.last_activity,
      ls.last_screenshot_url,
      ls.captured_at AS last_screenshot_at,
      ld.device_id,
      ld.hostname,
      ld.app_version,
      ld.os_platform,
      ld.os_version,
      ld.last_seen_at AS device_last_seen_at
    FROM public.profiles p
    LEFT JOIN departments d ON d.id = p.department_id
    LEFT JOIN employee_status es ON es.employee_id = p.id
    LEFT JOIN LATERAL (
      SELECT a.id AS attendance_id
      FROM attendance a
      WHERE a.employee_id = p.id AND a.check_out IS NULL
      ORDER BY a.check_in DESC
      LIMIT 1
    ) aa ON true
    LEFT JOIN LATERAL (
      SELECT ${latestScreenshotUrlExpression} AS last_screenshot_url, s.captured_at
      FROM screenshots s
      WHERE s.employee_id = p.id
      ORDER BY s.captured_at DESC
      LIMIT 1
    ) ls ON true
    LEFT JOIN LATERAL (
      SELECT dr.device_id, dr.hostname, dr.app_version, dr.os_platform, dr.os_version, dr.last_seen_at
      FROM device_registrations dr
      WHERE dr.employee_id = p.id
      ORDER BY dr.last_seen_at DESC NULLS LAST, dr.updated_at DESC NULLS LAST
      LIMIT 1
    ) ld ON true
    WHERE p.role = ANY($1)
      AND COALESCE(p.account_status, 'active') = 'active'
    ORDER BY p.full_name
  `, [LIVE_MONITORED_ROLES]);

  const results = [];
  const forceCheckedOut = isWithinForcedCheckoutWindow(new Date(), BUSINESS_TIME_ZONE);
  for (const row of rows) {
      const lastSeen = row.last_activity || row.last_screenshot_at || null;
      const rawStatus = String(row.current_status || 'offline').toLowerCase();
      const isRealtimeStatus = ['active', 'working', 'idle', 'on_break', 'break'].includes(rawStatus);
      const isStale = !row.last_activity || (Date.now() - new Date(row.last_activity).getTime()) > LIVE_HEARTBEAT_STALE_MS;
      const online = !forceCheckedOut && Boolean(row.attendance_id) && isRealtimeStatus && !isStale;

      results.push({
        employeeId: row.employee_id,
        name: row.employee_name,
        departmentId: row.department_id || null,
        departmentName: row.department_name || 'Unassigned',
        status: forceCheckedOut ? 'checked_out' : (online ? (row.current_status || 'offline') : 'offline'),
        online,
        activeApp: online ? (row.current_app || undefined) : undefined,
        lastSeen,
        lastUrl: row.last_screenshot_url || undefined,
        agentVersion: row.app_version || null,
        deviceId: row.device_id || null,
        hostname: row.hostname || null,
        osPlatform: row.os_platform || null,
        osVersion: row.os_version || null,
        deviceLastSeen: row.device_last_seen_at || null,
      });
    }

  return ok(results);
}
