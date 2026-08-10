import { NextRequest } from 'next/server';
import { requireRole, ok, err } from '@/lib/api';
import { resendInvite, resendVerification, UserServiceError } from '@/lib/user';
import { sql } from '@/lib/db';
import { normalizeRole } from '@/lib/roles';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  const auth = requireRole(req, 'superadmin', 'admin', 'hr');
  if ('status' in auth) return auth;

  const body = await req.json();
  const email = String(body?.email || '').trim().toLowerCase();
  const type = String(body?.type || 'invite').toLowerCase();

  if (!email) return err('email is required', 400);
  if (!['invite', 'verification'].includes(type)) return err('type must be invite or verification', 400);
  if (normalizeRole(auth.role) === 'hr') {
    const [targetUser] = await sql`SELECT role FROM public.profiles WHERE LOWER(email) = ${email} LIMIT 1`;
    if (['superadmin', 'admin'].includes(normalizeRole(targetUser?.role))) {
      return err('HR cannot modify super admin or admin accounts.', 403);
    }
  }

  try {
    const data = type === 'verification' ? await resendVerification(email) : await resendInvite(email);
    return ok({ ok: true, type, email, data });
  } catch (e: any) {
    console.error('[diagnostics/resend-invite] error', e);
    if (e instanceof UserServiceError) return err(e.message, e.status);
    return err(e?.message || 'Failed to resend invite/verification', 500);
  }
}
