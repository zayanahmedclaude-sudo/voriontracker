'use client';
// app/(dashboard)/dashboard/page.tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuthStore } from '@/store/auth';
import { io } from 'socket.io-client';
import { fmtCompact, fmtPrecise, timeAgo } from './timeUtils';
import { normalizeRole } from '@/lib/roles';
import { getSocketServerUrl } from '@/lib/socket';
import { apiFetch } from '@/lib/api-client';

const DASHBOARD_REPORT_REFRESH_MS = 5 * 60_000;
const DASHBOARD_REPORT_JITTER_MS = 30_000;
const DASHBOARD_STATUS_REFRESH_MS = 120_000;
const DASHBOARD_STATUS_JITTER_MS = 15_000;

function fmt(secs: number) {
  if (!secs) return '0h 0m';
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

// ---- Vorion Brand Palette (kept consistent with sidebar layout) ----
const BRAND = {
  black: '#0A0A0A',
  blackSoft: '#F7F8FB',
  white: '#FFFFFF',
  blue: '#0050B0',
  blueSoft: 'rgba(0,80,176,.08)',
  yellow: '#0050B0',
  yellowSoft: 'rgba(0,80,176,.06)',
  border: 'rgba(10,10,10,.10)',
  muted: 'rgba(10,10,10,.58)',
  mutedFaint: 'rgba(10,10,10,.38)',
  danger: '#B42318',
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: BRAND.blackSoft,
    color: BRAND.black,
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
    padding: '28px 32px',
  },
  topRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
  },
  heading: {
    fontSize: 22,
    fontWeight: 600,
    margin: 0,
    color: BRAND.black,
  },
  subtext: {
    fontSize: 13,
    color: BRAND.muted,
    marginTop: 4,
  },
  dateInput: {
    padding: '8px 12px',
    borderRadius: 12,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.white,
    color: BRAND.black,
    fontSize: 13,
    outline: 'none',
    cursor: 'pointer',
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 14,
    marginBottom: 24,
  },
  statCard: {
    background: BRAND.white,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 8,
    padding: 22,
    boxShadow: '0 12px 28px rgba(10,10,10,.06)',
    transition: 'all .25s ease',
    cursor: 'pointer',
  },
  statLabel: {
    fontSize: 11,
    color: BRAND.muted,
    marginBottom: 8,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  statValue: {
    fontSize: 24,
    fontWeight: 700,
    lineHeight: 1,
  },
  statSub: {
    fontSize: 11,
    color: BRAND.mutedFaint,
    marginTop: 6,
  },
  tableCard: {
    background: BRAND.white,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 8,
    overflow: 'hidden',
    boxShadow: '0 12px 28px rgba(10,10,10,.06)',
  },
  tableHeader: {
    padding: '14px 18px',
    borderBottom: `1px solid ${BRAND.border}`,
    fontSize: 14,
    fontWeight: 600,
    color: BRAND.black,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 13,
  },
  thead: {
    background: '#FAFBFC',
  },
  th: {
    padding: '10px 18px',
    textAlign: 'left' as const,
    fontWeight: 500,
    color: BRAND.mutedFaint,
    fontSize: 11,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    borderBottom: `1px solid ${BRAND.border}`,
  },
  td: {
    padding: '12px 18px',
    color: BRAND.black,
  },
  tdMuted: {
    padding: '12px 18px',
    color: BRAND.mutedFaint,
  },
  emptyState: {
    padding: 48,
    textAlign: 'center' as const,
    color: BRAND.mutedFaint,
    fontSize: 13,
  },
  loading: {
    padding: 48,
    textAlign: 'center' as const,
    color: BRAND.mutedFaint,
    fontSize: 13,
  },
};

