import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, ok, err, getErrorMessage } from '@/lib/api';
import { hashPassword } from '@/lib/password';
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
        p.password_hash,
        p.reset_token,
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
        p.account_status,
        p.password_hash,
        p.reset_token
      FROM public.profiles p
      WHERE p.role = 'employee'
      ORDER BY p.full_name
    `;
  } else {
    return err('Forbidden', 403);
  }

  try {
    const enriched = rows.map((row: any) => ({
      ...row,
      role: normalizeRole(row.role),
      status: deriveStatusFromAuthUser(row),
    }));

    return ok(enriched);
  } catch (e) {
    console.error('[users:GET] Failed to derive user status, returning Unknown', e);
    return ok(rows.map((row: any) => ({ ...row, status: 'Unknown' })));
  }
}

export async function POST(req: NextRequest) {
  const authUser = requireAuth(req);
  if ('status' in authUser) return authUser;
  if (!canManageUsers(normalizeRole(authUser.role))) return err('Forbidden', 403);
  await ensureRoleFeatureSchema();

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

  const safeDeptId = departmentId && String(departmentId).trim() !== '' ? departmentId : null;
  const safeAssignedEmployeeId = assignedEmployeeId && String(assignedEmployeeId).trim() !== '' ? String(assignedEmployeeId).trim() : null;

  if (normalizedRole === 'employee' && !safeDeptId) {
    return err('Department is required for employee accounts', 400);
  }

  try {
    if (!password || typeof password !== 'string' || password.length < 8) {
      return err('Password must be at least 8 characters', 400);
    }
    const passwordComplexity = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_\-+=[\]{};':"\\|<>,./?`~])/;
    if (!passwordComplexity.test(password)) {
      return err(
        'Password must include at least one lowercase letter, one uppercase letter, one digit, and one special character',
        400
      );
    }

    const { profile, status, emailSent, emailError } = await createEmployeeAccount({
      name,
      email,
      role: normalizedRole,
      departmentId: safeDeptId,
      password,
      shiftType: normalizedShiftType,
      employmentType: normalizedEmploymentType,
      accountStatus: normalizedAccountStatus,
      assignedEmployeeId: safeAssignedEmployeeId,
      assignmentShiftType: normalizedAssignmentShiftType,
    });

    return ok({ ...profile, status, emailSent, emailError }, 201);
  } catch (e: any) {
    console.error('[users:POST] create error:', e);
    if (e instanceof UserServiceError) return err(e.message, e.status);
    return err(getErrorMessage(e, 'Failed to create user'), 500);
  }
}

export async function DELETE(req: NextRequest) {
  const authUser = requireAuth(req);
  if ('status' in authUser) return authUser;
  if (!canDeleteRecords(normalizeRole(authUser.role))) return err('Forbidden', 403);

  const { id } = await req.json();
  if (!id) return err('User id is required', 400);
  if (authUser.sub === id) return err('You cannot delete your own account.', 403);

  const [targetUser] = await sql`SELECT role FROM public.profiles WHERE id = ${id} LIMIT 1`;
  if (normalizeRole(targetUser?.role) === 'superadmin') {
    return err('The super admin account cannot be deleted.', 403);
  }

  try {
    await deleteUserAndProfile(id);
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

  const currentUserRows = await sql`
    SELECT role, department_id, employment_type, account_status, password_hash
    FROM public.profiles
    WHERE id = ${id}
    LIMIT 1
  `;
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

  if (email !== undefined) {
    const existingEmailRows = await sql`
      SELECT id
      FROM public.profiles
      WHERE LOWER(email) = ${email}
        AND id <> ${id}
      LIMIT 1
    `;
    if (existingEmailRows.length > 0) {
      return err('Email already exists', 409);
    }
  }

  let nextPasswordHash: string | undefined;
  if (password !== undefined && password !== '') {
    if (typeof password !== 'string') return err('Password must be a string', 400);
    if (password.length < 8) return err('Password must be at least 8 characters', 400);
    const complexity = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_\-+=[\]{};':"\\|<>,./?`~])/;
    if (!complexity.test(password)) {
      return err(
        'Password must include at least one lowercase letter, one uppercase letter, one digit, and one special character',
        400
      );
    }
    nextPasswordHash = await hashPassword(password);
  }

  const resolvedEmploymentTypeForUpdate =
    nextEmploymentType === undefined ? currentUser?.employment_type ?? null : nextEmploymentType;
  const resolvedAccountStatusForUpdate =
    nextAccountStatus === undefined ? currentUser?.account_status ?? null : nextAccountStatus;
  const finalAccountStatus =
    typeof disabled === 'boolean'
      ? (disabled ? 'terminated' : (resolvedAccountStatusForUpdate || 'active'))
      : resolvedAccountStatusForUpdate;

  try {
    await sql`
      UPDATE public.profiles
      SET
        full_name = COALESCE(${name}, full_name),
        email = COALESCE(${email}, email),
        role = COALESCE(${nextRole as Role}, role),
        department_id = COALESCE(${safeDeptId}, department_id),
        password_hash = COALESCE(${nextPasswordHash}, password_hash),
        shift_type = COALESCE(${nextShiftType}, shift_type),
        employment_type = ${resolvedEmploymentTypeForUpdate},
        account_status = ${finalAccountStatus},
        updated_at = NOW()
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
