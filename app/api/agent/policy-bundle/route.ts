import { NextRequest } from 'next/server';
import { requireAuth, ok, err } from '@/lib/api';
import { getEffectivePolicyForEmployee, listEffectiveBlockedApps, listEffectiveBlockedWebsites } from '@/lib/security';
import { sql } from '@/lib/db';
import { requireAgentProtocol } from '@/lib/screenshot-protocol';

// One small, agent-only read replaces the three independently-polled policy routes.
export async function GET(req: NextRequest) {
  const protocolError = requireAgentProtocol(req);
  if (protocolError) return protocolError;
  const user = requireAuth(req);
  if ('status' in user) return user;

  try {
    const rows = await sql`SELECT email, department_id FROM public.profiles WHERE id = ${user.sub} LIMIT 1`;
    const profile = rows?.[0];
    const context = { employeeId: user.sub, employeeEmail: profile?.email || null, departmentId: profile?.department_id || null };
    const [policy, blockedApps, blockedWebsites] = await Promise.all([
      getEffectivePolicyForEmployee(context),
      listEffectiveBlockedApps({ departmentId: context.departmentId, employeeEmail: context.employeeEmail }),
      listEffectiveBlockedWebsites({ departmentId: context.departmentId, employeeEmail: context.employeeEmail }),
    ]);
    return ok({
      policy: { blockApps: policy.blockApps, blockWebsites: policy.blockWebsites, killProcess: policy.killProcess, showWarning: policy.showWarning, updatedAt: policy.updatedAt },
      blockedApps,
      blockedWebsites,
    });
  } catch (error: any) {
    console.error('GET /api/agent/policy-bundle error:', error?.message || error);
    return err('Internal server error', 500);
  }
}
