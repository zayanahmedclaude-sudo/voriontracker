// app/api/reports/route.ts
import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, ok, err } from '@/lib/api';
import { canViewReports, normalizeRole } from '@/lib/roles';
import { LIVE_HEARTBEAT_STALE_SECONDS, normalizePresenceStatus } from '@/lib/status';
import {
  BUSINESS_TIME_ZONE,
  getBusinessDayRange,
  getShiftDateInTimeZone,
  getShiftRangeForDate,
  getShiftWindowsForDate,
  isTimestampWithinShiftWindows,
} from '@/lib/shifts';

function overlapSeconds(startIso: string | null, endIso: string | null, windows: Array<{ start: Date; end: Date }>) {
  if (!startIso) return 0;
  const start = new Date(startIso);
  const end = new Date(endIso || new Date().toISOString());
  return windows.reduce((sum, window) => {
    const overlapStart = Math.max(start.getTime(), window.start.getTime());
    const overlapEnd = Math.min(end.getTime(), window.end.getTime());
    return sum + Math.max(0, Math.floor((overlapEnd - overlapStart) / 1000));
  }, 0);
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  const { searchParams } = new URL(req.url);
  const type   = searchParams.get('type') || 'daily';
  const requestedDate = searchParams.get('date');
  const role = normalizeRole(user.role);
  const isEmployee = role === 'employee';
  const isClient = role === 'client';
  const canViewAll = canViewReports(role);
  const date = requestedDate || getShiftDateInTimeZone(new Date(), BUSINESS_TIME_ZONE);

  try {
    if (!isEmployee && !isClient && !canViewAll) {
      return err('Forbidden', 403);
    }

    // ── DAILY DASHBOARD SUMMARY ──────────────────────────────────────────
    if (type === 'daily') {
      if (isClient) {
        const fullShiftRange = getShiftRangeForDate(date, 'full_time');
        const assignedEmployees = await sql`
          SELECT
            p.id,
            p.full_name AS name,
            p.role,
            p.department_id,
            ca.shift_type AS assignment_shift_type,
            es.current_status,
            es.current_app,
            es.last_activity
          FROM client_assignments ca
          JOIN public.profiles p ON p.id = ca.employee_id
          LEFT JOIN employee_status es ON es.employee_id = p.id
          WHERE ca.client_id = ${user.sub}
          ORDER BY p.full_name
        `;

        const rowsByEmployee = new Map<string, any>();
        for (const row of assignedEmployees || []) {
          const existing = rowsByEmployee.get(row.id) || {
            id: row.id,
            name: row.name,
            role: row.role,
            department_id: row.department_id,
            total_seconds: 0,
            screenshot_count: 0,
            avg_activity_pct: null,
            last_active: null,
            current_status: 'offline',
            current_app: null,
            assignment_shift_type: row.assignment_shift_type || 'full_time',
          };
          rowsByEmployee.set(row.id, existing);
        }

        const employeeIds = (assignedEmployees || []).map((row: any) => row.id);
        const [attendanceRows, screenshotRows] = employeeIds.length > 0
          ? await Promise.all([
              sql`
                SELECT employee_id, check_in, check_out
                FROM attendance
                WHERE employee_id = ANY(${employeeIds}::uuid[])
                  AND check_in < ${fullShiftRange.endIso}
                  AND COALESCE(check_out, NOW()) > ${fullShiftRange.startIso}
              `,
              sql`
                SELECT employee_id, activity_pct, captured_at
                FROM screenshots
                WHERE employee_id = ANY(${employeeIds}::uuid[])
                  AND captured_at >= ${fullShiftRange.startIso}
                  AND captured_at < ${fullShiftRange.endIso}
              `,
            ])
          : [[], []];

        const attendanceByEmployee = new Map<string, any[]>();
        for (const attendance of attendanceRows) {
          const records = attendanceByEmployee.get(attendance.employee_id) || [];
          records.push(attendance);
          attendanceByEmployee.set(attendance.employee_id, records);
        }

        const screenshotsByEmployee = new Map<string, any[]>();
        for (const screenshot of screenshotRows) {
          const records = screenshotsByEmployee.get(screenshot.employee_id) || [];
          records.push(screenshot);
          screenshotsByEmployee.set(screenshot.employee_id, records);
        }

        for (const row of assignedEmployees || []) {
          const shiftWindows = getShiftWindowsForDate(date, row.assignment_shift_type || 'full_time');
          const lastActivity = row.last_activity ? new Date(row.last_activity) : null;
          const now = new Date();
          const lastActivityIsInShift = Boolean(
            lastActivity && isTimestampWithinShiftWindows(lastActivity, shiftWindows),
          );
          const currentlyInShift = isTimestampWithinShiftWindows(now, shiftWindows);
          const hasFreshHeartbeat = Boolean(
            lastActivity
            && now.getTime() - lastActivity.getTime() <= LIVE_HEARTBEAT_STALE_SECONDS * 1000,
          );
          const visibleScreenshots = (screenshotsByEmployee.get(row.id) || []).filter((shot: any) =>
            isTimestampWithinShiftWindows(shot.captured_at, shiftWindows),
          );
          const existing = rowsByEmployee.get(row.id);
          if (lastActivityIsInShift) {
            existing.last_active = row.last_activity;
          }
          if (currentlyInShift && lastActivityIsInShift && hasFreshHeartbeat) {
            existing.current_status = normalizePresenceStatus(row.current_status);
            existing.current_app = row.current_app || null;
          }
          existing.total_seconds += (attendanceByEmployee.get(row.id) || []).reduce(
            (sum: number, attendance: any) => sum + overlapSeconds(attendance.check_in, attendance.check_out, shiftWindows),
            0,
          );
          existing.screenshot_count += visibleScreenshots.length;
          if (visibleScreenshots.length > 0) {
            const avg = visibleScreenshots.reduce((sum: number, shot: any) => sum + Number(shot.activity_pct || 0), 0) / visibleScreenshots.length;
            existing.avg_activity_pct = existing.avg_activity_pct == null
              ? avg
              : (existing.avg_activity_pct + avg) / 2;
            const latest = visibleScreenshots
              .map((shot: any) => shot.captured_at)
              .sort((a: string, b: string) => new Date(b).getTime() - new Date(a).getTime())[0];
            if (latest && (!existing.last_active || new Date(latest) > new Date(existing.last_active))) {
              existing.last_active = latest;
            }
          }
        }

        return ok({ date, rows: Array.from(rowsByEmployee.values()) });
      }

      const businessDayRange = getBusinessDayRange(date, BUSINESS_TIME_ZONE);
      const rows = await sql`
        WITH break_summary AS (
          SELECT
            attendance_id,
            COALESCE(SUM(COALESCE(duration_minutes, 0)), 0) AS break_minutes
          FROM breaks
          GROUP BY attendance_id
        ),
        attendance_summary AS (
          SELECT
            a.employee_id,
            MAX(a.check_out) AS last_check_out,
            SUM(
              CASE
                WHEN a.status IN ('checked_out', 'on_break') THEN
                  GREATEST(0, COALESCE(a.total_minutes, 0) - COALESCE(b.break_minutes, 0))
                WHEN es.last_activity IS NOT NULL AND es.last_activity < NOW() - (${LIVE_HEARTBEAT_STALE_SECONDS} * INTERVAL '1 second') THEN
                  GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM (es.last_activity - a.check_in)) / 60)::int
                    - COALESCE(b.break_minutes, 0)
                  )
                ELSE
                  GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM (NOW() - a.check_in)) / 60)::int
                    - COALESCE(b.break_minutes, 0)
                  )
              END
            ) AS total_minutes
          FROM attendance a
          LEFT JOIN break_summary   b  ON b.attendance_id = a.id
          LEFT JOIN employee_status es ON es.employee_id  = a.employee_id
          WHERE a.check_in < ${businessDayRange.endIso}
            AND COALESCE(a.check_out, NOW()) > ${businessDayRange.startIso}
          GROUP BY a.employee_id
        ),
        screenshot_summary AS (
          SELECT
            employee_id,
            COUNT(*) AS screenshot_count
          FROM screenshots
          WHERE captured_at >= ${businessDayRange.startIso}
            AND captured_at < ${businessDayRange.endIso}
          GROUP BY employee_id
        ),
        activity_summary AS (
          SELECT
            employee_id,
            AVG(activity_pct)                          AS avg_activity_pct,
            COUNT(*)                                   AS activity_record_count
          FROM screenshots
          WHERE captured_at >= ${businessDayRange.startIso}
            AND captured_at < ${businessDayRange.endIso}
            AND activity_pct IS NOT NULL
          GROUP BY employee_id
        )
        SELECT
          p.id,
          p.full_name                                  AS name,
          p.role,
          p.department_id,
          COALESCE(a.total_minutes, 0) * 60            AS total_seconds,
          COALESCE(ss.screenshot_count, 0)             AS screenshot_count,
          CASE
            WHEN COALESCE(act.activity_record_count, 0) = 0 THEN NULL
            ELSE LEAST(ROUND(COALESCE(act.avg_activity_pct, 0), 1), 100)
          END                                          AS avg_activity_pct,
          GREATEST(
            COALESCE(a.last_check_out, '1970-01-01'::timestamptz),
            COALESCE(es.last_activity, '1970-01-01'::timestamptz)
          )                                            AS last_active,
          CASE
            WHEN es.last_activity IS NULL OR es.last_activity < NOW() - (${LIVE_HEARTBEAT_STALE_SECONDS} * INTERVAL '1 second') THEN 'offline'
            WHEN es.current_status IN ('active', 'working') THEN 'working'
            WHEN es.current_status = 'idle' THEN 'idle'
            WHEN es.current_status IN ('break', 'on_break') THEN 'on_break'
            WHEN es.current_status IN ('checked_out', 'checkout', 'check_out') THEN 'checked_out'
            ELSE es.current_status
          END                                          AS current_status,
          es.current_app
        FROM public.profiles p
        LEFT JOIN attendance_summary  a   ON a.employee_id   = p.id
        LEFT JOIN screenshot_summary  ss  ON ss.employee_id  = p.id
        LEFT JOIN activity_summary    act ON act.employee_id = p.id
        LEFT JOIN employee_status     es  ON es.employee_id  = p.id
        WHERE p.role = 'employee'
          AND (
            (${isEmployee} = true AND p.id = ${user.sub})
            OR (${isEmployee} = false)
          )
        ORDER BY total_seconds DESC
      `;
      return ok({ date, rows });
    }

    // ── WEEKLY SUMMARY ───────────────────────────────────────────────────
    if (type === 'weekly') {
      if (isClient) {
        return ok([]);
      }
      const rows = await sql`
        WITH break_summary AS (
          SELECT
            attendance_id,
            COALESCE(SUM(COALESCE(duration_minutes, 0)), 0) AS break_minutes
          FROM breaks
          GROUP BY attendance_id
        ),
        attendance_weekly AS (
          SELECT
            DATE(a.check_in) AS day,
            a.employee_id,
            a.check_in,
            a.check_out,
            a.total_minutes,
            COALESCE(b.break_minutes, 0) AS break_minutes
          FROM attendance a
          LEFT JOIN break_summary b ON b.attendance_id = a.id
          JOIN public.profiles p ON p.id = a.employee_id
          WHERE a.check_in >= NOW() - INTERVAL '7 days'
            AND p.role = 'employee'
            AND (
              (${isEmployee} = true AND a.employee_id = ${user.sub})
              OR (${isEmployee} = false)
            )
        )
        SELECT
          day,
          COUNT(DISTINCT employee_id)                  AS active_users,
          COALESCE(SUM(
            CASE
              WHEN check_out IS NOT NULL THEN GREATEST(0, COALESCE(total_minutes, 0) - break_minutes)
              ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - check_in)) / 60)::int - break_minutes)
            END
          ), 0) * 60                                   AS total_seconds,
          (
            SELECT COUNT(*)
            FROM screenshots s
            JOIN public.profiles sp ON sp.id = s.employee_id
            WHERE DATE(s.captured_at) = day
              AND (
                (${isEmployee} = true AND s.employee_id = ${user.sub})
                OR (${isEmployee} = false)
              )
          )                                            AS screenshots
        FROM attendance_weekly
        GROUP BY day
        ORDER BY day
      `;
      return ok(rows);
    }

    return ok([]);

  } catch (e: any) {
    console.error('GET /api/reports error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}
