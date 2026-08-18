'use client';

import { apiFetch } from '@/lib/api-client';

import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/auth';
import { canManageUsers, canViewDepartmentManagement, normalizeRole } from '@/lib/roles';

const BRAND = {
  white: '#0A0A0A',
  blue: '#0050B0',
  border: 'rgba(10,10,10,.10)',
  muted: 'rgba(10,10,10,.58)',
  danger: '#B42318',
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

export default function DepartmentsPage() {
  const { token, user } = useAuthStore();
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [form, setForm] = useState({ id: '', name: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const role = normalizeRole(user?.role);
  const canDelete = role === 'superadmin';
  const canManage = canManageUsers(role);
  const canView = canViewDepartmentManagement(role);

  const loadDepartments = async () => {
    if (!headers) return;
    const res = await apiFetch<Response>('/api/departments', { headers });
    const data = await res.json();
    setDepartments(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    if (token) void loadDepartments();
  }, [token]);

  const resetForm = () => setForm({ id: '', name: '', description: '' });

  const saveDepartment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!headers || !canManage) return;
    if (!form.name.trim()) {
      setError('Department name is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch<Response>('/api/departments', {
        method: form.id ? 'PATCH' : 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: form.id || undefined,
          name: form.name,
          description: form.description,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Failed to save department');
        return;
      }
      resetForm();
      await loadDepartments();
    } finally {
      setSaving(false);
    }
  };

  const editDepartment = (department: DepartmentItem) => {
    setForm({
      id: department.id,
      name: department.name,
      description: department.description || '',
    });
  };

  const removeDepartment = async (id: string) => {
    if (!headers || !canDelete) return;
    if (!confirm('Delete this department?')) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch<Response>(`/api/departments?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Failed to delete department');
        return;
      }
      if (form.id === id) resetForm();
      await loadDepartments();
    } finally {
      setSaving(false);
    }
  };

  if (!canView) {
    return (
      <div style={{ color: BRAND.white }}>
        <h1 style={{ fontSize: 34, fontWeight: 800, margin: 0 }}>Department Management</h1>
        <p style={{ color: BRAND.muted, marginTop: 6 }}>Only Super Admin, Admin, HR, and QA Manager can access departments.</p>
      </div>
    );
  }

  return (
    <div style={{ color: BRAND.white }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 34, fontWeight: 800, margin: 0 }}>Department Management</h1>
        <p style={{ color: BRAND.muted, marginTop: 6 }}>
          {canManage
            ? 'Organize teams, maintain department records, and keep employee assignments aligned with your operational structure.'
            : 'Review department records and team structure across the organization.'}
        </p>
      </div>

      <div style={{ marginBottom: 20, background: '#FFFFFF', border: `1px solid ${BRAND.border}`, borderRadius: 22, padding: 24, boxShadow: '0 18px 48px rgba(15,23,42,.06)' }}>
        {canManage && (
          <form onSubmit={saveDepartment} style={{ display: 'grid', gridTemplateColumns: '2fr 3fr auto', gap: 12, marginBottom: 18 }}>
            <input style={baseInput} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Department name" />
            <input style={baseInput} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description" />
            <button type="submit" disabled={saving} style={{ padding: '10px 18px', borderRadius: 14, border: 'none', background: BRAND.blue, color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
              {saving ? 'Saving...' : form.id ? 'Update' : 'Add'}
            </button>
          </form>
        )}

        {error && (
          <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 12, background: 'rgba(255,92,122,.1)', color: BRAND.danger }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gap: 10 }}>
          {departments.map((department) => (
            <div key={department.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', padding: '12px 14px', borderRadius: 16, border: `1px solid ${BRAND.border}`, background: '#F7F8FB' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{department.name}</div>
                <div style={{ color: BRAND.muted, marginTop: 4 }}>{department.description || 'No description'}</div>
              </div>
              {canManage && (
                <div>
                  <button type="button" onClick={() => editDepartment(department)} style={{ padding: '8px 10px', borderRadius: 10, border: 'none', background: BRAND.blue, color: '#fff', cursor: 'pointer', fontWeight: 700 }}>
                    Edit
                  </button>
                  {canDelete && (
                    <button type="button" onClick={() => removeDepartment(department.id)} style={{ marginLeft: 8, padding: '8px 10px', borderRadius: 10, border: 'none', background: BRAND.danger, color: '#fff', cursor: 'pointer', fontWeight: 700 }}>
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
