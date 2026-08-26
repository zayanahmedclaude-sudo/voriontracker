'use client';

import { apiFetch } from '@/lib/api-client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowDownUp, CalendarRange, Download, Filter, Search } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { normalizeRole } from '@/lib/roles';

type ActivityType = 'work' | 'idle' | 'break';

type Segment = {
  type: ActivityType;
  startMinute: number;
  endMinute: number;
  project?: string;
  startedAt?: string;
  endedAt?: string;
};

type LogType = 'attendance' | 'break' | 'app';

type TimelineLog = {
  type: LogType;
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

type TimelineRow = {
  id: string;
  name: string;
  total_seconds: number;
  current_status?: string | null;
  current_app?: string | null;
  department_id?: string | null;
  segments?: Segment[];
  logs?: TimelineLog[];
};
type WeeklyDaySummary = {
  day: string;
  active_users: number;
  total_seconds: number;
  screenshots: number;
};

type MonthlySummary = {
  month: string;
  active_users: number;
  total_seconds: number;
  screenshots: number;
};
type InsightEmployee = {
  id: string;
  name: string;
  total_seconds: number;
  break_seconds: number;
  days_worked: number;
  sessions: number;
  first_check_in?: string | null;
  last_activity?: string | null;
  screenshots: number;
  avg_activity_pct?: number | null;
  low_activity_samples: number;
  top_app?: string | null;
  top_app_seconds: number;
  review_status: string;
};
type InsightApp = {
  app: string;
  employee_id: string;
  employee_name: string;
  estimated_seconds: number;
  samples: number;
  avg_activity_pct?: number | null;
};
type InsightReport = {
  summary?: {
    total_seconds: number;
    active_users: number;
    avg_activity_pct: number;
    review_flags: number;
  };
  employees?: InsightEmployee[];
  apps?: InsightApp[];
  days?: WeeklyDaySummary[];
  months?: MonthlySummary[];
};

type ZoomLevel = 'Hourly' | 'Daily' | 'Weekly' | 'Monthly';
type ZoomConfig = {
  interval: number;
  minWidth: number;
  rowHeight: number;
  labelEvery: number;
};

const WINDOW_START_HOUR = 16;
const WINDOW_END_HOUR = 7;
const DAY_MINUTES = ((24 - WINDOW_START_HOUR) + WINDOW_END_HOUR) * 60;
const TARGET_MINUTES = 9 * 60;
const ZOOM_OPTIONS: ZoomLevel[] = ['Hourly', 'Daily', 'Weekly', 'Monthly'];
const ZOOM_CONFIG: Record<ZoomLevel, ZoomConfig> = {
  Hourly: { interval: 60, minWidth: 1040, rowHeight: 36, labelEvery: 1 },
  Daily: { interval: 120, minWidth: 820, rowHeight: 34, labelEvery: 2 },
  Weekly: { interval: 180, minWidth: 720, rowHeight: 32, labelEvery: 2 },
  Monthly: { interval: 180, minWidth: 720, rowHeight: 32, labelEvery: 2 },
};

const COLORS = {
  panel: '#FFFFFF',
  panelSoft: '#F7F8FB',
  border: 'rgba(10,10,10,.10)',
  text: '#0A0A0A',
  muted: 'rgba(10,10,10,.58)',
  faint: 'rgba(10,10,10,.38)',
};

const ACTIVITY: Record<ActivityType, { label: string; color: string; soft: string }> = {
  work: { label: 'Work', color: '#3B82F6', soft: 'rgba(59,130,246,.16)' },
  idle: { label: 'Idle', color: '#F59E0B', soft: 'rgba(245,158,11,.16)' },
  break: { label: 'Break', color: '#64748B', soft: 'rgba(100,116,139,.22)' },
};

const LOG_META: Record<LogType, { label: string; color: string; soft: string }> = {
  attendance: { label: 'Check-in', color: '#22C55E', soft: 'rgba(34,197,94,.14)' },
  break: { label: 'Break', color: '#94A3B8', soft: 'rgba(148,163,184,.14)' },
  app: { label: 'App', color: '#38BDF8', soft: 'rgba(56,189,248,.14)' },
};

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  working: { label: 'Working', color: '#22C55E', bg: 'rgba(34,197,94,.13)' },
  active: { label: 'Working', color: '#22C55E', bg: 'rgba(34,197,94,.13)' },
  idle: { label: 'Idle', color: '#F59E0B', bg: 'rgba(245,158,11,.14)' },
  on_break: { label: 'Break', color: '#94A3B8', bg: 'rgba(148,163,184,.14)' },
  break: { label: 'Break', color: '#94A3B8', bg: 'rgba(148,163,184,.14)' },
  checked_out: { label: 'Offline', color: '#64748B', bg: 'rgba(100,116,139,.16)' },
  offline: { label: 'Offline', color: '#64748B', bg: 'rgba(100,116,139,.16)' },
};

function fmt(secs: number) {
  if (!secs) return '0h 0m';
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function fmtMinutes(minutes: number) {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  if (!hours) return `${mins}m`;
  if (!mins) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function fmtExactTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function weekDayLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { weekday: 'short' });
}

function shortDateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function monthLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function shiftDate(value: string, amount: number) {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  const next = new Date(Date.UTC(year, month - 1, day + amount));
  return next.toISOString().slice(0, 10);
}

function labelAtMinute(minute: number) {
  const hour24 = (WINDOW_START_HOUR + Math.floor(minute / 60)) % 24;
  const hour12 = hour24 % 12 || 12;
  return `${hour12}${hour24 >= 12 ? 'PM' : 'AM'}`;
}

function timeAtMinute(minute: number) {
  const bounded = Math.max(0, Math.min(DAY_MINUTES, minute));
  const hour24 = (WINDOW_START_HOUR + Math.floor(bounded / 60)) % 24;
  const mins = bounded % 60;
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(mins).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
}

function compactTimeAtMinute(minute: number) {
  const bounded = Math.max(0, Math.min(DAY_MINUTES, minute));
  const hour24 = (WINDOW_START_HOUR + Math.floor(bounded / 60)) % 24;
  const mins = bounded % 60;
  const hour12 = hour24 % 12 || 12;
  return `${hour12}${mins ? `:${String(mins).padStart(2, '0')}` : ''}${hour24 >= 12 ? 'PM' : 'AM'}`;
}

function formatScaleLabel(minute: number, zoomLevel: ZoomLevel) {
  if (minute === DAY_MINUTES) return '7AM';
  if (zoomLevel === 'Hourly') return labelAtMinute(minute);
  return compactTimeAtMinute(minute);
}

function shouldShowScaleLabel(index: number, minute: number, marks: number[], zoomConfig: ZoomConfig) {
  return index === 0 || minute === DAY_MINUTES || index % zoomConfig.labelEvery === 0 || index === marks.length - 1;
}

function statusMeta(status?: string | null) {
  return STATUS_META[String(status || 'offline').toLowerCase()] || STATUS_META.offline;
}

