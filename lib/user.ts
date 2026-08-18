import crypto from 'crypto';
import { PoolClient } from 'pg';
import { sql, withTransaction } from '@/lib/db';
import { hashPassword } from '@/lib/password';
import { hasSmtpConfig, sendCredentialsEmail, sendInviteEmail, sendPasswordResetEmail, sendVerificationEmail } from '@/lib/mailer';
import {
  normalizeAccountStatus,
  normalizeEmploymentType,
  normalizeRole,
  normalizeShiftType,
  type AccountStatus,
  type EmploymentType,
  type Role,
  type ShiftType,
} from '@/lib/roles';
import { ensureRoleFeatureSchema } from '@/lib/schema';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const RESET_TOKEN_TTL_HOURS = 24;

export type UserStatus = 'Active' | 'Pending Verification' | 'Invited' | 'Disabled' | 'Unknown';

export const INVITE_ROLES: Role[] = [];

type ProfileRecord = {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  department_id: string | null;
  employee_code?: string | null;
  shift_type?: ShiftType | null;
  employment_type?: EmploymentType | null;
  account_status?: AccountStatus | null;
  password_hash?: string | null;
  reset_token?: string | null;
  reset_token_expires_at?: string | Date | null;
};

export class UserServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function normalizeEmail(raw: unknown) {
  return String(raw || '').trim().toLowerCase();
}

function createResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getResetPasswordUrl(token: string) {
  return `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
}

function getInviteUrl(token: string) {
  return getResetPasswordUrl(token);
}

function getStatusFromProfile(profile: Pick<ProfileRecord, 'password_hash' | 'reset_token' | 'account_status'> | null | undefined): UserStatus {
  if (!profile) return 'Unknown';
  const normalizedStatus = normalizeAccountStatus(profile.account_status);
  if (normalizedStatus === 'left' || normalizedStatus === 'terminated') return 'Disabled';
  if (profile.password_hash) return 'Active';
  if (profile.reset_token) return 'Invited';
  return 'Pending Verification';
}

export function deriveStatusFromAuthUser(profile: Pick<ProfileRecord, 'password_hash' | 'reset_token' | 'account_status'> | null | undefined): UserStatus {
  return getStatusFromProfile(profile);
}

export async function findProfileByEmail(email: string) {
  const normalized = normalizeEmail(email);
  const [profile] = await sql`
    SELECT
      id,
      full_name,
      email,
      role,
      department_id,
      employee_code,
      shift_type,
      employment_type,
      account_status,
      password_hash,
      reset_token,
      reset_token_expires_at
    FROM public.profiles
    WHERE lower(email) = ${normalized}
    LIMIT 1
  `;
  return (profile as ProfileRecord | undefined) || null;
}

export async function ensureUserDoesNotExist(email: string) {
  const profile = await findProfileByEmail(email);
  if (profile) {
    throw new UserServiceError(409, 'User already exists');
  }
}

async function insertProfile(
  client: PoolClient,
  name: string,
  email: string,
  role: Role,
  departmentId: string | null,
  passwordHash: string | null,
  shiftType: ShiftType = 'full_time',
  employmentType: EmploymentType | null = null,
  accountStatus: AccountStatus | null = null,
) {
  const profileId = crypto.randomUUID();
  const result = await client.query(
    `INSERT INTO public.profiles (id, full_name, email, role, department_id, password_hash, shift_type, employment_type, account_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, full_name, full_name AS name, email, role, department_id, employee_code, shift_type, employment_type, account_status`,
    [profileId, name, email, role, departmentId, passwordHash, shiftType, employmentType, accountStatus]
  );
  return result.rows[0];
}

function shiftsConflict(existingShift: ShiftType, nextShift: ShiftType) {
  if (existingShift === 'full_time' || nextShift === 'full_time') return true;
  return existingShift === nextShift;
}

function getShiftLabel(shiftType: ShiftType) {
  if (shiftType === 'first_half') return 'First Half (20:00-00:00 PKT)';
  if (shiftType === 'second_half') return 'Second Half (01:00-05:00 PKT)';
  return 'Full Time (20:00-00:00 & 01:00-05:00 PKT)';
}

async function syncClientAssignment(
  client: PoolClient,
  clientId: string,
  employeeId: string | null,
  shiftType: ShiftType = 'full_time',
) {
  await client.query('DELETE FROM client_assignments WHERE client_id = $1', [clientId]);
  if (!employeeId) return;

  const normalizedShiftType = normalizeShiftType(shiftType);
  const employeeResult = await client.query(
    `SELECT id, full_name, role
     FROM public.profiles
     WHERE id = $1
     LIMIT 1`,
    [employeeId]
  );
  const employee = employeeResult.rows[0];
  if (!employee || normalizeRole(employee.role) !== 'employee') {
    throw new UserServiceError(400, 'Assigned user must be an employee.');
  }

  const conflictResult = await client.query(
    `SELECT ca.client_id, ca.shift_type, p.full_name AS client_name
     FROM client_assignments ca
     JOIN public.profiles p ON p.id = ca.client_id
     WHERE ca.employee_id = $1
       AND ca.client_id <> $2
     FOR UPDATE`,
    [employeeId, clientId]
  );

  const conflictingAssignment = conflictResult.rows.find((row) =>
    shiftsConflict(normalizeShiftType(row.shift_type), normalizedShiftType)
  );

  if (conflictingAssignment) {
    throw new UserServiceError(
      409,
      `${employee.full_name} is already assigned to ${conflictingAssignment.client_name} for ${getShiftLabel(normalizeShiftType(conflictingAssignment.shift_type))}.`
    );
  }

  await client.query(
    `INSERT INTO client_assignments (client_id, employee_id, shift_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (client_id, employee_id)
     DO UPDATE SET shift_type = EXCLUDED.shift_type, created_at = NOW()`,
    [clientId, employeeId, normalizedShiftType]
  );
}

export async function getAssignedClientId(employeeId: string) {
  await ensureRoleFeatureSchema();
  const [row] = await sql`
    SELECT client_id
    FROM client_assignments
    WHERE employee_id = ${employeeId}
    LIMIT 1
  `;
  return row?.client_id || null;
}

export async function listAssignedEmployeesForClient(clientId: string) {
  await ensureRoleFeatureSchema();
  return await sql`
    SELECT p.id, p.full_name AS name, p.email, p.role, p.department_id, p.employee_code, ca.shift_type AS assignment_shift_type
    FROM client_assignments ca
    JOIN public.profiles p ON p.id = ca.employee_id
    WHERE ca.client_id = ${clientId}
    ORDER BY p.full_name
  `;
}

export async function createUserAccount(payload: { name: string; email: string; role: Role; departmentId: string | null; password: string }) {
  const email = normalizeEmail(payload.email);
  const normalizedRole = normalizeRole(payload.role);
  console.log('[userService] Creating user', { email, role: normalizedRole });
  await ensureUserDoesNotExist(email);

  const passwordHash = await hashPassword(payload.password);
  const profile = await withTransaction(async (client) => {
    return insertProfile(client, payload.name, email, normalizedRole, payload.departmentId, passwordHash);
  });

  let emailSent = true;
  try {
    if (hasSmtpConfig()) {
      await sendCredentialsEmail({ to: email, name: payload.name, password: payload.password, role: normalizedRole });
      console.log('[userService] Credentials email sent', { email });
    } else {
      emailSent = false;
    }
  } catch (mailError) {
    emailSent = false;
    console.error('[userService] Credentials email failed', { email, error: mailError });
  }

  return { profile, status: 'Active' as const, emailSent };
}

export async function createEmployeeAccount(payload: {
  name: string;
  email: string;
  role: Role;
  departmentId: string | null;
  password: string;
  shiftType?: ShiftType | null;
  employmentType?: EmploymentType | null;
  accountStatus?: AccountStatus | null;
  assignedEmployeeId?: string | null;
  assignmentShiftType?: ShiftType | null;
}) {
  const email = normalizeEmail(payload.email);
  const normalizedRole = normalizeRole(payload.role);
  const normalizedShiftType = normalizeShiftType(payload.shiftType);
  const normalizedEmploymentType = normalizeEmploymentType(payload.employmentType);
  const normalizedAccountStatus = normalizeAccountStatus(payload.accountStatus);
  await ensureUserDoesNotExist(email);

  const passwordHash = await hashPassword(payload.password);
  const profile = await withTransaction(async (client) => {
    const createdProfile = await insertProfile(
      client,
      payload.name,
      email,
      normalizedRole,
      payload.departmentId,
      passwordHash,
      normalizedShiftType,
      normalizedEmploymentType,
      normalizedAccountStatus,
    );
    if (normalizedRole === 'client') {
      await syncClientAssignment(client, createdProfile.id, payload.assignedEmployeeId || null, normalizeShiftType(payload.assignmentShiftType));
    }
    return createdProfile;
  });

  let emailSent = true;
  try {
    if (hasSmtpConfig()) {
      await sendCredentialsEmail({ to: email, name: payload.name, password: payload.password, role: normalizedRole });
    } else {
      emailSent = false;
    }
  } catch (mailError) {
    emailSent = false;
    console.error('[userService] Failed to send credentials email', { email, error: mailError });
  }

  return { profile, status: getStatusFromProfile({ password_hash: passwordHash, reset_token: null, account_status: normalizedAccountStatus }), emailSent };
}

async function setResetTokenForEmail(email: string) {
  const normalized = normalizeEmail(email);
  const token = createResetToken();
  const [profile] = await sql`
    UPDATE public.profiles
    SET
      reset_token = ${token},
      reset_token_expires_at = NOW() + (${RESET_TOKEN_TTL_HOURS} * INTERVAL '1 hour'),
      updated_at = NOW()
    WHERE lower(email) = ${normalized}
    RETURNING id, full_name, email, role, account_status, password_hash, reset_token, reset_token_expires_at
  `;

  if (!profile) {
    throw new UserServiceError(404, 'User not found');
  }

  return {
    profile: profile as ProfileRecord,
    token,
    actionUrl: getResetPasswordUrl(token),
  };
}

export async function inviteUserAccount(payload: { name: string; email: string; role: Role; departmentId: string | null }) {
  const email = normalizeEmail(payload.email);
  const normalizedRole = normalizeRole(payload.role);
  await ensureUserDoesNotExist(email);

  const profile = await withTransaction(async (client) => {
    return insertProfile(client, payload.name, email, normalizedRole, payload.departmentId, null);
  });

  const { token } = await setResetTokenForEmail(email);
  const actionUrl = getInviteUrl(token);

  let emailSent = true;
  try {
    if (!hasSmtpConfig()) {
      throw new Error('Invitation email delivery is unavailable. Configure SMTP first.');
    }
    await sendInviteEmail({ to: email, name: payload.name, role: normalizedRole, actionUrl });
  } catch (mailError) {
    emailSent = false;
    console.error('[userService] Failed to send invite email', { email, error: mailError });
  }

  return { profile, status: 'Invited' as const, emailSent };
}

export async function resendInvite(email: string) {
  const normalized = normalizeEmail(email);
  const existing = await findProfileByEmail(normalized);
  if (!existing) {
    throw new UserServiceError(404, 'User not found');
  }
  if (existing.password_hash) {
    throw new UserServiceError(400, 'User is already active');
  }
  if (!hasSmtpConfig()) {
    throw new UserServiceError(502, 'Invitation email delivery is unavailable. Configure SMTP first.');
  }

  const { profile, token } = await setResetTokenForEmail(normalized);
  const actionUrl = getInviteUrl(token);
  await sendInviteEmail({
    to: normalized,
    name: profile.full_name || normalized,
    role: normalizeRole(profile.role || 'employee'),
    actionUrl,
  });

  return { ok: true, actionUrl };
}

export async function resendVerification(email: string) {
  const normalized = normalizeEmail(email);
  const existing = await findProfileByEmail(normalized);
  if (!existing) {
    throw new UserServiceError(404, 'User not found');
  }
  if (!hasSmtpConfig()) {
    throw new UserServiceError(502, 'Verification email delivery is unavailable. Configure SMTP first.');
  }

  const { profile, token } = await setResetTokenForEmail(normalized);
  await sendVerificationEmail({
    to: normalized,
    name: profile.full_name || normalized,
    actionUrl: getResetPasswordUrl(token),
  });

  return { ok: true };
}

export async function sendPasswordReset(email: string) {
  const normalized = normalizeEmail(email);
  const existing = await findProfileByEmail(normalized);
  if (!existing) {
    throw new UserServiceError(404, 'User not found');
  }
  if (!hasSmtpConfig()) {
    throw new UserServiceError(502, 'Password reset email delivery is unavailable. Configure SMTP first.');
  }

  const { token } = await setResetTokenForEmail(normalized);
  const actionUrl = getResetPasswordUrl(token);
  await sendPasswordResetEmail({
    to: normalized,
    name: existing.full_name || normalized,
    actionUrl,
  });

  return { ok: true, actionUrl };
}

export async function requestPasswordReset(email: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new UserServiceError(400, 'Email is required');
  }
  if (!hasSmtpConfig()) {
    throw new UserServiceError(502, 'Password reset email delivery is unavailable. Configure SMTP first.');
  }

  const existing = await findProfileByEmail(normalized);
  if (!existing) {
    return { ok: true };
  }

  const { token } = await setResetTokenForEmail(normalized);
  const actionUrl = getResetPasswordUrl(token);
  await sendPasswordResetEmail({
    to: normalized,
    name: existing.full_name || normalized,
    actionUrl,
  });

  return { ok: true };
}

export async function resetPasswordWithToken(token: string, password: string) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    throw new UserServiceError(400, 'Reset token is required');
  }

  const [profile] = await sql`
    SELECT id, email
    FROM public.profiles
    WHERE reset_token = ${normalizedToken}
      AND reset_token_expires_at IS NOT NULL
      AND reset_token_expires_at > NOW()
    LIMIT 1
  `;

  if (!profile) {
    throw new UserServiceError(400, 'Invalid or expired reset token');
  }

  const passwordHash = await hashPassword(password);
  await sql`
    UPDATE public.profiles
    SET
      password_hash = ${passwordHash},
      reset_token = NULL,
      reset_token_expires_at = NULL,
      updated_at = NOW()
    WHERE id = ${profile.id}
  `;

  return { ok: true, userId: profile.id };
}

export async function deleteUserAndProfile(id: string) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM app_activity WHERE employee_id = $1', [id]);
    await client.query('DELETE FROM website_activity WHERE employee_id = $1', [id]);
    await client.query('DELETE FROM screenshots WHERE employee_id = $1', [id]);
    await client.query('DELETE FROM screenshot_flags WHERE employee_id = $1 OR flagged_by = $1', [id]);
    await client.query('DELETE FROM recordings WHERE employee_id = $1', [id]);
    await client.query('DELETE FROM employee_status WHERE employee_id = $1', [id]);
    await client.query('DELETE FROM client_assignments WHERE employee_id = $1 OR client_id = $1', [id]);
    await client.query(
      `DELETE FROM breaks WHERE attendance_id IN (
         SELECT id FROM attendance WHERE employee_id = $1
       )`,
      [id]
    );
    await client.query('DELETE FROM attendance WHERE employee_id = $1', [id]);
    await client.query('DELETE FROM public.profiles WHERE id = $1', [id]);
  });
}
