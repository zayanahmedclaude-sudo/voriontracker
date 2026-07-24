// app/api/reports/route.ts
import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, ok, err } from '@/lib/api';
import { canViewReports, normalizeRole } from '@/lib/roles';
import { LIVE_HEARTBEAT_STALE_SECONDS, normalizePresenceStatus } from '@/lib/status';
import {
  BUSINESS_TIME_ZONE,
  getShiftWindowsForDate,
  getTimelineWindowForDate,
  getWindowDateInTimeZone,
  isTimestampWithinShiftWindows,
} from '@/lib/shifts';

type TimelineRange = { start: Date; end: Date; startIso: string; endIso: string };
type TimelineLog = {
  type: 'attendance' | 'break' | 'app';
  label: string;
  startAt: string;
  endAt: string;
  startMinute: number;
  endMinute: number;
  durationMinutes: number;
  app?: string | null;
  activityPct?: number | null;
  detail?: string;
};

function toTime(value: string | Date | null | undefined, fallback?: Date) {
  if (!value) return fallback?.getTime() ?? NaN;
  return new Date(value).getTime();
}

function minuteFromRange(value: number, range: TimelineRange) {
  return Math.max(0, Math.min(15 * 60, Math.round((value - range.start.getTime()) / 60000)));
}

function logFromRange(
  type: TimelineLog['type'],
  label: string,
  start: number,
  end: number,
  range: TimelineRange,
  extra: Partial<TimelineLog> = {},
): TimelineLog {
  return {
    type,
    label,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    startMinute: minuteFromRange(start, range),
    endMinute: minuteFromRange(end, range),
    durationMinutes: Math.max(0, Math.round((end - start) / 60000)),
    ...extra,
  };
}

function buildAppLogsForAttendance(screenshots: any[], attendanceStart: number, attendanceEnd: number, range: TimelineRange) {
  const captures = (screenshots || [])
    .map((shot) => ({
      app: String(shot.active_app || '').trim(),
      capturedAt: toTime(shot.captured_at),
      activityPct: shot.activity_pct == null ? null : Number(shot.activity_pct),
    }))
    .filter((shot) => shot.app && Number.isFinite(shot.capturedAt) && shot.capturedAt >= attendanceStart && shot.capturedAt <= attendanceEnd)
    .sort((a, b) => a.capturedAt - b.capturedAt);

  if (!captures.length) return [];

  const logs: TimelineLog[] = [];
  let current: { app: string; idle: boolean; start: number; end: number; activityValues: number[] } | null = null;

  const pushCurrent = () => {
    if (!current || current.end <= current.start) return;
    const avgActivity = current.activityValues.length
      ? current.activityValues.reduce((sum, value) => sum + value, 0) / current.activityValues.length
      : null;
    logs.push(logFromRange('app', current.idle ? 'Idle' : current.app, current.start, current.end, range, {
      app: current.idle ? 'Idle' : current.app,
      activityPct: avgActivity == null ? null : Math.round(avgActivity),
      detail: current.idle ? 'No mouse or keyboard activity' : undefined,
    }));
  };

  for (let index = 0; index < captures.length; index += 1) {
    const capture = captures[index];
    const isIdle = capture.activityPct != null && capture.activityPct <= 0;
    const nextCapture = captures[index + 1]?.capturedAt;
    const inferredEnd = nextCapture
      ? Math.min(nextCapture, attendanceEnd)
      : Math.min(capture.capturedAt + 5 * 60 * 1000, attendanceEnd);

    if (!current || current.app !== capture.app || current.idle !== isIdle || capture.capturedAt - current.end > 10 * 60 * 1000) {
      pushCurrent();
      current = { app: capture.app, idle: isIdle, start: capture.capturedAt, end: inferredEnd, activityValues: [] };
    } else {
      current.end = Math.max(current.end, inferredEnd);
    }

    if (current && capture.activityPct != null && Number.isFinite(capture.activityPct)) {
      current.activityValues.push(capture.activityPct);
    }
  }

  pushCurrent();

  return logs;
}