function normalizeStatus(status?: string | null) {
  const value = String(status || '').toLowerCase();
  if (value === 'active') return 'working';
  if (value === 'break') return 'on_break';
  if (value === 'checkout' || value === 'check_out') return 'checked_out';
  return value || 'offline';
}

function currentMinuteInWindow() {
  const now = new Date();
  const minutesFromMidnight = now.getHours() * 60 + now.getMinutes();
  const start = WINDOW_START_HOUR * 60;
  const end = WINDOW_END_HOUR * 60;

  if (minutesFromMidnight >= start) return minutesFromMidnight - start;
  if (minutesFromMidnight <= end) return (24 * 60 - start) + minutesFromMidnight;
  return -1;
}

function buildSegments(row: TimelineRow): Segment[] {
  if (Array.isArray(row.segments)) return row.segments;
  return [];
}

function summarize(segments: Segment[], type: ActivityType) {
  return segments
    .filter((segment) => segment.type === type)
    .reduce((sum, segment) => sum + segment.endMinute - segment.startMinute, 0);
}

function isIdleLog(log: TimelineLog) {
  return log.type === 'app' && log.activityPct != null && log.activityPct <= 0;
}

function sumLogMinutes(logs: TimelineLog[], predicate: (log: TimelineLog) => boolean) {
  return logs
    .filter(predicate)
    .reduce((sum, log) => sum + Math.max(0, Number(log.durationMinutes) || log.endMinute - log.startMinute), 0);
}

function getActivityMinutes(row: { workMinutes: number; idleMinutes: number; breakMinutes: number }, type: ActivityType) {
  if (type === 'work') return row.workMinutes;
  if (type === 'idle') return row.idleMinutes;
  return row.breakMinutes;
}

function clampHourPage(page: number) {
  return Math.max(0, Math.min(Math.floor(DAY_MINUTES / 60) - 1, page));
}

function getPercentLabel(workMinutes: number) {
  const percent = Math.round((workMinutes / TARGET_MINUTES) * 100);
  return `${percent}% of 9h work target`;
}

function buildDisplaySegments(segments: Segment[], logs: TimelineLog[]) {
  const displaySegments = [...segments];
  if (summarize(displaySegments, 'idle') === 0) {
    displaySegments.push(...logs.filter(isIdleLog).map((log) => ({
      type: 'idle' as const,
      startMinute: log.startMinute,
      endMinute: log.endMinute,
      project: log.app || log.label || 'Idle',
      startedAt: log.startAt,
      endedAt: log.endAt,
    })));
  }
  if (summarize(displaySegments, 'break') === 0) {
    displaySegments.push(...logs.filter((log) => log.type === 'break').map((log) => ({
      type: 'break' as const,
      startMinute: log.startMinute,
      endMinute: log.endMinute,
      project: log.label || 'Break',
      startedAt: log.startAt,
      endedAt: log.endAt,
    })));
  }
  return displaySegments
    .filter((segment) => segment.endMinute > segment.startMinute)
    .sort((a, b) => a.startMinute - b.startMinute || (a.type === 'work' ? -1 : 1));
}

function fallbackLogs(row: TimelineRow & { segments: Segment[] }): TimelineLog[] {
  return row.segments.map((item) => ({
    type: item.type === 'break' ? 'break' : 'app',
    label: item.project || ACTIVITY[item.type].label,
    startAt: item.startedAt || '',
    endAt: item.endedAt || '',
    startMinute: item.startMinute,
    endMinute: item.endMinute,
    durationMinutes: item.endMinute - item.startMinute,
    app: item.type === 'work' ? item.project : null,
  }));
}

