import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
const MAX_JSON_API_BODY_BYTES = 256 * 1024;
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://tracker.vorionsystems.com')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const legacyUploadPaths = new Set([
  '/api/screenshots',
  '/api/agent/screenshots/upload-urls',
]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();
  const origin = req.headers.get('origin');
  const corsHeaders: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Agent-Version,X-Vorion-Agent-Protocol,X-Vorion-Agent-Id,X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'Retry-After',
  };

  if (origin && allowedOrigins.includes(origin)) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
  }

  if (pathname.startsWith('/api/') && method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: corsHeaders });
  }

  if (method === 'POST' && legacyUploadPaths.has(pathname)) {
    return NextResponse.json(
      { error: 'Legacy upload endpoint disabled. Update the Vorion Tracker agent.' },
      {
        status: 410,
        headers: {
          ...corsHeaders,
          Connection: 'close',
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  if (pathname.startsWith('/api/') && method !== 'GET' && method !== 'HEAD') {
    const contentLength = Number(req.headers.get('content-length') || 0);
    if (contentLength > MAX_JSON_API_BODY_BYTES) {
      return NextResponse.json(
        { error: 'Request body too large' },
        {
          status: 413,
          headers: {
            ...corsHeaders,
            Connection: 'close',
            'Cache-Control': 'no-store',
          },
        },
      );
    }
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: [
    '/api/:path*',
  ],
};
