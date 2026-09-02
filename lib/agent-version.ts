import { NextRequest, NextResponse } from 'next/server';
import type { TokenPayload } from './auth';

const DEFAULT_MIN_SUPPORTED_AGENT_VERSION = '1.1.6';

const noStoreHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

function normalizeVersion(value: unknown) {
  return String(value || '').trim().replace(/^v/i, '');
}

function parseVersion(value: unknown) {
  const normalized = normalizeVersion(value);
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

export function getMinimumSupportedAgentVersion() {
  return normalizeVersion(process.env.MIN_SUPPORTED_AGENT_VERSION) || DEFAULT_MIN_SUPPORTED_AGENT_VERSION;
}

export function getAgentVersionWarning(req: NextRequest, user?: TokenPayload | null) {
  const minimumSupportedAgentVersion = getMinimumSupportedAgentVersion();
  const agentVersion = normalizeVersion(req.headers.get('x-agent-version'));
  const comparison = compareVersions(agentVersion, minimumSupportedAgentVersion);
  const updateRequired = !agentVersion || comparison === null || comparison < 0;
  if (!updateRequired) return { updateRequired: false, agentVersion, minimumSupportedAgentVersion };

  console.warn('[agent-version] stale_or_missing_agent_version', {
    timestamp: new Date().toISOString(),
    route: req.nextUrl.pathname,
    method: req.method,
    agentVersion: agentVersion || null,
    minimumSupportedAgentVersion,
    employeeId: user?.sub || null,
    agentId: req.headers.get('x-vorion-agent-id') || null,
    userAgent: req.headers.get('user-agent') || null,
  });

  return { updateRequired: true, agentVersion, minimumSupportedAgentVersion };
}

export function agentOk(req: NextRequest, user: TokenPayload | null, data: Record<string, any>, status = 200) {
  const warning = getAgentVersionWarning(req, user);
  const headers: Record<string, string> = { ...noStoreHeaders };
  if (warning.updateRequired) {
    headers['X-Agent-Update-Required'] = 'true';
    headers['X-Min-Supported-Agent-Version'] = warning.minimumSupportedAgentVersion;
  }
  return NextResponse.json(
    warning.updateRequired
      ? { ...data, updateRequired: true, minimumSupportedAgentVersion: warning.minimumSupportedAgentVersion }
      : data,
    { status, headers },
  );
}
