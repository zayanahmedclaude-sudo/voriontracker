import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { getPoolStats, sql } from './db';
import { getR2Bucket, getR2Client } from './r2';
import { getRuntimeMetrics, type RecordedError } from './runtime-metrics';

// Health checks for the super admin Health page and the Prometheus /api/metrics
// endpoint. Results are cached briefly so page polling and scrapes don't
// multiply load on the database or external services.

export type CheckStatus = 'up' | 'down' | 'not_configured';
export type HealthCheck = {
  name: string;
  label: string;
  status: CheckStatus;
  latencyMs: number | null;
  message: string | null;
  details?: Record<string, unknown>;
};

export type PrometheusSnapshot = {
  configured: boolean;
  reachable: boolean;
  error: string | null;
  vps: { cpuPct: number | null; memoryPct: number | null; diskPct: number | null; load1: number | null; uptimeSeconds: number | null };
  targets: Array<{ job: string; instance: string; up: boolean }>;
  probes: Array<{ target: string; up: boolean; durationMs: number | null; httpStatus: number | null; sslExpiryDays: number | null }>;
  alerts: Array<{ name: string; severity: string; summary: string; since: string | null }>;
};

export type HealthReport = {
  status: 'ok' | 'degraded' | 'down';
  checkedAt: string;
  checks: HealthCheck[];
  fleet: {
    agentsOnline: number;
    checkedIn: number;
    screenshotsLast10m: number;
    lastScreenshotAt: string | null;
    openCaptureAlerts: Array<{ type: string; count: number }>;
  } | null;
  runtime: {
    uptimeSeconds: number;
    nodeVersion: string;
    memoryRssMb: number;
    heapUsedMb: number;
    responsesByStatus: Record<string, number>;
    loggedErrors: number;
    unhandledErrors: number;
    recentErrors: RecordedError[];
  };
  prometheus: PrometheusSnapshot;
};

const CHECK_TIMEOUT_MS = 5_000;
const CACHE_MS = 15_000;
const CACHE_KEY = Symbol.for('vorion.healthReportCache');
const PROMETHEUS_CACHE_KEY = Symbol.for('vorion.prometheusSnapshotCache');

function withTimeout<T>(promise: Promise<T>, ms = CHECK_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function timed(name: string, label: string, run: () => Promise<Record<string, unknown> | void>): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const details = await withTimeout(run());
    return { name, label, status: 'up', latencyMs: Date.now() - started, message: null, ...(details ? { details } : {}) };
  } catch (error: any) {
    return { name, label, status: 'down', latencyMs: Date.now() - started, message: String(error?.message || error).slice(0, 300) };
  }
}

function notConfigured(name: string, label: string, message: string): HealthCheck {
  return { name, label, status: 'not_configured', latencyMs: null, message };
}

async function optionalRow(query: Promise<any[]>) {
  try { return (await withTimeout(query))?.[0] || null; } catch { return null; }
}

