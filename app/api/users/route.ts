// app/api/users/route.ts
import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { assertSupabaseAdmin } from '@/lib/supabase';
import { requireAuth, ok, err } from '@/lib/api';
import {
  canManageUsers,
  canViewUserManagement,
  canMonitorAll,
  canDeleteRecords,
  isInactiveAccountStatus,
  normalizeAccountStatus,
  normalizeEmploymentType,
  normalizeRole,
  normalizeShiftType,
  type Role,
} from '@/lib/roles';
import { ensureRoleFeatureSchema } from '@/lib/schema';
import {
  createEmployeeAccount,
  deleteUserAndProfile,
  deriveStatusFromAuthUser,
  listAssignedEmployeesForClient,
  UserServiceError,
} from '@/lib/user';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  await ensureRoleFeatureSchema();

  const role = normalizeRole(user.role);
  const { sub } = user;

  let rows;

  if (canViewUserManagement(role)) {
    rows = await sql`
      SELECT
        p.id,
        p.full_name,
        p.full_name AS name,
        p.email,
        p.role,
        p.department_id,
        p.employee_code,
        p.shift_type,
        p.employment_type,
        p.account_status,
        p.created_at,
        d.name AS department_name,
        ca.employee_id AS assigned_employee_id,
        ca.shift_type AS assignment_shift_type,
        employee.full_name AS assigned_employee_name
      FROM public.profiles p
      LEFT JOIN departments d ON d.id = p.department_id
      LEFT JOIN client_assignments ca ON ca.client_id = p.id
      LEFT JOIN public.profiles employee ON employee.id = ca.employee_id
      ORDER BY p.full_name
    `;
  } else if (role === 'client') {
    rows = await listAssignedEmployeesForClient(sub);
  } else if (canMonitorAll(role)) {
    rows = await sql`
      SELECT
        p.id,
        p.full_name,
        p.full_name AS name,
        p.email,
        p.role,
        p.department_id,
        p.employee_code,
        p.shift_type,
        p.employment_type,
        p.account_status
      FROM public.profiles p
      WHERE p.role = 'employee'
      ORDER BY p.full_name
    `;
  } else {
    return err('Forbidden', 403);
  }

  // Enrich rows with auth status (Active / Invited / Pending Verification / Disabled).
  //
  // Previously this did one admin.auth.admin.getUserById() call PER ROW inside a
  // try/catch that silently swallowed any error ("ignore per-user errors"), and the
  // outer try/catch silently returned rows with NO status field at all if
  // assertSupabaseAdmin() failed. Either failure mode makes every user look like
  // 'Unknown' in the UI with zero indication of why — which hides real invite
  // status and makes the "Resend invite" button disappear even for users who
  // genuinely are Invited.
  //
  // Fetching all auth users once via listUsers() instead of N individual calls
  // is both more reliable (one call to fail/rate-limit instead of N) and gives
  // us a single place to log what went wrong.
  try {
    const admin = assertSupabaseAdmin();

    const authUsersById = new Map<string, any>();
    let page = 1;
    const perPage = 1000;
    // Paginate in case there are more than 1000 auth users.
    while (true) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
      if (error) {
        console.error('[users:GET] listUsers failed', { page, error });
        break;
      }
      const batch = data?.users || [];
      for (const u of batch) {
        authUsersById.set(u.id, u);
      }
      if (batch.length < perPage) break;
      page += 1;
    }

    const enriched = rows.map((r: any) => {
      const normalizedRowRole = normalizeRole(r.role);
      if (isInactiveAccountStatus(r.account_status)) {
        return { ...r, role: normalizedRowRole, status: 'Disabled' };
      }
      const authUser = authUsersById.get(r.id);
      if (!authUser) {
        const fallbackStatus = ['superadmin', 'admin', 'hr', 'executive', 'client', 'qa_manager', 'qa_lead', 'qa'].includes(normalizedRowRole)
          ? 'Invited'
          : 'Pending Verification';
        return { ...r, role: normalizedRowRole, status: fallbackStatus };
      }
      return { ...r, role: normalizedRowRole, status: deriveStatusFromAuthUser(authUser) };
    });

    return ok(enriched);
  } catch (e) {
    console.error('[users:GET] Failed to enrich rows with auth status — returning rows with status=Unknown', e);
    return ok(rows.map((r: any) => ({ ...r, status: 'Unknown' })));
  }
}

