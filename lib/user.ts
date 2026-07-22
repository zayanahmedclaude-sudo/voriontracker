import { PoolClient } from 'pg';
import { sql, withTransaction } from '@/lib/db';
import { hasSmtpConfig, sendCredentialsEmail, sendInviteEmail, sendVerificationEmail } from '@/lib/mailer';
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

const redirectTo = process.env.NEXT_PUBLIC_APP_URL || undefined;

export type UserStatus = 'Active' | 'Pending Verification' | 'Invited' | 'Disabled' | 'Unknown';

export const INVITE_ROLES: Role[] = [];

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

export function deriveStatusFromAuthUser(u: any): UserStatus {
  if (!u) return 'Unknown';
  const banned = u.banned || u.user_metadata?.banned || u.app_metadata?.banned || u.disabled || u.user_metadata?.disabled;
  if (banned) return 'Disabled';
  if (u.email_confirmed_at || u.confirmed_at) return 'Active';
  if (u.confirmation_sent_at || u.invited_at) return 'Invited';
  return 'Pending Verification';
}

export async function getAuthUserByEmail(admin: any, email: string) {
  if (!email) return null;
  const normalized = normalizeEmail(email);

  if (typeof admin.auth.admin.getUserByEmail === 'function') {
    const { data, error } = await admin.auth.admin.getUserByEmail(normalized);
    if (error) throw error;
    return data?.user || null;
  }

  if (typeof admin.auth.admin.listUsers === 'function') {
    const { data, error } = await admin.auth.admin.listUsers();
    if (error) throw error;
    return (data?.users || []).find((u: any) => String(u.email || '').toLowerCase() === normalized) || null;
  }

  throw new Error('Supabase admin list or lookup APIs are unavailable');
}

export async function findProfileByEmail(email: string) {
  const normalized = normalizeEmail(email);
  const [profile] = await sql`
    SELECT id, full_name, email, role, department_id, employee_code
    FROM public.profiles
    WHERE lower(email) = ${normalized}
    LIMIT 1
  `;
  return profile || null;
}

export async function ensureUserDoesNotExist(admin: any, email: string) {
  const [profile, authUser] = await Promise.all([
    findProfileByEmail(email),
    getAuthUserByEmail(admin, email).catch((error) => {
      throw new UserServiceError(500, `Auth lookup failed: ${error?.message || error}`);
    }),
  ]);

  if (authUser || profile) {
    throw new UserServiceError(409, 'User already exists');
  }
}

async function insertProfile(
  client: PoolClient,
  userId: string,
  name: string,
  email: string,
  role: Role,
  departmentId: string | null,
  shiftType: ShiftType = 'full_time',
  employmentType: EmploymentType | null = null,
  accountStatus: AccountStatus | null = null,
) {
  const result = await client.query(
    `INSERT INTO public.profiles (id, full_name, email, role, department_id, shift_type, employment_type, account_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, full_name, full_name AS name, email, role, department_id, employee_code, shift_type, employment_type, account_status`,
    [userId, name, email, role, departmentId, shiftType, employmentType, accountStatus]
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

/**
 * Creates a user with the admin-provided password and sends a verification email.
 * Every role follows this same flow so the initial password is consistent and
 * the user can sign in after verifying their account.
 */
export async function createUserAccount(admin: any, payload: { name: string; email: string; role: Role; departmentId: string | null; password: string }) {
  const email = normalizeEmail(payload.email);
  const normalizedRole = normalizeRole(payload.role);
  console.log('[userService] Creating user', { email, role: normalizedRole });
  await ensureUserDoesNotExist(admin, email);

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: payload.password,
    email_confirm: false,
    user_metadata: { full_name: payload.name, role: normalizedRole },
  });
  if (error) {
    if (String(error?.message || '').toLowerCase().includes('already registered')) {
      throw new UserServiceError(409, 'User already exists');
    }
    throw error;
  }

  const userId = data?.user?.id;
  if (!userId) {
    throw new Error('Auth user created without id');
  }

  console.log('[userService] Auth user created', { email, userId });

  let profile;
  try {
    profile = await withTransaction(async (client) => {
      return await insertProfile(client, userId, payload.name, email, normalizedRole, payload.departmentId);
    });
  } catch (error) {
    try {
      await admin.auth.admin.deleteUser(userId);
    } catch (cleanupError) {
      console.error('[userService] Failed cleanup after user creation failure', cleanupError);
    }
    throw error;
  }

  console.log('[userService] Profile inserted', { email, profileId: profile?.id });

  let emailSent = true;
  try {
    if (typeof admin.auth.admin.generateLink === 'function') {
      const { error: linkError } = await admin.auth.admin.generateLink({ type: 'signup', email, redirectTo });
      if (linkError) throw linkError;
      console.log('[userService] Verification email sent', { email });
    } else if (hasSmtpConfig()) {
      await sendVerificationEmail({ to: email, name: payload.name, actionUrl: `${redirectTo || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/confirm?email=${encodeURIComponent(email)}` });
      console.log('[userService] Verification email sent via SMTP', { email });
    } else {
      throw new Error('Verification email delivery is unavailable.');
    }
  } catch (mailError) {
    emailSent = false;
    console.error('[userService] Verification email failed', { email, error: mailError });
  }

  return { profile, status: 'Pending Verification' as const, emailSent };
}

