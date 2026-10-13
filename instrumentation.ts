// Next.js instrumentation hook: runs once per server process.
// Captures every logged and unhandled API error for /api/metrics and the
// super admin Health page.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { recordError, formatLogArgs } = await import('./lib/runtime-metrics');
  const marker = Symbol.for('vorion.consoleErrorWrapped');
  const consoleAny = console as any;
  if (consoleAny[marker]) return;
  consoleAny[marker] = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try { recordError({ source: 'log', message: formatLogArgs(args) }); } catch {}
    original(...args);
  };
}

export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routePath?: string; routeType?: string },
) {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { recordError } = await import('./lib/runtime-metrics');
  recordError({
    source: 'route',
    route: `${request.method} ${context.routePath || request.path}`,
    status: 500,
    message: error instanceof Error ? error.message : String(error),
  });
}
