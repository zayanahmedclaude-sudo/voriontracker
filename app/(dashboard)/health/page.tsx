'use client';

import { apiFetch } from '@/lib/api-client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { normalizeRole } from '@/lib/roles';
import { useAuthStore } from '@/store/auth';
import type { HealthReport } from '@/lib/health';

type Report = HealthReport & { grafanaUrl: string | null };

const REFRESH_MS = 30_000;

const COLORS = {
  panel: '#FFFFFF',
  border: 'rgba(10,10,10,.10)',
  text: '#0A0A0A',
  muted: 'rgba(10,10,10,.58)',
  faint: 'rgba(10,10,10,.38)',
  accent: '#0050B0',
  ok: '#067647',
  okSoft: 'rgba(6,118,71,.08)',
  warn: '#B54708',
  warnSoft: 'rgba(181,71,8,.08)',
  bad: '#B42318',
  badSoft: 'rgba(180,35,24,.08)',
  track: 'rgba(10,10,10,.06)',
};

const CAPTURE_ALERT_LABELS: Record<string, string> = {
  screenshots_missing: 'Screenshots stopped',
  screenshot_upload_blocked: 'Uploads failing',
  clock_tampering: 'Clock wrong',
  device_enrollment_invalid: 'Device credential rejected',
  device_unassigned: 'Device not assigned',
};

function tone(state: 'ok' | 'warn' | 'bad' | 'none') {
  if (state === 'ok') return { color: COLORS.ok, background: COLORS.okSoft };
  if (state === 'warn') return { color: COLORS.warn, background: COLORS.warnSoft };
  if (state === 'bad') return { color: COLORS.bad, background: COLORS.badSoft };
  return { color: COLORS.muted, background: COLORS.track };
}

function Pill({ state, label }: { state: 'ok' | 'warn' | 'bad' | 'none'; label: string }) {
  const t = tone(state);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, color: t.color, background: t.background, whiteSpace: 'nowrap' }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: t.color }} />
      {label}
    </span>
  );
}