export default function DashboardPage() {
  const { token, user } = useAuthStore();
  const role = normalizeRole(user?.role);
  const clientTimeZone = typeof window === 'undefined'
    ? 'America/New_York'
    : Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  const [rows,       setRows]       = useState<any[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [precise,    setPrecise]    = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [isVisible,  setIsVisible]  = useState(true);
  const liveStatusVersionRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      const v = localStorage.getItem('timePrecise');
      if (v) setPrecise(v === '1');
    } catch {}
  }, []);

  useEffect(() => {
    const updateVisibility = () => setIsVisible(!document.hidden);
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  const normalizeStatus = useCallback((value?: string | null) => {
    const raw = String(value || '').toLowerCase();
    if (raw === 'active' || raw === 'working') return 'working';
    if (raw === 'idle') return 'idle';
    if (raw === 'break' || raw === 'on_break') return 'on_break';
    if (raw === 'checked_out' || raw === 'checkout' || raw === 'check_out') return 'checked_out';
    if (raw === 'offline') return 'offline';
    return raw || 'offline';
  }, []);

  const updateRowFromSocket = useCallback((payload: any) => {
    const employeeId = payload?.employeeId || payload?.userId;
    if (!employeeId) return;

    const nextStatus = normalizeStatus(payload?.status);
    const version = payload?.version || payload?.updatedAt || payload?.timestamp || payload?.lastActivity;
    if (version) liveStatusVersionRef.current = String(version);
    setRows(prev => prev.map((row) => {
      if (String(row.id) !== String(employeeId)) return row;
      return {
        ...row,
        current_status: nextStatus,
        last_active: payload?.lastActivity || payload?.timestamp || row.last_active,
        current_app: payload?.currentApp ?? row.current_app,
      };
    }));
  }, [normalizeStatus]);

  const updateRowsFromLiveStatus = useCallback((statusRows: any[]) => {
    if (!Array.isArray(statusRows) || statusRows.length === 0) return;

    setRows(prev => {
      const updatesById = new Map(statusRows.map(row => [String(row.id), row]));
      return prev.map(row => {
        const update = updatesById.get(String(row.id));
        if (!update) return row;
        return {
          ...row,
          current_status: normalizeStatus(update.current_status),
          last_active: update.last_active || row.last_active,
          current_app: update.current_app ?? row.current_app,
        };
      });
    });
  }, [normalizeStatus]);

  // ── Fetch logic extracted into a stable callback ──────────────────────
  const fetchData = useCallback(() => {
    if (!token) return;
    const params = new URLSearchParams();
    if (role === 'client') params.set('tz', clientTimeZone);
    const query = params.toString();
    apiFetch<Response>(query ? `/api/reports?${query}` : '/api/reports', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async r => {
        if (!r.ok) {
          const text = await r.text();
          console.error(`/api/reports failed ${r.status}`, text);
          return { rows: [] };
        }
        return r.json();
      })
      .then(d => {
        const normalized = (Array.isArray(d?.rows) ? d.rows : []).map((r: any) => ({
          ...r,
          current_status: normalizeStatus(r.current_status),
          total_seconds:    Number(r.total_seconds)    || 0,
          screenshot_count: Number(r.screenshot_count) || 0,
          avg_activity_pct: r.avg_activity_pct == null ? null : Number(r.avg_activity_pct),
          session_count:    Number(r.session_count)    || 0,
        }));
        setRows(normalized);
        setLoading(false);
        setLastSynced(new Date());
      })
      .catch(e => {
        console.error('Dashboard fetch error:', e);
        setRows([]);
        setLoading(false);
      });
  }, [clientTimeZone, role, token, normalizeStatus]);

  const fetchLiveStatus = useCallback(() => {
    if (!token) return;
    const params = new URLSearchParams();
    if (liveStatusVersionRef.current) params.set('since', liveStatusVersionRef.current);
    const query = params.toString();

    apiFetch<Response>(query ? `/api/dashboard/live-status?${query}` : '/api/dashboard/live-status', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async r => {
        if (!r.ok) {
          const text = await r.text();
          console.error(`/api/dashboard/live-status failed ${r.status}`, text);
          return { rows: [], latestVersion: liveStatusVersionRef.current };
        }
        return r.json();
      })
      .then(d => {
        updateRowsFromLiveStatus(d?.rows);
        if (d?.latestVersion) liveStatusVersionRef.current = String(d.latestVersion);
      })
      .catch(e => {
        console.error('Dashboard live status fetch error:', e);
      });
  }, [token, updateRowsFromLiveStatus]);

  // Initial fetch whenever date or token changes
  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  // Heavy report reconciliation. Live status is handled by Socket.IO.
  useEffect(() => {
    if (!isVisible) return;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const scheduleNextFetch = () => {
      const jitter = Math.floor(Math.random() * DASHBOARD_REPORT_JITTER_MS);
      timeoutId = setTimeout(() => {
        fetchData();
        scheduleNextFetch();
      }, DASHBOARD_REPORT_REFRESH_MS + jitter);
    };

    scheduleNextFetch();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [fetchData, isVisible]);

  // Lightweight live-status reconciliation for any missed socket events.
  useEffect(() => {
    if (!isVisible) return;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const scheduleNextFetch = () => {
      const jitter = Math.floor(Math.random() * DASHBOARD_STATUS_JITTER_MS);
      timeoutId = setTimeout(() => {
        fetchLiveStatus();
        scheduleNextFetch();
      }, DASHBOARD_STATUS_REFRESH_MS + jitter);
    };

    fetchLiveStatus();
    scheduleNextFetch();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [fetchLiveStatus, isVisible]);

  // Live status updates from the authenticated Socket.IO relay.
  useEffect(() => {
    if (!token || !user?.id) return;
    const socketUrl = getSocketServerUrl();
    if (!socketUrl) return;
    const socket = io(socketUrl, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });
    const onStatus = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const record = payload as Record<string, unknown>;
      const employeeId = record.employeeId ?? record.userId;
      if (typeof employeeId !== 'string' || !employeeId) return;
      if (record.status != null && typeof record.status !== 'string') return;
      updateRowFromSocket(record);
    };
    socket.on('connect', () => socket.emit('register', { token }));
    socket.on('employee-status', onStatus);
    socket.on('employee-activity-updated', onStatus);

    return () => {
      socket.off('employee-status', onStatus);
      socket.off('employee-activity-updated', onStatus);
      socket.disconnect();
    };
  }, [token, user?.id, updateRowFromSocket]);

  // ── Derived stats ─────────────────────────────────────────────────────
  const active   = rows.filter(r => ['working', 'idle', 'on_break'].includes(r.current_status)).length;
  const totHrs   = rows.reduce((a, r) => a + r.total_seconds, 0);
  const totShots = rows.reduce((a, r) => a + r.screenshot_count, 0);
  const activityValues = rows
    .map(r => r.avg_activity_pct)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const avgAct = activityValues.length
    ? Math.round(activityValues.reduce((a, v) => a + v, 0) / activityValues.length)
    : null;

  const statusLabels: Record<string, string> = {
    working:      'Working',
    idle:         'Idle',
    on_break:     'On Break',
    checked_out:  'Checked Out',
    offline:      'Offline',
  };

  // Status colors kept within the light theme: blue = active, black/muted = inactive
  const statusColors: Record<string, string> = {
    working:     BRAND.blue,
    idle:        BRAND.black,
    on_break:    BRAND.black,
    checked_out: BRAND.black,
    offline:     BRAND.mutedFaint,
  };

  const statCards = [
    { label: 'Active Today',  value: active,                                                             color: BRAND.blue,   sub: `of ${rows.length} employees` },
    { label: 'Total Hours',   value: precise ? fmtPrecise(totHrs) : fmtCompact(totHrs),                 color: BRAND.black, sub: 'logged today' },
    { label: 'Screenshots',   value: totShots,                                                           color: BRAND.black, sub: 'taken today' },
    { label: 'Avg Activity',  value: avgAct == null ? '--' : `${avgAct}%`,                               color: avgAct == null ? BRAND.mutedFaint : (avgAct < 40 ? BRAND.black : BRAND.blue), sub: 'keyboard + mouse' },
  ];

  return (
    <div style={styles.page}>
      <>
      {/* Top row */}
      <div style={styles.topRow}>
        <div>
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: 0, color: BRAND.black }}>
            {role === 'client'
              ? <>Assigned VAs for <span style={{ color: BRAND.blue }}>{user?.name}</span></>
              : <>Here&apos;s what&apos;s happening today, <span style={{ color: BRAND.blue }}>{user?.name}</span></>}
          </h1>
          <p style={styles.subtext}>
            {role === 'client'
              ? 'Review the assigned VA activity below.'
              : "Welcome back — here's your team overview"}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => {
              setPrecise(p => {
                const v = !p;
                try { localStorage.setItem('timePrecise', v ? '1' : '0'); } catch {}
                return v;
              });
            }}
            title="Toggle compact / precise time format"
            style={{
              padding: '8px 10px',
              borderRadius: 10,
              border: `1px solid ${BRAND.border}`,
              background: 'transparent',
              color: BRAND.black,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {precise ? 'Precise' : 'Compact'}
          </button>
          {/* Manual refresh button */}
          <button
            onClick={() => { setLoading(true); fetchData(); }}
            title="Refresh now"
            style={{
              padding: '8px 10px',
              borderRadius: 10,
              border: `1px solid ${BRAND.border}`,
              background: 'transparent',
              color: BRAND.black,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            ↻
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div style={styles.statsGrid}>
        {statCards.map(c => (
          <div
            key={c.label}
            style={styles.statCard}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-6px)';
              e.currentTarget.style.boxShadow = '0 18px 38px rgba(10,10,10,.10)';
              e.currentTarget.style.borderColor = `${c.color}40`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 12px 28px rgba(10,10,10,.06)';
              e.currentTarget.style.borderColor = BRAND.border;
            }}
          >
            <div style={styles.statLabel}>{c.label}</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: c.color }}>
              {c.value}
            </div>
            <div style={styles.statSub}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Table card */}
      <div style={styles.tableCard}>
        <div style={styles.tableHeader}>
          <span>{role === 'client' ? 'Assigned VA Summary' : 'Employee Summary'}</span>
          {lastSynced && (
            <span style={{ fontSize: 11, color: BRAND.mutedFaint, fontWeight: 400 }}>
              Last synced: {lastSynced.toLocaleTimeString()} · reports refresh every 2m while visible
            </span>
          )}
        </div>

        {loading ? (
          <div style={styles.loading}>Loading…</div>
        ) : (
          <table style={styles.table}>
            <thead style={styles.thead}>
              <tr>
                {['Employee', 'Status', 'Hours', 'Screenshots', 'Activity', 'Last Active'].map(h => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.id}
                  style={{
                    borderBottom: i < rows.length - 1
                      ? `1px solid ${BRAND.border}`
                      : 'none',
                    transition: 'background .15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,80,176,.04)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Name */}
                  <td style={{ ...styles.td, fontWeight: 600 }}>{r.name}</td>

                  {/* Status */}
                  <td style={styles.td}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 14px',
                        borderRadius: 999,
                        fontWeight: 600,
                        background: 'rgba(0,80,176,.05)',
                        border: `1px solid ${statusColors[r.current_status]}35`,
                        color: statusColors[r.current_status],
                      }}
                    >
                      {statusLabels[r.current_status] || 'Offline'}
                    </span>
                  </td>

                  {/* Hours */}
                  <td style={r.total_seconds ? styles.td : styles.tdMuted}>
                    {precise ? fmtPrecise(r.total_seconds) : fmtCompact(r.total_seconds)}
                  </td>

                  {/* Screenshots */}
                  <td style={styles.td}>{r.screenshot_count}</td>

                  {/* Activity bar */}
                  <td style={styles.td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{
                        flex: 1,
                        height: 8,
                        borderRadius: 999,
                        background: 'rgba(10,10,10,.08)',
                        maxWidth: 80,
                        overflow: 'hidden',
                      }}>
                        <div style={{
                          height: '100%',
                          borderRadius: 2,
                          width: `${r.avg_activity_pct == null ? 0 : r.avg_activity_pct}%`,
                          background: r.avg_activity_pct < 30
                            ? BRAND.yellow
                            : BRAND.blue,
                        }} />
                      </div>
                      <span
                        title={r.avg_activity_pct == null ? 'No activity data' : `${r.avg_activity_pct}%`}
                        style={{ fontSize: 11, color: BRAND.muted, minWidth: 36 }}
                      >
                        {r.avg_activity_pct == null ? '—' : `${r.avg_activity_pct.toFixed(1)}%`}
                      </span>
                    </div>
                  </td>

                  {/* Last active */}
                  <td style={styles.tdMuted} title={r.last_active ? timeAgo(r.last_active) : ''}>
                    {r.last_active
                      ? new Date(r.last_active).toLocaleString(undefined, {
                          year: 'numeric', month: 'short', day: 'numeric',
                          hour: '2-digit', minute: '2-digit', second: '2-digit',
                        })
                      : '—'}
                  </td>
                </tr>
              ))}

              {!rows.length && (
                <tr>
                  <td colSpan={6} style={styles.emptyState}>
                    No data available
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      </>
    </div>
  );
}
