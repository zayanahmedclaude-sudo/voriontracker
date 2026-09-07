import { attendanceBounds } from './timeline-attendance';
import { activityMinutes } from './timeline-view';
import { attachTimelineAudit } from '@/lib/timeline-audit';
﻿// app/api/reports/route.ts
import { NextRequest } from 'next/server';
import { queryRows, sql } from '@/lib/db';
import { requireAuth, ok, err } from '@/lib/api';
import { createExportAccessLog } from '@/lib/export-access';
import { AGENT_TRACKED_ROLES, canViewReports, isAgentTrackedRole, normalizeRole } from '@/lib/roles';
import { LIVE_HEARTBEAT_STALE_SECONDS, normalizePresenceStatus } from '@/lib/status';
import {
  AUTO_CHECKOUT_HOUR,
  BUSINESS_TIME_ZONE,
  getTimelineAutoCheckoutCutoffForDate,
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
type ReportsContext = {
  userSub: string;
  isEmployee: boolean;
  isClient: boolean;
};
type ReportCacheEntry = {
  expiresAt: number;
  data: unknown;
};

const REPORT_CACHE_TTL_MS = 120_000;
const REPORT_CACHE_MAX_ENTRIES = 200;
const reportCache = new Map<string, ReportCacheEntry>();
const AUTO_CHECKOUT_SQL = `
  (
    (
      date_trunc('day', check_in AT TIME ZONE '${BUSINESS_TIME_ZONE}') +
      CASE
        WHEN EXTRACT(HOUR FROM check_in AT TIME ZONE '${BUSINESS_TIME_ZONE}') >= 16
          THEN INTERVAL '1 day ${AUTO_CHECKOUT_HOUR} hours'
        ELSE INTERVAL '${AUTO_CHECKOUT_HOUR} hours'
      END
    ) AT TIME ZONE '${BUSINESS_TIME_ZONE}'
  )
`;

function getCachedReport(cacheKey: string) {
  const cached = reportCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    reportCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

function setCachedReport(cacheKey: string, data: unknown) {
  if (reportCache.size >= REPORT_CACHE_MAX_ENTRIES) {
    const oldestKey = reportCache.keys().next().value;
    if (oldestKey) reportCache.delete(oldestKey);
  }
  reportCache.set(cacheKey, {
    expiresAt: Date.now() + REPORT_CACHE_TTL_MS,
    data,
  });
}

function isValidReportDate(value: string | null | undefined) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

async function getTimelineRowsForEmployees(employeeIds: string[], range: TimelineRange) {
  if (!employeeIds.length) return { attendanceRows: [], breakRows: [], screenshotRows: [] };

  const [attendanceRows, breakRows, screenshotRows] = await Promise.all([
    sql`
      WITH scoped_attendance AS (
        SELECT id, employee_id, check_in, check_out
        FROM attendance
        WHERE employee_id = ANY(${employeeIds}::uuid[])
          AND check_in < ${range.endIso}
          AND COALESCE(check_out, NOW()) > ${range.startIso}
      ),
      screenshot_activity AS (
        SELECT s.session_id, MAX(s.captured_at) AS last_screenshot_at
        FROM screenshots s
        JOIN scoped_attendance a ON a.id = s.session_id
        GROUP BY s.session_id
      ),
      break_activity AS (
        SELECT b.attendance_id, MAX(GREATEST(b.start_time, COALESCE(b.end_time, b.start_time))) AS last_break_at
        FROM breaks b
        JOIN scoped_attendance a ON a.id = b.attendance_id
        GROUP BY b.attendance_id
      )
      SELECT
        a.id,
        a.employee_id,
        a.check_in,
        a.check_out,
        es.current_app,
        es.last_activity,
        GREATEST(
          a.check_in,
          COALESCE(sa.last_screenshot_at, a.check_in),
          COALESCE(ba.last_break_at, a.check_in)
        ) AS session_last_activity
      FROM scoped_attendance a
      LEFT JOIN screenshot_activity sa ON sa.session_id = a.id
      LEFT JOIN break_activity ba ON ba.attendance_id = a.id
      LEFT JOIN employee_status es ON es.employee_id = a.employee_id
    `,
    sql`
      SELECT b.id, b.attendance_id, b.start_time, b.end_time, a.employee_id
      FROM breaks b
      JOIN attendance a ON a.id = b.attendance_id
      WHERE a.employee_id = ANY(${employeeIds}::uuid[])
        AND b.start_time < ${range.endIso}
        AND COALESCE(b.end_time, NOW()) > ${range.startIso}
    `,
    sql`
      SELECT employee_id, session_id, active_app, activity_pct, captured_at
      FROM screenshots
      WHERE employee_id = ANY(${employeeIds}::uuid[])
        AND captured_at >= ${range.startIso}
        AND captured_at < ${range.endIso}
    `,
  ]);

  return { attendanceRows, breakRows, screenshotRows };
}

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
      ? Math.min(nextCapture, capture.capturedAt + 5 * 60 * 1000, attendanceEnd)
      : Math.min(capture.capturedAt + 5 * 60 * 1000, attendanceEnd);

    if (!current || current.app !== capture.app || current.idle !== isIdle || capture.capturedAt > current.end) {
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
  const rangeStart = range.start.getTime();
  const rangeEnd = range.end.getTime();
  const breaksByAttendance = new Map<string, any[]>();
  const screenshotsByEmployee = new Map<string, any[]>();
  const screenshotsByAttendance = new Map<string, any[]>();
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
    if (screenshot.session_id) {
      const attendanceId = String(screenshot.session_id);
      const attendanceRecords = screenshotsByAttendance.get(attendanceId) || [];
      attendanceRecords.push(screenshot);
      screenshotsByAttendance.set(attendanceId, attendanceRecords);
    }
  }

  const ensureTimeline = (employeeId: string) => {
    const existing = timelines.get(employeeId) || { segments: [], logs: [], totalSeconds: 0, lastActive: null };
    timelines.set(employeeId, existing);
    return existing;
  };

  for (const attendance of attendanceRows || []) {
    const employeeId = String(attendance.employee_id);
    const timeline = ensureTimeline(employeeId);
    const bounds = attendanceBounds(attendance, range, nowMs, LIVE_HEARTBEAT_STALE_SECONDS);
    if (!bounds) continue;
    const attendanceStart = bounds.start;
    const attendanceEnd = bounds.end;
    const attendanceScreenshots = screenshotsByAttendance.get(String(attendance.id)) || [];
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
      attendanceScreenshots.length > 0 ? attendanceScreenshots : screenshotsByEmployee.get(employeeId) || [],
      attendanceStart,
      attendanceEnd,
      range,
    ));
  }

  for (const timeline of timelines.values()) {
    timeline.segments.push(...timeline.logs
      .filter(log => log.type === 'app' && log.activityPct === 0)
      .map(log => ({ type: 'idle', startMinute: log.startMinute, endMinute: log.endMinute })));
    timeline.segments = timeline.segments
      .filter((segment) => segment.endMinute > segment.startMinute)
      .sort((a, b) => a.startMinute - b.startMinute);
    timeline.logs = timeline.logs
      .filter((log) => log.endMinute > log.startMinute)
      .sort((a, b) => a.startMinute - b.startMinute || a.type.localeCompare(b.type));
    timeline.totalSeconds = activityMinutes(timeline.segments).work * 60;
  }

  return timelines;
}

