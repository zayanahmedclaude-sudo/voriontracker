import { NextRequest } from 'next/server';
import { requireRole, err, ok } from '@/lib/api';
import { assertSupabaseAdmin } from '@/lib/supabase';
import { resendVerification, UserServiceError } from '@/lib/user';
import { sql } from '@/lib/db';
import { normalizeRole } from '@/lib/roles';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  const authUser = requireRole(req, 'superadmin', 'admin', 'hr');
  if ('status' in authUser) return authUser;

  let admin;
  try { admin = assertSupabaseAdmin(); } catch (e: any) { return err('Supabase admin unavailable', 500); }

  const { email } = await req.json();
  if (!email) return err('email is required', 400);
  if (normalizeRole(authUser.role) === 'hr') {
    const [targetUser] = await sql`SELECT role FROM public.profiles WHERE LOWER(email) = ${String(email).trim().toLowerCase()} LIMIT 1`;
    if (['superadmin', 'admin'].includes(normalizeRole(targetUser?.role))) {
      return err('HR cannot modify super admin or admin accounts.', 403);
    }
  }

  try {
    const data = await resendVerification(admin, email);
    return ok({ ok: true, data });
  } catch (e: any) {
    console.error('[resend-verification] error', e);
    if (e instanceof UserServiceError) return err(e.message, e.status);
    return err(e?.message || 'Failed to resend verification', 500);
  }
}
