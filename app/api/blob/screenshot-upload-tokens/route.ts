import { NextRequest, NextResponse } from 'next/server';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { requireAuth } from '@/lib/api';

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_TOKEN_REQUESTS = 60;
const ALLOWED_IMAGE_CONTENT_TYPES = ['image/png', 'image/webp', 'image/jpeg'];

type TokenRequest = {
  pathname?: string;
  contentType?: string;
};

function isValidScreenshotPath(pathname: string, userId: string) {
  if (!pathname.startsWith(`screenshots/${userId}/`)) return false;
  if (pathname.includes('//')) return false;
  return /\.(png|webp|jpg|jpeg)$/i.test(pathname);
}

export async function POST(request: NextRequest) {
  const user = requireAuth(request);
  if ('status' in user) return user;

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'Server misconfigured: BLOB_READ_WRITE_TOKEN is not set' }, { status: 500 });
  }

  let entries: TokenRequest[] = [];
  try {
    const body = await request.json();
    entries = Array.isArray(body?.uploads) ? body.uploads : [];
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (entries.length < 1 || entries.length > MAX_TOKEN_REQUESTS) {
    return NextResponse.json({ error: `uploads must contain 1 to ${MAX_TOKEN_REQUESTS} items` }, { status: 400 });
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    const pathname = String(entry?.pathname || '');
    const contentType = String(entry?.contentType || '').toLowerCase();
    if (!isValidScreenshotPath(pathname, user.sub)) {
      return NextResponse.json({ error: `Invalid screenshot upload path: ${pathname}` }, { status: 400 });
    }
    if (!ALLOWED_IMAGE_CONTENT_TYPES.includes(contentType)) {
      return NextResponse.json({ error: `Invalid screenshot content type: ${contentType}` }, { status: 400 });
    }
    if (seen.has(pathname)) {
      return NextResponse.json({ error: `Duplicate screenshot upload path: ${pathname}` }, { status: 400 });
    }
    seen.add(pathname);
  }

  try {
    const tokens = await Promise.all(entries.map(async (entry) => {
      const pathname = String(entry.pathname);
      const contentType = String(entry.contentType).toLowerCase();
      const token = await generateClientTokenFromReadWriteToken({
        pathname,
        allowedContentTypes: [contentType],
        maximumSizeInBytes: MAX_SCREENSHOT_BYTES,
        addRandomSuffix: false,
        allowOverwrite: false,
        validUntil: Date.now() + 10 * 60 * 1000,
      });
      return { pathname, token };
    }));

    console.info('[blob-upload] screenshot batch tokens issued', {
      route: '/api/blob/screenshot-upload-tokens',
      userId: user.sub,
      count: tokens.length,
    });

    return NextResponse.json({ tokens });
  } catch (error: any) {
    console.error('POST /api/blob/screenshot-upload-tokens error:', error?.message || error);
    return NextResponse.json({ error: 'Failed to issue screenshot upload tokens' }, { status: 500 });
  }
}
