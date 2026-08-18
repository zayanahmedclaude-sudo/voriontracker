import { NextRequest } from 'next/server';
import { corsHeaders, err, getErrorMessage, ok, options } from '@/lib/api';
import { requestPasswordReset, UserServiceError } from '@/lib/user';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map<string, { count: number; resetAt: number }>();

function getRateLimitKey(req: NextRequest, email: string) {
  const forwardedFor = req.headers.get('x-forwarded-for') || '';
  const ip = forwardedFor.split(',')[0]?.trim() || 'unknown';
  return `${ip}:${email.toLowerCase()}`;
}

function isRateLimited(key: string, now: number) {
  const current = attempts.get(key);
  if (!current) return false;
  if (current.resetAt <= now) {
    attempts.delete(key);
    return false;
  }
  return current.count >= MAX_ATTEMPTS;
}

function recordAttempt(key: string, now: number) {
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  attempts.set(key, { count: current.count + 1, resetAt: current.resetAt });
}

export function OPTIONS(req: NextRequest) {
  return options(req);
}

export async function POST(req: NextRequest) {
  let body;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON payload', 400, corsHeaders(req));
  }

  const email = String(body?.email || '').trim().toLowerCase();
  if (!email) return err('Email is required', 400, corsHeaders(req));

  const now = Date.now();
  const key = getRateLimitKey(req, email);
  if (isRateLimited(key, now)) {
    return err('Too many reset requests. Please try again later.', 429, corsHeaders(req));
  }

  recordAttempt(key, now);

  try {
    await requestPasswordReset(email);
    return ok(
      {
        ok: true,
        message: 'If an account exists for this email, a password reset link has been sent.',
      },
      200,
      corsHeaders(req)
    );
  } catch (error) {
    console.error('[auth/forgot-password] error', error);
    if (error instanceof UserServiceError) {
      return err(getErrorMessage(error, 'Failed to send reset email'), error.status, corsHeaders(req));
    }
    return err(getErrorMessage(error, 'Failed to send reset email'), 500, corsHeaders(req));
  }
}