async function checkDatabase() {
  return timed('database', 'Database', async () => {
    await sql`SELECT 1`;
    const [info, connections, slowest] = await Promise.all([
      optionalRow(sql`SELECT current_setting('server_version') AS version, pg_database_size(current_database()) AS size_bytes, current_setting('max_connections')::int AS max_connections`),
      optionalRow(sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE state = 'active')::int AS active FROM pg_stat_activity WHERE datname = current_database()`),
      optionalRow(sql`SELECT COALESCE(EXTRACT(EPOCH FROM MAX(NOW() - query_start)), 0)::float AS seconds FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()`),
    ]);
    return {
      version: info?.version ?? null,
      sizeMb: info?.size_bytes ? Math.round(Number(info.size_bytes) / 1024 / 1024) : null,
      maxConnections: info?.max_connections ?? null,
      connections: connections?.total ?? null,
      activeQueries: connections?.active ?? null,
      longestQuerySeconds: slowest ? Math.round(Number(slowest.seconds)) : null,
      pool: getPoolStats(),
    };
  });
}

async function checkR2() {
  if (!process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID) return notConfigured('storage', 'Screenshot storage (R2)', 'R2 credentials are not set');
  return timed('storage', 'Screenshot storage (R2)', async () => {
    await getR2Client().send(new HeadBucketCommand({ Bucket: getR2Bucket() }), { abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  });
}

// Any HTTP answer below 500 proves the service is reachable and serving.
async function checkHttpService(name: string, label: string, rawUrl: string | undefined, path = '') {
  if (!rawUrl) return notConfigured(name, label, 'URL is not set');
  const url = rawUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '') + path;
  return timed(name, label, async () => {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), cache: 'no-store' });
    if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
    return { httpStatus: response.status };
  });
}

async function readFleet(): Promise<HealthReport['fleet']> {
  try {
    const [agents, attendance, shots, alerts] = await withTimeout(Promise.all([
      sql`SELECT COUNT(*)::int AS online FROM employee_status WHERE last_activity > NOW() - INTERVAL '90 seconds' AND current_status IN ('working', 'idle', 'on_break')`,
      sql`SELECT COUNT(*)::int AS checked_in FROM attendance WHERE check_out IS NULL AND check_in > NOW() - INTERVAL '1 day'`,
      sql`SELECT COUNT(*) FILTER (WHERE captured_at > NOW() - INTERVAL '10 minutes')::int AS recent, MAX(captured_at) AS last_at FROM screenshots WHERE captured_at > NOW() - INTERVAL '1 day'`,
      sql`SELECT alert_type, COUNT(*)::int AS count FROM device_alerts WHERE resolved_at IS NULL AND detected_at > NOW() - INTERVAL '24 hours' AND alert_type IN ('screenshots_missing','screenshot_upload_blocked','clock_tampering','device_enrollment_invalid','device_unassigned') GROUP BY alert_type`,
    ]));
    return {
      agentsOnline: agents?.[0]?.online ?? 0,
      checkedIn: attendance?.[0]?.checked_in ?? 0,
      screenshotsLast10m: shots?.[0]?.recent ?? 0,
      lastScreenshotAt: shots?.[0]?.last_at ? new Date(shots[0].last_at).toISOString() : null,
      openCaptureAlerts: (alerts || []).map((row: any) => ({ type: String(row.alert_type), count: Number(row.count) })),
    };
  } catch {
    return null;
  }
}

async function promQuery(baseUrl: string, query: string) {
  const response = await fetch(`${baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), cache: 'no-store' });
  if (!response.ok) throw new Error(`Prometheus HTTP ${response.status}`);
  const body = await response.json();
  return (body?.data?.result || []) as Array<{ metric: Record<string, string>; value: [number, string] }>;
}

const scalar = (rows: Array<{ value: [number, string] }>) => {
  const value = Number(rows?.[0]?.value?.[1]);
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
};

async function readPrometheus(): Promise<PrometheusSnapshot> {
  const empty: PrometheusSnapshot = {
    configured: false, reachable: false, error: null,
    vps: { cpuPct: null, memoryPct: null, diskPct: null, load1: null, uptimeSeconds: null },
    targets: [], probes: [], alerts: [],
  };
  const baseUrl = String(process.env.PROMETHEUS_URL || '').replace(/\/$/, '');
  if (!baseUrl) return empty;
  try {
    const rootfs = 'mountpoint="/",fstype!~"tmpfs|overlay|squashfs"';
    const [cpu, memory, disk, load, uptime, up, probes, probeDurations, probeStatus, sslExpiry, alertsResponse] = await Promise.all([
      promQuery(baseUrl, '100 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100'),
      promQuery(baseUrl, '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100'),
      promQuery(baseUrl, `(1 - node_filesystem_avail_bytes{${rootfs}} / node_filesystem_size_bytes{${rootfs}}) * 100`),
      promQuery(baseUrl, 'node_load1'),
      promQuery(baseUrl, 'time() - node_boot_time_seconds'),
      promQuery(baseUrl, 'up'),
      promQuery(baseUrl, 'probe_success'),
      promQuery(baseUrl, 'probe_duration_seconds'),
      promQuery(baseUrl, 'probe_http_status_code'),
      promQuery(baseUrl, '(probe_ssl_earliest_cert_expiry - time()) / 86400'),
      fetch(`${baseUrl}/api/v1/alerts`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), cache: 'no-store' }).then((r) => r.json()),
    ]);
    const byTarget = (rows: typeof probes) => new Map(rows.map((row) => [row.metric.instance, Number(row.value[1])]));
    const durations = byTarget(probeDurations), statuses = byTarget(probeStatus), certs = byTarget(sslExpiry);
    return {
      configured: true,
      reachable: true,
      error: null,
      vps: { cpuPct: scalar(cpu), memoryPct: scalar(memory), diskPct: scalar(disk), load1: scalar(load), uptimeSeconds: scalar(uptime) },
      targets: up.filter((row) => !['blackbox', 'endpoints', 'endpoints-internal'].includes(row.metric.job)).map((row) => ({ job: row.metric.job, instance: row.metric.instance, up: row.value[1] === '1' })),
      probes: probes.map((row) => {
        const target = row.metric.instance;
        const sslDays = certs.get(target);
        return {
          target,
          up: row.value[1] === '1',
          durationMs: durations.has(target) ? Math.round(durations.get(target)! * 1000) : null,
          httpStatus: statuses.get(target) || null,
          sslExpiryDays: sslDays !== undefined && Number.isFinite(sslDays) ? Math.floor(sslDays) : null,
        };
      }).sort((a, b) => a.target.localeCompare(b.target)),
      alerts: (alertsResponse?.data?.alerts || [])
        .filter((alert: any) => alert.state === 'firing')
        .map((alert: any) => ({
          name: String(alert.labels?.alertname || 'Alert'),
          severity: String(alert.labels?.severity || 'warning'),
          summary: String(alert.annotations?.summary || alert.annotations?.description || ''),
          since: alert.activeAt || null,
        })),
    };
  } catch (error: any) {
    return { ...empty, configured: true, error: String(error?.message || error).slice(0, 300) };
  }
}

