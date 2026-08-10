import { NextRequest } from 'next/server';
import { requireRole, err, ok } from '@/lib/api';
import { sql } from '@/lib/db';
import { isInactiveAccountStatus, normalizeRole } from '@/lib/roles';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  const authUser = requireRole(req, 'superadmin', 'admin', 'hr');
  if ('status' in authUser) return authUser;

  const { id, disable } = await req.json();
  if (!id) return err('id is required', 400);
  const actorRole = normalizeRole(authUser.role);
  const [targetUser] = await sql`SELECT role, account_status FROM public.profiles WHERE id = ${id} LIMIT 1`;
  if (!disable && actorRole !== 'superadmin' && isInactiveAccountStatus(targetUser?.account_status)) {
    return err('Only super admin can reactivate left or terminated accounts.', 403);
  }
  if (normalizeRole(authUser.role) === 'hr') {
    if (['superadmin', 'admin'].includes(normalizeRole(targetUser?.role))) {
      return err('HR cannot modify super admin or admin accounts.', 403);
    }
  }

  try {
    const nextStatus = Boolean(disable) ? 'terminated' : 'active';
    await sql`
      UPDATE public.profiles
      SET account_status = ${nextStatus}, updated_at = NOW()
      WHERE id = ${id}
    `;
    return ok({ ok: true, disabled: Boolean(disable) });
  } catch (e: any) {
    console.error('[toggle-status] error', e);
    return err(e?.message || 'Failed to toggle status', 500);
  }
}