export async function createEmployeeAccount(admin: any, payload: {
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
  const isInactive = normalizedAccountStatus === 'left' || normalizedAccountStatus === 'terminated';
  console.log('[userService] Creating account via Supabase invite + admin-set password', { email, role: normalizedRole });
  await ensureUserDoesNotExist(admin, email);

  // Step 1: inviteUserByEmail creates the user AND triggers Supabase's own
  // SMTP to send the "Invite user" template — with name + password passed
  // via metadata so the template can render {{ .Data.full_name }} and
  // {{ .Data.temp_password }}.
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { full_name: payload.name, role: normalizedRole, temp_password: payload.password, banned: isInactive },
  });
  if (error) {
    const message = String(error?.message || '').toLowerCase();
    if (message.includes('already registered')) {
      throw new UserServiceError(409, 'User already exists');
    }
    if (message.includes('rate limit') || message.includes('too many')) {
      throw new UserServiceError(429, 'Supabase email rate limit reached. Configure custom SMTP under Project Settings → Auth → SMTP Settings.');
    }
    throw error;
  }

  const userId = data?.user?.id;
  if (!userId) throw new Error('Invited user created without id');
  console.log('[userService] Auth user invited', { email, userId });

  // Step 2: force-set the actual password so the one shown in the email
  // really logs the user in immediately, without requiring them to click
  // the invite link first.
  try {
    const { error: pwError } = await admin.auth.admin.updateUserById(userId, {
      password: payload.password,
      email_confirm: true,
      user_metadata: { full_name: payload.name, role: normalizedRole, temp_password: payload.password, banned: isInactive },
    });
    if (pwError) throw pwError;
    console.log('[userService] Password set on invited user', { email });
  } catch (pwError) {
    console.error('[userService] Failed to set password after invite', { email, error: pwError });
    try {
      await admin.auth.admin.deleteUser(userId);
    } catch (cleanupError) {
      console.error('[userService] Failed cleanup after password-set failure', cleanupError);
    }
    throw pwError;
  }

  let profile;
  try {
    profile = await withTransaction(async (client) => {
      const createdProfile = await insertProfile(
        client,
        userId,
        payload.name,
        email,
        normalizedRole,
        payload.departmentId,
        normalizedShiftType,
        normalizedEmploymentType,
        normalizedAccountStatus,
      );
      if (normalizedRole === 'client') {
        await syncClientAssignment(client, userId, payload.assignedEmployeeId || null, normalizeShiftType(payload.assignmentShiftType));
      }
      return createdProfile;
    });
  } catch (error) {
    try {
      await admin.auth.admin.deleteUser(userId);
    } catch (cleanupError) {
      console.error('[userService] Failed cleanup after profile insert failure', cleanupError);
    }
    throw error;
  }
  console.log('[userService] Profile inserted', { email, profileId: profile?.id });

  return { profile, status: 'Active' as const, emailSent: true };
}
export async function inviteUserAccount(admin: any, payload: { name: string; email: string; role: Role; departmentId: string | null }) {
  const email = normalizeEmail(payload.email);
  const normalizedRole = normalizeRole(payload.role);
  await ensureUserDoesNotExist(admin, email);

  let authUser: any = null;
  let inviteResponse: any = null;
  let emailSent = true;

  const attemptInvite = async () => {
    if (typeof admin.auth.admin.inviteUserByEmail === 'function') {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (!error) {
        inviteResponse = data;
        authUser = data?.user || data || null;
        return;
      }

      console.error('[userService] inviteUserByEmail failed', { email, error });
      const message = String(error?.message || '').toLowerCase();
      if (message.includes('already registered')) {
        throw new UserServiceError(409, 'User already exists');
      }
      if (message.includes('rate limit') || message.includes('too many')) {
        throw new UserServiceError(
          429,
          'Supabase email rate limit reached. Configure custom SMTP under Project Settings → Auth → SMTP Settings.'
        );
      }
    }

    if (typeof admin.auth.admin.generateLink === 'function') {
      try {
        console.warn('[userService] inviteUserByEmail unavailable; using generateLink fallback.');
        const { data, error } = await admin.auth.admin.generateLink({ type: 'invite', email, redirectTo });
        if (error) throw error;
        inviteResponse = data;
        authUser = data?.user || data || null;
        return;
      } catch (fallbackError) {
        console.error('[userService] generateLink fallback failed', fallbackError);
      }
    }

    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: false });
    if (error) throw error;
    console.warn('[userService] Created user via createUser fallback; sending SMTP invite manually.');
    inviteResponse = data;
    authUser = data?.user || data || null;
  };

  try {
    await attemptInvite();
  } catch (error) {
    if (error instanceof UserServiceError) throw error;
    const message = String((error as any)?.message || 'Unknown error');
    throw new UserServiceError(502, `Failed to send invitation email: ${message}`);
  }

  let userId = authUser?.id || inviteResponse?.user?.id || inviteResponse?.id || null;
  if (!userId) {
    const created = await getAuthUserByEmail(admin, email);
    userId = created?.id || null;
  }

  if (!userId) {
    throw new Error('Unable to determine invited user id');
  }

  try {
    const profile = await withTransaction(async (client) => {
      return await insertProfile(client, userId, payload.name, email, normalizedRole, payload.departmentId);
    });

    const inviteUrl = typeof redirectTo === 'string' && redirectTo
      ? `${redirectTo}/auth/confirm?email=${encodeURIComponent(email)}`
      : `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/login`;

    try {
      if (hasSmtpConfig()) {
        await sendInviteEmail({ to: email, name: payload.name, role: normalizedRole, actionUrl: inviteUrl });
      } else if (typeof admin.auth.admin.inviteUserByEmail === 'function') {
        const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
        if (error) throw error;
      } else if (typeof admin.auth.admin.generateLink === 'function') {
        const { error } = await admin.auth.admin.generateLink({ type: 'invite', email, redirectTo });
        if (error) throw error;
      } else {
        emailSent = false;
      }
    } catch (mailError) {
      emailSent = false;
      console.error('[userService] Failed to send invite email', { email, error: mailError });
    }

    return { profile, status: 'Invited' as const, emailSent };
  } catch (error) {
    try {
      await admin.auth.admin.deleteUser(userId);
    } catch (cleanupError) {
      console.error('[userService] Failed cleanup after invite creation failure', cleanupError);
    }
    throw error;
  }
}