export async function getDailyReportData(date: string, context: ReportsContext) {
  const { userSub, isEmployee, isClient } = context;
  const timelineRange = getTimelineWindowForDate(date, BUSINESS_TIME_ZONE);
  const autoCheckoutCutoff = getTimelineAutoCheckoutCutoffForDate(date, BUSINESS_TIME_ZONE);
  const forceCheckedOut = new Date().getTime() >= autoCheckoutCutoff.getTime();

  if (isClient) {
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
      WHERE ca.client_id = ${userSub}
        AND p.role = ANY(${AGENT_TRACKED_ROLES}::text[])
        AND COALESCE(p.account_status, 'active') = 'active'
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
    const { attendanceRows, breakRows, screenshotRows } = await getTimelineRowsForEmployees(employeeIds, timelineRange);

    const timelinesByEmployee = buildTimelineSegments(attendanceRows, breakRows, timelineRange, screenshotRows);
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
      const lastActivityIsInShift = Boolean(lastActivity && isTimestampWithinShiftWindows(lastActivity, shiftWindows));
      const currentlyInShift = isTimestampWithinShiftWindows(now, shiftWindows);
      const hasFreshHeartbeat = Boolean(
        lastActivity && now.getTime() - lastActivity.getTime() <= LIVE_HEARTBEAT_STALE_SECONDS * 1000,
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
      if (forceCheckedOut) {
        existing.current_status = 'checked_out';
        existing.current_app = null;
      }
      existing.screenshot_count += visibleScreenshots.length;
      if (visibleScreenshots.length > 0) {
        const avg = visibleScreenshots.reduce((sum: number, shot: any) => sum + Number(shot.activity_pct || 0), 0) / visibleScreenshots.length;
        existing.avg_activity_pct = existing.avg_activity_pct == null ? avg : (existing.avg_activity_pct + avg) / 2;
        const latest = visibleScreenshots
          .map((shot: any) => shot.captured_at)
          .sort((a: string, b: string) => new Date(b).getTime() - new Date(a).getTime())[0];
        if (latest && (!existing.last_active || new Date(latest) > new Date(existing.last_active))) {
          existing.last_active = latest;
        }
      }
    }

    return { date, rows: await attachTimelineAudit(Array.from(rowsByEmployee.values()), timelineRange) };
  }

  const rows = await sql`
    WITH scoped_profiles AS (
      SELECT id, full_name, role, department_id
      FROM public.profiles
      WHERE role = ANY(${AGENT_TRACKED_ROLES})
        AND COALESCE(account_status, 'active') = 'active'
        AND (
          (${isEmployee} = true AND id = ${userSub})
          OR (${isEmployee} = false)
        )
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
        AVG(activity_pct) AS avg_activity_pct,
        COUNT(*) AS activity_record_count
      FROM screenshots
      WHERE captured_at >= ${timelineRange.startIso}
        AND captured_at < ${timelineRange.endIso}
        AND activity_pct IS NOT NULL
      GROUP BY employee_id
    )
    SELECT
      p.id,
      p.full_name AS name,
      p.role,
      p.department_id,
      0 AS total_seconds,
      COALESCE(ss.screenshot_count, 0) AS screenshot_count,
      CASE
        WHEN COALESCE(act.activity_record_count, 0) = 0 THEN NULL
        ELSE LEAST(ROUND(COALESCE(act.avg_activity_pct, 0), 1), 100)
      END AS avg_activity_pct,
      COALESCE(es.last_activity, '1970-01-01'::timestamptz) AS last_active,
      CASE
        WHEN es.last_activity IS NULL OR es.last_activity < NOW() - (${LIVE_HEARTBEAT_STALE_SECONDS} * INTERVAL '1 second') THEN 'offline'
        WHEN es.current_status IN ('active', 'working') THEN 'working'
        WHEN es.current_status = 'idle' THEN 'idle'
        WHEN es.current_status IN ('break', 'on_break') THEN 'on_break'
        WHEN es.current_status IN ('checked_out', 'checkout', 'check_out') THEN 'checked_out'
        ELSE es.current_status
      END AS current_status,
      es.current_app
    FROM scoped_profiles p
    LEFT JOIN screenshot_summary ss ON ss.employee_id = p.id
    LEFT JOIN activity_summary act ON act.employee_id = p.id
    LEFT JOIN employee_status es ON es.employee_id = p.id
    ORDER BY p.full_name
  `;

  const employeeIds = (rows || []).map((row: any) => row.id);
  const { attendanceRows, breakRows, screenshotRows: appScreenshotRows } = await getTimelineRowsForEmployees(employeeIds, timelineRange);

  const timelinesByEmployee = buildTimelineSegments(attendanceRows, breakRows, timelineRange, appScreenshotRows);
  const timelineRows = (rows || []).map((row: any) => {
    const timeline = timelinesByEmployee.get(String(row.id));
    return {
      ...row,
      total_seconds: timeline?.totalSeconds || 0,
      segments: timeline?.segments || [],
      logs: timeline?.logs || [],
      last_active: timeline?.lastActive || row.last_active,
      current_status: forceCheckedOut ? 'checked_out' : row.current_status,
      current_app: forceCheckedOut ? null : row.current_app,
    };
  }).sort((a: any, b: any) => Number(b.total_seconds || 0) - Number(a.total_seconds || 0));

  return { date, rows: await attachTimelineAudit(timelineRows, timelineRange) };
}

