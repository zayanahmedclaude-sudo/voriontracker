'use client';

import { useEffect, useMemo, useState } from 'react';
import { getRoleLabel, useAuthStore } from '@/store/auth';
import {
  accountStatusLabel,
  canManageUsers,
  canViewUserManagement,
  employmentTypeLabel,
  isInactiveAccountStatus,
  normalizeRole,
  normalizeShiftType,
} from '@/lib/roles';

const BRAND = {
  black: '#0A0E1A',
  blackSoft: '#10182B',
  white: '#F5F7FA',
  blue: '#1E5AE0',
  blueSoft: 'rgba(30,90,224,.16)',
  yellow: '#F5C400',
  border: 'rgba(245,247,250,.08)',
  muted: 'rgba(245,247,250,.5)',
  danger: '#FF5C7A',
};

const ROLES = ['superadmin', 'admin', 'hr', 'executive', 'client', 'qa_manager', 'qa_lead', 'qa', 'employee'];
const EMPLOYMENT_TYPES = [
  { value: '', label: 'Employment type' },
  { value: 'probation', label: 'Probation' },
  { value: 'permanent', label: 'Permanent' },
  { value: 'internship', label: 'Internship' },
];
const ACCOUNT_STATUSES = [
  { value: '', label: 'Account status' },
  { value: 'active', label: 'Active' },
  { value: 'left', label: 'Left' },
  { value: 'terminated', label: 'Terminated' },
];

const ROLE_COLOR: Record<string, string> = {
  superadmin: '#B45CFF',
  admin: BRAND.blue,
  hr: '#38BDF8',
  executive: '#E879F9',
  client: '#F97316',
  qa_manager: '#2DD4BF',
  qa_lead: BRAND.yellow,
  qa: '#60A5FA',
  employee: 'rgba(245,247,250,.55)',
};

const baseInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '12px 14px',
  borderRadius: 14,
  border: `1px solid ${BRAND.border}`,
  background: 'rgba(245,247,250,.05)',
  color: BRAND.white,
};

interface DepartmentItem {
  id: string;
  name: string;
  description: string | null;
}

function getShiftLabel(shiftType: string) {
  const normalized = normalizeShiftType(shiftType);
  if (normalized === 'first_half') return 'First Half (20:00-00:00 PKT)';
  if (normalized === 'second_half') return 'Second Half (01:00-05:00 PKT)';
  return 'Full Time (20:00-00:00 & 01:00-05:00 PKT)';
}

function shiftsConflict(existingShift: string, nextShift: string) {
  const existing = normalizeShiftType(existingShift);
  const next = normalizeShiftType(nextShift);
  if (existing === 'full_time' || next === 'full_time') return true;
  return existing === next;
}

function responseErrorMessage(data: unknown, fallback: string) {
  if (typeof data === 'string' && data.trim()) return data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of ['error', 'message']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (value && typeof value === 'object') {
        const nested = value as Record<string, unknown>;
        if (typeof nested.message === 'string' && nested.message.trim()) return nested.message;
      }
    }
  }
  return fallback;
}

