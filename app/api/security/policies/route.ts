import { NextRequest } from 'next/server';
import { cachedOk, requireAuth, err } from '@/lib/api';
import { getEffectivePolicyForEmployee } from '@/lib/security';
import { sql } from '@/lib/db';

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  try {
    const rows = await sql`
      SELECT email, department_id
      FROM public.profiles
      WHERE id = ${user.sub}
      LIMIT 1
    `;
    const profile = rows?.[0];
    const policy = await getEffectivePolicyForEmployee({
      employeeId: user.sub,
      employeeEmail: profile?.email || null,
      departmentId: profile?.department_id || null,
    });
    return cachedOk({
      blockApps: policy.blockApps,
      blockWebsites: policy.blockWebsites,
      killProcess: policy.killProcess,
      showWarning: policy.showWarning,
      updatedAt: policy.updatedAt,
    }, 300);
  } catch (e: any) {
    console.error('GET /api/security/policies error:', e?.message || e);
    return err('Internal server error', 500);
  }
}