export async function POST(req: NextRequest) {
  const authUser = requireAuth(req);
  if ('status' in authUser) return authUser;
  if (!canManageUsers(normalizeRole(authUser.role))) return err('Forbidden', 403);
  await ensureRoleFeatureSchema();

  let admin;
  try {
    admin = assertSupabaseAdmin();
  } catch (e: any) {
    console.error('[users:POST] Supabase admin unavailable:', e?.message || e);
    return err(e?.message || 'Server misconfigured: Supabase admin unavailable', 500);
  }

  const {
    name,
    email: rawEmail,
    role,
    departmentId,
    password,
    shiftType,
    employmentType,
    accountStatus,
    assignedEmployeeId,
    assignmentShiftType,
  } = await req.json();
  const email = String(rawEmail || '').trim().toLowerCase();
  const normalizedRole = normalizeRole(role);
  const normalizedShiftType = normalizeShiftType(shiftType);
  const normalizedEmploymentType = normalizeEmploymentType(employmentType);
  const normalizedAccountStatus = normalizeAccountStatus(accountStatus);
  const normalizedAssignmentShiftType = normalizeShiftType(assignmentShiftType);
  if (!name || !email || !normalizedRole) {
    return err('name, email and role are required');
  }

  const allowedRoles: Role[] = ['superadmin', 'admin', 'hr', 'executive', 'client', 'qa_manager', 'qa_lead', 'qa', 'employee'];
  if (!allowedRoles.includes(normalizedRole)) {
    return err('Invalid role', 400);
  }

  if (normalizeRole(authUser.role) === 'admin' && normalizedRole === 'superadmin') {
    return err('Admins cannot create a super admin account.', 403);
  }

  if (normalizeRole(authUser.role) === 'hr' && ['superadmin', 'admin'].includes(normalizedRole)) {
    return err('HR cannot create super admin or admin accounts.', 403);
  }

  if (normalizedRole === 'superadmin') {
    const existingSuperAdmins = await sql`SELECT id FROM public.profiles WHERE role = 'superadmin' LIMIT 2`;
    if (existingSuperAdmins.length >= 2) {
      return err('Only two super admin accounts are allowed.', 403);
    }
  }

  if (normalizedRole !== 'client' && assignedEmployeeId) {
    return err('Only client accounts can have an assigned employee.', 400);
  }

  const safeDeptId =
    departmentId && String(departmentId).trim() !== '' ? departmentId : null;
  const safeAssignedEmployeeId =
    assignedEmployeeId && String(assignedEmployeeId).trim() !== '' ? String(assignedEmployeeId).trim() : null;

  if (normalizedRole === 'employee' && !safeDeptId) {
    return err('Department is required for employee accounts', 400);
  }

  console.log('[users:POST] create request', {
    email,
    role: normalizedRole,
    departmentId: safeDeptId,
    assignedEmployeeId: safeAssignedEmployeeId,
    assignmentShiftType: normalizedAssignmentShiftType,
    shiftType: normalizedShiftType,
    employmentType: normalizedEmploymentType,
    accountStatus: normalizedAccountStatus,
  });

  const payload = {
    name,
    email,
    role: normalizedRole,
    departmentId: safeDeptId,
    shiftType: normalizedShiftType,
    employmentType: normalizedEmploymentType,
    accountStatus: normalizedAccountStatus,
    assignedEmployeeId: safeAssignedEmployeeId,
    assignmentShiftType: normalizedAssignmentShiftType,
  };

  try {
    if (!password || typeof password !== 'string' || password.length < 8) {
      return err('Password must be at least 8 characters', 400);
    }

    // Every role gets an admin-set password + credentials email.
    const { profile, status, emailSent } = await createEmployeeAccount(admin, { ...payload, password });

    return ok({ ...profile, status, emailSent }, 201);
  } catch (e: any) {
    console.error('[users:POST] create error:', e);
    if (e instanceof UserServiceError) return err(e.message, e.status);
    if (String(e?.message || '').toLowerCase().includes('already registered')) return err('User already exists', 409);
    return err(e?.message || 'Failed to create user', 500);
  }
}
export async function DELETE(req: NextRequest) {
  const authUser = requireAuth(req);
  if ('status' in authUser) return authUser;
  if (!canDeleteRecords(normalizeRole(authUser.role))) return err('Forbidden', 403);

  let admin;
  try {
    admin = assertSupabaseAdmin();
  } catch (e: any) {
    console.error('[users:DELETE] Supabase admin unavailable:', e?.message || e);
    return err(e?.message || 'Server misconfigured: Supabase admin unavailable', 500);
  }

  const { id } = await req.json();
  if (!id) return err('User id is required', 400);
  if (authUser.sub === id) return err('You cannot delete your own account.', 403);

  const [targetUser] = await sql`SELECT role FROM public.profiles WHERE id = ${id} LIMIT 1`;
  if (normalizeRole(targetUser?.role) === 'superadmin') {
    return err('The super admin account cannot be deleted.', 403);
  }

  try {
    await deleteUserAndProfile(admin, id);
    return ok({ ok: true });
  } catch (e: any) {
    console.error('[users:DELETE] delete error:', e);
    if (e instanceof UserServiceError) return err(e.message, e.status);
    return err(e?.message || 'Failed to delete user', 500);
  }
}

