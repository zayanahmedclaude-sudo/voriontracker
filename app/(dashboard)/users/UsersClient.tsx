'use client';

import { apiFetch } from '@/lib/api-client';

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
import { getClientShiftLabel } from '@/lib/shifts';

const BRAND = {
  black: '#0A0A0A',
  blackSoft: '#F7F8FB',
  white: '#0A0A0A',
  surface: '#FFFFFF',
  blue: '#0050B0',
  blueSoft: 'rgba(0,80,176,.08)',
  yellow: '#B54708',
  border: 'rgba(10,10,10,.10)',
  muted: 'rgba(10,10,10,.58)',
  mutedFaint: 'rgba(10,10,10,.38)',
  danger: '#B42318',
  successSoft: 'rgba(6,118,71,.08)',
  shadow: '0 18px 48px rgba(15,23,42,.06)',
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
  superadmin: '#7E22CE',
  admin: BRAND.blue,
  hr: '#0369A1',
  executive: '#A21CAF',
  client: '#C2410C',
  qa_manager: '#0F766E',
  qa_lead: '#92400E',
  qa: '#1D4ED8',
  employee: '#374151',
};

const panelStyle: React.CSSProperties = {
  background: BRAND.surface,
  border: `1px solid ${BRAND.border}`,
  borderRadius: 22,
  boxShadow: BRAND.shadow,
};

const baseInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '12px 14px',
  borderRadius: 14,
  border: `1px solid ${BRAND.border}`,
  background: '#FFFFFF',
  color: BRAND.white,
};

interface DepartmentItem {
  id: string;
  name: string;
  description: string | null;
}