function readRuntime(): HealthReport['runtime'] {
  const registry = getRuntimeMetrics();
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: Math.round((Date.now() - registry.startedAt) / 1000),
    nodeVersion: process.version,
    memoryRssMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    responsesByStatus: Object.fromEntries([...registry.responsesByStatus.entries()].map(([status, count]) => [String(status), count])),
    loggedErrors: registry.loggedErrors,
    unhandledErrors: registry.unhandledErrors,
    recentErrors: registry.recentErrors.slice(0, 50),
  };
}

function cached<T>(key: symbol, build: () => Promise<T>): Promise<T> {
  const store = globalThis as any;
  const entry = store[key] as { at: number; promise: Promise<T> } | undefined;
  if (entry && Date.now() - entry.at < CACHE_MS) return entry.promise;
  const promise = build();
  store[key] = { at: Date.now(), promise };
  promise.catch(() => { if (store[key]?.promise === promise) store[key] = undefined; });
  return promise;
}

type CoreReport = Omit<HealthReport, 'status' | 'runtime' | 'prometheus'>;

async function buildCore(): Promise<CoreReport> {
  const [database, storage, socket, livekit, fleet] = await Promise.all([
    checkDatabase(),
    checkR2(),
    checkHttpService('realtime', 'Realtime socket server', process.env.SOCKET_SERVER_URL || process.env.NEXT_PUBLIC_SOCKET_SERVER_URL, '/health'),
    checkHttpService('livekit', 'Live view (LiveKit)', process.env.LIVEKIT_URL),
    readFleet(),
  ]);
  return { checkedAt: new Date().toISOString(), checks: [database, storage, socket, livekit], fleet };
}

function summarize(core: CoreReport, prometheus: PrometheusSnapshot): HealthReport {
  const { checks } = core;
  const database = checks.find((check) => check.name === 'database')!;
  const anyDown = checks.some((check) => check.status === 'down');
  const probeDown = prometheus.probes.some((probe) => !probe.up) || prometheus.targets.some((target) => !target.up);
  const status = database.status === 'down' ? 'down' : anyDown || probeDown || prometheus.alerts.length > 0 ? 'degraded' : 'ok';
  return { ...core, status, runtime: readRuntime(), prometheus };
}

