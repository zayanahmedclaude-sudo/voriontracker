import { createClient } from 'redis';

// Shared response cache backed by Redis (REDIS_URL), with an in-process
// fallback. Redis problems must never slow or break a request: every Redis
// call has a short timeout, and on any failure the loader just runs.
//
//   cached('reports:daily:...', 60, () => buildReport())
//   await bumpCacheVersion('users')   // after a mutation; invalidates 'users' keys
//
// Keys must encode everything the response depends on, including the caller's
// scope (role, and user id where results are per user).

type RedisClient = ReturnType<typeof createClient>;

const PREFIX = 'vorion:cache:v1:';
const REDIS_TIMEOUT_MS = 250;
const LOCAL_MAX_ENTRIES = 300;
const VERSION_LOCAL_TTL_MS = 2_000;

type Store = {
  client: RedisClient | null;
  connecting: Promise<void> | null;
  inflight: Map<string, Promise<unknown>>;
  local: Map<string, { expiresAt: number; value: unknown }>;
  versions: Map<string, { at: number; value: string }>;
  hits: number;
  misses: number;
};

const KEY = Symbol.for('vorion.responseCache');

function store(): Store {
  const g = globalThis as any;
  if (!g[KEY]) {
    g[KEY] = { client: null, connecting: null, inflight: new Map(), local: new Map(), versions: new Map(), hits: 0, misses: 0 } satisfies Store;
  }
  return g[KEY];
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('redis timeout')), REDIS_TIMEOUT_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function redis(): RedisClient | null {
  const s = store();
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!s.client) {
    const client = createClient({
      url,
      socket: { connectTimeout: 2_000, reconnectStrategy: (retries) => Math.min(500 * (retries + 1), 10_000) },
    });
    client.on('error', (error) => console.warn('Redis cache unavailable:', error?.message || error));
    s.client = client;
    s.connecting = client.connect().then(() => undefined).catch(() => undefined);
  }
  return s.client.isReady ? s.client : null;
}

export function getCacheStatus() {
  const s = store();
  return {
    configured: Boolean(process.env.REDIS_URL),
    connected: Boolean(s.client?.isReady),
    hits: s.hits,
    misses: s.misses,
  };
}

async function namespaceVersion(namespace: string) {
  const s = store();
  const local = s.versions.get(namespace);
  if (local && Date.now() - local.at < VERSION_LOCAL_TTL_MS) return local.value;
  const client = redis();
  let value = local?.value || '0';
  if (client) {
    try { value = (await withTimeout(client.get(`${PREFIX}ver:${namespace}`))) || '0'; } catch {}
  }
  s.versions.set(namespace, { at: Date.now(), value });
  return value;
}

// Invalidate every key in a namespace (the part of the key before the first ':').
export async function bumpCacheVersion(namespace: string) {
  const s = store();
  s.versions.delete(namespace);
  for (const key of s.local.keys()) if (key.startsWith(`${namespace}:`)) s.local.delete(key);
  const client = redis();
  if (!client) return;
  try { await withTimeout(client.incr(`${PREFIX}ver:${namespace}`)); } catch {}
}

function readLocal(key: string) {
  const entry = store().local.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) { store().local.delete(key); return undefined; }
  return entry.value;
}

function writeLocal(key: string, value: unknown, ttlSeconds: number) {
  const local = store().local;
  if (local.size >= LOCAL_MAX_ENTRIES) {
    const oldest = local.keys().next().value;
    if (oldest) local.delete(oldest);
  }
  local.set(key, { expiresAt: Date.now() + ttlSeconds * 1000, value });
}

export async function cached<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const s = store();
  const namespace = key.split(':')[0];
  const fullKey = `${key}@${await namespaceVersion(namespace)}`;

  const local = readLocal(fullKey);
  if (local !== undefined) { s.hits += 1; return local as T; }

  const client = redis();
  if (client) {
    try {
      const raw = await withTimeout(client.get(PREFIX + fullKey));
      if (raw !== null) {
        const value = JSON.parse(raw) as T;
        // A short local copy avoids repeated Redis round trips for hot keys.
        writeLocal(fullKey, value, Math.min(ttlSeconds, 2));
        s.hits += 1;
        return value;
      }
    } catch {}
  }

  // Single flight: concurrent misses for the same key share one load.
  const pending = s.inflight.get(fullKey);
  if (pending) return pending as Promise<T>;
  s.misses += 1;
  const load = (async () => {
    try {
      const value = await loader();
      writeLocal(fullKey, value, client ? Math.min(ttlSeconds, 2) : ttlSeconds);
      if (client) {
        withTimeout(client.set(PREFIX + fullKey, JSON.stringify(value), { EX: ttlSeconds })).catch(() => undefined);
      }
      return value;
    } finally {
      s.inflight.delete(fullKey);
    }
  })();
  s.inflight.set(fullKey, load);
  return load;
}

export async function pingCache() {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is not set');
  if (!redis()) await store().connecting;
  const client = redis();
  if (!client) throw new Error('Not connected');
  return withTimeout(client.ping());
}

// Wrap a route handler so a successful (non-error) response invalidates the
// given cache namespaces, e.g. export const POST = invalidatesCache(['users'], post).
export function invalidatesCache<A extends unknown[], R extends Response>(namespaces: string[], handler: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    const response = await handler(...args);
    if (response.status < 400) await Promise.all(namespaces.map((namespace) => bumpCacheVersion(namespace)));
    return response;
  };
}