export async function resendInvite(admin: any, email: string) {
  const normalized = normalizeEmail(email);
  const profile = await findProfileByEmail(normalized);

  if (!profile) {
    throw new UserServiceError(404, 'User not found');
  }

  let authUser = null;
  try {
    authUser = await getAuthUserByEmail(admin, normalized);
  } catch (error) {
    console.warn('[userService] getAuthUserByEmail failed during resend invite', error);
  }

  if (authUser?.email_confirmed_at || authUser?.confirmed_at) {
    throw new UserServiceError(400, 'User is already active');
  }

  console.log('[userService] Resending invitation', { email: normalized });

  let response: any = null;
  if (typeof admin.auth.admin.generateLink === 'function') {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'signup', email: normalized, redirectTo });
    if (error) throw error;
    response = data;
  }

  if (!response && typeof admin.auth.admin.inviteUserByEmail === 'function') {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(normalized, { redirectTo });
    if (error) {
      throw new UserServiceError(502, `Failed to resend invite email: ${error?.message || 'Unknown error'}`);
    }
    response = data;
  }

  const inviteUrl = typeof redirectTo === 'string' && redirectTo
    ? `${redirectTo}/auth/confirm?email=${encodeURIComponent(normalized)}`
    : `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/login`;
  if (profile && hasSmtpConfig()) {
    await sendInviteEmail({ to: normalized, name: profile.full_name || normalized, role: profile.role || 'admin', actionUrl: inviteUrl });
  } else if (!response) {
    throw new UserServiceError(502, 'Invitation email delivery is unavailable. Configure SMTP or Supabase email settings.');
  }

  return response || { ok: true };
}