function buildTimelineSegments(attendanceRows: any[], breakRows: any[], range: TimelineRange, screenshotRows: any[] = []) {
  const now = new Date();
  const nowMs = now.getTime();
  const staleCutoffMs = nowMs - LIVE_HEARTBEAT_STALE_SECONDS * 1000;
  const rangeStart = range.start.getTime();
  const rangeEnd = range.end.getTime();
  const breaksByAttendance = new Map<string, any[]>();
  const screenshotsByEmployee = new Map<string, any[]>();
  const timelines = new Map<string, { segments: any[]; logs: TimelineLog[]; totalSeconds: number; lastActive: string | null }>();

  for (const breakRow of breakRows || []) {
    const records = breaksByAttendance.get(breakRow.attendance_id) || [];
    records.push(breakRow);
    breaksByAttendance.set(breakRow.attendance_id, records);
  }

  for (const screenshot of screenshotRows || []) {
    const employeeId = String(screenshot.employee_id);
    const records = screenshotsByEmployee.get(employeeId) || [];
    records.push(screenshot);
    screenshotsByEmployee.set(employeeId, records);
  }

  const ensureTimeline = (employeeId: string) => {
    const existing = timelines.get(employeeId) || { segments: [], logs: [], totalSeconds: 0, lastActive: null };
    timelines.set(employeeId, existing);
    return existing;
  };

  for (const attendance of attendanceRows || []) {
    const employeeId = String(attendance.employee_id);
    const timeline = ensureTimeline(employeeId);
    const attendanceStart = Math.max(toTime(attendance.check_in), rangeStart);
    const lastActivity = toTime(attendance.last_activity);
    const openAttendanceEnd = Number.isFinite(lastActivity) && lastActivity < staleCutoffMs
      ? lastActivity
      : nowMs;
    const attendanceEnd = Math.min(
      attendance.check_out ? toTime(attendance.check_out) : openAttendanceEnd,
      rangeEnd,
    );
    if (!Number.isFinite(attendanceStart) || !Number.isFinite(attendanceEnd) || attendanceEnd <= attendanceStart) continue;
    timeline.logs.push(logFromRange('attendance', attendance.check_out ? 'Checked in' : 'Checked in - active session', attendanceStart, attendanceEnd, range, {
      detail: attendance.check_out ? 'Session completed' : 'Session is still open',
    }));

    const clippedBreaks = (breaksByAttendance.get(attendance.id) || [])
      .map((breakRow) => {
        const start = Math.max(toTime(breakRow.start_time), attendanceStart, rangeStart);
        const end = Math.min(toTime(breakRow.end_time, now), attendanceEnd, rangeEnd);
        return { start, end };
      })
      .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
      .sort((a, b) => a.start - b.start);

    let cursor = attendanceStart;
    for (const breakItem of clippedBreaks) {
      if (breakItem.start > cursor) {
        timeline.segments.push({
          type: 'work',
          startMinute: minuteFromRange(cursor, range),
          endMinute: minuteFromRange(breakItem.start, range),
          project: attendance.current_app || 'Checked in',
          startedAt: new Date(cursor).toISOString(),
          endedAt: new Date(breakItem.start).toISOString(),
        });
        timeline.totalSeconds += Math.floor((breakItem.start - cursor) / 1000);
      }

      timeline.segments.push({
        type: 'break',
        startMinute: minuteFromRange(breakItem.start, range),
        endMinute: minuteFromRange(breakItem.end, range),
        project: 'Break',
        startedAt: new Date(breakItem.start).toISOString(),
        endedAt: new Date(breakItem.end).toISOString(),
      });
      timeline.logs.push(logFromRange('break', 'Break', breakItem.start, breakItem.end, range));
      cursor = Math.max(cursor, breakItem.end);
    }

    if (attendanceEnd > cursor) {
      timeline.segments.push({
        type: 'work',
        startMinute: minuteFromRange(cursor, range),
        endMinute: minuteFromRange(attendanceEnd, range),
        project: attendance.current_app || 'Checked in',
        startedAt: new Date(cursor).toISOString(),
        endedAt: new Date(attendanceEnd).toISOString(),
      });
      timeline.totalSeconds += Math.floor((attendanceEnd - cursor) / 1000);
    }

    const lastActive = new Date(attendanceEnd).toISOString();
    if (!timeline.lastActive || new Date(lastActive) > new Date(timeline.lastActive)) {
      timeline.lastActive = lastActive;
    }

    timeline.logs.push(...buildAppLogsForAttendance(
      screenshotsByEmployee.get(employeeId) || [],
      attendanceStart,
      attendanceEnd,
      range,
    ));
  }

  for (const timeline of timelines.values()) {
    timeline.segments = timeline.segments
      .filter((segment) => segment.endMinute > segment.startMinute)
      .sort((a, b) => a.startMinute - b.startMinute);
    timeline.logs = timeline.logs
      .filter((log) => log.endMinute > log.startMinute)
      .sort((a, b) => a.startMinute - b.startMinute || a.type.localeCompare(b.type));
  }

  return timelines;
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
  const date = requestedDate || getWindowDateInTimeZone(new Date(), 16, BUSINESS_TIME_ZONE);

  try {
    if (!isEmployee && !isClient && !canViewAll) {
      return err('Forbidden', 403);
    }

    // ── DAILY DASHBOARD SUMMARY ──────────────────────────────────────────
    if (type === 'daily') {
      const timelineRange = getTimelineWindowForDate(date, BUSINESS_TIME_ZONE);

      if (isClient) {
        const fullShiftRange = timelineRange;
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
        const [attendanceRows, breakRows, screenshotRows] = employeeIds.length > 0
          ? await Promise.all([
              sql`
                SELECT a.id, a.employee_id, a.check_in, a.check_out, es.current_app, es.last_activity
                FROM attendance a
                LEFT JOIN employee_status es ON es.employee_id = a.employee_id
                WHERE a.employee_id = ANY(${employeeIds}::uuid[])
                  AND a.check_in < ${fullShiftRange.endIso}
                  AND COALESCE(a.check_out, NOW()) > ${fullShiftRange.startIso}
              `,
              sql`
                SELECT b.id, b.attendance_id, b.start_time, b.end_time, a.employee_id
                FROM breaks b
                JOIN attendance a ON a.id = b.attendance_id
                WHERE a.employee_id = ANY(${employeeIds}::uuid[])
                  AND b.start_time < ${fullShiftRange.endIso}
                  AND COALESCE(b.end_time, NOW()) > ${fullShiftRange.startIso}
              `,
              sql`
                SELECT employee_id, active_app, activity_pct, captured_at
                FROM screenshots
                WHERE employee_id = ANY(${employeeIds}::uuid[])
                  AND captured_at >= ${fullShiftRange.startIso}
                  AND captured_at < ${fullShiftRange.endIso}
              `,
            ])
          : [[], [], []];

        const timelinesByEmployee = buildTimelineSegments(attendanceRows, breakRows, timelineRange, screenshotRows);

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
          const timeline = timelinesByEmployee.get(String(row.id));
          existing.segments = timeline?.segments || [];
          existing.logs = timeline?.logs || [];
          existing.total_seconds = timeline?.totalSeconds || 0;
          if (timeline?.lastActive && (!existing.last_active || new Date(timeline.lastActive) > new Date(existing.last_active))) {
            existing.last_active = timeline.lastActive;
          }
          if (lastActivityIsInShift && (!existing.last_active || new Date(row.last_activity) > new Date(existing.last_active))) {
            existing.last_active = row.last_activity;
          }
          if (currentlyInShift && lastActivityIsInShift && hasFreshHeartbeat) {
            existing.current_status = normalizePresenceStatus(row.current_status);
            existing.current_app = row.current_app || null;
          }
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
          WHERE a.check_in < ${timelineRange.endIso}
            AND COALESCE(a.check_out, NOW()) > ${timelineRange.startIso}
          GROUP BY a.employee_id
        ),
        screenshot_summary AS (
          SELECT
            employee_id,
            COUNT(*) AS screenshot_count
          FROM screenshots
          WHERE captured_at >= ${timelineRange.startIso}
            AND captured_at < ${timelineRange.endIso}
          GROUP BY employee_id
        ),
        activity_summary AS (
          SELECT
            employee_id,
            AVG(activity_pct)                          AS avg_activity_pct,
            COUNT(*)                                   AS activity_record_count
          FROM screenshots
          WHERE captured_at >= ${timelineRange.startIso}
            AND captured_at < ${timelineRange.endIso}
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

      const employeeIds = (rows || []).map((row: any) => row.id);
      const [attendanceRows, breakRows, appScreenshotRows] = employeeIds.length > 0
        ? await Promise.all([
            sql`
              SELECT a.id, a.employee_id, a.check_in, a.check_out, es.current_app, es.last_activity
              FROM attendance a
              LEFT JOIN employee_status es ON es.employee_id = a.employee_id
              WHERE a.employee_id = ANY(${employeeIds}::uuid[])
                AND a.check_in < ${timelineRange.endIso}
                AND COALESCE(a.check_out, NOW()) > ${timelineRange.startIso}
            `,
            sql`
              SELECT b.id, b.attendance_id, b.start_time, b.end_time, a.employee_id
              FROM breaks b
              JOIN attendance a ON a.id = b.attendance_id
              WHERE a.employee_id = ANY(${employeeIds}::uuid[])
                AND b.start_time < ${timelineRange.endIso}
                AND COALESCE(b.end_time, NOW()) > ${timelineRange.startIso}
            `,
            sql`
              SELECT employee_id, active_app, activity_pct, captured_at
              FROM screenshots
              WHERE employee_id = ANY(${employeeIds}::uuid[])
                AND captured_at >= ${timelineRange.startIso}
                AND captured_at < ${timelineRange.endIso}
                AND active_app IS NOT NULL
            `,
          ])
        : [[], [], []];

      const timelinesByEmployee = buildTimelineSegments(attendanceRows, breakRows, timelineRange, appScreenshotRows);
      const timelineRows = (rows || []).map((row: any) => {
        const timeline = timelinesByEmployee.get(String(row.id));
        return {
          ...row,
          total_seconds: timeline?.totalSeconds || 0,
          segments: timeline?.segments || [],
          logs: timeline?.logs || [],
          last_active: timeline?.lastActive || row.last_active,
        };
      }).sort((a: any, b: any) => Number(b.total_seconds || 0) - Number(a.total_seconds || 0));

      return ok({ date, rows: timelineRows });
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
