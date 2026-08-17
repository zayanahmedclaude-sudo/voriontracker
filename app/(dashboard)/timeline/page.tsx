'use client';

import { apiFetch } from '@/lib/api-client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Download, Filter, Search } from 'lucide-react';
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

type ZoomLevel = '15 min' | '30 min' | 'Hourly' | 'Daily' | 'Weekly';
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
const PAGED_WINDOW_MINUTES = 4 * 60;
const ZOOM_OPTIONS: ZoomLevel[] = ['15 min', '30 min', 'Hourly', 'Daily', 'Weekly'];
const ZOOM_CONFIG: Record<ZoomLevel, ZoomConfig> = {
  '15 min': { interval: 15, minWidth: 1800, rowHeight: 42, labelEvery: 2 },
  '30 min': { interval: 30, minWidth: 1320, rowHeight: 40, labelEvery: 2 },
  Hourly: { interval: 60, minWidth: 1040, rowHeight: 36, labelEvery: 1 },
  Daily: { interval: 120, minWidth: 820, rowHeight: 34, labelEvery: 2 },
  Weekly: { interval: 180, minWidth: 720, rowHeight: 32, labelEvery: 2 },
};

const COLORS = {
  panel: 'rgba(16,24,43,.78)',
  panelSoft: 'rgba(245,247,250,.04)',
  border: 'rgba(245,247,250,.1)',
  text: '#F8FAFC',
  muted: 'rgba(248,250,252,.62)',
  faint: 'rgba(248,250,252,.38)',
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

function shiftDate(value: string, amount: number) {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  const next = new Date(Date.UTC(year, month - 1, day + amount));
  return next.toISOString().slice(0, 10);
}

function listDatesInRange(start: string, end: string) {
  if (!start || !end) return [];
  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    dates.push(cursor);
    cursor = shiftDate(cursor, 1);
    if (dates.length > 366) break;
  }
  return dates;
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
  if (zoomLevel === '15 min') return timeAtMinute(minute);
  if (zoomLevel === '30 min') return compactTimeAtMinute(minute);
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

function segment(type: ActivityType, startMinute: number, duration: number, project?: string): Segment {
  return {
    type,
    startMinute: Math.max(0, Math.min(DAY_MINUTES, Math.round(startMinute))),
    endMinute: Math.max(0, Math.min(DAY_MINUTES, Math.round(startMinute + duration))),
    project,
  };
}

function buildSegments(row: TimelineRow): Segment[] {
  if (Array.isArray(row.segments)) return row.segments;

  const totalMinutes = Math.min(DAY_MINUTES, Math.max(0, Math.round((Number(row.total_seconds) || 0) / 60)));
  if (!totalMinutes) return [];

  const start = 0;
  const breakMinutes = totalMinutes >= 330 ? 30 : totalMinutes >= 180 ? 15 : 0;
  const idleMinutes = totalMinutes >= 240 ? Math.min(28, Math.round(totalMinutes * 0.06)) : 0;
  const workMinutes = Math.max(0, totalMinutes - breakMinutes - idleMinutes);
  const firstWork = Math.round(workMinutes * 0.42);
  const secondWork = Math.round(workMinutes * 0.33);
  const finalWork = workMinutes - firstWork - secondWork;

  const result: Segment[] = [];
  let cursor = start;
  result.push(segment('work', cursor, firstWork, row.current_app || 'Primary work'));
  cursor += firstWork;
  result.push(segment('work', cursor, secondWork, row.current_app || 'Client tasks'));
  cursor += secondWork;
  if (breakMinutes) {
    result.push(segment('break', cursor, breakMinutes, 'Break'));
    cursor += breakMinutes;
  }
  if (idleMinutes) {
    result.push(segment('idle', cursor, idleMinutes, 'Low activity'));
    cursor += idleMinutes;
  }
  result.push(segment('work', cursor, finalWork, row.current_app || 'Follow up'));

  return result.filter((item) => item.endMinute > item.startMinute);
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
  const [activityFilter, setActivityFilter] = useState<ActivityType | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nowMinute, setNowMinute] = useState(-1);
  const [weeklyRows, setWeeklyRows] = useState<WeeklyDaySummary[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportStartDate, setExportStartDate] = useState('');
  const [exportEndDate, setExportEndDate] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const syncLocalTime = () => setNowMinute(currentMinuteInWindow());
    syncLocalTime();
    const timer = window.setInterval(syncLocalTime, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (isClient) params.set('tz', clientTimeZone);
    const query = params.toString();
    fetch(query ? `/api/reports?${query}` : '/api/reports', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => {
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
      .catch(() => {
        setRows([]);
        setLoading(false);
      });
  }, [clientTimeZone, isClient, token]);

  useEffect(() => {
    if (!token) return;
    apiFetch<Response>('/api/reports?type=weekly', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => setWeeklyRows(Array.isArray(d) ? d : []))
      .catch(() => setWeeklyRows([]));
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
      percent: Math.min(100, Math.round((workMinutes / TARGET_MINUTES) * 100)),
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
  const timelinePageCount = Math.ceil(DAY_MINUTES / PAGED_WINDOW_MINUTES);
  const [timelinePage, setTimelinePage] = useState(0);

  useEffect(() => {
    setTimelinePage(0);
  }, [zoom]);

  const visibleRange = useMemo(() => {
    if (zoom !== '15 min') return { start: 0, end: DAY_MINUTES };
    const start = timelinePage * PAGED_WINDOW_MINUTES;
    return { start, end: Math.min(DAY_MINUTES, start + PAGED_WINDOW_MINUTES) };
  }, [timelinePage, zoom]);

  const visibleMarks = useMemo(
    () => scaleMarks.filter((minute) => minute >= visibleRange.start && minute <= visibleRange.end),
    [scaleMarks, visibleRange.end, visibleRange.start],
  );

  const filteredRows = useMemo(() => {
    const query = queryText.trim().toLowerCase();
    return enrichedRows
      .filter((row) => !query || row.name.toLowerCase().includes(query))
      .filter((row) => statusFilter === 'all' || normalizeStatus(row.current_status) === statusFilter)
      .filter((row) => activityFilter === 'all' || getActivityMinutes(row, activityFilter) > 0)
      .sort((a, b) => {
        if (sortBy === 'least_work') return a.workMinutes - b.workMinutes;
        if (sortBy === 'most_idle') return b.idleMinutes - a.idleMinutes;
        if (sortBy === 'alphabetical') return a.name.localeCompare(b.name);
        if (sortBy === 'status') return String(a.current_status).localeCompare(String(b.current_status));
        return b.workMinutes - a.workMinutes;
      });
  }, [activityFilter, enrichedRows, queryText, sortBy, statusFilter]);

  const selected = filteredRows.find((row) => row.id === selectedId) || filteredRows[0] || null;
  const selectedLogs = selected ? (selected.logs.length ? selected.logs : fallbackLogs(selected)) : [];
  const weeklyTotalSeconds = weeklyRows.reduce((sum, row) => sum + Number(row.total_seconds || 0), 0);
  const weeklyTotalShots = weeklyRows.reduce((sum, row) => sum + Number(row.screenshots || 0), 0);
  const weeklyPeakUsers = weeklyRows.reduce((max, row) => Math.max(max, Number(row.active_users || 0)), 0);

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
    try {
      const params = new URLSearchParams({
        type: 'range',
        start_date: exportStartDate,
        end_date: exportEndDate,
      });
      if (isClient) params.set('tz', clientTimeZone);
      const response = await apiFetch<Response>(`/api/reports?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
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
          const percent = Math.min(100, Math.round((workMinutes / TARGET_MINUTES) * 100));
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
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="timelineTop">
        <div>
          <h1 className="title">{isClient ? 'Assigned VA Timeline' : 'Employee Timeline'}</h1>
          <div className="subTitle">Daily window: 4:00 PM to 7:00 AM{reportDate ? `, ${reportDate}` : ''}</div>
        </div>
        <div className="legend" aria-label="Activity filters">
          <button
            className={`legendButton ${activityFilter === 'all' ? 'activeLegend' : ''}`}
            onClick={() => setActivityFilter('all')}
            type="button"
          >
            All
          </button>
          {(Object.keys(ACTIVITY) as ActivityType[]).map((key) => (
            <button
              key={key}
              className={`legendButton ${activityFilter === key ? 'activeLegend' : ''}`}
              onClick={() => setActivityFilter(activityFilter === key ? 'all' : key)}
              type="button"
            >
              <span style={{ background: ACTIVITY[key].color }} />
              {ACTIVITY[key].label}
            </button>
          ))}
        </div>
      </div>

      <div className="toolbar">
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
        <select className="select" value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
          <option value="most_work">Most working time</option>
          <option value="least_work">Least working time</option>
          <option value="most_idle">Most idle time</option>
          <option value="alphabetical">Alphabetical</option>
          <option value="status">Current status</option>
        </select>
        <div className="zoom" aria-label="Zoom level">
          {ZOOM_OPTIONS.map((option) => (
            <button key={option} className={zoom === option ? 'zoomActive' : ''} onClick={() => setZoom(option)} type="button">
              {option}
            </button>
          ))}
        </div>
        <button className="iconButton" type="button" title="Export timeline" onClick={exportVisibleRows}>
          <Download size={16} />
        </button>
        {canExportDateRange && (
          <button className={`iconButton ${exportOpen ? 'activeLegend' : ''}`} type="button" title="Export date range" onClick={() => setExportOpen((open) => !open)}>
            Export dates
          </button>
        )}
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
            <small>Exports daily activity rows for each selected date.</small>
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

      {zoom === '15 min' && (
        <div className="pageToolbar">
          <div>
            <strong>15 minute focus</strong>
            <span>{timeAtMinute(visibleRange.start)} - {timeAtMinute(visibleRange.end)}</span>
          </div>
          <div className="pageControls">
            <button type="button" className="pagerButton" onClick={() => setTimelinePage((page) => Math.max(0, page - 1))} disabled={timelinePage === 0}>
              Previous
            </button>
            <small>Page {timelinePage + 1} of {timelinePageCount}</small>
            <button
              type="button"
              className="pagerButton"
              onClick={() => setTimelinePage((page) => Math.min(timelinePageCount - 1, page + 1))}
              disabled={timelinePage >= timelinePageCount - 1}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {zoom === 'Weekly' ? (
        <div className="weeklyBoard">
          <div className="weeklySummary">
            <div>
              <span>Total tracked</span>
              <strong>{fmt(weeklyTotalSeconds)}</strong>
            </div>
            <div>
              <span>Peak active users</span>
              <strong>{weeklyPeakUsers}</strong>
            </div>
            <div>
              <span>Screenshots</span>
              <strong>{weeklyTotalShots}</strong>
            </div>
          </div>
          <div className="weeklyGrid">
            {weeklyRows.length > 0 ? weeklyRows.map((item) => (
              <div key={item.day} className="weeklyCardDay">
                <div className="weeklyCardHead">
                  <strong>{weekDayLabel(item.day)}</strong>
                  <span>{shortDateLabel(item.day)}</span>
                </div>
                <div className="weeklyMetric">
                  <label>Tracked</label>
                  <b>{fmt(item.total_seconds)}</b>
                </div>
                <div className="weeklyMetric">
                  <label>Active users</label>
                  <b>{item.active_users}</b>
                </div>
                <div className="weeklyMetric">
                  <label>Screenshots</label>
                  <b>{item.screenshots}</b>
                </div>
              </div>
            )) : (
              <div className="weeklyEmpty">No weekly data available for Monday to Sunday.</div>
            )}
          </div>
        </div>
      ) : (

      <div className="timelineCard">
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
              <div className="nowLine" style={{ left: `${toVisiblePosition(nowMinute)}%` }} title={`Current local time: ${timeAtMinute(nowMinute)}`} />
            )}
          </div>
          <div className="totalSpacer" />
        </div>

        {loading ? (
          <div className="empty">Loading...</div>
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
                      const dim = activityFilter !== 'all' && activityFilter !== item.type;
                      const meta = ACTIVITY[item.type];
                      return (
                        <div
                          key={`${row.id}-${index}`}
                          className="segment"
                          style={{
                            left: `${toVisiblePosition(clipped.start)}%`,
                            width: `${toVisiblePosition(clipped.end) - toVisiblePosition(clipped.start)}%`,
                            background: meta.color,
                            opacity: dim ? 0.22 : 1,
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
                  <span>{row.percent}%</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {zoom !== 'Weekly' && selected && (
        <div className="details">
          <div className="detailPanel">
            <div className="detailHeader">
              <div>
                <h2>{selected.name}</h2>
                <StatusBadge status={selected.current_status} />
              </div>
              <div className="detailTotal">{fmt(selected.total_seconds)} <span>{selected.percent}% of target</span></div>
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
        .legendButton, .zoom button, .iconButton {
          border: 1px solid ${COLORS.border};
          background: rgba(245,247,250,.05);
          color: #CBD5E1;
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
          background: rgba(30,90,224,.2);
          border-color: rgba(59,130,246,.5);
          color: #F8FAFC;
        }
        .toolbar {
          margin-bottom: 16px;
          background: rgba(10,14,26,.36);
          border: 1px solid ${COLORS.border};
          border-radius: 8px;
          padding: 10px;
        }
        .pageToolbar {
          margin: 0 0 14px;
          padding: 12px 14px;
          border: 1px solid ${COLORS.border};
          border-radius: 10px;
          background: rgba(10,14,26,.34);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          flex-wrap: wrap;
        }
        .exportPanel {
          margin: 0 0 14px;
          padding: 14px;
          border: 1px solid ${COLORS.border};
          border-radius: 10px;
          background: rgba(10,14,26,.34);
          display: flex;
          align-items: end;
          gap: 14px;
          flex-wrap: wrap;
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
          background: rgba(245,247,250,.04);
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
          background: rgba(245,247,250,.05);
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
          background: rgba(245,247,250,.04);
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
          background: rgba(245,247,250,.04);
          padding: 0 12px;
        }
        .timelineCard, .detailPanel, .logsPanel {
          background: ${COLORS.panel};
          border: 1px solid ${COLORS.border};
          border-radius: 8px;
          box-shadow: 0 20px 50px rgba(0,0,0,.28);
        }
        .timelineCard {
          overflow: auto;
        }
        .weeklyBoard {
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
          box-shadow: 0 20px 50px rgba(0,0,0,.28);
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
          background: rgba(16,24,43,.96);
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
          background: rgba(248,250,252,.13);
        }
        .hourMark span {
          position: absolute;
          top: 0;
          left: 6px;
          color: ${COLORS.faint};
          font-size: 11px;
          font-weight: 800;
          white-space: nowrap;
          background: linear-gradient(90deg, rgba(16,24,43,.96) 0%, rgba(16,24,43,.9) 72%, rgba(16,24,43,0) 100%);
          padding-right: 8px;
        }
        .targetLine, .nowLine {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 2px;
          pointer-events: none;
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
          border-bottom: 1px solid rgba(245,247,250,.06);
          cursor: pointer;
        }
        .row:hover, .selectedRow {
          background: rgba(245,247,250,.035);
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
          overflow: hidden;
          background: rgba(245,247,250,.06);
          border: 1px solid rgba(245,247,250,.09);
        }
        .gridLines span {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 1px;
          background: rgba(248,250,252,.11);
        }
        .rowMarker {
          z-index: 2;
        }
        .segment {
          position: absolute;
          top: 5px;
          bottom: 5px;
          min-width: 3px;
          border-radius: 5px;
          transition: opacity .15s ease, filter .15s ease;
        }
        .segment:hover {
          filter: brightness(1.16);
        }
        .noActivity {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          padding-left: 12px;
          color: ${COLORS.faint};
          font-size: 12px;
          font-weight: 700;
        }
        .totalCell {
          text-align: right;
          padding-right: 10px;
        }
        .totalCell strong {
          display: block;
          color: #E2E8F0;
          font-size: 13px;
        }
        .totalCell span {
          display: block;
          margin-top: 4px;
          color: ${COLORS.faint};
          font-size: 12px;
          font-weight: 800;
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
          background: rgba(245,247,250,.035);
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
          border: 1px solid rgba(245,247,250,.08);
          border-radius: 8px;
          background: rgba(245,247,250,.035);
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
          border: 1px solid rgba(245,247,250,.08);
          border-radius: 8px;
          background: rgba(245,247,250,.035);
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