function Panel({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 18, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: COLORS.text }}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, hint, state = 'none' }: { label: string; value: React.ReactNode; hint?: string; state?: 'ok' | 'warn' | 'bad' | 'none' }) {
  const color = state === 'none' ? COLORS.text : tone(state).color;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: COLORS.faint, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function Meter({ label, pct }: { label: string; pct: number | null }) {
  const state = pct === null ? 'none' : pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'ok';
  const color = state === 'none' ? COLORS.faint : tone(state).color;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
        <span style={{ color: COLORS.muted }}>{label}</span>
        <span style={{ fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{pct === null ? '—' : `${pct.toFixed(1)}%`}</span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: COLORS.track, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%`, height: '100%', background: color, borderRadius: 999 }} />
      </div>
    </div>
  );
}

function fmtDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function fmtAgo(value: string | null | undefined) {
  if (!value) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function fmtTime(value: string) {
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '.04em', padding: '8px 10px', borderBottom: `1px solid ${COLORS.border}` };
const td: React.CSSProperties = { fontSize: 13, color: COLORS.text, padding: '10px', borderBottom: `1px solid ${COLORS.border}`, verticalAlign: 'top' };

export default function HealthPage() {
  const router = useRouter();
  const { token, user } = useAuthStore();
  const canView = normalizeRole(user?.role) === 'superadmin';
  const [report, setReport] = useState<Report | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user && !canView) router.replace('/dashboard');
  }, [canView, router, user]);

  const load = useCallback(async () => {
    if (!token || !canView) return;
    setLoading(true);
    try {
      const response = await apiFetch<Response>('/api/health/details', { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`The health API answered HTTP ${response.status}`);
      setReport(await response.json());
      setLoadError(null);
    } catch (error: any) {
      // Failing to reach the API at all is itself the most important signal.
      setLoadError(error?.message || 'The API could not be reached');
    } finally {
      setLoading(false);
    }
  }, [token, canView]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const responseClasses = useMemo(() => {
    const totals: Record<string, number> = { '2xx': 0, '4xx': 0, '5xx': 0 };
    for (const [status, count] of Object.entries(report?.runtime.responsesByStatus || {})) {
      const key = `${status[0]}xx`;
      totals[key] = (totals[key] || 0) + count;
    }
    return totals;
  }, [report]);

  if (!canView) return null;

  const overall = loadError ? { state: 'bad' as const, label: 'API unreachable' }
    : !report ? { state: 'none' as const, label: 'Checking…' }
    : report.status === 'ok' ? { state: 'ok' as const, label: 'All systems operational' }
    : report.status === 'degraded' ? { state: 'warn' as const, label: 'Degraded' }
    : { state: 'bad' as const, label: 'Down' };
  const prom = report?.prometheus;
  const fleet = report?.fleet;
  const shotsState = fleet ? (fleet.checkedIn > 0 && fleet.screenshotsLast10m === 0 ? 'bad' : 'ok') : 'none';

  return (
    <div style={{ padding: '24px 16px', maxWidth: 1280, margin: '0 auto', display: 'grid', gap: 16 }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: COLORS.text }}>System health</h1>
          <div style={{ fontSize: 13, color: COLORS.muted, marginTop: 4 }}>
            {report ? `Checked ${fmtAgo(report.checkedAt)} · refreshes every 30 seconds` : 'Loading health checks…'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Pill state={overall.state} label={overall.label} />
          {report?.grafanaUrl && (
            <a href={report.grafanaUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600, color: COLORS.accent, textDecoration: 'none' }}>Open Grafana ↗</a>
          )}
          <button onClick={() => void load()} disabled={loading} style={{ border: `1px solid ${COLORS.border}`, background: COLORS.panel, borderRadius: 10, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: loading ? 'default' : 'pointer', color: COLORS.text }}>
            {loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </header>

      {loadError && (
        <div style={{ ...tone('bad'), borderRadius: 12, padding: '12px 16px', fontSize: 14, fontWeight: 600 }}>
          {loadError}. {report ? 'Showing the last successful check below.' : ''}
        </div>
      )}

      {prom && prom.alerts.length > 0 && (
        <Panel title={`Active alerts (${prom.alerts.length})`}>
          <div style={{ display: 'grid', gap: 8 }}>
            {prom.alerts.map((alert, index) => (
              <div key={`${alert.name}-${index}`} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', ...tone(alert.severity === 'critical' ? 'bad' : 'warn'), borderRadius: 10, padding: '10px 12px' }}>
                <strong style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{alert.name}</strong>
                <span style={{ fontSize: 13, color: COLORS.text, flex: 1 }}>{alert.summary}</span>
                <span style={{ fontSize: 12, color: COLORS.muted, whiteSpace: 'nowrap' }}>{fmtAgo(alert.since)}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {report && (
        <>
          <Panel title="Services">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              {report.checks.map((check) => (
                <div key={check.name} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{check.label}</span>
                    <Pill state={check.status === 'up' ? 'ok' : check.status === 'down' ? 'bad' : 'none'} label={check.status === 'up' ? 'Up' : check.status === 'down' ? 'Down' : 'Not set up'} />
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 8 }}>
                    {check.latencyMs !== null ? `${check.latencyMs} ms` : ''}{check.message ? `${check.latencyMs !== null ? ' · ' : ''}${check.message}` : ''}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Endpoint checks" aside={<span style={{ fontSize: 12, color: COLORS.muted }}>Probed from the VPS every 30s</span>}>
            {!prom?.configured ? (
              <div style={{ fontSize: 13, color: COLORS.muted }}>Prometheus is not connected. Set <code>PROMETHEUS_URL</code> in the API environment after running the monitoring setup.</div>
            ) : prom.error ? (
              <div style={{ fontSize: 13, color: COLORS.bad }}>Prometheus could not be reached: {prom.error}</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={th}>Endpoint</th><th style={th}>Status</th><th style={th}>Response</th><th style={th}>HTTP</th><th style={th}>TLS certificate</th></tr></thead>
                  <tbody>
                    {prom.probes.map((probe) => (
                      <tr key={probe.target}>
                        <td style={{ ...td, wordBreak: 'break-all' }}>{probe.target}</td>
                        <td style={td}><Pill state={probe.up ? 'ok' : 'bad'} label={probe.up ? 'Up' : 'Failing'} /></td>
                        <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{probe.durationMs !== null ? `${probe.durationMs} ms` : '—'}</td>
                        <td style={td}>{probe.httpStatus ?? '—'}</td>
                        <td style={{ ...td, color: probe.sslExpiryDays !== null && probe.sslExpiryDays < 14 ? COLORS.bad : COLORS.text }}>
                          {probe.sslExpiryDays !== null ? `${probe.sslExpiryDays} days left` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
            <Panel title="VPS">
              {prom?.reachable ? (
                <div style={{ display: 'grid', gap: 14 }}>
                  <Meter label="CPU" pct={prom.vps.cpuPct} />
                  <Meter label="Memory" pct={prom.vps.memoryPct} />
                  <Meter label="Disk (/)" pct={prom.vps.diskPct} />
                  <div style={{ display: 'flex', gap: 24, fontSize: 13, color: COLORS.muted }}>
                    <span>Load: <strong style={{ color: COLORS.text }}>{prom.vps.load1 ?? '—'}</strong></span>
                    <span>Uptime: <strong style={{ color: COLORS.text }}>{fmtDuration(prom.vps.uptimeSeconds)}</strong></span>
                  </div>
                </div>
              ) : <div style={{ fontSize: 13, color: COLORS.muted }}>Available once Prometheus is connected.</div>}
            </Panel>

            <Panel title="Database">
              {(() => {
                const db = report.checks.find((check) => check.name === 'database');
                const d = (db?.details || {}) as Record<string, any>;
                const connPct = d.connections && d.maxConnections ? (d.connections / d.maxConnections) * 100 : null;
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
                    <Stat label="Status" value={db?.status === 'up' ? 'Up' : 'Down'} state={db?.status === 'up' ? 'ok' : 'bad'} hint={db?.latencyMs !== null ? `${db?.latencyMs} ms query` : undefined} />
                    <Stat label="Connections" value={d.connections ?? '—'} hint={d.maxConnections ? `of ${d.maxConnections} max` : undefined} state={connPct === null ? 'none' : connPct > 80 ? 'bad' : 'none'} />
                    <Stat label="Active queries" value={d.activeQueries ?? '—'} hint={d.longestQuerySeconds ? `longest ${d.longestQuerySeconds}s` : undefined} state={d.longestQuerySeconds > 60 ? 'warn' : 'none'} />
                    <Stat label="Size" value={d.sizeMb !== null && d.sizeMb !== undefined ? `${d.sizeMb} MB` : '—'} hint={d.version ? `Postgres ${d.version}` : undefined} />
                    <Stat label="API pool" value={d.pool ? `${d.pool.total - d.pool.idle}/${d.pool.total}` : '—'} hint={d.pool?.waiting ? `${d.pool.waiting} waiting` : 'busy / open'} state={d.pool?.waiting ? 'warn' : 'none'} />
                  </div>
                );
              })()}
            </Panel>

            <Panel title="Agents & screenshots">
              {fleet ? (
                <div style={{ display: 'grid', gap: 16 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
                    <Stat label="Agents online" value={fleet.agentsOnline} />
                    <Stat label="Checked in" value={fleet.checkedIn} />
                    <Stat label="Screenshots (10 min)" value={fleet.screenshotsLast10m} state={shotsState} hint={shotsState === 'bad' ? 'none while people are checked in' : undefined} />
                    <Stat label="Last screenshot" value={fmtAgo(fleet.lastScreenshotAt)} />
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {fleet.openCaptureAlerts.length === 0
                      ? <Pill state="ok" label="No open capture alerts" />
                      : fleet.openCaptureAlerts.map((alert) => <Pill key={alert.type} state="warn" label={`${CAPTURE_ALERT_LABELS[alert.type] || alert.type}: ${alert.count}`} />)}
                  </div>
                </div>
              ) : <div style={{ fontSize: 13, color: COLORS.bad }}>Fleet data unavailable (database query failed).</div>}
            </Panel>

            <Panel title="API process">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
                <Stat label="Uptime" value={fmtDuration(report.runtime.uptimeSeconds)} hint={`Node ${report.runtime.nodeVersion}`} />
                <Stat label="Memory" value={`${report.runtime.memoryRssMb} MB`} hint={`heap ${report.runtime.heapUsedMb} MB`} state={report.runtime.memoryRssMb > 450 ? 'warn' : 'none'} />
                <Stat label="Successful responses" value={responseClasses['2xx'].toLocaleString()} hint={`${responseClasses['4xx'].toLocaleString()} client errors`} />
                <Stat label="Server errors (5xx)" value={responseClasses['5xx'].toLocaleString()} state={responseClasses['5xx'] > 0 ? 'bad' : 'ok'} hint={`${report.runtime.loggedErrors} logged errors since start`} />
              </div>
            </Panel>
          </div>

          <Panel title="Recent API errors" aside={<span style={{ fontSize: 12, color: COLORS.muted }}>Since the API last started</span>}>
            {report.runtime.recentErrors.length === 0 ? (
              <Pill state="ok" label="No errors recorded" />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={th}>When</th><th style={th}>Endpoint</th><th style={th}>Error</th></tr></thead>
                  <tbody>
                    {report.runtime.recentErrors.map((error, index) => (
                      <tr key={`${error.at}-${index}`}>
                        <td style={{ ...td, whiteSpace: 'nowrap', color: COLORS.muted }}>{fmtTime(error.at)}</td>
                        <td style={{ ...td, whiteSpace: 'nowrap', fontWeight: 600 }}>{error.route || '—'}</td>
                        <td style={{ ...td, wordBreak: 'break-word' }}>{error.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {prom?.reachable && prom.targets.length > 0 && (
            <Panel title="Monitoring targets">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {prom.targets.map((target) => <Pill key={`${target.job}-${target.instance}`} state={target.up ? 'ok' : 'bad'} label={`${target.job} · ${target.instance}`} />)}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
