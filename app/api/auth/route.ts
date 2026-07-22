import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { assertSupabaseAdmin } from '@/lib/supabase';
import { signToken } from '@/lib/auth';
import { requireAuth, ok, err } from '@/lib/api';
import { canAccessWebApp, isInactiveAccountStatus, normalizeRole } from '@/lib/roles';
import { ensureProfileSchema } from '@/lib/schema';

// This route depends on runtime env/DB state — never statically evaluate it.
export const dynamic = 'force-dynamic';

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

type LoginAttemptState = {
  count: number;
  firstAttemptAt: number;
  lockedUntil: number;
};

const loginAttempts = new Map<string, LoginAttemptState>();

function getClientIdentifier(req: NextRequest) {
  const forwardedFor = req.headers.get('x-forwarded-for');
  const firstForwarded = forwardedFor?.split(',')[0]?.trim();
  return firstForwarded || req.headers.get('x-real-ip') || 'unknown';
}

function getLoginKey(req: NextRequest, email: string) {
  return `${getClientIdentifier(req)}:${email}`;
}

function getActiveAttemptState(key: string, now: number) {
  const current = loginAttempts.get(key);
  if (!current) return null;
  if (current.lockedUntil > now) return current;
  if (now - current.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return null;
  }
  return current;
}

function recordFailedLogin(key: string, now: number) {
  const existing = getActiveAttemptState(key, now);
  const nextCount = (existing?.count || 0) + 1;
  const nextState: LoginAttemptState = {
    count: nextCount,
    firstAttemptAt: existing?.firstAttemptAt || now,
    lockedUntil: nextCount >= MAX_LOGIN_ATTEMPTS ? now + LOGIN_LOCKOUT_MS : 0,
  };
  loginAttempts.set(key, nextState);
  return nextState;
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  await ensureProfileSchema();

  try {
    const rows = await sql`
      SELECT id, email, full_name, role, department_id, employee_code, account_status
      FROM public.profiles
      WHERE id = ${user.sub}
      LIMIT 1
    `;

    const profile = rows?.[0];
    if (!profile) return err('Profile not found', 404);
    if (isInactiveAccountStatus(profile.account_status)) {
      return err('This account is inactive. Please contact a super admin.', 403);
    }

    return ok({
      user: {
        id:            profile.id,
        email:         profile.email,
        full_name:     profile.full_name,
        role:          normalizeRole(profile.role),
        department_id: profile.department_id,
        employee_code: profile.employee_code,
        name:          profile.full_name,
      },
    });
  } catch (e: any) {
    console.error('GET /api/auth error:', e?.message || e);
    return err('Service unavailable: database error', 503);
  }
}

export async function POST(req: NextRequest) {
  let admin;
  try {
    admin = assertSupabaseAdmin();
  } catch (e: any) {
    console.error('POST /api/auth config error:', e?.message || e);
    return err('Service unavailable: auth not configured', 503);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON payload', 400);
  }

  const { email: rawEmail, password, context } = body;
  const email = String(rawEmail || '').trim().toLowerCase();
  const loginContext = String(context || 'web').toLowerCase();
  if (!email || !password) return err('Email and password required');
  await ensureProfileSchema();
  const now = Date.now();
  const loginKey = getLoginKey(req, email);
  const currentAttempt = getActiveAttemptState(loginKey, now);
  if (currentAttempt?.lockedUntil && currentAttempt.lockedUntil > now) {
    return err('Too many login attempts. Please try again later.', 429);
  }

  // 1. Verify credentials via Supabase Auth
  const { data: authData, error: authError } =
    await admin.auth.signInWithPassword({ email, password });

  if (authError || !authData?.user) {
    recordFailedLogin(loginKey, now);
    return err('Invalid credentials', 401);
  }
  loginAttempts.delete(loginKey);

  // Enforce email verification
  // Supabase user object may have `email_confirmed_at` or `confirmed_at` depending on setup
  const userRecord: any = authData.user;
  const confirmedAt = userRecord?.email_confirmed_at || userRecord?.confirmed_at || null;
  if (!confirmedAt) {
    return err('Please verify your email before signing in.', 403);
  }

  // 2. Fetch profile from public.profiles
  let profile;
  try {
    const rows = await sql`
      SELECT id, email, full_name, role, department_id, employee_code, account_status
      FROM public.profiles
      WHERE LOWER(email) = ${email}
      LIMIT 1
    `;
    profile = rows?.[0];
  } catch (e: any) {
    console.error('Database query failed in /api/auth:', e?.message || e);
    return err('Service unavailable: database error', 503);
  }

  if (!profile) return err('Profile not found', 404);
  if (isInactiveAccountStatus(profile.account_status)) {
    return err('This account is inactive. Please contact a super admin.', 403);
  }

  profile.role = normalizeRole(profile.role);
  console.log('[auth:login] Successful password check', { email, role: profile.role, context: loginContext });

  if (loginContext === 'web' && !canAccessWebApp(profile.role)) {
    return err('You are not allowed to use the web app. Please sign in using the Desktop Agent.', 403);
  }

  if (profile.role !== 'employee' && loginContext === 'agent') {
    return err('This account is only allowed to use the Web Dashboard.', 403);
  }

  const token = signToken({
    sub:    profile.id,
    role:   profile.role,
    name:   profile.full_name,   // keep 'name' in JWT payload for compatibility
    teamId: profile.department_id,
  });

  return ok({
    token,
    user: {
      id:            profile.id,
      email:         profile.email,
      full_name:     profile.full_name,
      role:          profile.role,
      department_id: profile.department_id,
      employee_code: profile.employee_code,
      name:          profile.full_name,
    },
  });
}
