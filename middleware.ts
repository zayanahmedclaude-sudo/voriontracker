import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
const MAX_JSON_API_BODY_BYTES = 256 * 1024;

const legacyUploadPaths = new Set([
  '/api/screenshots',
  '/api/agent/screenshots/upload-urls',
]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  if (method === 'POST' && legacyUploadPaths.has(pathname)) {
    return NextResponse.json(
      { error: 'Legacy upload endpoint disabled. Update the Vorion Tracker agent.' },
      {
        status: 410,
        headers: {
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
            Connection: 'close',
            'Cache-Control': 'no-store',
          },
        },
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/api/:path*',
  ],
};
