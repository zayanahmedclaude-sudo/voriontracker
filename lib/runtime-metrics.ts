// In-process API metrics shared by the response helpers, instrumentation.ts,
// /api/metrics and the Health page. Kept on globalThis because Next.js can
// bundle the same module separately for instrumentation and each route.

export type RecordedError = {
  at: string;
  source: 'route' | 'log';
  route: string | null;
  status: number | null;
  message: string;
};

type Registry = {
  startedAt: number;
  responsesByStatus: Map<number, number>;
  loggedErrors: number;
  unhandledErrors: number;
  recentErrors: RecordedError[];
};

const KEY = Symbol.for('vorion.runtimeMetrics');
const MAX_RECENT_ERRORS = 100;

export function getRuntimeMetrics(): Registry {
  const store = globalThis as any;
  if (!store[KEY]) {
    store[KEY] = {
      startedAt: Date.now(),
      responsesByStatus: new Map(),
      loggedErrors: 0,
      unhandledErrors: 0,
      recentErrors: [],
    } satisfies Registry;
  }
  return store[KEY];
}

export function recordResponse(status: number) {
  const registry = getRuntimeMetrics();
  registry.responsesByStatus.set(status, (registry.responsesByStatus.get(status) || 0) + 1);
}

// Route handlers log `console.error('POST /api/foo error:', ...)`, so the
// first word pair usually identifies the failing endpoint.
function guessRoute(message: string) {
  const match = message.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s:]+)/);
  return match ? `${match[1]} ${match[2]}` : null;
}

export function recordError(input: { source: RecordedError['source']; message: string; route?: string | null; status?: number | null }) {
  const registry = getRuntimeMetrics();
  if (input.source === 'log') registry.loggedErrors += 1;
  else registry.unhandledErrors += 1;
  const message = input.message.replace(/\s+/g, ' ').trim().slice(0, 500);
  registry.recentErrors.unshift({
    at: new Date().toISOString(),
    source: input.source,
    route: input.route ?? guessRoute(message),
    status: input.status ?? null,
    message,
  });
  if (registry.recentErrors.length > MAX_RECENT_ERRORS) registry.recentErrors.length = MAX_RECENT_ERRORS;
}

export function formatLogArgs(args: unknown[]) {
  return args.map((arg) => {
    if (arg instanceof Error) return arg.message;
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }).join(' ');
}