function getViewerTimeZone() {
  if (typeof window === 'undefined') return 'UTC';
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function getShiftLabel(shiftType: string, timeZone = getViewerTimeZone()) {
  const normalized = normalizeShiftType(shiftType);
  return getClientShiftLabel(normalized, timeZone);
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
  const [deleting, setDeleting] = useState<any | null>(null);
  const [actionMenu, setActionMenu] = useState<{ id: string; top: number; right: number } | null>(null);
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [viewerTimeZone, setViewerTimeZone] = useState('UTC');
  const [filters, setFilters] = useState({
    search: '',
    role: '',
    departmentId: '',
    employmentType: '',
    accountStatus: '',
  });
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
  useEffect(() => {
    setViewerTimeZone(getViewerTimeZone());
  }, []);
  const selectableRoles = useMemo(
    () => actorRole === 'hr' ? ROLES.filter((role) => role !== 'superadmin' && role !== 'admin') : ROLES,
    [actorRole],
  );
  const clients = useMemo(() => users.filter((entry) => normalizeRole(entry.role) === 'client'), [users]);
  const employees = useMemo(() => users.filter((entry) => normalizeRole(entry.role) === 'employee'), [users]);
  const filteredUsers = useMemo(() => {
    const query = filters.search.trim().toLowerCase();

    return users.filter((entry) => {
      const entryRole = normalizeRole(entry.role);
      const departmentName = departments.find((department) => department.id === entry.department_id)?.name || entry.department_name || '';
      const matchesSearch =
        !query ||
        String(entry.name || '').toLowerCase().includes(query) ||
        String(entry.email || '').toLowerCase().includes(query) ||
        String(entry.assigned_employee_name || '').toLowerCase().includes(query) ||
        String(departmentName).toLowerCase().includes(query);

      const matchesRole = !filters.role || entryRole === filters.role;
      const matchesDepartment = !filters.departmentId || entry.department_id === filters.departmentId;
      const matchesEmploymentType = !filters.employmentType || (entry.employment_type || '') === filters.employmentType;
      const matchesAccountStatus = !filters.accountStatus || (entry.account_status || '') === filters.accountStatus;

      return matchesSearch && matchesRole && matchesDepartment && matchesEmploymentType && matchesAccountStatus;
    });
  }, [departments, filters.accountStatus, filters.departmentId, filters.employmentType, filters.role, filters.search, users]);
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
    const res = await apiFetch<Response>('/api/users', { headers });
    const data = await res.json();
    setUsers(Array.isArray(data) ? data : []);
  };

  const loadDepartments = async () => {
    if (!headers) return;
    const res = await apiFetch<Response>('/api/departments', { headers });
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

  const setFilter = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
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
        { value: 'full_time', label: getShiftLabel('full_time', viewerTimeZone), disabled: false },
        { value: 'first_half', label: getShiftLabel('first_half', viewerTimeZone), disabled: false },
        { value: 'second_half', label: getShiftLabel('second_half', viewerTimeZone), disabled: false },
      ];
    }

    return ['full_time', 'first_half', 'second_half'].map((value) => ({
      value,
      label: getShiftLabel(value, viewerTimeZone),
      disabled: currentEmployeeAssignments.some((assignment) => shiftsConflict(assignment.shiftType, value)),
    }));
  }, [currentEmployeeAssignments, form.assignedEmployeeId, form.role, viewerTimeZone]);

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

      const res = await apiFetch<Response>('/api/users', {
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

  async function removeUser() {
    if (!canDelete) return;
    if (!deleting) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch<Response>('/api/users', {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleting.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(responseErrorMessage(data, 'Failed to delete user'));
      setDeleting(null);
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

  function toggleActionMenu(event: React.MouseEvent<HTMLButtonElement>, entryId: string) {
    event.stopPropagation();
    if (actionMenu?.id === entryId) return setActionMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    setActionMenu({ id: entryId, top: rect.bottom + 6, right: Math.max(12, window.innerWidth - rect.right) });
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
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
            style={{ padding: '10px 18px', borderRadius: 14, border: 'none', background: BRAND.blue, color: '#fff', fontWeight: 700, cursor: 'pointer' }}
          >
            Add User
          </button>
        )}
      </div>

      {show && canManage && (
        <div
          className={editing ? 'user-modal-backdrop' : undefined}
          onMouseDown={(event) => {
            if (editing && event.target === event.currentTarget && !saving) {
              setShow(false);
              resetForm();
            }
          }}
        >
        <div className={editing ? 'user-edit-modal' : undefined} style={{ ...panelStyle, marginBottom: editing ? 0 : 20, padding: 24 }}>
          {editing && (
            <div className="user-modal-heading">
              <div>
                <h2>Edit user</h2>
                <p>Update the account details for {editing.name}.</p>
              </div>
              <button type="button" aria-label="Close edit dialog" onClick={() => { setShow(false); resetForm(); }}>×</button>
            </div>
          )}
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
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 12, background: BRAND.blueSoft, color: BRAND.white }}>
                {currentEmployeeAssignments.map((assignment) => `${assignment.clientName}: ${getShiftLabel(assignment.shiftType, viewerTimeZone)}`).join(' | ')}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="submit" disabled={saving} style={{ padding: '10px 18px', borderRadius: 14, border: 'none', background: BRAND.blue, color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
                {saving ? 'Saving...' : editing ? 'Save changes' : 'Create user'}
              </button>
              <button type="button" onClick={() => { setShow(false); resetForm(); }} style={{ padding: '10px 18px', borderRadius: 14, border: `1px solid ${BRAND.border}`, background: BRAND.surface, color: BRAND.white }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
        </div>
      )}

      <div style={{ ...panelStyle, marginBottom: 20, padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <input
            style={baseInput}
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
            placeholder="Search name, email, department..."
          />
          <select style={baseInput} value={filters.role} onChange={(e) => setFilter('role', e.target.value)}>
            <option value="" style={{ background: BRAND.blackSoft }}>All roles</option>
            {ROLES.map((role) => (
              <option key={role} value={role} style={{ background: BRAND.blackSoft }}>
                {getRoleLabel(role as any)}
              </option>
            ))}
          </select>
          <select style={baseInput} value={filters.departmentId} onChange={(e) => setFilter('departmentId', e.target.value)}>
            <option value="" style={{ background: BRAND.blackSoft }}>All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id} style={{ background: BRAND.blackSoft }}>
                {department.name}
              </option>
            ))}
          </select>
          <select style={baseInput} value={filters.employmentType} onChange={(e) => setFilter('employmentType', e.target.value)}>
            <option value="" style={{ background: BRAND.blackSoft }}>All employment types</option>
            {EMPLOYMENT_TYPES.filter((option) => option.value).map((option) => (
              <option key={option.value} value={option.value} style={{ background: BRAND.blackSoft }}>
                {option.label}
              </option>
            ))}
          </select>
          <select style={baseInput} value={filters.accountStatus} onChange={(e) => setFilter('accountStatus', e.target.value)}>
            <option value="" style={{ background: BRAND.blackSoft }}>All account statuses</option>
            {ACCOUNT_STATUSES.filter((option) => option.value).map((option) => (
              <option key={option.value} value={option.value} style={{ background: BRAND.blackSoft }}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ ...panelStyle, overflow: 'hidden' }}>
        <div className="users-table-wrap">
        <table className="users-table" style={{ width: '100%', minWidth: 980, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Name', 'Email', 'Role', 'Department', 'Employment', 'Account', 'Assignment Time', 'Assigned Employee', 'Status', ...(canManage || canDelete ? ['Actions'] : [])].map((heading) => (
                <th className="users-th" key={heading} style={{ textAlign: 'left', padding: '12px 16px', color: BRAND.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: `1px solid ${BRAND.border}` }}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map((entry) => {
              const entryRole = normalizeRole(entry.role);
              const canEditEntry = canManage && !(actorRole === 'hr' && ['superadmin', 'admin'].includes(entryRole));
              const departmentName = departments.find((department) => department.id === entry.department_id)?.name || entry.department_name || '-';
              return (
                <tr key={entry.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                  <td className="users-td users-col-name" style={{ padding: '12px 16px' }}>{entry.name}</td>
                  <td className="users-td users-col-email" style={{ padding: '12px 16px' }}>{entry.email}</td>
                  <td className="users-td users-col-role" style={{ padding: '12px 16px' }}>
                    <span style={{
                      display: 'inline-flex',
                      padding: '6px 12px',
                      borderRadius: 999,
                      border: `1px solid ${ROLE_COLOR[entryRole]}40`,
                      color: ROLE_COLOR[entryRole],
                      background: `${ROLE_COLOR[entryRole]}0D`,
                  }}>
                      {getRoleLabel(entryRole)}
                    </span>
                  </td>
                  <td className="users-td users-col-department" style={{ padding: '12px 16px' }}>{departmentName}</td>
                  <td className="users-td users-col-employment" style={{ padding: '12px 16px' }}>{employmentTypeLabel(entry.employment_type)}</td>
                  <td className="users-td users-col-account" style={{ padding: '12px 16px' }}>{accountStatusLabel(entry.account_status)}</td>
                  <td className="users-td users-col-assignment-time" style={{ padding: '12px 16px' }}>{entryRole === 'client' && entry.assignment_shift_type ? getShiftLabel(entry.assignment_shift_type, viewerTimeZone) : '-'}</td>
                  <td className="users-td users-col-assigned-employee" style={{ padding: '12px 16px' }}>{entryRole === 'client' ? (entry.assigned_employee_name || '-') : '-'}</td>
                  <td className="users-td users-col-status" style={{ padding: '12px 16px' }}>{entry.status || 'Unknown'}</td>
                  {(canManage || canDelete) && (
                    <td className="users-td users-col-actions" style={{ padding: '12px 16px' }}>
                      {(canEditEntry || canDelete) && (
                        <button className="user-action-trigger" aria-label={`Actions for ${entry.name}`} aria-expanded={actionMenu?.id === entry.id} onClick={(event) => toggleActionMenu(event, entry.id)}>
                          ⋮
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {filteredUsers.length === 0 && (
              <tr>
                <td
                  colSpan={canManage || canDelete ? 10 : 9}
                  style={{ padding: '18px 16px', color: BRAND.muted, textAlign: 'center' }}
                >
                  No users match the selected filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>

        <div className="users-mobile-list">
          {filteredUsers.map((entry) => {
            const entryRole = normalizeRole(entry.role);
            const canEditEntry = canManage && !(actorRole === 'hr' && ['superadmin', 'admin'].includes(entryRole));
            const departmentName = departments.find((department) => department.id === entry.department_id)?.name || entry.department_name || '-';
            return (
              <div key={`mobile-${entry.id}`} className="user-mobile-card">
                <div className="user-mobile-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="user-mobile-name">{entry.name}</div>
                    <div className="user-mobile-email">{entry.email}</div>
                  </div>
                  <span
                    style={{
                      display: 'inline-flex',
                      padding: '6px 12px',
                      borderRadius: 999,
                      border: `1px solid ${ROLE_COLOR[entryRole]}40`,
                      color: ROLE_COLOR[entryRole],
                      background: `${ROLE_COLOR[entryRole]}0D`,
                      fontSize: 12,
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {getRoleLabel(entryRole)}
                  </span>
                </div>

                <div className="user-mobile-grid">
                  <div><label>Department</label><strong>{departmentName}</strong></div>
                  <div><label>Employment</label><strong>{employmentTypeLabel(entry.employment_type)}</strong></div>
                  <div><label>Account</label><strong>{accountStatusLabel(entry.account_status)}</strong></div>
                  <div><label>Status</label><strong>{entry.status || 'Unknown'}</strong></div>
                  <div><label>Assignment Time</label><strong>{entryRole === 'client' && entry.assignment_shift_type ? getShiftLabel(entry.assignment_shift_type, viewerTimeZone) : '-'}</strong></div>
                  <div><label>Assigned Employee</label><strong>{entryRole === 'client' ? (entry.assigned_employee_name || '-') : '-'}</strong></div>
                </div>

                {(canManage || canDelete) && (
                  <div className="user-mobile-actions">
                    {(canEditEntry || canDelete) && (
                      <button className="user-action-trigger" aria-label={`Actions for ${entry.name}`} aria-expanded={actionMenu?.id === entry.id} onClick={(event) => toggleActionMenu(event, entry.id)}>
                        ⋮
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {filteredUsers.length === 0 && (
            <div style={{ padding: '18px 16px', color: BRAND.muted, textAlign: 'center' }}>
              No users match the selected filters.
            </div>
          )}
        </div>
      </div>

      {actionMenu && (() => {
        const entry = users.find((candidate) => candidate.id === actionMenu.id);
        if (!entry) return null;
        const entryRole = normalizeRole(entry.role);
        const canEditEntry = canManage && !(actorRole === 'hr' && ['superadmin', 'admin'].includes(entryRole));
        return (
          <>
            <button className="action-menu-dismiss" aria-label="Close actions menu" onClick={() => setActionMenu(null)} />
            <div className="user-action-menu" style={{ top: actionMenu.top, right: actionMenu.right }} role="menu">
              {canEditEntry && (
                <button role="menuitem" onClick={() => { setActionMenu(null); setError(''); startEdit(entry); }}>Edit</button>
              )}
              {canDelete && (
                <button className="delete-action" role="menuitem" onClick={() => { setActionMenu(null); setError(''); setDeleting(entry); }}>Delete</button>
              )}
            </div>
          </>
        );
      })()}

      {deleting && (
        <div className="user-modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) setDeleting(null);
        }}>
          <div className="user-delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-user-title">
            <div className="delete-icon">!</div>
            <h2 id="delete-user-title">Delete user?</h2>
            <p>
              You are about to permanently delete <strong>{deleting.name}</strong> ({deleting.email}). This action cannot be undone.
            </p>
            {error && <div className="modal-error">{error}</div>}
            <div className="delete-modal-actions">
              <button type="button" className="secondary-button" disabled={saving} onClick={() => { setDeleting(null); setError(''); }}>Cancel</button>
              <button type="button" className="danger-button" disabled={saving} onClick={() => void removeUser()}>
                {saving ? 'Deleting...' : 'Delete user'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .user-modal-backdrop {
          position: fixed;
          inset: 0;
          z-index: 100;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          background: rgba(10, 10, 10, .48);
          backdrop-filter: blur(4px);
        }
        .user-edit-modal {
          width: min(900px, 100%);
          max-height: calc(100vh - 40px);
          overflow-y: auto;
        }
        .user-modal-heading {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 20px;
        }
        .user-modal-heading h2,
        .user-delete-modal h2 { margin: 0; font-size: 22px; }
        .user-modal-heading p { margin: 5px 0 0; color: ${BRAND.muted}; }
        .user-modal-heading button {
          width: 36px; height: 36px; border-radius: 50%; border: 1px solid ${BRAND.border};
          background: ${BRAND.surface}; color: ${BRAND.white}; font-size: 24px; cursor: pointer;
        }
        .user-action-trigger {
          min-width: 40px; height: 36px; padding: 0 10px; border-radius: 10px;
          border: 1px solid ${BRAND.border}; background: ${BRAND.surface}; color: ${BRAND.white};
          cursor: pointer; font-size: 24px; font-weight: 800; line-height: 1;
        }
        .user-action-trigger:hover { background: ${BRAND.blueSoft}; border-color: rgba(0,80,176,.25); }
        .action-menu-dismiss { position: fixed; inset: 0; z-index: 89; border: 0; background: transparent; cursor: default; }
        .user-action-menu {
          position: fixed; z-index: 90; width: 150px; padding: 6px; border: 1px solid ${BRAND.border};
          border-radius: 12px; background: ${BRAND.surface}; box-shadow: 0 14px 35px rgba(15,23,42,.18);
        }
        .user-action-menu button {
          display: block; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px;
          background: transparent; color: ${BRAND.white}; text-align: left; font-weight: 700; cursor: pointer;
        }
        .user-action-menu button:hover { background: ${BRAND.blueSoft}; }
        .user-action-menu .delete-action { color: ${BRAND.danger}; }
        .user-delete-modal {
          width: min(440px, 100%); padding: 28px; border-radius: 22px; border: 1px solid ${BRAND.border};
          background: ${BRAND.surface}; box-shadow: 0 24px 70px rgba(15,23,42,.22); text-align: center;
        }
        .delete-icon {
          display: grid; place-items: center; width: 48px; height: 48px; margin: 0 auto 16px;
          border-radius: 50%; background: rgba(180,35,24,.1); color: ${BRAND.danger}; font-size: 24px; font-weight: 900;
        }
        .user-delete-modal p { margin: 10px 0 0; color: ${BRAND.muted}; line-height: 1.55; }
        .modal-error { margin-top: 14px; padding: 10px 12px; border-radius: 12px; background: rgba(180,35,24,.08); color: ${BRAND.danger}; }
        .delete-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
        .secondary-button, .danger-button { padding: 10px 16px; border-radius: 12px; font-weight: 700; cursor: pointer; }
        .secondary-button { border: 1px solid ${BRAND.border}; background: ${BRAND.surface}; color: ${BRAND.white}; }
        .danger-button { border: 0; background: ${BRAND.danger}; color: #fff; }
        .secondary-button:disabled, .danger-button:disabled { opacity: .6; cursor: not-allowed; }
        .users-table-wrap {
          overflow-x: auto;
        }
        .users-table {
          table-layout: fixed;
        }
        .users-th,
        .users-td {
          vertical-align: top;
        }
        .users-td {
          color: ${BRAND.white};
        }
        .users-col-name {
          width: 12%;
          min-width: 120px;
          overflow-wrap: anywhere;
        }
        .users-col-email {
          width: 22%;
          min-width: 220px;
          overflow-wrap: anywhere;
        }
        .users-col-role {
          width: 10%;
        }
        .users-col-department {
          width: 12%;
          overflow-wrap: anywhere;
        }
        .users-col-employment,
        .users-col-account,
        .users-col-status {
          width: 9%;
        }
        .users-col-assignment-time {
          width: 11%;
        }
        .users-col-assigned-employee {
          width: 12%;
          overflow-wrap: anywhere;
        }
        .users-col-actions {
          width: 12%;
          white-space: nowrap;
        }
        .users-mobile-list {
          display: none;
          padding: 16px;
          gap: 14px;
        }
        .user-mobile-card {
          border: 1px solid ${BRAND.border};
          border-radius: 18px;
          background: ${BRAND.surface};
          padding: 16px;
        }
        .user-mobile-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 14px;
        }
        .user-mobile-name {
          font-size: 16px;
          font-weight: 800;
          color: ${BRAND.white};
        }
        .user-mobile-email {
          margin-top: 4px;
          color: ${BRAND.muted};
          font-size: 13px;
          overflow-wrap: anywhere;
        }
        .user-mobile-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }
        .user-mobile-grid label {
          display: block;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: .06em;
          text-transform: uppercase;
          color: ${BRAND.mutedFaint};
          margin-bottom: 4px;
        }
        .user-mobile-grid strong {
          color: ${BRAND.white};
          font-size: 13px;
          overflow-wrap: anywhere;
        }
        .user-mobile-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 16px;
        }
        @media (max-width: 1360px) {
          .users-th,
          .users-td {
            padding: 10px 12px !important;
            font-size: 13px;
          }
          .users-col-assignment-time,
          .users-col-assigned-employee {
            display: none;
          }
        }
        @media (max-width: 1180px) {
          .users-table-wrap {
            display: none;
          }
          .users-mobile-list {
            display: grid;
          }
        }
        @media (max-width: 640px) {
          .user-mobile-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}
