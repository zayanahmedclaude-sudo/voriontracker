import { NextRequest, NextResponse } from 'next/server';
import { createR2Upload } from '@/lib/r2';
import { isCanonicalRegularScreenshotKey, isCanonicalRegularThumbnailKey } from '@/lib/screenshot-keys';
import {
  SCREENSHOT_ALLOWED_CONTENT_TYPES,
  SCREENSHOT_MAX_UPLOAD_AUTHORIZATIONS,
  requireAgentProtocol,
} from '@/lib/screenshot-protocol';
import { agentOk } from '@/lib/agent-version';
import { getDevicePrincipal, hasDeviceCredential } from '@/lib/device-auth';
import { getTokenFromRequest } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const protocolError = requireAgentProtocol(request);
  if (protocolError) return protocolError;
  const user = getTokenFromRequest(request);
  if (request.headers.has('authorization') && hasDeviceCredential(request)) {
    return NextResponse.json({ error: 'Employee and device credentials cannot be combined' }, { status: 400 });
  }
  const device = user ? null : await getDevicePrincipal(request);
  if (!user && !device) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const ownerId = user?.sub || `device-${device!.id}`;
  const body = await request.json().catch(() => null);
  const uploads = Array.isArray(body?.uploads) ? body.uploads : [];
  if (uploads.length < 1 || uploads.length > SCREENSHOT_MAX_UPLOAD_AUTHORIZATIONS) {
    return NextResponse.json({ error: `uploads must contain 1 to ${SCREENSHOT_MAX_UPLOAD_AUTHORIZATIONS} items` }, { status: 400 });
  }
  const seen = new Set<string>();
  for (const entry of uploads) {
    const key = String(entry?.pathname || '');
    const contentType = String(entry?.contentType || '').toLowerCase();
    const isKnownRegularKey = isCanonicalRegularScreenshotKey(key, ownerId)
      || isCanonicalRegularThumbnailKey(key, ownerId);
    if (!isKnownRegularKey) {
      return NextResponse.json({ error: 'Invalid screenshot upload key' }, { status: 400 });
    }
    if (!SCREENSHOT_ALLOWED_CONTENT_TYPES.has(contentType) || seen.has(key)) {
      return NextResponse.json({ error: 'Invalid or duplicate screenshot upload' }, { status: 400 });
    }
    seen.add(key);
  }
  try {
    const targets = await Promise.all(uploads.map(async (entry: any) => {
      const pathname = String(entry.pathname);
      return { pathname, ...(await createR2Upload(pathname, String(entry.contentType).toLowerCase())) };
    }));
    return agentOk(request, user, { targets, authContext: user ? 'employee_session' : 'device_background' });
  } catch (error: any) {
    console.error('[r2-upload] failed to issue screenshot URLs', error?.message || error);
    return NextResponse.json({ error: 'Failed to issue screenshot upload URLs' }, { status: 500 });
  }
}
