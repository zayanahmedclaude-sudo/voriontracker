import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/api';
import { resetPasswordWithToken, UserServiceError } from '@/lib/user';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  let body;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON payload', 400);
  }

  const token = String(body?.token || '').trim();
  const password = String(body?.password || '');

  if (!token) return err('Reset token is required', 400);
  if (!password || password.length < 8) return err('Password must be at least 8 characters', 400);

  const complexity = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_\-+=[\]{};':"\\|<>,./?`~])/;
  if (!complexity.test(password)) {
    return err(
      'Password must include at least one lowercase letter, one uppercase letter, one digit, and one special character',
      400
    );
  }

  try {
    const result = await resetPasswordWithToken(token, password);
    return ok(result);
  } catch (e: any) {
    console.error('[auth/reset-password] error', e);
    if (e instanceof UserServiceError) return err(e.message, e.status);
    return err(e?.message || 'Failed to reset password', 500);
  }
}
