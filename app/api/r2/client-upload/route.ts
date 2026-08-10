import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api';
import { canAccessLiveMonitor, normalizeRole } from '@/lib/roles';
import { createR2Upload } from '@/lib/r2';

const ALLOWED_VIDEO_TYPES = new Set([
  'video/webm', 'video/webm;codecs=vp9', 'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8', 'video/webm;codecs=vp8,opus',
]);

export async function POST(request: NextRequest) {
  const user = requireAuth(request);
  if ('status' in user) return user;
  const body = await request.json().catch(() => null);
  const key = String(body?.key || body?.pathname || '');
  const contentType = String(body?.contentType || '').toLowerCase();
  const kind = String(body?.kind || '');
  if (!ALLOWED_VIDEO_TYPES.has(contentType)) {
    return NextResponse.json({ error: 'Unsupported content type' }, { status: 400 });
  }
  if (kind === 'live-recording') {
    const employeeId = String(body?.employeeId || '');
    if (!canAccessLiveMonitor(normalizeRole(user.role))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (!employeeId || !key.startsWith(`live-recordings/${employeeId}/`)) {
      return NextResponse.json({ error: 'Invalid live recording key' }, { status: 400 });
    }
  } else if (kind === 'recording') {
    if (!key.startsWith(`recordings/${user.sub}/`)) {
      return NextResponse.json({ error: 'Invalid recording key' }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: 'Unsupported upload kind' }, { status: 400 });
  }
  try {
    return NextResponse.json(await createR2Upload(key, contentType));
  } catch (error: any) {
    console.error('[r2-upload] failed to issue upload URL', error?.message || error);
    return NextResponse.json({ error: 'Failed to issue upload URL' }, { status: 500 });
  }
}
