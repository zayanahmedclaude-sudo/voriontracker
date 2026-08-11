import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runScreenshotRetention } from '@/lib/screenshot-retention';

export const runtime = 'nodejs';
export const maxDuration = 30;

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function isAuthorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const expected = `Bearer ${secret}`;
  const actual = req.headers.get('authorization') || '';
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return json({ error: 'Unauthorized' }, 401);
  if (!process.env.DATABASE_URL) return json({ error: 'Server misconfigured' }, 500);

  const dryRun = req.nextUrl.searchParams.get('dryRun') === 'true';

  try {
    const result = await runScreenshotRetention({ dryRun });
    return json(result);
  } catch (error: any) {
    console.error('[cron:screenshot-retention] failed', {
      category: error?.code || error?.name || 'unknown',
      message: error?.message || String(error),
    });
    return json({ success: false, error: 'Failed to run screenshot retention cleanup' }, 500);
  }
}