export async function PATCH(req: NextRequest) {
  const authUser = requireAuth(req);
  if ('status' in authUser) return authUser;
  const actorRole = normalizeRole(authUser.role);
  await ensureRoleFeatureSchema();

  let admin;
  try {
    admin = assertSupabaseAdmin();
  } catch (e: any) {
    console.error('[users:PATCH] Supabase admin unavailable:', e?.message || e);
    return err(e?.message || 'Server misconfigured: Supabase admin unavailable', 500);
  }

  const body = await req.json();
  const {
    id,
    name,
    email: rawEmail,
    role,
    departmentId,
    password,
    disabled,
    shiftType,
    employmentType,
    accountStatus,
    assignedEmployeeId,
    assignmentShiftType,
  } = body;
  if (!id) return err('User id is required', 400);

  // Allow if the requester can manage users, or if they're editing their own profile
  const isAdmin = canManageUsers(actorRole);
  const isSelf = authUser.sub === id;
  if (!isAdmin && !isSelf) return err('Forbidden', 403);
  if (actorRole === 'admin') {
    const [targetUser] = await sql`SELECT role FROM public.profiles WHERE id = ${id} LIMIT 1`;
    if (normalizeRole(targetUser?.role) === 'superadmin') return err('Admins cannot modify a super admin account.', 403);
  }
  if (actorRole === 'hr') {
    const [targetUser] = await sql`SELECT role FROM public.profiles WHERE id = ${id} LIMIT 1`;
    if (['superadmin', 'admin'].includes(normalizeRole(targetUser?.role))) {
      return err('HR cannot modify super admin or admin accounts.', 403);
    }
  }

  const nextRole = role === undefined ? undefined : normalizeRole(role);
  const nextShiftType = shiftType === undefined ? undefined : normalizeShiftType(shiftType);
  const nextEmploymentType = employmentType === undefined ? undefined : normalizeEmploymentType(employmentType);
  const nextAccountStatus = accountStatus === undefined ? undefined : normalizeAccountStatus(accountStatus);

  if (role !== undefined) {
    if (actorRole === 'admin' && nextRole === 'superadmin') {
      return err('Admins cannot create a super admin account.', 403);
    }
    if (nextRole && actorRole === 'hr' && ['superadmin', 'admin'].includes(nextRole)) {
      return err('HR cannot assign super admin or admin roles.', 403);
    }

    if (nextRole === 'superadmin') {
      const existingSuperAdmins = await sql`SELECT id FROM public.profiles WHERE role = 'superadmin' AND id != ${id} LIMIT 2`;
      if (existingSuperAdmins.length >= 2) {
        return err('Only two super admin accounts are allowed.', 403);
      }
    }
  }

  const email = rawEmail === undefined ? undefined : String(rawEmail || '').trim().toLowerCase();
  const safeDeptId =
    departmentId === undefined
      ? undefined
      : departmentId && String(departmentId).trim() !== ''
      ? departmentId
      : null;
  const safeAssignedEmployeeId =
    assignedEmployeeId === undefined
      ? undefined
      : assignedEmployeeId && String(assignedEmployeeId).trim() !== ''
      ? String(assignedEmployeeId).trim()
      : null;
  const safeAssignmentShiftType =
    assignmentShiftType === undefined
      ? undefined
      : normalizeShiftType(assignmentShiftType);

  const currentUserRows = await sql`SELECT role, department_id, employment_type, account_status FROM public.profiles WHERE id = ${id} LIMIT 1`;
  const currentUser = currentUserRows?.[0];
  const resolvedRoleForValidation = nextRole !== undefined ? nextRole : normalizeRole(currentUser?.role);
  const resolvedDeptForValidation = safeDeptId !== undefined ? safeDeptId : currentUser?.department_id ?? null;

  if (resolvedRoleForValidation === 'employee' && !resolvedDeptForValidation) {
    return err('Department is required for employee accounts', 400);
  }

  if (!isAdmin && role !== undefined) return err('Forbidden', 403);
  if (!isAdmin && departmentId !== undefined) return err('Forbidden', 403);
  if (!isAdmin && assignedEmployeeId !== undefined) return err('Forbidden', 403);
  if (!isAdmin && assignmentShiftType !== undefined) return err('Forbidden', 403);
  if (!isAdmin && shiftType !== undefined) return err('Forbidden', 403);
  if (!isAdmin && employmentType !== undefined) return err('Forbidden', 403);
  if (!isAdmin && accountStatus !== undefined) return err('Forbidden', 403);

  if (accountStatus !== undefined && actorRole !== 'superadmin') {
    if (isInactiveAccountStatus(currentUser?.account_status) && !isInactiveAccountStatus(nextAccountStatus)) {
      return err('Only super admin can reactivate left or terminated accounts.', 403);
    }
  }

  const authPayload: Record<string, unknown> = {};
  if (email !== undefined) authPayload.email = email;
  if (password !== undefined && password !== '') {
    if (typeof password !== 'string') return err('Password must be a string', 400);
    if (password.length < 8) return err('Password must be at least 8 characters', 400);
    authPayload.password = password;
  }

  if (Object.keys(authPayload).length > 0) {
    // Validate password complexity server-side to avoid Supabase throwing AuthWeakPasswordError
    if (authPayload.password) {
      const pw = String(authPayload.password);
      const complexity = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_\-+=[\]{};':"\\|<>,./?`~])/;
      if (!complexity.test(pw)) {
        return err(
          'Password must include at least one lowercase letter, one uppercase letter, one digit, and one special character',
          400
        );
      }
    }

    try {
      const { error: authError } = await admin.auth.admin.updateUserById(id, authPayload as any);
      if (authError) {
        console.error('Supabase auth update error:', authError);
        if (authError.message?.includes('already registered')) return err('Email already exists in auth', 409);
        if (authError.message?.toLowerCase().includes('password') || authError.name === 'AuthWeakPasswordError') {
          return err(authError.message || 'Password does not meet complexity requirements', 400);
        }
        return err('Failed to update auth user', 500);
      }
    } catch (e: any) {
      console.error('Supabase auth update exception:', e);
      if (String(e?.message || '').toLowerCase().includes('password')) {
        return err(String(e.message), 400);
      }
      return err('Failed to update auth user', 500);
    }
  }

  // If disabling/enabling, call Supabase admin API
  //
  // NOTE: this reuses `email_confirm` as a disable flag (email_confirm: !disabled).
  // Be aware that toggling this ON (i.e. "enabling" a user) also marks their email
  // as confirmed, which will flip an Invited user straight to Active even if they
  // never actually clicked their invite link and set a password. If you only ever
  // call this for genuinely-active users being re-enabled, this is fine — but don't
  // wire "enable" up to invited-but-not-yet-confirmed users expecting it to be a
  // no-op on their invite status.
  if (typeof disabled === 'boolean') {
    try {
      const { error } = await admin.auth.admin.updateUserById(id, { email_confirm: !disabled });
      if (error) console.error('Failed to update disabled flag on auth user:', error);
    } catch (e) { console.error('Failed to update disabled flag', e); }
  }

  if (accountStatus !== undefined) {
    try {
      const { error } = await admin.auth.admin.updateUserById(id, {
        user_metadata: {
          banned: isInactiveAccountStatus(nextAccountStatus),
        },
      } as any);
      if (error) console.error('Failed to update account status metadata on auth user:', error);
    } catch (e) { console.error('Failed to update account status metadata', e); }
  }

  try {
    const resolvedEmploymentTypeForUpdate =
      nextEmploymentType === undefined ? currentUser?.employment_type ?? null : nextEmploymentType;
    const resolvedAccountStatusForUpdate =
      nextAccountStatus === undefined ? currentUser?.account_status ?? null : nextAccountStatus;

    await sql`
      UPDATE public.profiles
      SET
        full_name     = COALESCE(${name},            full_name),
        email         = COALESCE(${email},           email),
        role          = COALESCE(${nextRole as Role},    role),
        department_id = COALESCE(${safeDeptId},      department_id),
        shift_type    = COALESCE(${nextShiftType},   shift_type),
        employment_type = ${resolvedEmploymentTypeForUpdate},
        account_status  = ${resolvedAccountStatusForUpdate},
        updated_at    = NOW()
      WHERE id = ${id}
    `;

    const resolvedRole = nextRole !== undefined
      ? nextRole
      : normalizeRole((await sql`SELECT role FROM public.profiles WHERE id = ${id} LIMIT 1`)[0]?.role);

    if (resolvedRole !== 'client') {
      await sql`DELETE FROM client_assignments WHERE client_id = ${id}`;
    } else if (safeAssignedEmployeeId !== undefined || safeAssignmentShiftType !== undefined || nextRole === 'client') {
      const currentAssignmentRows = await sql`
        SELECT employee_id, shift_type
        FROM client_assignments
        WHERE client_id = ${id}
        LIMIT 1
      `;
      const currentAssignment = currentAssignmentRows[0];
      const nextAssignedEmployeeId =
        safeAssignedEmployeeId !== undefined ? safeAssignedEmployeeId : currentAssignment?.employee_id || null;
      const nextAssignmentShift =
        safeAssignmentShiftType !== undefined ? safeAssignmentShiftType : normalizeShiftType(currentAssignment?.shift_type);

      if (nextAssignedEmployeeId) {
        const [employeeRow] = await sql`
          SELECT full_name, role
          FROM public.profiles
          WHERE id = ${nextAssignedEmployeeId}
          LIMIT 1
        `;
        if (!employeeRow || normalizeRole(employeeRow.role) !== 'employee') {
          return err('Assigned user must be an employee.', 400);
        }

        const conflictRows = await sql`
          SELECT ca.client_id, ca.shift_type, p.full_name AS client_name, employee.full_name AS employee_name
          FROM client_assignments ca
          JOIN public.profiles p ON p.id = ca.client_id
          JOIN public.profiles employee ON employee.id = ca.employee_id
          WHERE ca.employee_id = ${nextAssignedEmployeeId}
            AND ca.client_id <> ${id}
        `;
        const conflictingAssignment = conflictRows.find((row: any) => {
          const existingShift = normalizeShiftType(row.shift_type);
          return existingShift === 'full_time' || nextAssignmentShift === 'full_time' || existingShift === nextAssignmentShift;
        });
          if (conflictingAssignment) {
            const existingShift = normalizeShiftType(conflictingAssignment.shift_type);
            const label = existingShift === 'first_half'
            ? 'First Half (20:00-00:00 PKT)'
              : existingShift === 'second_half'
            ? 'Second Half (01:00-05:00 PKT)'
            : 'Full Time (20:00-00:00 & 01:00-05:00 PKT)';
            return err(`${conflictingAssignment.employee_name} is already assigned to ${conflictingAssignment.client_name} for ${label}.`, 409);
          }

        await sql`DELETE FROM client_assignments WHERE client_id = ${id}`;

        await sql`
          INSERT INTO client_assignments (client_id, employee_id, shift_type)
          VALUES (${id}, ${nextAssignedEmployeeId}, ${nextAssignmentShift})
          ON CONFLICT (client_id, employee_id)
          DO UPDATE SET shift_type = EXCLUDED.shift_type, created_at = NOW()
        `;
      } else {
        await sql`DELETE FROM client_assignments WHERE client_id = ${id}`;
      }
    }
  } catch (e: any) {
    console.error('Update profile error:', e);
    if (e instanceof UserServiceError) return err(e.message, e.status);
    if (e.code === '23505') return err('Email already exists', 409);
    return err(e?.message || 'Failed to update user profile', 500);
  }

  return ok({ ok: true });
}