export default function TimelinePage() {
  const { token, user } = useAuthStore();
  const role = normalizeRole(user?.role);
  const isClient = role === 'client';
  const canExportDateRange = role !== 'employee';
  const clientTimeZone = typeof window === 'undefined'
    ? 'America/New_York'
    : Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reportDate, setReportDate] = useState('');
  const [queryText, setQueryText] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortBy, setSortBy] = useState('most_work');
  const [zoom, setZoom] = useState<ZoomLevel>('Hourly');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nowMinute, setNowMinute] = useState(-1);
  const [hourPage, setHourPage] = useState(0);
  const [weeklyRows, setWeeklyRows] = useState<WeeklyDaySummary[]>([]);
  const [monthlyRows, setMonthlyRows] = useState<MonthlySummary[]>([]);
  const [weeklyReport, setWeeklyReport] = useState<InsightReport | null>(null);
  const [monthlyReport, setMonthlyReport] = useState<InsightReport | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportStartDate, setExportStartDate] = useState('');
  const [exportEndDate, setExportEndDate] = useState('');
  const [exporting, setExporting] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [exportError, setExportError] = useState('');

  useEffect(() => {
    const syncLocalTime = () => setNowMinute(currentMinuteInWindow());
    syncLocalTime();
    const timer = window.setInterval(syncLocalTime, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (zoom !== 'Hourly') return;
    if (nowMinute >= 0) {
      setHourPage(clampHourPage(Math.floor(nowMinute / 60)));
      return;
    }
    setHourPage(0);
  }, [nowMinute, zoom]);

  useEffect(() => {
    if (!token) {
      setRows([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    const params = new URLSearchParams();
    if (isClient) params.set('tz', clientTimeZone);
    const query = params.toString();
    apiFetch<{ date?: string; rows?: TimelineRow[] }>(query ? `/api/reports?${query}` : '/api/reports', {
      headers: { Authorization: `Bearer ${token}` },
      expect: 'json',
      signal: controller.signal,
    })
      .then((d) => {
        if (controller.signal.aborted) return;
        const normalized = (Array.isArray(d?.rows) ? d.rows : []).map((row: any) => ({
          ...row,
          total_seconds: Math.min(DAY_MINUTES * 60, Number(row.total_seconds) || 0),
          current_status: normalizeStatus(row.current_status),
        }));
        setRows(normalized);
        setReportDate(d?.date || '');
        setExportStartDate((current) => current || d?.date || '');
        setExportEndDate((current) => current || d?.date || '');
        setSelectedId((current) => current || normalized[0]?.id || null);
        setLoading(false);
      })
      .catch((error: any) => {
        if (error?.name === 'AbortError') return;
        setRows([]);
        setLoadError(error?.message || 'Unable to load timeline data.');
        setLoading(false);
      });
    return () => controller.abort();
  }, [clientTimeZone, isClient, token]);

  useEffect(() => {
    if (!token) {
      setWeeklyReport(null);
      setWeeklyRows([]);
      return;
    }
    const controller = new AbortController();
    apiFetch<InsightReport>('/api/reports?type=weekly', {
      headers: { Authorization: `Bearer ${token}` },
      expect: 'json',
      signal: controller.signal,
    })
      .then((d: any) => {
        if (controller.signal.aborted) return;
        setWeeklyReport(d && typeof d === 'object' ? d : null);
        setWeeklyRows(Array.isArray(d) ? d : Array.isArray(d?.days) ? d.days : []);
      })
      .catch((error: any) => {
        if (error?.name === 'AbortError') return;
        console.error('Weekly timeline report failed:', error?.message || error);
        setWeeklyReport(null);
        setWeeklyRows([]);
      });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token) {
      setMonthlyReport(null);
      setMonthlyRows([]);
      return;
    }
    const controller = new AbortController();
    apiFetch<InsightReport>('/api/reports?type=monthly', {
      headers: { Authorization: `Bearer ${token}` },
      expect: 'json',
      signal: controller.signal,
    })
      .then((d: any) => {
        if (controller.signal.aborted) return;
        setMonthlyReport(d && typeof d === 'object' ? d : null);
        setMonthlyRows(Array.isArray(d) ? d : Array.isArray(d?.months) ? d.months : []);
      })
      .catch((error: any) => {
        if (error?.name === 'AbortError') return;
        console.error('Monthly timeline summary failed:', error?.message || error);
        setMonthlyReport(null);
        setMonthlyRows([]);
      });
    return () => controller.abort();
  }, [token]);

  const enrichedRows = useMemo(() => rows.map((row) => {
    const baseSegments = buildSegments(row);
    const logs = Array.isArray(row.logs) ? row.logs : [];
    const segments = buildDisplaySegments(baseSegments, logs);
    const totalTrackedMinutes = Math.max(0, Math.round((Number(row.total_seconds) || 0) / 60));
    const breakMinutes = Math.max(summarize(baseSegments, 'break'), sumLogMinutes(logs, (log) => log.type === 'break'));
    const idleMinutes = Math.max(summarize(baseSegments, 'idle'), sumLogMinutes(logs, isIdleLog));
    const fallbackWorkMinutes = summarize(baseSegments, 'work');
    const workMinutes = totalTrackedMinutes > 0
      ? Math.max(0, totalTrackedMinutes - idleMinutes)
      : fallbackWorkMinutes;
    return {
      ...row,
      segments,
      logs,
      workMinutes,
      idleMinutes,
      breakMinutes,
      totalMinutes: workMinutes + idleMinutes + breakMinutes,
      percent: Math.round((workMinutes / TARGET_MINUTES) * 100),
      percentLabel: getPercentLabel(workMinutes),
    };
  }), [rows]);

  const zoomConfig = ZOOM_CONFIG[zoom];
  const scaleMarks = useMemo(() => {
    const marks = [];
    for (let minute = 0; minute <= DAY_MINUTES; minute += zoomConfig.interval) {
      marks.push(minute);
    }
    if (marks[marks.length - 1] !== DAY_MINUTES) marks.push(DAY_MINUTES);
    return marks;
  }, [zoomConfig.interval]);
  const visibleRange = useMemo(() => {
    if (zoom !== 'Hourly') return { start: 0, end: DAY_MINUTES };
    const start = hourPage * 60;
    return { start, end: Math.min(DAY_MINUTES, start + 60) };
  }, [hourPage, zoom]);

  const visibleMarks = useMemo(
    () => scaleMarks.filter((minute) => minute >= visibleRange.start && minute <= visibleRange.end),
    [scaleMarks, visibleRange.end, visibleRange.start],
  );

  const filteredRows = useMemo(() => {
    const query = queryText.trim().toLowerCase();
    return enrichedRows
      .filter((row) => !query || row.name.toLowerCase().includes(query))
      .filter((row) => statusFilter === 'all' || normalizeStatus(row.current_status) === statusFilter)
      .sort((a, b) => {
        if (sortBy === 'least_work') return a.workMinutes - b.workMinutes;
        if (sortBy === 'most_idle') return b.idleMinutes - a.idleMinutes;
        if (sortBy === 'alphabetical') return a.name.localeCompare(b.name);
        if (sortBy === 'status') return String(a.current_status).localeCompare(String(b.current_status));
        return b.workMinutes - a.workMinutes;
      });
  }, [enrichedRows, queryText, sortBy, statusFilter]);

  const selected = filteredRows.find((row) => row.id === selectedId) || filteredRows[0] || null;
  const selectedLogs = selected ? (selected.logs.length ? selected.logs : fallbackLogs(selected)) : [];
  const weeklyTotalSeconds = weeklyRows.reduce((sum, row) => sum + Number(row.total_seconds || 0), 0);
  const monthlyTotalSeconds = monthlyRows.reduce((sum, row) => sum + Number(row.total_seconds || 0), 0);
  const insightReport = zoom === 'Weekly' ? weeklyReport : monthlyReport;
  const insightBuckets = zoom === 'Weekly' ? weeklyRows : monthlyRows;
  const insightSummary = insightReport?.summary;
  const insightEmployees = insightReport?.employees || [];
  const insightApps = insightReport?.apps || [];

  function toVisiblePosition(minute: number) {
    const width = Math.max(1, visibleRange.end - visibleRange.start);
    return ((minute - visibleRange.start) / width) * 100;
  }

  function clipSegmentToVisibleRange(startMinute: number, endMinute: number) {
    const clippedStart = Math.max(startMinute, visibleRange.start);
    const clippedEnd = Math.min(endMinute, visibleRange.end);
    if (clippedEnd <= clippedStart) return null;
    return { start: clippedStart, end: clippedEnd };
  }

  function exportVisibleRows() {
    if (token) {
      void apiFetch<Response>('/api/export-access-logs', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          exportType: 'timeline_daily_csv',
          target: 'timeline',
          startDate: reportDate || null,
          endDate: reportDate || null,
          details: {
            zoom,
            rowCount: filteredRows.length,
          },
        }),
      }).catch(() => undefined);
    }
    const headers = ['Employee', 'Status', 'Total', 'Target %', 'Work', 'Idle', 'Break'];
    const values = filteredRows.map((row) => [
      row.name,
      statusMeta(row.current_status).label,
      fmt(row.total_seconds),
      `${row.percent}%`,
      fmtMinutes(row.workMinutes),
      fmtMinutes(row.idleMinutes),
      fmtMinutes(row.breakMinutes),
    ]);
    const escapeCsv = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const csv = [headers, ...values].map((line) => line.map(escapeCsv).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `employee-timeline-${reportDate || 'daily'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function exportDateRange() {
    if (!token || !exportStartDate || !exportEndDate || exportStartDate > exportEndDate) return;
    setExporting(true);
    setExportError('');
    try {
      const params = new URLSearchParams({
        type: 'range',
        mode: 'export',
        start_date: exportStartDate,
        end_date: exportEndDate,
      });
      if (isClient) params.set('tz', clientTimeZone);
      const data = await apiFetch<{ days?: Array<{ date?: string; rows?: any[] }> }>(`/api/reports?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        expect: 'json',
      });
      const reports = Array.isArray(data?.days) ? data.days : [];
      const rowsForCsv: Array<Array<string | number>> = [];

      for (const report of reports) {
        const date = String(report?.date || '');
        const dayRows = Array.isArray(report?.rows) ? report.rows : [];
        for (const row of dayRows) {
          const normalizedStatus = normalizeStatus(row.current_status);
          const totalSeconds = Math.min(DAY_MINUTES * 60, Number(row.total_seconds) || 0);
          const baseSegments = buildSegments({ ...row, total_seconds: totalSeconds });
          const logs = Array.isArray(row.logs) ? row.logs : [];
          const breakMinutes = Math.max(summarize(baseSegments, 'break'), sumLogMinutes(logs, (log) => log.type === 'break'));
          const idleMinutes = Math.max(summarize(baseSegments, 'idle'), sumLogMinutes(logs, isIdleLog));
          const workMinutes = Math.max(0, Math.round(totalSeconds / 60) - idleMinutes);
          const percent = Math.round((workMinutes / TARGET_MINUTES) * 100);
          rowsForCsv.push([
            date,
            row.name,
            statusMeta(normalizedStatus).label,
            fmt(totalSeconds),
            `${percent}%`,
            fmtMinutes(workMinutes),
            fmtMinutes(idleMinutes),
            fmtMinutes(breakMinutes),
          ]);
        }
      }

      const headers = ['Date', 'Employee', 'Status', 'Total', 'Target %', 'Work', 'Idle', 'Break'];
      const escapeCsv = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
      const csv = [headers, ...rowsForCsv].map((line) => line.map(escapeCsv).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `employee-timeline-${exportStartDate}-to-${exportEndDate}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      setExportOpen(false);
    } catch (error: any) {
      setExportError(error?.message || 'Unable to export timeline CSV.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="timelineTop">
        <div>
          <h1 className="title">{isClient ? 'Assigned VA Timeline' : 'Employee Timeline'}</h1>
          <div className="subTitle">
            {zoom === 'Hourly'
              ? `Hourly view: one hour at a time within the 4:00 PM to 7:00 AM window${reportDate ? `, ${reportDate}` : ''}`
              : zoom === 'Daily'
                ? `Daily view: full 4:00 PM to 7:00 AM window${reportDate ? `, ${reportDate}` : ''}`
                : zoom === 'Weekly'
                  ? 'Weekly summary for the current week'
                  : 'Monthly summary for the last 6 months'}
          </div>
        </div>
        <div className="topRight">
          <div className="chartLegend" aria-label="Activity legend">
            {(Object.keys(ACTIVITY) as ActivityType[]).map((key) => (
              <div key={key} className="legendChip">
                <span className={`legendSwatch legendSwatch_${key}`} style={{ background: ACTIVITY[key].color }} />
                {ACTIVITY[key].label}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbarGroup toolbarGroupControls">
          <label className="searchBox">
            <Search size={16} />
            <input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="Search employee" />
          </label>
          <label className="selectWrap">
            <Filter size={15} />
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">All statuses</option>
              <option value="working">Working</option>
              <option value="idle">Idle</option>
              <option value="on_break">Break</option>
              <option value="offline">Offline</option>
            </select>
          </label>
          <label className="selectWrap sortWrap">
            <ArrowDownUp size={15} />
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value)} aria-label="Sort timeline rows">
              <option value="most_work">Most working time</option>
              <option value="least_work">Least working time</option>
              <option value="most_idle">Most idle time</option>
              <option value="alphabetical">Alphabetical</option>
              <option value="status">Current status</option>
            </select>
          </label>
        </div>
        <div className="toolbarGroup toolbarGroupZoom">
          <div className="groupLabel">View</div>
          <div className="zoom segmentedControl" aria-label="Zoom level">
            {ZOOM_OPTIONS.map((option) => (
              <button key={option} className={zoom === option ? 'zoomActive' : ''} onClick={() => setZoom(option)} type="button">
                {option}
              </button>
            ))}
          </div>
        </div>
        <div className="toolbarGroup toolbarGroupActions">
          <button className="iconButton" type="button" title="Download visible timeline CSV" aria-label="Download visible timeline CSV" onClick={exportVisibleRows}>
            <Download size={16} />
          </button>
          {canExportDateRange && (
            <button className={`iconButton ${exportOpen ? 'activeLegend' : ''}`} type="button" title="Export date range" aria-label="Export date range" onClick={() => setExportOpen((open) => !open)}>
              <CalendarRange size={16} />
            </button>
          )}
        </div>
      </div>

      {canExportDateRange && exportOpen && (
        <div className="exportPanel">
          <div className="exportField">
            <span>From</span>
            <input type="date" value={exportStartDate} max={exportEndDate || undefined} onChange={(event) => setExportStartDate(event.target.value)} />
          </div>
          <div className="exportField">
            <span>To</span>
            <input type="date" value={exportEndDate} min={exportStartDate || undefined} onChange={(event) => setExportEndDate(event.target.value)} />
          </div>
          <div className="exportActions">
            <small>{exportError || 'Exports daily activity rows for each selected date.'}</small>
            <button
              type="button"
              className="pagerButton"
              disabled={!exportStartDate || !exportEndDate || exportStartDate > exportEndDate || exporting}
              onClick={exportDateRange}
            >
              {exporting ? 'Preparing...' : 'Download CSV'}
            </button>
          </div>
        </div>
      )}

      {zoom === 'Hourly' && (
        <div className="pageToolbar">
          <div>
            <strong>Current hour</strong>
            <span>{timeAtMinute(visibleRange.start)} - {timeAtMinute(visibleRange.end)}</span>
          </div>
          <div className="pageControls">
            <button type="button" className="pagerButton" onClick={() => setHourPage((page) => clampHourPage(page - 1))} disabled={hourPage === 0}>
              Previous hour
            </button>
            <small>Hour {hourPage + 1} of {Math.floor(DAY_MINUTES / 60)}</small>
            <button
              type="button"
              className="pagerButton"
              onClick={() => setHourPage((page) => clampHourPage(page + 1))}
              disabled={hourPage >= Math.floor(DAY_MINUTES / 60) - 1}
            >
              Next hour
            </button>
          </div>
        </div>
      )}

      {zoom === 'Weekly' || zoom === 'Monthly' ? (
        <div className="insightBoard">
          <div className="weeklySummary">
            <div>
              <span>Employee work time</span>
              <strong>{fmt(insightSummary?.total_seconds || (zoom === 'Weekly' ? weeklyTotalSeconds : monthlyTotalSeconds))}</strong>
            </div>
            <div>
              <span>Average activity</span>
              <strong>{insightSummary?.avg_activity_pct || 0}%</strong>
            </div>
            <div>
              <span>Needs review</span>
              <strong>{insightSummary?.review_flags || 0}</strong>
            </div>
          </div>

          <div className="insightLayout">
            <div className="insightPanel">
              <div className="insightHeader">
                <div>
                  <strong>Employee activity</strong>
                  <span>Work evidence by person, app, activity, and review status.</span>
                </div>
              </div>
              {insightEmployees.length > 0 ? (
                <div className="insightTableWrap">
                  <table className="insightTable">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Worked</th>
                        <th>Days</th>
                        <th>Activity</th>
                        <th>Most used app</th>
                        <th>Review</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insightEmployees.map((employee) => (
                        <tr key={employee.id}>
                          <td>
                            <strong>{employee.name}</strong>
                            <span>{fmtExactTime(employee.first_check_in)} - {fmtExactTime(employee.last_activity)}</span>
                          </td>
                          <td>{fmt(employee.total_seconds)}</td>
                          <td>{employee.days_worked || 0}</td>
                          <td>{employee.avg_activity_pct == null ? '-' : `${employee.avg_activity_pct}%`}</td>
                          <td>
                            <strong>{employee.top_app || 'No app data'}</strong>
                            <span>{employee.top_app ? fmt(employee.top_app_seconds) : 'No samples'}</span>
                          </td>
                          <td><span className={`reviewPill ${employee.review_status === 'Normal' ? 'ok' : 'warn'}`}>{employee.review_status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="weeklyEmpty">No employee activity found for this {zoom.toLowerCase()} view.</div>
              )}
            </div>

            <div className="insightPanel">
              <div className="insightHeader">
                <div>
                  <strong>Most used apps</strong>
                  <span>Estimated from captured foreground app samples.</span>
                </div>
              </div>
              <div className="appList">
                {insightApps.length > 0 ? insightApps.slice(0, 10).map((item) => (
                  <div key={`${item.employee_id}-${item.app}`} className="appUsageRow">
                    <div>
                      <strong>{item.app}</strong>
                      <span>{item.employee_name}</span>
                    </div>
                    <div>
                      <b>{fmt(item.estimated_seconds)}</b>
                      <span>{item.avg_activity_pct == null ? '-' : `${item.avg_activity_pct}% activity`}</span>
                    </div>
                  </div>
                )) : (
                  <div className="weeklyEmpty">No app usage recorded.</div>
                )}
              </div>
            </div>
          </div>

          <div className="periodStrip">
            {insightBuckets.length > 0 ? insightBuckets.map((item: any) => (
              <div key={item.day || item.month} className="periodBucket">
                <div className="weeklyCardHead">
                  <strong>{zoom === 'Weekly' ? weekDayLabel(item.day) : monthLabel(item.month)}</strong>
                  <span>{shortDateLabel(item.day || item.month)}</span>
                </div>
                <div className="weeklyMetric">
                  <label>Tracked</label>
                  <b>{fmt(item.total_seconds)}</b>
                </div>
                <div className="weeklyMetric">
                  <label>Active users</label>
                  <b>{item.active_users}</b>
                </div>
              </div>
            )) : (
              <div className="weeklyEmpty">No period trend available.</div>
            )}
          </div>
        </div>
      ) : (

      <div className="timelineCard">
        <div className="timelineMetaBar">
          <div>
            <strong>Comparison view</strong>
            <span>Sort rows to compare quickly before scanning the full timeline.</span>
          </div>
          <div>
            <strong>Metric</strong>
            <span>Percent values reflect tracked work against the 4PM-7AM, 9 hour target window.</span>
          </div>
        </div>
        <div className="timeHeader" style={{ minWidth: zoomConfig.minWidth }}>
          <div className="nameSpacer" />
          <div className="scale">
            {visibleMarks.map((minute, index) => (
              <div key={minute} className="hourMark" style={{ left: `${toVisiblePosition(minute)}%` }}>
                {shouldShowScaleLabel(index, minute, visibleMarks, zoomConfig) ? (
                  <span>{formatScaleLabel(minute, zoom)}</span>
                ) : null}
              </div>
            ))}
            {TARGET_MINUTES >= visibleRange.start && TARGET_MINUTES <= visibleRange.end && (
              <div className="targetLine" style={{ left: `${toVisiblePosition(TARGET_MINUTES)}%` }} title="Expected 9 hour target" />
            )}
            {nowMinute >= visibleRange.start && nowMinute <= visibleRange.end && (
              <div className="nowMarkerWrap" style={{ left: `${toVisiblePosition(nowMinute)}%` }}>
                <span className="nowTag">Now</span>
                <div className="nowLine" title={`Current local time: ${timeAtMinute(nowMinute)}`} />
              </div>
            )}
          </div>
          <div className="totalSpacer" />
        </div>

        {loading ? (
          <div className="empty">Loading...</div>
        ) : loadError ? (
          <div className="empty">{loadError}</div>
        ) : filteredRows.length === 0 ? (
          <div className="empty">No data available</div>
        ) : (
          <div className="rows" style={{ minWidth: zoomConfig.minWidth }}>
            {filteredRows.map((row) => (
              <div key={row.id} className={`row ${selected?.id === row.id ? 'selectedRow' : ''}`} onClick={() => setSelectedId(row.id)}>
                <div className="employeeCell">
                  <div className="employeeName">{row.name}</div>
                  <StatusBadge status={row.current_status} />
                </div>
                <div className="barWrap" style={{ height: zoomConfig.rowHeight }}>
                  <div className="gridLines">
                    {visibleMarks.slice(0, -1).map((minute) => (
                      <span key={minute} style={{ left: `${toVisiblePosition(minute)}%` }} />
                    ))}
                  </div>
                  {TARGET_MINUTES >= visibleRange.start && TARGET_MINUTES <= visibleRange.end && (
                    <div className="targetLine rowMarker" style={{ left: `${toVisiblePosition(TARGET_MINUTES)}%` }} />
                  )}
                  {nowMinute >= visibleRange.start && nowMinute <= visibleRange.end && (
                    <div className="nowLine rowMarker" style={{ left: `${toVisiblePosition(nowMinute)}%` }} title={`Current local time: ${timeAtMinute(nowMinute)}`} />
                  )}
                  {row.segments.length > 0 ? (
                    row.segments.map((item, index) => {
                      const clipped = clipSegmentToVisibleRange(item.startMinute, item.endMinute);
                      if (!clipped) return null;
                      const meta = ACTIVITY[item.type];
                      const left = toVisiblePosition(clipped.start);
                      const width = Math.max(toVisiblePosition(clipped.end) - left, item.type === 'idle' ? 8 : 4);
                      const isMicro = item.type === 'idle' && item.endMinute - item.startMinute <= 6;
                      return (
                        <div
                          key={`${row.id}-${index}`}
                          className={`segment segment_${item.type} ${isMicro ? 'segmentMicro' : ''}`}
                          style={{
                            left: `${left}%`,
                            width: `${width}%`,
                            background: meta.color,
                          }}
                          title={`${meta.label}\n${timeAtMinute(item.startMinute)} - ${timeAtMinute(item.endMinute)}\nDuration: ${fmtMinutes(item.endMinute - item.startMinute)}\nProject: ${item.project || 'General'}`}
                        />
                      );
                    })
                  ) : (
                    <div className="noActivity">No activity</div>
                  )}
                </div>
                <div className="totalCell">
                  <strong>{fmt(row.total_seconds)}</strong>
                  <span title={row.percentLabel}>{row.percentLabel}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {(zoom === 'Hourly' || zoom === 'Daily') && selected && (
        <div className="details">
          <div className="detailPanel">
            <div className="detailHeader">
              <div>
                <h2>{selected.name}</h2>
                <StatusBadge status={selected.current_status} />
              </div>
              <div className="detailTotal">{fmt(selected.total_seconds)} <span>{selected.percentLabel}</span></div>
            </div>
            <div className="detailStats">
              {(Object.keys(ACTIVITY) as ActivityType[]).map((type) => (
                <div key={type} style={{ borderColor: ACTIVITY[type].soft } as CSSProperties}>
                  <span style={{ color: ACTIVITY[type].color }}>{ACTIVITY[type].label}</span>
                  <strong>{fmtMinutes(getActivityMinutes(selected, type))}</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="logsPanel">
            <div className="logsHeader">
              <span>Logs</span>
              <small>{selectedLogs.length} entries</small>
            </div>
            <div className="logsList">
              {selectedLogs.length > 0 ? selectedLogs.map((item, index) => {
                const meta = LOG_META[item.type] || LOG_META.app;
                const title = item.type === 'app' ? (item.app || item.label || 'Application') : item.label;
                const detail = item.type === 'app'
                  ? [
                      item.activityPct == null ? null : `${item.activityPct}% activity`,
                      item.activityPct != null && item.activityPct <= 0 ? 'No mouse or keyboard activity' : item.detail,
                    ].filter(Boolean).join(' - ')
                  : item.detail;
                return (
                  <div key={`${selected.id}-log-${index}`} className="logItem" style={{ borderColor: meta.soft } as CSSProperties}>
                    <span className="logDot" style={{ background: meta.color }} />
                    <div className="logBody">
                      <div className="logTitle">
                        <strong>{title}</strong>
                        <em style={{ color: meta.color }}>{meta.label}</em>
                      </div>
                      <p>{fmtExactTime(item.startAt)} - {fmtExactTime(item.endAt)}</p>
                      <small>{fmtMinutes(item.durationMinutes)}{detail ? ` - ${detail}` : ''}</small>
                    </div>
                  </div>
                );
              }) : (
                <div className="emptyLogs">No logs recorded for this timeline window.</div>
              )}
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .timelineTop {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 18px;
          margin-bottom: 18px;
          flex-wrap: wrap;
        }
        .topRight {
          display: grid;
          gap: 10px;
          justify-items: end;
        }
        .title {
          margin: 0;
          color: ${COLORS.text};
          font-size: 34px;
          font-weight: 800;
          letter-spacing: 0;
        }
        .subTitle {
          margin-top: 6px;
          color: ${COLORS.muted};
          font-size: 14px;
          font-weight: 600;
        }
        .legend, .toolbar, .zoom {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .chartLegend {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .legendChip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          border-radius: 999px;
          background: ${COLORS.panelSoft};
          color: ${COLORS.text};
          font-size: 12px;
          font-weight: 700;
        }
        .legendSwatch {
          width: 14px;
          height: 14px;
          border-radius: 4px;
          border: 1px solid rgba(10,10,10,.14);
        }
        .legendSwatch_idle, .segment_idle {
          background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.34) 0px, rgba(255,255,255,.34) 3px, rgba(255,255,255,0) 3px, rgba(255,255,255,0) 6px);
        }
        .legendSwatch_break, .segment_break {
          background-image: repeating-linear-gradient(90deg, rgba(255,255,255,.28) 0px, rgba(255,255,255,.28) 2px, rgba(255,255,255,0) 2px, rgba(255,255,255,0) 5px);
        }
        .legendButton, .zoom button, .iconButton {
          border: 1px solid ${COLORS.border};
          background: ${COLORS.panel};
          color: ${COLORS.text};
          border-radius: 8px;
          min-height: 34px;
          padding: 0 12px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }
        .legendButton span {
          width: 10px;
          height: 10px;
          border-radius: 3px;
        }
        .activeLegend, .zoom .zoomActive {
          background: rgba(0,80,176,.08);
          border-color: rgba(0,80,176,.24);
          color: #0050B0;
        }
        .toolbar {
          margin-bottom: 16px;
          background: ${COLORS.panel};
          border: 1px solid ${COLORS.border};
          border-radius: 12px;
          padding: 12px;
          box-shadow: 0 18px 48px rgba(15,23,42,.06);
          justify-content: space-between;
        }
        .toolbarGroup {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .toolbarGroupZoom {
          flex: 1;
          justify-content: center;
        }
        .toolbarGroupActions {
          justify-content: flex-end;
        }
        .groupLabel {
          color: ${COLORS.muted};
          font-size: 12px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: .06em;
        }
        .segmentedControl {
          gap: 0;
          padding: 4px;
          border: 1px solid ${COLORS.border};
          border-radius: 999px;
          background: ${COLORS.panelSoft};
        }
        .segmentedControl button {
          border: 0;
          border-radius: 999px;
          min-height: 32px;
          padding: 0 12px;
          background: transparent;
        }
        .toolbarGroupControls .searchBox {
          min-width: 220px;
        }
        .pageToolbar {
          margin: 0 0 14px;
          padding: 12px 14px;
          border: 1px solid ${COLORS.border};
          border-radius: 10px;
          background: ${COLORS.panel};
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          flex-wrap: wrap;
          box-shadow: 0 18px 48px rgba(15,23,42,.06);
        }
        .exportPanel {
          margin: 0 0 14px;
          padding: 14px;
          border: 1px solid ${COLORS.border};
          border-radius: 10px;
          background: ${COLORS.panel};
          display: flex;
          align-items: end;
          gap: 14px;
          flex-wrap: wrap;
          box-shadow: 0 18px 48px rgba(15,23,42,.06);
        }
        .exportField {
          display: grid;
          gap: 6px;
        }
        .exportField span, .exportActions small {
          color: ${COLORS.muted};
          font-size: 12px;
          font-weight: 700;
        }
        .exportField input {
          min-height: 38px;
          border-radius: 8px;
          border: 1px solid ${COLORS.border};
          background: ${COLORS.panel};
          color: ${COLORS.text};
          padding: 0 12px;
        }
        .exportActions {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-left: auto;
          flex-wrap: wrap;
        }
        .pageToolbar strong, .pageToolbar small {
          color: ${COLORS.text};
        }
        .pageToolbar span {
          display: block;
          margin-top: 4px;
          color: ${COLORS.muted};
          font-size: 12px;
          font-weight: 700;
        }
        .pageControls {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .pagerButton {
          border: 1px solid ${COLORS.border};
          background: ${COLORS.panel};
          color: ${COLORS.text};
          border-radius: 8px;
          min-height: 34px;
          padding: 0 12px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }
        .pagerButton:disabled {
          opacity: .45;
          cursor: not-allowed;
        }
        .searchBox, .selectWrap {
          min-height: 38px;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 12px;
          border-radius: 8px;
          border: 1px solid ${COLORS.border};
          background: ${COLORS.panel};
          color: ${COLORS.muted};
        }
        .searchBox input, .selectWrap select, .select {
          border: 0;
          outline: 0;
          background: transparent;
          color: ${COLORS.text};
          font-size: 14px;
          min-height: 36px;
        }
        .searchBox input::placeholder {
          color: ${COLORS.faint};
        }
        .select {
          border: 1px solid ${COLORS.border};
          border-radius: 8px;
          background: ${COLORS.panel};
          padding: 0 12px;
        }
        .sortWrap select {
          min-width: 170px;
        }
        .timelineCard, .detailPanel, .logsPanel {
          background: ${COLORS.panel};
          border: 1px solid ${COLORS.border};
          border-radius: 8px;
          box-shadow: 0 18px 48px rgba(15,23,42,.06);
        }
        .timelineCard {
          overflow: auto;
        }
        .timelineMetaBar {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
          padding: 14px 18px 0;
        }
        .timelineMetaBar div {
          display: grid;
          gap: 4px;
        }
        .timelineMetaBar strong {
          color: ${COLORS.text};
          font-size: 12px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: .06em;
        }
        .timelineMetaBar span {
          color: ${COLORS.muted};
          font-size: 13px;
          font-weight: 600;
        }
        .weeklyBoard {
          display: grid;
          gap: 16px;
        }
        .insightBoard {
          display: grid;
          gap: 16px;
        }
        .weeklySummary {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }
        .weeklySummary div, .weeklyCardDay {
          background: ${COLORS.panel};
          border: 1px solid ${COLORS.border};
          border-radius: 10px;
          box-shadow: 0 18px 48px rgba(15,23,42,.06);
        }
        .weeklySummary div {
          padding: 16px;
        }
        .weeklySummary span, .weeklyMetric label, .weeklyCardHead span {
          color: ${COLORS.muted};
          font-size: 12px;
          font-weight: 700;
        }
        .weeklySummary strong {
          display: block;
          margin-top: 8px;
          color: ${COLORS.text};
          font-size: 24px;
          font-weight: 900;
        }
        .weeklyGrid {
          display: grid;
          grid-template-columns: repeat(7, minmax(0, 1fr));
          gap: 12px;
        }
        .weeklyEmpty {
          grid-column: 1 / -1;
          padding: 24px;
          text-align: center;
          color: ${COLORS.muted};
          background: ${COLORS.panel};
          border: 1px solid ${COLORS.border};
          border-radius: 10px;
        }
        .weeklyCardDay {
          padding: 16px;
        }
        .periodStrip {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 12px;
        }
        .periodBucket {
          padding: 14px;
          background: ${COLORS.panel};
          border: 1px solid ${COLORS.border};
          border-radius: 10px;
          box-shadow: 0 18px 48px rgba(15,23,42,.06);
        }
        .insightLayout {
          display: grid;
          grid-template-columns: minmax(0, 1.7fr) minmax(320px, .9fr);
          gap: 16px;
          align-items: start;
        }
        .insightPanel {
          background: ${COLORS.panel};
          border: 1px solid ${COLORS.border};
          border-radius: 10px;
          box-shadow: 0 18px 48px rgba(15,23,42,.06);
          overflow: hidden;
        }
        .insightHeader {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 16px;
          border-bottom: 1px solid rgba(10,10,10,.08);
        }
        .insightHeader div {
          display: grid;
          gap: 4px;
        }
        .insightHeader strong {
          color: ${COLORS.text};
          font-size: 13px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: .06em;
        }
        .insightHeader span, .insightTable td span, .appUsageRow span {
          color: ${COLORS.muted};
          font-size: 12px;
          font-weight: 600;
        }
        .insightTableWrap {
          overflow-x: auto;
        }
        .insightTable {
          width: 100%;
          min-width: 760px;
          border-collapse: collapse;
        }
        .insightTable th {
          text-align: left;
          color: ${COLORS.muted};
          font-size: 11px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: .06em;
          padding: 12px 16px;
          background: ${COLORS.panelSoft};
        }
        .insightTable td {
          padding: 13px 16px;
          border-top: 1px solid rgba(10,10,10,.06);
          color: ${COLORS.text};
          font-size: 13px;
          font-weight: 800;
          vertical-align: top;
        }
        .insightTable td:first-child, .insightTable td:nth-child(5) {
          display: grid;
          gap: 4px;
        }
        .reviewPill {
          display: inline-flex;
          align-items: center;
          width: fit-content;
          padding: 5px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 900;
        }
        .reviewPill.ok {
          color: #166534;
          background: rgba(34,197,94,.12);
        }
        .reviewPill.warn {
          color: #92400E;
          background: rgba(245,158,11,.16);
        }
        .appList {
          display: grid;
        }
        .appUsageRow {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 13px 16px;
          border-top: 1px solid rgba(10,10,10,.06);
        }
        .appUsageRow:first-child {
          border-top: 0;
        }
        .appUsageRow div {
          display: grid;
          gap: 4px;
          min-width: 0;
        }
        .appUsageRow div:last-child {
          text-align: right;
        }
        .appUsageRow strong, .appUsageRow b {
          color: ${COLORS.text};
          font-size: 13px;
        }
        .weeklyCardHead {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: 14px;
        }
        .weeklyCardHead strong, .weeklyMetric b {
          color: ${COLORS.text};
        }
        .weeklyMetric {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          padding-top: 10px;
          margin-top: 10px;
          border-top: 1px solid rgba(245,247,250,.08);
        }
        .timeHeader {
          position: sticky;
          top: 0;
          z-index: 4;
          min-width: 1040px;
          display: grid;
          grid-template-columns: 190px minmax(700px, 1fr) 86px;
          gap: 18px;
          padding: 18px 18px 8px;
          background: rgba(255,255,255,.96);
          border-bottom: 1px solid ${COLORS.border};
        }
        .scale {
          position: relative;
          height: 42px;
        }
        .hourMark {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 1px;
          background: rgba(10,10,10,.08);
        }
        .hourMark span {
          position: absolute;
          top: 0;
          left: 6px;
          color: ${COLORS.faint};
          font-size: 11px;
          font-weight: 800;
          white-space: nowrap;
          background: linear-gradient(90deg, rgba(255,255,255,.96) 0%, rgba(255,255,255,.9) 72%, rgba(255,255,255,0) 100%);
          padding-right: 8px;
        }
        .targetLine, .nowLine {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 2px;
          pointer-events: none;
        }
        .nowMarkerWrap {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 0;
          pointer-events: none;
        }
        .nowTag {
          position: absolute;
          top: 0;
          left: 8px;
          padding: 3px 7px;
          border-radius: 999px;
          background: #EF4444;
          color: #fff;
          font-size: 10px;
          font-weight: 800;
          line-height: 1;
        }
        .targetLine {
          background: rgba(245,196,0,.78);
        }
        .nowLine {
          background: #EF4444;
          box-shadow: 0 0 0 1px rgba(239,68,68,.18);
        }
        .rows {
          min-width: 1040px;
          padding: 8px 18px 18px;
        }
        .row {
          display: grid;
          grid-template-columns: 190px minmax(700px, 1fr) 86px;
          gap: 18px;
          align-items: center;
          padding: 14px 0;
          border-bottom: 1px solid rgba(10,10,10,.06);
          cursor: pointer;
        }
        .row:hover, .selectedRow {
          background: rgba(0,80,176,.04);
        }
        .employeeCell {
          padding-left: 10px;
        }
        .employeeName {
          color: ${COLORS.text};
          font-size: 14px;
          font-weight: 800;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .statusBadge {
          width: fit-content;
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 7px;
          padding: 4px 8px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 800;
        }
        .statusBadge i {
          display: block;
          width: 8px;
          height: 8px;
          border-radius: 999px;
        }
        .barWrap {
          position: relative;
          height: 36px;
          border-radius: 8px;
          overflow: visible;
          background: rgba(10,10,10,.04);
          border: 1px solid rgba(10,10,10,.08);
        }
        .gridLines span {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 1px;
          background: rgba(10,10,10,.08);
        }
        .rowMarker {
          z-index: 2;
        }
        .segment {
          position: absolute;
          top: 4px;
          bottom: 4px;
          min-width: 4px;
          border-radius: 6px;
          transition: opacity .15s ease, filter .15s ease;
          z-index: 3;
          cursor: pointer;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,.18);
        }
        .segment:hover {
          filter: brightness(1.16);
        }
        .segmentMicro {
          box-shadow: inset 0 0 0 1px rgba(255,255,255,.22), 0 0 0 1px rgba(10,10,10,.12);
        }
        .segmentTooltip {
          position: absolute;
          bottom: calc(100% + 10px);
          transform: translateX(-50%);
          display: grid;
          gap: 3px;
          min-width: 170px;
          max-width: 220px;
          padding: 10px 12px;
          border-radius: 10px;
          background: rgba(15,23,42,.96);
          color: #F8FAFC;
          z-index: 8;
          pointer-events: none;
          box-shadow: 0 18px 36px rgba(15,23,42,.22);
        }
        .segmentTooltip strong {
          font-size: 12px;
        }
        .segmentTooltip span {
          font-size: 11px;
          line-height: 1.35;
        }
        .noActivity {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          color: ${COLORS.faint};
          font-size: 12px;
          font-weight: 700;
        }
        .totalCell {
          display: grid;
          justify-items: end;
          gap: 4px;
          text-align: right;
          padding-right: 10px;
        }
        .totalCell strong {
          color: ${COLORS.text};
          font-size: 14px;
        }
        .totalCell span {
          color: ${COLORS.muted};
          font-size: 11px;
          font-weight: 700;
          line-height: 1.3;
        }
        .empty {
          padding: 52px;
          text-align: center;
          color: ${COLORS.muted};
          font-size: 14px;
          font-weight: 700;
        }
        .details {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 420px;
          gap: 16px;
          margin-top: 16px;
        }
        .detailPanel, .logsPanel {
          padding: 18px;
        }
        .detailHeader {
          display: flex;
          justify-content: space-between;
          gap: 18px;
          align-items: flex-start;
          margin-bottom: 16px;
        }
        .detailHeader h2 {
          margin: 0;
          color: ${COLORS.text};
          font-size: 20px;
        }
        .detailTotal {
          color: ${COLORS.text};
          font-size: 20px;
          font-weight: 900;
          text-align: right;
        }
        .detailTotal span {
          display: block;
          color: ${COLORS.faint};
          font-size: 12px;
          margin-top: 4px;
        }
        .detailStats {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
        }
        .detailStats div {
          border: 1px solid;
          border-radius: 8px;
          padding: 12px;
          background: ${COLORS.panelSoft};
        }
        .detailStats span {
          display: block;
          font-size: 12px;
          font-weight: 900;
          margin-bottom: 6px;
        }
        .detailStats strong {
          color: ${COLORS.text};
          font-size: 16px;
        }
        .logsHeader {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          color: ${COLORS.text};
          font-size: 16px;
          font-weight: 900;
          margin-bottom: 12px;
        }
        .logsHeader small {
          color: ${COLORS.faint};
          font-size: 11px;
          font-weight: 800;
          text-transform: uppercase;
        }
        .logsList {
          display: grid;
          gap: 10px;
          max-height: 420px;
          overflow: auto;
        }
        .logItem {
          display: grid;
          grid-template-columns: 10px 1fr;
          gap: 10px;
          padding: 10px;
          border: 1px solid rgba(10,10,10,.08);
          border-radius: 8px;
          background: ${COLORS.panelSoft};
        }
        .logBody {
          min-width: 0;
        }
        .logTitle {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .logDot {
          width: 10px;
          height: 10px;
          border-radius: 3px;
          margin-top: 4px;
        }
        .logItem strong {
          color: ${COLORS.text};
          font-size: 13px;
          overflow-wrap: anywhere;
        }
        .logItem em {
          flex: 0 0 auto;
          font-size: 10px;
          font-style: normal;
          font-weight: 900;
          text-transform: uppercase;
        }
        .logItem p {
          margin: 3px 0;
          color: ${COLORS.muted};
          font-size: 12px;
        }
        .logItem small {
          color: ${COLORS.faint};
          font-size: 12px;
        }
        .emptyLogs {
          padding: 18px;
          color: ${COLORS.faint};
          font-size: 12px;
          font-weight: 800;
          text-align: center;
          border: 1px solid rgba(10,10,10,.08);
          border-radius: 8px;
          background: ${COLORS.panelSoft};
        }
        @media (max-width: 1100px) {
          .details {
            grid-template-columns: 1fr 1fr;
          }
          .logsPanel {
            grid-column: 1 / -1;
          }
          .weeklyGrid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 760px) {
          .title {
            font-size: 26px;
          }
          .weeklySummary, .weeklyGrid, .detailStats, .details {
            grid-template-columns: 1fr;
          }
          .toolbar {
            align-items: stretch;
          }
          .exportActions {
            margin-left: 0;
          }
          .searchBox, .selectWrap, .select {
            width: 100%;
          }
        }
      `}</style>
    </div>
  );
}

function StatusBadge({ status }: { status?: string | null }) {
  const meta = statusMeta(status);
  return (
    <div className="statusBadge" style={{ background: meta.bg, color: meta.color }}>
      <i style={{ background: meta.color }} />
      {meta.label}
    </div>
  );
}