export default function UsersClient({ initialUsers }: { initialUsers: any[] }) {
  const { token, user } = useAuthStore();
  const [users, setUsers] = useState(initialUsers || []);
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '',
    email: '',
    role: 'employee',
    departmentId: '',
    password: '',
    confirmPassword: '',
    employmentType: '',
    accountStatus: '',
    assignedEmployeeId: '',
    assignmentShiftType: 'full_time',
  });

  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const actorRole = normalizeRole(user?.role);
  const canManage = canManageUsers(actorRole);
  const canView = canViewUserManagement(actorRole);
  const canDelete = actorRole === 'superadmin';
  const selectableRoles = useMemo(
    () => actorRole === 'hr' ? ROLES.filter((role) => role !== 'superadmin' && role !== 'admin') : ROLES,
    [actorRole],
  );
  const clients = useMemo(() => users.filter((entry) => normalizeRole(entry.role) === 'client'), [users]);
  const employees = useMemo(() => users.filter((entry) => normalizeRole(entry.role) === 'employee'), [users]);
  const employeeAssignments = useMemo(() => {
    const map = new Map<string, Array<{ clientId: string; clientName: string; shiftType: string }>>();
    for (const client of clients) {
      if (!client.assigned_employee_id) continue;
      const next = map.get(client.assigned_employee_id) || [];
      next.push({
        clientId: client.id,
        clientName: client.name,
        shiftType: client.assignment_shift_type || 'full_time',
      });
      map.set(client.assigned_employee_id, next);
    }
    return map;
  }, [clients]);

  const loadUsers = async () => {
    if (!headers) return;
    const res = await fetch('/api/users', { headers });
    const data = await res.json();
    setUsers(Array.isArray(data) ? data : []);
  };

  const loadDepartments = async () => {
    if (!headers) return;
    const res = await fetch('/api/departments', { headers });
    const data = await res.json();
    setDepartments(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    if (token) {
      void loadUsers();
      void loadDepartments();
    }
  }, [token]);

  const setField = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const resetForm = () => {
    setEditing(null);
    setForm({
      name: '',
      email: '',
      role: 'employee',
      departmentId: '',
      password: '',
      confirmPassword: '',
      employmentType: '',
      accountStatus: '',
      assignedEmployeeId: '',
      assignmentShiftType: 'full_time',
    });
  };

  const currentEmployeeAssignments = useMemo(() => {
    if (form.role !== 'client' || !form.assignedEmployeeId) return [];
    return (employeeAssignments.get(form.assignedEmployeeId) || []).filter((assignment) => assignment.clientId !== editing?.id);
  }, [editing?.id, employeeAssignments, form.assignedEmployeeId, form.role]);

  const availableShiftOptions = useMemo(() => {
    if (form.role !== 'client' || !form.assignedEmployeeId) {
      return [
        { value: 'full_time', label: getShiftLabel('full_time'), disabled: false },
        { value: 'first_half', label: getShiftLabel('first_half'), disabled: false },
        { value: 'second_half', label: getShiftLabel('second_half'), disabled: false },
      ];
    }

    return ['full_time', 'first_half', 'second_half'].map((value) => ({
      value,
      label: getShiftLabel(value),
      disabled: currentEmployeeAssignments.some((assignment) => shiftsConflict(assignment.shiftType, value)),
    }));
  }, [currentEmployeeAssignments, form.assignedEmployeeId, form.role]);

  useEffect(() => {
    if (form.role !== 'client') return;
    const currentOption = availableShiftOptions.find((option) => option.value === form.assignmentShiftType);
    if (currentOption && !currentOption.disabled) return;
    const firstAvailable = availableShiftOptions.find((option) => !option.disabled);
    setForm((prev) => ({
      ...prev,
      assignmentShiftType: firstAvailable?.value || '',
    }));
  }, [availableShiftOptions, form.assignmentShiftType, form.role]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage) return;
    setSaving(true);
    setError('');
    try {
      if (!form.name.trim()) return setError('Full name is required');
      if (form.role === 'employee' && !form.departmentId) return setError('Department is required for employee accounts');
      if (form.role === 'employee' && !departments.length) return setError('Create a department first, then assign the employee to it');
      if (form.role === 'client' && form.assignedEmployeeId && !form.assignmentShiftType) return setError('Select an assignment time for the client');
      if (form.role === 'client' && form.assignedEmployeeId && availableShiftOptions.every((option) => option.disabled)) {
        return setError('This employee has no available client time slots.');
      }
      if (!editing && (!form.password || !form.confirmPassword)) return setError('Password and confirm password are required');
      if ((form.password || form.confirmPassword) && form.password !== form.confirmPassword) return setError('Passwords do not match');

      const body: any = {
        ...(editing ? { id: editing.id } : {}),
        name: form.name,
        email: form.email,
        role: form.role,
        departmentId: form.departmentId,
        employmentType: form.employmentType,
        accountStatus: form.accountStatus,
        assignedEmployeeId: form.role === 'client' ? form.assignedEmployeeId : '',
        assignmentShiftType: form.role === 'client' ? form.assignmentShiftType : 'full_time',
      };
      if (form.password) body.password = form.password;

      const res = await fetch('/api/users', {
        method: editing ? 'PATCH' : 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(responseErrorMessage(data, 'Failed to save user'));

      setShow(false);
      resetForm();
      await loadUsers();
    } finally {
      setSaving(false);
    }
  }

  async function removeUser(entry: any) {
    if (!canDelete) return;
    if (!confirm(`Delete user ${entry.name}?`)) return;
    setSaving(true);
    try {
      const res = await fetch('/api/users', {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: entry.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(responseErrorMessage(data, 'Failed to delete user'));
      await loadUsers();
    } finally {
      setSaving(false);
    }
  }

  function startEdit(entry: any) {
    if (!canManage) return;
    setEditing(entry);
    setForm({
      name: entry.name || '',
      email: entry.email || '',
      role: normalizeRole(entry.role),
      departmentId: entry.department_id || '',
      password: '',
      confirmPassword: '',
      employmentType: entry.employment_type || '',
      accountStatus: entry.account_status || '',
      assignedEmployeeId: entry.assigned_employee_id || '',
      assignmentShiftType: entry.assignment_shift_type || 'full_time',
    });
    setShow(true);
  }

  if (!canView) {
    return (
      <div style={{ color: BRAND.white }}>
        <h1 style={{ fontSize: 34, fontWeight: 800, margin: 0 }}>User Management</h1>
        <p style={{ color: BRAND.muted, marginTop: 6 }}>Only Super Admin, Admin, HR, and QA Manager can access this view.</p>
      </div>
    );
  }

  return (
    <div style={{ color: BRAND.white }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 34, fontWeight: 800, margin: 0 }}>User Management</h1>
          <p style={{ color: BRAND.muted, marginTop: 6 }}>
            {canManage
              ? 'Manage users, employee departments, and client-to-employee assignments.'
              : 'QA Manager has view-only access to users, departments, and assignments.'}
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => { resetForm(); setShow(true); }}
            style={{ padding: '10px 18px', borderRadius: 14, border: 'none', background: `linear-gradient(90deg,${BRAND.blue},#4C8CFF)`, color: '#fff', fontWeight: 700, cursor: 'pointer' }}
          >
            Add User
          </button>
        )}
      </div>

      {show && canManage && (
        <div style={{ marginBottom: 20, background: 'rgba(16,24,43,.78)', border: `1px solid ${BRAND.border}`, borderRadius: 22, padding: 24 }}>
          <form onSubmit={save}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <input style={baseInput} value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="Full name" />
              <input style={baseInput} type="email" value={form.email} onChange={(e) => setField('email', e.target.value)} placeholder="Email" />
              <select style={baseInput} value={form.role} onChange={(e) => setField('role', e.target.value)}>
                {selectableRoles.map((role) => (
                  <option key={role} value={role} style={{ background: BRAND.blackSoft }}>
                    {getRoleLabel(role as any)}
                  </option>
                ))}
              </select>
              {form.role === 'employee' && (
                <>
                  <select style={baseInput} value={form.departmentId} onChange={(e) => setField('departmentId', e.target.value)}>
                    <option value="" style={{ background: BRAND.blackSoft }}>Select employee department</option>
                    {departments.map((department) => (
                      <option key={department.id} value={department.id} style={{ background: BRAND.blackSoft }}>
                        {department.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {form.role === 'client' && (
                <>
                  <select style={baseInput} value={form.assignedEmployeeId} onChange={(e) => setField('assignedEmployeeId', e.target.value)}>
                    <option value="" style={{ background: BRAND.blackSoft }}>No assigned employee</option>
                    {employees.map((employee) => (
                      <option key={employee.id} value={employee.id} style={{ background: BRAND.blackSoft }}>
                        {employee.name}
                      </option>
                    ))}
                  </select>
                  <select
                    style={baseInput}
                    value={form.assignmentShiftType}
                    onChange={(e) => setField('assignmentShiftType', e.target.value)}
                    disabled={!form.assignedEmployeeId}
                  >
                    {availableShiftOptions.map((option) => (
                      <option key={option.value} value={option.value} disabled={option.disabled} style={{ background: BRAND.blackSoft }}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {form.role !== 'employee' && (
                <select style={baseInput} value={form.departmentId} onChange={(e) => setField('departmentId', e.target.value)}>
                  <option value="" style={{ background: BRAND.blackSoft }}>No department</option>
                  {departments.map((department) => (
                    <option key={department.id} value={department.id} style={{ background: BRAND.blackSoft }}>
                      {department.name}
                    </option>
                  ))}
                </select>
              )}
              <select style={baseInput} value={form.employmentType} onChange={(e) => setField('employmentType', e.target.value)}>
                {EMPLOYMENT_TYPES.map((option) => (
                  <option key={option.value || 'blank'} value={option.value} style={{ background: BRAND.blackSoft }}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select style={baseInput} value={form.accountStatus} onChange={(e) => setField('accountStatus', e.target.value)}>
                {ACCOUNT_STATUSES.map((option) => {
                  const reactivatingInactiveAccount =
                    (option.value === '' || option.value === 'active') && actorRole !== 'superadmin' && isInactiveAccountStatus(editing?.account_status);
                  return (
                    <option key={option.value || 'blank'} value={option.value} disabled={reactivatingInactiveAccount} style={{ background: BRAND.blackSoft }}>
                      {option.label}
                    </option>
                  );
                })}
              </select>
              <input style={baseInput} type="password" value={form.password} onChange={(e) => setField('password', e.target.value)} placeholder={editing ? 'New password (optional)' : 'Password'} />
              <input style={baseInput} type="password" value={form.confirmPassword} onChange={(e) => setField('confirmPassword', e.target.value)} placeholder="Confirm password" />
            </div>

            {error && (
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 12, background: 'rgba(255,92,122,.1)', color: BRAND.danger }}>
                {error}
              </div>
            )}

            {form.role === 'client' && form.assignedEmployeeId && currentEmployeeAssignments.length > 0 && (
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 12, background: 'rgba(30,90,224,.12)', color: BRAND.white }}>
                {currentEmployeeAssignments.map((assignment) => `${assignment.clientName}: ${getShiftLabel(assignment.shiftType)}`).join(' | ')}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button type="submit" disabled={saving} style={{ padding: '10px 18px', borderRadius: 14, border: 'none', background: BRAND.blue, color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
                {saving ? 'Saving...' : editing ? 'Save changes' : 'Create user'}
              </button>
              <button type="button" onClick={() => setShow(false)} style={{ padding: '10px 18px', borderRadius: 14, border: `1px solid ${BRAND.border}`, background: 'transparent', color: BRAND.white }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div style={{ background: 'rgba(16,24,43,.78)', border: `1px solid ${BRAND.border}`, borderRadius: 22, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Name', 'Email', 'Role', 'Department', 'Employment', 'Account', 'Assignment Time', 'Assigned Employee', 'Status', ...(canManage || canDelete ? ['Actions'] : [])].map((heading) => (
                <th key={heading} style={{ textAlign: 'left', padding: '12px 16px', color: BRAND.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: `1px solid ${BRAND.border}` }}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((entry) => {
              const entryRole = normalizeRole(entry.role);
              const canEditEntry = canManage && !(actorRole === 'hr' && ['superadmin', 'admin'].includes(entryRole));
              const departmentName = departments.find((department) => department.id === entry.department_id)?.name || entry.department_name || '-';
              return (
                <tr key={entry.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                  <td style={{ padding: '12px 16px' }}>{entry.name}</td>
                  <td style={{ padding: '12px 16px' }}>{entry.email}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{
                      display: 'inline-flex',
                      padding: '6px 12px',
                      borderRadius: 999,
                      border: `1px solid ${ROLE_COLOR[entryRole]}40`,
                      color: ROLE_COLOR[entryRole],
                      background: 'rgba(245,247,250,.05)',
                    }}>
                      {getRoleLabel(entryRole)}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>{departmentName}</td>
                  <td style={{ padding: '12px 16px' }}>{employmentTypeLabel(entry.employment_type)}</td>
                  <td style={{ padding: '12px 16px' }}>{accountStatusLabel(entry.account_status)}</td>
                  <td style={{ padding: '12px 16px' }}>{entryRole === 'client' && entry.assignment_shift_type ? getShiftLabel(entry.assignment_shift_type) : '-'}</td>
                  <td style={{ padding: '12px 16px' }}>{entryRole === 'client' ? (entry.assigned_employee_name || '-') : '-'}</td>
                  <td style={{ padding: '12px 16px' }}>{entry.status || 'Unknown'}</td>
                  {(canManage || canDelete) && (
                    <td style={{ padding: '12px 16px' }}>
                      {canEditEntry && (
                        <button onClick={() => startEdit(entry)} style={{ padding: '8px 10px', borderRadius: 10, border: 'none', background: BRAND.blue, color: '#fff', cursor: 'pointer', fontWeight: 700 }}>
                          Edit
                        </button>
                      )}
                      {canDelete && (
                        <button onClick={() => removeUser(entry)} style={{ marginLeft: 8, padding: '8px 10px', borderRadius: 10, border: 'none', background: BRAND.danger, color: '#fff', cursor: 'pointer', fontWeight: 700 }}>
                          Delete
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
