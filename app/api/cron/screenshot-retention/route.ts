import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api';
import { deleteExpiredScreenshots } from '@/lib/screenshot-retention';

export const runtime = 'nodejs';

function isAuthorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!process.env.DATABASE_URL) return err('Server misconfigured: DATABASE_URL not set', 500);
  if (!isAuthorized(req)) return err('Unauthorized', 401);

  try {
    const result = await deleteExpiredScreenshots({ force: true });
    return ok(result);
  } catch (error: any) {
    console.error('GET /api/cron/screenshot-retention error:', error?.message || error);
    return err('Failed to run screenshot retention cleanup', 500);
  }
}