export async function resendVerification(admin: any, email: string) {
  const normalized = normalizeEmail(email);
  const profile = await findProfileByEmail(normalized);

  if (!profile) {
    throw new UserServiceError(404, 'User not found');
  }

  let authUser = null;
  try {
    authUser = await getAuthUserByEmail(admin, normalized);
  } catch (error) {
    console.warn('[userService] getAuthUserByEmail failed during resend verification', error);
  }

  if (authUser?.email_confirmed_at || authUser?.confirmed_at) {
    throw new UserServiceError(400, 'User is already active');
  }

  console.log('[userService] Resending verification', { email: normalized });

  let response: any = null;
  if (typeof admin.auth.admin.generateLink === 'function') {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'signup', email: normalized, redirectTo });
    if (error) throw error;
    response = data;
  }

  if (!response && typeof admin.auth.admin.inviteUserByEmail === 'function') {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(normalized, { redirectTo });
    if (error) {
      throw new UserServiceError(502, `Failed to resend verification email: ${error?.message || 'Unknown error'}`);
    }
    response = data;
  }

  const verifyUrl = typeof redirectTo === 'string' && redirectTo
    ? `${redirectTo}/auth/confirm?email=${encodeURIComponent(normalized)}`
    : `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/login`;
  if (profile && hasSmtpConfig()) {
    await sendVerificationEmail({ to: normalized, name: profile.full_name || normalized, actionUrl: verifyUrl });
  } else if (!response) {
    throw new UserServiceError(502, 'Verification email delivery is unavailable. Configure SMTP or Supabase email settings.');
  }

  return response || { ok: true };
}

export async function sendPasswordReset(admin: any, email: string) {
  const normalized = normalizeEmail(email);
  if (typeof admin.auth.admin.generateLink !== 'function') {
    throw new Error('Supabase password reset not available');
  }
  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email: normalized, redirectTo });
  if (error) throw error;
  return data;
}

export async function deleteUserAndProfile(admin: any, id: string) {
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

  try {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) {
      if (String(error?.message || '').toLowerCase().includes('not found')) {
        console.warn('[userService] Auth user not found during delete, skipping');
        return;
      }
      throw error;
    }
  } catch (e: any) {
    if (String(e?.message || '').toLowerCase().includes('not found')) {
      console.warn('[userService] Auth user not found during delete, skipping');
      return;
    }
    throw e;
  }
}
