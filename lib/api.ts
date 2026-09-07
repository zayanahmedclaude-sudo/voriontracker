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

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://tracker.vorionsystems.com')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export function corsHeaders(req: NextRequest): HeadersInit {
  const origin = req.headers.get('origin');
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Agent-Version,X-Vorion-Agent-Protocol,X-Vorion-Agent-Id,X-Vorion-Device-Token,X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'Retry-After',
  };

  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

export function options(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export const ok  = (data: unknown, status = 200, headers: HeadersInit = {}) => NextResponse.json(data, { status, headers: { ...noStoreHeaders, ...headers } });
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

export const err = (msg: unknown, status = 400, headers: HeadersInit = {}) => {
  return NextResponse.json({ error: errorMessage(msg) }, { status, headers: { ...noStoreHeaders, ...headers } });
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
