// lib/auth.ts
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { canManageUsers, canMonitorAll, canSendAlerts, normalizeRole, type Role } from './roles';

const SECRET = process.env.JWT_SECRET!;

export interface TokenPayload {
  sub: string; role: Role; teamId: string | null; name: string;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: '30d' });   // 8h se 30d kar diya
}

export function verifyToken(token: string): TokenPayload {
  const payload = jwt.verify(token, SECRET) as TokenPayload;
  return { ...payload, role: normalizeRole(payload.role) };
}

export function getTokenFromRequest(req: NextRequest): TokenPayload | null {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  try { return verifyToken(auth.slice(7)); }
  catch { return null; }
}

// ── Role levels ────────────────────────────────────────────────────────────
const LEVELS: Record<Role, number> = {
  superadmin: 7,
  admin: 6,
  hr: 5,
  executive: 4,
  qa_manager: 3,
  qa_lead: 2,
  qa: 2,
  client: 1,
  employee: 0,
};

export const roleLevel    = (r: Role) => LEVELS[r] ?? 0;
export const isAtLeast     = (r: Role, min: Role) => roleLevel(r) >= roleLevel(min);
export { canMonitorAll, canManageUsers, canSendAlerts };
