import { NextRequest } from 'next/server';
import { err, ok, requireAuth } from '@/lib/api';
import { getHealthReport } from '@/lib/health';
import { normalizeRole } from '@/lib/roles';

export const dynamic = 'force-dynamic';

// Full health report for the super admin Health page.
export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (normalizeRole(user.role) !== 'superadmin') return err('Forbidden', 403);
  try {
    return ok({ ...(await getHealthReport()), grafanaUrl: process.env.GRAFANA_PUBLIC_URL || null });
  } catch (e: any) {
    console.error('GET /api/health/details error:', e?.message || e);
    return err('Health check failed', 500);
  }
}
