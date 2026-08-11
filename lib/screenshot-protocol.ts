import { NextRequest, NextResponse } from 'next/server';

export const SCREENSHOT_PROTOCOL_VERSION = 2;
export const SCREENSHOT_PROTOCOL_HEADER = 'x-vorion-agent-protocol';
export const SCREENSHOT_AUTHORIZATION_ROUTE = '/api/r2/screenshot-upload-urls';
export const SCREENSHOT_COMMIT_ROUTE = '/api/agent/screenshots/commit';
export const SCREENSHOT_MAX_BATCH_SIZE = 60;
export const SCREENSHOT_UPLOADS_PER_CAPTURE = 2;
export const SCREENSHOT_MAX_UPLOAD_AUTHORIZATIONS = SCREENSHOT_MAX_BATCH_SIZE * SCREENSHOT_UPLOADS_PER_CAPTURE;
export const SCREENSHOT_ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/webp', 'image/jpeg']);
export const SCREENSHOT_MAX_FULL_BYTES = 1024 * 1024;
export const SCREENSHOT_MAX_THUMBNAIL_BYTES = 256 * 1024;
export const SCREENSHOT_CAPTURE_TIME_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export function getMinimumAgentProtocolVersion() {
  const raw = process.env.MIN_AGENT_PROTOCOL_VERSION;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Server misconfigured: MIN_AGENT_PROTOCOL_VERSION is required in production');
    }
    return SCREENSHOT_PROTOCOL_VERSION;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('Server misconfigured: MIN_AGENT_PROTOCOL_VERSION is invalid');
  }
  return parsed;
}

function getTrustedAgentDownloadUrl(req: NextRequest) {
  const configured = String(process.env.AGENT_DOWNLOAD_URL || '').trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:') return url.toString();
    } catch {}
  }
  return new URL('/download', req.nextUrl.origin).toString();
}

export function requireAgentProtocol(req: NextRequest): NextResponse | null {
  const minimumProtocolVersion = getMinimumAgentProtocolVersion();
  const raw = req.headers.get(SCREENSHOT_PROTOCOL_HEADER) || '';
  const parsed = Number.parseInt(raw, 10);
  const deviceId = req.headers.get('x-vorion-agent-id') || 'unknown';

  if (!raw || !Number.isInteger(parsed)) {
    console.warn('[agent-protocol] rejected', { version: raw || null, deviceId, category: 'missing_or_invalid' });
    return NextResponse.json({ error: 'agent_protocol_required', minimumProtocolVersion, downloadUrl: getTrustedAgentDownloadUrl(req) }, {
      status: 426,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (parsed < minimumProtocolVersion) {
    console.warn('[agent-protocol] rejected', { version: parsed, deviceId, category: 'upgrade_required' });
    return NextResponse.json({ error: 'agent_upgrade_required', minimumProtocolVersion, downloadUrl: getTrustedAgentDownloadUrl(req) }, {
      status: 426,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return null;
}

