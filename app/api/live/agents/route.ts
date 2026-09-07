import { NextRequest } from 'next/server';
import { getExistingColumns, queryRows } from '@/lib/db';
import { requireAuth, err, ok } from '@/lib/api';
import { AGENT_TRACKED_ROLES, canAccessLiveMonitor, normalizeRole } from '@/lib/roles';
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
    ),
    latest_devices AS (
      SELECT DISTINCT ON (dr.employee_id)
        dr.employee_id,
        dr.device_id,
        dr.hostname,
        dr.app_version,
        dr.os_platform,
        dr.os_version,
        dr.last_seen_at
      FROM device_registrations dr
      WHERE dr.employee_id IS NOT NULL
      ORDER BY dr.employee_id, dr.last_seen_at DESC NULLS LAST, dr.updated_at DESC NULLS LAST
    )
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
    LEFT JOIN active_attendance aa ON aa.employee_id = p.id
    LEFT JOIN employee_status es ON es.employee_id = p.id
    LEFT JOIN latest_screenshots ls ON ls.employee_id = p.id
    LEFT JOIN latest_devices ld ON ld.employee_id = p.id
    WHERE p.role = ANY($1)
      AND COALESCE(p.account_status, 'active') <> 'terminated'
    ORDER BY p.full_name
  `, [AGENT_TRACKED_ROLES]);

  const results = [];
  const forceCheckedOut = isWithinForcedCheckoutWindow(new Date(), BUSINESS_TIME_ZONE);
  for (const row of rows) {
      const lastSeen = row.last_activity || row.last_screenshot_at || null;
      const rawStatus = String(row.current_status || 'offline').toLowerCase();
      const isRealtimeStatus = ['active', 'working', 'idle', 'on_break', 'break'].includes(rawStatus);
      const isStale = !row.last_activity || (Date.now() - new Date(row.last_activity).getTime()) > LIVE_HEARTBEAT_STALE_MS;
      const online = !forceCheckedOut && Boolean(row.attendance_id) && isRealtimeStatus && !isStale;
      const silentTooLong = !online && lastSeen && (Date.now() - new Date(lastSeen).getTime()) > 5 * 60 * 1000;

      if (silentTooLong) {
        await queryRows(
          `INSERT INTO device_alerts (employee_id, device_id, hostname, alert_type, severity, title, description, metadata)
           SELECT $1, COALESCE(dr.device_id, $2), dr.hostname, 'device_silent', 'high', $3, $4, $5::jsonb
           WHERE NOT EXISTS (
             SELECT 1
             FROM device_alerts da
             WHERE da.employee_id = $1
               AND da.alert_type = 'device_silent'
               AND da.resolved_at IS NULL
               AND da.created_at > NOW() - INTERVAL '6 hours'
           )`,
          [
            row.employee_id,
            `employee:${row.employee_id}`,
            'Device reporting gap detected',
            `${row.employee_name} has gone silent unexpectedly. Last activity was ${lastSeen}.`,
            JSON.stringify({ employeeId: row.employee_id, lastSeen }),
          ],
        ).catch(() => undefined);
      }

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