// The Prometheus snapshot is skipped for /api/metrics, which Prometheus itself
// scrapes; querying it back from there would be circular.
export async function getHealthReport(options: { includePrometheus?: boolean } = {}): Promise<HealthReport> {
  const includePrometheus = options.includePrometheus !== false;
  const [core, prometheus] = await Promise.all([
    cached(CACHE_KEY, buildCore),
    includePrometheus ? cached(PROMETHEUS_CACHE_KEY, readPrometheus) : Promise.resolve(null),
  ]);
  return summarize(core, prometheus || { configured: false, reachable: false, error: null, vps: { cpuPct: null, memoryPct: null, diskPct: null, load1: null, uptimeSeconds: null }, targets: [], probes: [], alerts: [] });
}

// Prometheus text exposition format.
export function renderPrometheusMetrics(report: HealthReport) {
  const lines: string[] = [];
  const metric = (name: string, help: string, type: 'gauge' | 'counter', samples: Array<[Record<string, string>, number | null | undefined]>) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      const labelText = Object.entries(labels).map(([key, val]) => `${key}="${String(val).replace(/["\\\n]/g, '_')}"`).join(',');
      lines.push(`${name}${labelText ? `{${labelText}}` : ''} ${value}`);
    }
  };
  const configured = report.checks.filter((check) => check.status !== 'not_configured');
  const db = report.checks.find((check) => check.name === 'database');
  const dbDetails = (db?.details || {}) as Record<string, any>;

  metric('vorion_health_status', 'Overall health: 1 ok, 0.5 degraded, 0 down', 'gauge', [[{}, report.status === 'ok' ? 1 : report.status === 'degraded' ? 0.5 : 0]]);
  metric('vorion_check_up', 'Dependency check result (1 up, 0 down)', 'gauge', configured.map((check) => [{ check: check.name }, check.status === 'up' ? 1 : 0]));
  metric('vorion_check_latency_seconds', 'Dependency check latency', 'gauge', configured.map((check) => [{ check: check.name }, check.latencyMs === null ? null : check.latencyMs / 1000]));
  metric('vorion_db_connections', 'Connections to the application database', 'gauge', [[{ state: 'total' }, dbDetails.connections], [{ state: 'active' }, dbDetails.activeQueries]]);
  metric('vorion_db_max_connections', 'Postgres max_connections', 'gauge', [[{}, dbDetails.maxConnections]]);
  metric('vorion_db_longest_query_seconds', 'Longest running active query', 'gauge', [[{}, dbDetails.longestQuerySeconds]]);
  metric('vorion_db_size_megabytes', 'Application database size', 'gauge', [[{}, dbDetails.sizeMb]]);
  metric('vorion_db_pool_clients', 'API process connection pool', 'gauge', [[{ state: 'total' }, dbDetails.pool?.total], [{ state: 'idle' }, dbDetails.pool?.idle], [{ state: 'waiting' }, dbDetails.pool?.waiting]]);
  if (report.fleet) {
    metric('vorion_agents_online', 'Agents with a heartbeat in the last 90 seconds', 'gauge', [[{}, report.fleet.agentsOnline]]);
    metric('vorion_employees_checked_in', 'Open attendance sessions', 'gauge', [[{}, report.fleet.checkedIn]]);
    metric('vorion_screenshots_last_10m', 'Screenshots captured in the last 10 minutes', 'gauge', [[{}, report.fleet.screenshotsLast10m]]);
    metric('vorion_capture_alerts_open', 'Open capture-health alerts in the last 24 hours', 'gauge', report.fleet.openCaptureAlerts.map((alert) => [{ type: alert.type }, alert.count]));
  }
  metric('vorion_http_responses_total', 'API responses by status code since process start', 'counter', Object.entries(report.runtime.responsesByStatus).map(([status, count]) => [{ status, class: `${status[0]}xx` }, count]));
  metric('vorion_errors_total', 'Errors since process start', 'counter', [[{ kind: 'logged' }, report.runtime.loggedErrors], [{ kind: 'unhandled' }, report.runtime.unhandledErrors]]);
  metric('vorion_process_uptime_seconds', 'API process uptime', 'gauge', [[{}, report.runtime.uptimeSeconds]]);
  metric('vorion_process_memory_megabytes', 'API process memory', 'gauge', [[{ kind: 'rss' }, report.runtime.memoryRssMb], [{ kind: 'heap_used' }, report.runtime.heapUsedMb]]);
  return lines.join('\n') + '\n';
}
