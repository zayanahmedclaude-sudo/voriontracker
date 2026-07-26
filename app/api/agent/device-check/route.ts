import { NextRequest } from 'next/server';
import { ok } from '@/lib/api';

function toPatterns(value: string | undefined) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const hostname = String(body?.hostname || '').trim();
  const platform = String(body?.platform || '').trim();
  const installScope = String(body?.installScope || '').trim();

  const allowedHostPatterns = toPatterns(process.env.ALLOWED_COMPANY_DEVICE_HOST_PATTERNS);
  const blockPersonalInstalls = String(process.env.BLOCK_PERSONAL_DEVICE_INSTALLS || 'true').toLowerCase() !== 'false';

  const hostAllowed = !allowedHostPatterns.length || allowedHostPatterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(hostname);
    } catch {
      return hostname.toLowerCase().includes(pattern.toLowerCase());
    }
  });

  const allowed = !blockPersonalInstalls || hostAllowed;
  return ok({
    allowed,
    reason: allowed
      ? 'Install approved for company-managed device.'
      : 'Install blocked: this device does not match configured company device hostname rules.',
    policy: {
      hostname,
      platform,
      installScope,
      hostPatternsConfigured: allowedHostPatterns.length > 0,
    },
  });
}
