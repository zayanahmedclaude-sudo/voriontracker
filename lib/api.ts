// lib/api.ts
import { NextResponse } from 'next/server';
import { getTokenFromRequest } from './auth';
import type { NextRequest } from 'next/server';
import type { TokenPayload } from './auth';

const noStoreHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

export const ok  = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: noStoreHeaders });
export const cachedOk = (data: unknown, seconds: number, status = 200) => NextResponse.json(data, {
  status,
  headers: {
    'Cache-Control': `private, max-age=${seconds}, stale-while-revalidate=${seconds}`,
  },
});
function errorMessage(msg: unknown) {
  if (typeof msg === 'string') return msg;
  if (msg instanceof Error) return msg.message;
  if (msg && typeof msg === 'object') {
    const record = msg as Record<string, unknown>;
    for (const key of ['message', 'error_description', 'error']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  return 'Internal server error';
}

export const err = (msg: unknown, status = 400) => {
  return NextResponse.json({ error: errorMessage(msg) }, { status, headers: noStoreHeaders });
};

export function getErrorMessage(error: unknown, fallback = 'Internal server error') {
  const message = errorMessage(error);
  return message === 'Internal server error' ? fallback : message;
};

export function requireAuth(req: NextRequest): TokenPayload | NextResponse {
  const user = getTokenFromRequest(req);
  if (!user) return err('Unauthorized', 401);
  return user;
}

export function requireRole(req: NextRequest, ...roles: string[]): TokenPayload | NextResponse {
  const user = getTokenFromRequest(req);
  if (!user) return err('Unauthorized', 401);
  if (!roles.includes(user.role)) return err('Forbidden', 403);
  return user;
}
