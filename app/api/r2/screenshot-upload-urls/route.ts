import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api';
import { createR2Upload } from '@/lib/r2';
import { DEFAULT_ORGANIZATION_SCOPE, isRegularScreenshotKey, isRegularThumbnailKey } from '@/lib/screenshot-storage';

const MAX_SCREENSHOTS_PER_WINDOW = 60;
const UPLOADS_PER_SCREENSHOT = 2;
const MAX_REQUESTS = MAX_SCREENSHOTS_PER_WINDOW * UPLOADS_PER_SCREENSHOT;
const ALLOWED_TYPES = new Set(['image/png', 'image/webp', 'image/jpeg']);

export async function POST(request: NextRequest) {
  const user = requireAuth(request);
  if ('status' in user) return user;
  const body = await request.json().catch(() => null);
  const uploads = Array.isArray(body?.uploads) ? body.uploads : [];
  if (uploads.length < 1 || uploads.length > MAX_REQUESTS) {
    return NextResponse.json({ error: `uploads must contain 1 to ${MAX_REQUESTS} items` }, { status: 400 });
  }
  const seen = new Set<string>();
  for (const entry of uploads) {
    const key = String(entry?.pathname || entry?.key || '');
    const contentType = String(entry?.contentType || '').toLowerCase();
    const isKnownRegularKey = isRegularScreenshotKey(key, DEFAULT_ORGANIZATION_SCOPE, user.sub)
      || isRegularThumbnailKey(key, DEFAULT_ORGANIZATION_SCOPE, user.sub);
    if (!isKnownRegularKey || key.includes('//') || !/\.(png|webp|jpg|jpeg)$/i.test(key)) {
      return NextResponse.json({ error: 'Invalid screenshot upload key' }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(contentType) || seen.has(key)) {
      return NextResponse.json({ error: 'Invalid or duplicate screenshot upload' }, { status: 400 });
    }
    seen.add(key);
  }
  try {
    const targets = await Promise.all(uploads.map(async (entry: any) => {
      const pathname = String(entry.pathname || entry.key);
      return { pathname, ...(await createR2Upload(pathname, String(entry.contentType).toLowerCase())) };
    }));
    return NextResponse.json({ targets });
  } catch (error: any) {
    console.error('[r2-upload] failed to issue screenshot URLs', error?.message || error);
    return NextResponse.json({ error: 'Failed to issue screenshot upload URLs' }, { status: 500 });
  }
}