async function getWorkInsightReport(period: 'weekly' | 'monthly', isEmployee: boolean, userSub: string) {
  const isWeekly = period === 'weekly';
  const periodStartSql = isWeekly
    ? "date_trunc('week', CURRENT_DATE::timestamp)"
    : "date_trunc('month', CURRENT_DATE::timestamp) - INTERVAL '5 months'";
  const periodEndSql = isWeekly
    ? "date_trunc('week', CURRENT_DATE::timestamp) + INTERVAL '7 days'"
    : "date_trunc('month', CURRENT_DATE::timestamp) + INTERVAL '1 month'";

  const buckets = await queryRows(`
    WITH bucket_series AS (
      SELECT generate_series(
        ${isWeekly ? "date_trunc('week', CURRENT_DATE::timestamp)::date" : "date_trunc('month', CURRENT_DATE::timestamp) - INTERVAL '5 months'"},
        ${isWeekly ? "(date_trunc('week', CURRENT_DATE::timestamp) + INTERVAL '6 days')::date" : "date_trunc('month', CURRENT_DATE::timestamp)"},
        INTERVAL '${isWeekly ? '1 day' : '1 month'}'
      )::date AS bucket_start
    ),
    break_summary AS (
      SELECT attendance_id, COALESCE(SUM(COALESCE(duration_minutes, 0)), 0) AS break_minutes
      FROM breaks
      GROUP BY attendance_id
    ),
    attendance_period AS (
      SELECT
        ${isWeekly ? 'DATE(a.check_in)' : "date_trunc('month', a.check_in)::date"} AS bucket_start,
        a.employee_id,
        a.check_in,
        a.check_out,
        a.total_minutes,
        COALESCE(b.break_minutes, 0) AS break_minutes
      FROM attendance a
      LEFT JOIN break_summary b ON b.attendance_id = a.id
      JOIN public.profiles p ON p.id = a.employee_id
      WHERE a.check_in >= ${periodStartSql}
        AND a.check_in < ${periodEndSql}
        AND p.role = ANY($3::text[])
        AND COALESCE(p.account_status, 'active') = 'active'
        AND (($1 = true AND a.employee_id = $2::uuid) OR ($1 = false))
    ),
    bucket_rollup AS (
      SELECT
        bucket_start,
        COUNT(DISTINCT employee_id) AS active_users,
        COALESCE(SUM(
          GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (LEAST(COALESCE(check_out, NOW()), NOW(), ${AUTO_CHECKOUT_SQL}) - check_in)) / 60)::int
            - break_minutes
          )
        ), 0) * 60 AS total_seconds
      FROM attendance_period
      GROUP BY bucket_start
    )
    SELECT
      bucket_series.bucket_start AS ${isWeekly ? 'day' : 'month'},
      COALESCE(bucket_rollup.active_users, 0) AS active_users,
      COALESCE(bucket_rollup.total_seconds, 0) AS total_seconds,
      (
        SELECT COUNT(*)
        FROM screenshots s
        WHERE s.captured_at >= bucket_series.bucket_start
          AND s.captured_at < bucket_series.bucket_start + INTERVAL '${isWeekly ? '1 day' : '1 month'}'
          AND (($1 = true AND s.employee_id = $2::uuid) OR ($1 = false))
      ) AS screenshots
    FROM bucket_series
    LEFT JOIN bucket_rollup ON bucket_rollup.bucket_start = bucket_series.bucket_start
    ORDER BY bucket_series.bucket_start
  `, [isEmployee, userSub, AGENT_TRACKED_ROLES]);

  const employees = await queryRows(`
    WITH break_summary AS (
      SELECT attendance_id, COALESCE(SUM(COALESCE(duration_minutes, 0)), 0) AS break_minutes
      FROM breaks
      GROUP BY attendance_id
    ),
    attendance_period AS (
      SELECT
        a.employee_id,
        MIN(a.check_in) AS first_check_in,
        MAX(COALESCE(a.check_out, NOW())) AS last_activity,
        COUNT(*) AS sessions,
        COUNT(DISTINCT DATE(a.check_in)) AS days_worked,
        COALESCE(SUM(COALESCE(b.break_minutes, 0)), 0) AS break_minutes,
        COALESCE(SUM(
          GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (LEAST(COALESCE(a.check_out, NOW()), NOW(), ${AUTO_CHECKOUT_SQL}) - a.check_in)) / 60)::int
            - COALESCE(b.break_minutes, 0)
          )
        ), 0) AS work_minutes
      FROM attendance a
      LEFT JOIN break_summary b ON b.attendance_id = a.id
      JOIN public.profiles p ON p.id = a.employee_id
      WHERE a.check_in >= ${periodStartSql}
        AND a.check_in < ${periodEndSql}
        AND p.role = ANY($3::text[])
        AND COALESCE(p.account_status, 'active') = 'active'
        AND (($1 = true AND a.employee_id = $2::uuid) OR ($1 = false))
      GROUP BY a.employee_id
    ),
    app_counts AS (
      SELECT
        s.employee_id,
        s.active_app,
        COUNT(*) AS app_samples,
        SUM(COUNT(*)) OVER (PARTITION BY s.employee_id) AS employee_app_samples,
        AVG(s.activity_pct) AS app_activity_pct
      FROM screenshots s
      JOIN public.profiles p ON p.id = s.employee_id
      WHERE s.captured_at >= ${periodStartSql}
        AND s.captured_at < ${periodEndSql}
        AND s.active_app IS NOT NULL
        AND TRIM(s.active_app) <> ''
        AND p.role = ANY($3::text[])
        AND COALESCE(p.account_status, 'active') = 'active'
        AND (($1 = true AND s.employee_id = $2::uuid) OR ($1 = false))
      GROUP BY s.employee_id, s.active_app
    ),
    app_rank AS (
      SELECT DISTINCT ON (employee_id)
        employee_id,
        active_app AS top_app,
        app_samples,
        employee_app_samples,
        app_activity_pct
      FROM app_counts
      ORDER BY employee_id, app_samples DESC, app_activity_pct DESC
    ),
    activity_summary AS (
      SELECT
        s.employee_id,
        COUNT(*) AS screenshots,
        AVG(s.activity_pct) AS avg_activity_pct,
        COUNT(*) FILTER (WHERE COALESCE(s.activity_pct, 0) <= 20) AS low_activity_samples
      FROM screenshots s
      JOIN public.profiles p ON p.id = s.employee_id
      WHERE s.captured_at >= ${periodStartSql}
        AND s.captured_at < ${periodEndSql}
        AND p.role = ANY($3::text[])
        AND COALESCE(p.account_status, 'active') = 'active'
        AND (($1 = true AND s.employee_id = $2::uuid) OR ($1 = false))
      GROUP BY s.employee_id
    )
    SELECT
      p.id,
      p.full_name AS name,
      p.department_id,
      COALESCE(a.work_minutes, 0) * 60 AS total_seconds,
      COALESCE(a.break_minutes, 0) * 60 AS break_seconds,
      COALESCE(a.days_worked, 0) AS days_worked,
      COALESCE(a.sessions, 0) AS sessions,
      a.first_check_in,
      a.last_activity,
      COALESCE(act.screenshots, 0) AS screenshots,
      CASE WHEN act.avg_activity_pct IS NULL THEN NULL ELSE ROUND(act.avg_activity_pct, 1) END AS avg_activity_pct,
      COALESCE(act.low_activity_samples, 0) AS low_activity_samples,
      app_rank.top_app,
      CASE
        WHEN COALESCE(a.work_minutes, 0) <= 0 OR COALESCE(app_rank.employee_app_samples, 0) <= 0 THEN 0
        ELSE ROUND((COALESCE(a.work_minutes, 0) * 60) * (app_rank.app_samples::numeric / app_rank.employee_app_samples))
      END AS top_app_seconds,
      CASE
        WHEN COALESCE(a.work_minutes, 0) = 0 THEN 'No tracked work'
        WHEN COALESCE(act.screenshots, 0) = 0 THEN 'No screenshot evidence'
        WHEN COALESCE(act.avg_activity_pct, 100) < 35 THEN 'Low activity'
        WHEN COALESCE(act.screenshots, 0) > 0
          AND (COALESCE(act.low_activity_samples, 0)::numeric / NULLIF(act.screenshots, 0)) >= 0.25 THEN 'Frequent idle/low activity'
        ELSE 'Normal'
      END AS review_status
    FROM public.profiles p
    LEFT JOIN attendance_period a ON a.employee_id = p.id
    LEFT JOIN activity_summary act ON act.employee_id = p.id
    LEFT JOIN app_rank ON app_rank.employee_id = p.id
    WHERE p.role = ANY($3::text[])
      AND COALESCE(p.account_status, 'active') = 'active'
      AND (($1 = true AND p.id = $2::uuid) OR ($1 = false))
    ORDER BY COALESCE(a.work_minutes, 0) DESC, p.full_name
    LIMIT 100
  `, [isEmployee, userSub, AGENT_TRACKED_ROLES]);

  const apps = await queryRows(`
    WITH break_summary AS (
      SELECT attendance_id, COALESCE(SUM(COALESCE(duration_minutes, 0)), 0) AS break_minutes
      FROM breaks
      GROUP BY attendance_id
    ),
    employee_work AS (
      SELECT
        a.employee_id,
        COALESCE(SUM(
          GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (LEAST(COALESCE(a.check_out, NOW()), NOW(), ${AUTO_CHECKOUT_SQL}) - a.check_in)) / 60)::int
            - COALESCE(b.break_minutes, 0)
          )
        ), 0) * 60 AS total_seconds
      FROM attendance a
      LEFT JOIN break_summary b ON b.attendance_id = a.id
      JOIN public.profiles p ON p.id = a.employee_id
      WHERE a.check_in >= ${periodStartSql}
        AND a.check_in < ${periodEndSql}
        AND p.role = ANY($3::text[])
        AND COALESCE(p.account_status, 'active') = 'active'
        AND (($1 = true AND a.employee_id = $2::uuid) OR ($1 = false))
      GROUP BY a.employee_id
    ),
    app_counts AS (
      SELECT
        s.active_app AS app,
        s.employee_id,
        p.full_name AS employee_name,
        COUNT(*) AS samples,
        SUM(COUNT(*)) OVER (PARTITION BY s.employee_id) AS employee_app_samples,
        ROUND(AVG(s.activity_pct), 1) AS avg_activity_pct
      FROM screenshots s
      JOIN public.profiles p ON p.id = s.employee_id
      WHERE s.captured_at >= ${periodStartSql}
        AND s.captured_at < ${periodEndSql}
        AND s.active_app IS NOT NULL
        AND TRIM(s.active_app) <> ''
        AND p.role = ANY($3::text[])
        AND COALESCE(p.account_status, 'active') = 'active'
        AND (($1 = true AND s.employee_id = $2::uuid) OR ($1 = false))
      GROUP BY s.active_app, s.employee_id, p.full_name
    )
    SELECT
      app_counts.app,
      app_counts.employee_id,
      app_counts.employee_name,
      CASE
        WHEN COALESCE(employee_work.total_seconds, 0) <= 0 OR COALESCE(app_counts.employee_app_samples, 0) <= 0 THEN 0
        ELSE ROUND(employee_work.total_seconds * (app_counts.samples::numeric / app_counts.employee_app_samples))
      END AS estimated_seconds,
      app_counts.samples,
      app_counts.avg_activity_pct
    FROM app_counts
    LEFT JOIN employee_work ON employee_work.employee_id = app_counts.employee_id
    ORDER BY estimated_seconds DESC, app_counts.avg_activity_pct DESC
    LIMIT 20
  `, [isEmployee, userSub, AGENT_TRACKED_ROLES]);

  const summary = {
    total_seconds: employees.reduce((sum: number, row: any) => sum + Number(row.total_seconds || 0), 0),
    active_users: employees.filter((row: any) => Number(row.total_seconds || 0) > 0).length,
    avg_activity_pct: employees.length
      ? Math.round(
          employees.reduce((sum: number, row: any) => sum + Number(row.avg_activity_pct || 0), 0) /
          Math.max(1, employees.filter((row: any) => row.avg_activity_pct != null).length)
        )
      : 0,
    review_flags: employees.filter((row: any) => row.review_status && row.review_status !== 'Normal').length,
  };

  return {
    period,
    summary,
    employees,
    apps,
    [isWeekly ? 'days' : 'months']: buckets,
  };
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  const { searchParams } = new URL(req.url);
  const type   = searchParams.get('type') || 'daily';
  const requestedDate = searchParams.get('date');
  const startDate = searchParams.get('start_date');
  const endDate = searchParams.get('end_date');
  const mode = searchParams.get('mode');
  const role = normalizeRole(user.role);
  const isEmployee = isAgentTrackedRole(role);
  const isClient = role === 'client';
  const canViewAll = canViewReports(role);
  const date = requestedDate || getWindowDateInTimeZone(new Date(), 16, BUSINESS_TIME_ZONE);

  try {
    if (!isEmployee && !isClient && !canViewAll) {
      return err('Forbidden', 403);
    }

    if (requestedDate && !isValidReportDate(requestedDate)) {
      return err('Invalid date', 400);
    }

    if (type === 'range') {
      if (!isValidReportDate(startDate) || !isValidReportDate(endDate) || !startDate || !endDate || startDate > endDate) {
        return err('Invalid date range', 400);
      }

      const dayList: string[] = [];
      let cursor = startDate;
      while (cursor <= endDate) {
        dayList.push(cursor);
        const [year, month, day] = cursor.split('-').map(Number);
        const next = new Date(Date.UTC(year, month - 1, day + 1));
        cursor = next.toISOString().slice(0, 10);
        if (dayList.length > 31) {
          return err('Date range cannot exceed 31 days', 400);
        }
      }

      const reports = await Promise.all(
        dayList.map((day) => getDailyReportData(day, { userSub: user.sub, isEmployee, isClient })),
      );
      if (mode === 'export') {
        await createExportAccessLog({
          actorUserId: user.sub || null,
          actorName: user.name || null,
          actorEmail: null,
          exportType: 'timeline_range_csv',
          target: 'timeline',
          startDate,
          endDate,
          details: {
            days: dayList.length,
            role,
            scope: isClient ? 'client' : isEmployee ? 'employee' : 'all',
          },
        });
      }
      return ok({ start_date: startDate, end_date: endDate, days: reports });
    }

    // ── DAILY DASHBOARD SUMMARY ──────────────────────────────────────────
    if (type === 'daily') {
      const cacheKey = JSON.stringify({
        type,
        date,
        userSub: user.sub,
        role,
        tz: searchParams.get('tz') || null,
      });
      const cached = getCachedReport(cacheKey);
      if (cached) return ok(cached);
      const data = await getDailyReportData(date, { userSub: user.sub, isEmployee, isClient });
      setCachedReport(cacheKey, data);
      return ok(data);
    }

    // ── WEEKLY SUMMARY ───────────────────────────────────────────────────
    if (type === 'weekly') {
      if (isClient) {
        return ok({ period: 'weekly', summary: { total_seconds: 0, active_users: 0, avg_activity_pct: 0, review_flags: 0 }, employees: [], apps: [], days: [] });
      }
      const cacheKey = JSON.stringify({
        type,
        userSub: user.sub,
        role,
      });
      const cached = getCachedReport(cacheKey);
      if (cached) return ok(cached);
      const data = await getWorkInsightReport('weekly', isEmployee, user.sub);
      setCachedReport(cacheKey, data);
      return ok(data);
    }

    if (type === 'monthly') {
      if (isClient) return ok({ period: 'monthly', summary: { total_seconds: 0, active_users: 0, avg_activity_pct: 0, review_flags: 0 }, employees: [], apps: [], months: [] });
      const cacheKey = JSON.stringify({
        type,
        userSub: user.sub,
        role,
      });
      const cached = getCachedReport(cacheKey);
      if (cached) return ok(cached);
      const data = await getWorkInsightReport('monthly', isEmployee, user.sub);
      setCachedReport(cacheKey, data);
      return ok(data);
    }

    return ok([]);

  } catch (e: any) {
    console.error('GET /api/reports error:', {
      message: e?.message || String(e),
      code: e?.code,
      detail: e?.detail,
      hint: e?.hint,
      where: e?.where,
      constraint: e?.constraint,
      stack: e?.stack,
    });
    return err(e?.message || 'Internal server error', 500);
  }
}
