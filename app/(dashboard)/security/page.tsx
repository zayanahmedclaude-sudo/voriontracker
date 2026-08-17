'use client';

import { apiFetch } from '@/lib/api-client';

import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/auth';
import { canViewSecurity, normalizeRole } from '@/lib/roles';

type ScopeType = 'global' | 'department' | 'employee';

interface DepartmentItem {
  id: string;
  name: string;
  description?: string | null;
}

interface EmployeeItem {
  id: string;
  name: string;
  email: string;
  departmentId: string | null;
  departmentName?: string | null;
}

interface PolicyState {
  blockApps: boolean;
  blockWebsites: boolean;
  showWarning: boolean;
  killProcess: boolean;
}

interface PolicyOverrideItem {
  id: string;
  scopeType: ScopeType;
  departmentId: string | null;
  departmentName?: string | null;
  employeeEmail: string | null;
  blockApps: boolean | null;
  blockWebsites: boolean | null;
  showWarning: boolean | null;
  killProcess: boolean | null;
}

interface AppItem {
  id: string;
  displayName: string;
  processName: string;
  reason: string | null;
  enabled: boolean;
  scopeType: ScopeType;
  departmentId: string | null;
  departmentName?: string | null;
  employeeEmail: string | null;
}

interface WebsiteItem {
  id: string;
  domain: string;
  reason: string | null;
  enabled: boolean;
  scopeType: ScopeType;
  departmentId: string | null;
  departmentName?: string | null;
  employeeEmail: string | null;
}

const BRAND = {
  black: '#0A0E1A',
  blackSoft: '#10182B',
  white: '#F5F7FA',
  blue: '#1E5AE0',
  blueSoft: 'rgba(30,90,224,.16)',
  yellow: '#F5C400',
  yellowSoft: 'rgba(245,196,0,.12)',
  border: 'rgba(245,247,250,.08)',
  muted: 'rgba(245,247,250,.5)',
  mutedFaint: 'rgba(245,247,250,.3)',
  danger: '#FF5C7A',
  success: '#4ADE80',
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: `
linear-gradient(180deg,${BRAND.black},${BRAND.blackSoft}),
radial-gradient(circle at top left,${BRAND.blueSoft} 0%,transparent 35%),
radial-gradient(circle at bottom right,${BRAND.yellowSoft} 0%,transparent 40%)
`,
    color: BRAND.white,
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
    padding: '28px 32px',
  },
  card: {
    border: `1px solid ${BRAND.border}`,
    background: 'rgba(16,24,43,.75)',
    borderRadius: 20,
    padding: '20px 22px',
    marginBottom: 18,
  },
  header: { fontSize: 20, fontWeight: 700, marginBottom: 8, color: BRAND.white },
  sub: { fontSize: 13, color: BRAND.muted, marginBottom: 12 },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 12,
    border: `1px solid ${BRAND.border}`,
    background: 'rgba(245,247,250,.05)',
    color: BRAND.white,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
  },
  button: {
    padding: '10px 16px',
    borderRadius: 12,
    border: 'none',
    background: `linear-gradient(90deg,${BRAND.blue},#4C8CFF)`,
    color: '#fff',
    fontWeight: 700,
    cursor: 'pointer',
  },
  secondary: {
    padding: '9px 14px',
    borderRadius: 10,
    border: `1px solid ${BRAND.border}`,
    background: 'rgba(245,247,250,.06)',
    color: BRAND.white,
    cursor: 'pointer',
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 0',
    borderBottom: `1px solid ${BRAND.border}`,
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    padding: '10px 12px',
    textAlign: 'left',
    color: BRAND.mutedFaint,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    borderBottom: `1px solid ${BRAND.border}`,
  },
  td: { padding: '10px 12px', borderBottom: `1px solid ${BRAND.border}`, color: BRAND.white, verticalAlign: 'top' },
  badge: { display: 'inline-block', padding: '3px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 },
};

function scopeLabel(item: { scopeType: ScopeType; departmentName?: string | null; employeeEmail?: string | null }) {
  if (item.scopeType === 'department') return item.departmentName || 'Department';
  if (item.scopeType === 'employee') return `${item.departmentName || 'Department'} / ${item.employeeEmail || 'Employee'}`;
  return 'All Departments';
}

function scopeTone(scopeType: ScopeType) {
  if (scopeType === 'employee') return { background: 'rgba(245,196,0,.15)', color: BRAND.yellow };
  if (scopeType === 'department') return { background: 'rgba(30,90,224,.15)', color: '#8DB0FF' };
  return { background: 'rgba(74,222,128,.15)', color: BRAND.success };
}

function triStateValue(value: boolean | null) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'inherit';
}

export default function SecurityPage() {
  const { token, user } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'apps' | 'websites'>('apps');
  const [policy, setPolicy] = useState<PolicyState>({ blockApps: true, blockWebsites: true, showWarning: true, killProcess: true });
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [employees, setEmployees] = useState<EmployeeItem[]>([]);
  const [overrides, setOverrides] = useState<PolicyOverrideItem[]>([]);
  const [apps, setApps] = useState<AppItem[]>([]);
  const [websites, setWebsites] = useState<WebsiteItem[]>([]);
  const [policyOverrideForm, setPolicyOverrideForm] = useState({
    id: '',
    scopeType: 'department' as ScopeType,
    departmentId: '',
    employeeEmail: '',
    blockApps: 'inherit',
    blockWebsites: 'inherit',
    showWarning: 'inherit',
    killProcess: 'inherit',
  });
  const [appForm, setAppForm] = useState({
    id: '',
    displayName: '',
    processName: '',
    reason: '',
    enabled: true,
    scopeType: 'global' as ScopeType,
    departmentId: '',
    employeeEmail: '',
  });
  const [siteForm, setSiteForm] = useState({
    id: '',
    domain: '',
    reason: '',
    enabled: true,
    scopeType: 'global' as ScopeType,
    departmentId: '',
    employeeEmail: '',
  });
  const [saving, setSaving] = useState(false);

  const normalizedRole = normalizeRole(user?.role);
  const canManage = normalizedRole === 'superadmin' || normalizedRole === 'admin';
  const canView = canViewSecurity(normalizedRole);
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  const employeesForOverrideDepartment = employees.filter((employee) => employee.departmentId === policyOverrideForm.departmentId);
  const employeesForAppDepartment = employees.filter((employee) => employee.departmentId === appForm.departmentId);
  const employeesForSiteDepartment = employees.filter((employee) => employee.departmentId === siteForm.departmentId);

  const loadData = async () => {
    if (!headers) return;
    const [policyRes, appsRes, sitesRes] = await Promise.all([
      apiFetch<Response>('/api/policies', { headers }),
      apiFetch<Response>('/api/blocked/apps', { headers }),
      apiFetch<Response>('/api/blocked/websites', { headers }),
    ]);
    if (policyRes.ok) {
      const payload = await policyRes.json();
      setPolicy({
        blockApps: Boolean(payload.blockApps),
        blockWebsites: Boolean(payload.blockWebsites),
        showWarning: Boolean(payload.showWarning),
        killProcess: Boolean(payload.killProcess),
      });
      setOverrides(Array.isArray(payload.overrides) ? payload.overrides : []);
      setDepartments(Array.isArray(payload.departments) ? payload.departments : []);
      setEmployees(Array.isArray(payload.employees) ? payload.employees : []);
    }
    if (appsRes.ok) setApps(await appsRes.json());
    if (sitesRes.ok) setWebsites(await sitesRes.json());
  };

  useEffect(() => {
    if (token) void loadData();
  }, [token]);

  const savePolicy = async () => {
    if (!headers || !canManage) return;
    setSaving(true);
    const res = await apiFetch<Response>('/api/policies', {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
    });
    setSaving(false);
    if (res.ok) await loadData();
  };

  const saveOverride = async () => {
    if (!headers || !canManage) return;
    const body = {
      id: policyOverrideForm.id || undefined,
      scopeType: policyOverrideForm.scopeType,
      departmentId: policyOverrideForm.scopeType === 'global' ? null : policyOverrideForm.departmentId,
      employeeEmail: policyOverrideForm.scopeType === 'employee' ? policyOverrideForm.employeeEmail : null,
      blockApps: policyOverrideForm.blockApps === 'inherit' ? undefined : policyOverrideForm.blockApps === 'true',
      blockWebsites: policyOverrideForm.blockWebsites === 'inherit' ? undefined : policyOverrideForm.blockWebsites === 'true',
      showWarning: policyOverrideForm.showWarning === 'inherit' ? undefined : policyOverrideForm.showWarning === 'true',
      killProcess: policyOverrideForm.killProcess === 'inherit' ? undefined : policyOverrideForm.killProcess === 'true',
    };
    const res = await apiFetch<Response>('/api/policies', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setPolicyOverrideForm({
        id: '',
        scopeType: 'department',
        departmentId: '',
        employeeEmail: '',
        blockApps: 'inherit',
        blockWebsites: 'inherit',
        showWarning: 'inherit',
        killProcess: 'inherit',
      });
      await loadData();
    }
  };

  const deleteOverride = async (id: string) => {
    if (!headers || !canManage) return;
    await apiFetch<Response>(`/api/policies?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers });
    await loadData();
  };

  const saveApp = async () => {
    if (!headers || !canManage) return;
    const payload = {
      displayName: appForm.displayName,
      processName: appForm.processName,
      reason: appForm.reason,
      enabled: appForm.enabled,
      scopeType: appForm.scopeType,
      departmentId: appForm.scopeType === 'global' ? null : appForm.departmentId,
      employeeEmail: appForm.scopeType === 'employee' ? appForm.employeeEmail : null,
    };
    const res = await apiFetch<Response>('/api/blocked/apps', {
      method: appForm.id ? 'PUT' : 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(appForm.id ? { id: appForm.id, ...payload } : payload),
    });
    if (res.ok) {
      setAppForm({ id: '', displayName: '', processName: '', reason: '', enabled: true, scopeType: 'global', departmentId: '', employeeEmail: '' });
      await loadData();
    }
  };

  const saveSite = async () => {
    if (!headers || !canManage) return;
    const payload = {
      domain: siteForm.domain,
      reason: siteForm.reason,
      enabled: siteForm.enabled,
      scopeType: siteForm.scopeType,
      departmentId: siteForm.scopeType === 'global' ? null : siteForm.departmentId,
      employeeEmail: siteForm.scopeType === 'employee' ? siteForm.employeeEmail : null,
    };
    const res = await apiFetch<Response>('/api/blocked/websites', {
      method: siteForm.id ? 'PUT' : 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(siteForm.id ? { id: siteForm.id, ...payload } : payload),
    });
    if (res.ok) {
      setSiteForm({ id: '', domain: '', reason: '', enabled: true, scopeType: 'global', departmentId: '', employeeEmail: '' });
      await loadData();
    }
  };

  const deleteApp = async (id: string) => {
    if (!headers || !canManage) return;
    await apiFetch<Response>(`/api/blocked/apps?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers });
    await loadData();
  };

  const deleteSite = async (id: string) => {
    if (!headers || !canManage) return;
    await apiFetch<Response>(`/api/blocked/websites?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers });
    await loadData();
  };

  const editOverride = (item: PolicyOverrideItem) => {
    setPolicyOverrideForm({
      id: item.id,
      scopeType: item.scopeType,
      departmentId: item.departmentId || '',
      employeeEmail: item.employeeEmail || '',
      blockApps: triStateValue(item.blockApps),
      blockWebsites: triStateValue(item.blockWebsites),
      showWarning: triStateValue(item.showWarning),
      killProcess: triStateValue(item.killProcess),
    });
  };

  const editApp = (item: AppItem) => {
    setAppForm({
      id: item.id,
      displayName: item.displayName,
      processName: item.processName,
      reason: item.reason || '',
      enabled: item.enabled,
      scopeType: item.scopeType,
      departmentId: item.departmentId || '',
      employeeEmail: item.employeeEmail || '',
    });
  };

  const editSite = (item: WebsiteItem) => {
    setSiteForm({
      id: item.id,
      domain: item.domain,
      reason: item.reason || '',
      enabled: item.enabled,
      scopeType: item.scopeType,
      departmentId: item.departmentId || '',
      employeeEmail: item.employeeEmail || '',
    });
  };

  if (!canView) {
    return (
      <div style={styles.page}>
        <h1 style={styles.header}>Security Policies</h1>
        <p style={styles.sub}>Only Super Admin, Admin, Executive, and QA Manager can access this view.</p>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h1 style={{ ...styles.header, fontSize: 30, fontWeight: 800 }}>Security Policies</h1>
      <p style={styles.sub}>
        Super Admin and Admin can create departments and keep separate policies for each department. Employee-specific changes are only allowed inside that employee&apos;s department.
      </p>

      <div style={styles.card}>
        <div style={styles.header}>Global Policy Switches</div>
        <div style={styles.toggleRow}><span>Enable Website Blocking</span><input type="checkbox" checked={policy.blockWebsites} disabled={!canManage} onChange={(e) => setPolicy({ ...policy, blockWebsites: e.target.checked })} /></div>
        <div style={styles.toggleRow}><span>Enable Application Blocking</span><input type="checkbox" checked={policy.blockApps} disabled={!canManage} onChange={(e) => setPolicy({ ...policy, blockApps: e.target.checked })} /></div>
        <div style={styles.toggleRow}><span>Show Warning Popup</span><input type="checkbox" checked={policy.showWarning} disabled={!canManage} onChange={(e) => setPolicy({ ...policy, showWarning: e.target.checked })} /></div>
        <div style={{ ...styles.toggleRow, borderBottom: 'none' }}><span>Kill Process Automatically</span><input type="checkbox" checked={policy.killProcess} disabled={!canManage} onChange={(e) => setPolicy({ ...policy, killProcess: e.target.checked })} /></div>
        {canManage && <div style={{ marginTop: 12 }}><button style={styles.button} onClick={savePolicy} disabled={saving}>{saving ? 'Saving...' : 'Save Global Policy'}</button></div>}
      </div>

      <div style={styles.card}>
        <div style={styles.header}>Department and Employee Overrides</div>
        <p style={styles.sub}>Set a policy for a department, or pick one employee from that department for a specific exception.</p>
        {canManage && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 14 }}>
            <select style={styles.input} value={policyOverrideForm.scopeType} onChange={(e) => setPolicyOverrideForm({ ...policyOverrideForm, scopeType: e.target.value as ScopeType, employeeEmail: '' })}>
              <option value="department">Department</option>
              <option value="employee">Employee In Department</option>
            </select>
            <select style={styles.input} value={policyOverrideForm.departmentId} onChange={(e) => setPolicyOverrideForm({ ...policyOverrideForm, departmentId: e.target.value, employeeEmail: '' })}>
              <option value="">Select department</option>
              {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
            {policyOverrideForm.scopeType === 'employee' ? (
              <select style={styles.input} value={policyOverrideForm.employeeEmail} onChange={(e) => setPolicyOverrideForm({ ...policyOverrideForm, employeeEmail: e.target.value })}>
                <option value="">Select employee</option>
                {employeesForOverrideDepartment.map((employee) => <option key={employee.id} value={employee.email}>{employee.name} ({employee.email})</option>)}
              </select>
            ) : (
              <div style={{ ...styles.input, display: 'flex', alignItems: 'center', color: BRAND.muted }}>Applies to whole department</div>
            )}
            {['blockApps', 'blockWebsites', 'showWarning', 'killProcess'].map((field) => (
              <select
                key={field}
                style={styles.input}
                value={(policyOverrideForm as any)[field]}
                onChange={(e) => setPolicyOverrideForm({ ...policyOverrideForm, [field]: e.target.value })}
              >
                <option value="inherit">{field} inherit</option>
                <option value="true">{field} on</option>
                <option value="false">{field} off</option>
              </select>
            ))}
            <button style={styles.button} onClick={saveOverride}>{policyOverrideForm.id ? 'Update Override' : 'Add Override'}</button>
          </div>
        )}
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Scope</th>
              <th style={styles.th}>Block Apps</th>
              <th style={styles.th}>Block Websites</th>
              <th style={styles.th}>Warning</th>
              <th style={styles.th}>Kill Process</th>
              {canManage && <th style={styles.th}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {overrides.map((item) => {
              const tone = scopeTone(item.scopeType);
              return (
                <tr key={item.id}>
                  <td style={styles.td}><span style={{ ...styles.badge, ...tone }}>{scopeLabel(item)}</span></td>
                  <td style={styles.td}>{triStateValue(item.blockApps)}</td>
                  <td style={styles.td}>{triStateValue(item.blockWebsites)}</td>
                  <td style={styles.td}>{triStateValue(item.showWarning)}</td>
                  <td style={styles.td}>{triStateValue(item.killProcess)}</td>
                  {canManage && (
                    <td style={styles.td}>
                      <button style={styles.secondary} onClick={() => editOverride(item)}>Edit</button>
                      <button style={{ ...styles.secondary, marginLeft: 8, color: BRAND.danger }} onClick={() => deleteOverride(item.id)}>Delete</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button style={{ ...styles.secondary, background: activeTab === 'apps' ? BRAND.blueSoft : 'rgba(245,247,250,.06)' }} onClick={() => setActiveTab('apps')}>Blocked Applications</button>
        <button style={{ ...styles.secondary, background: activeTab === 'websites' ? BRAND.yellowSoft : 'rgba(245,247,250,.06)' }} onClick={() => setActiveTab('websites')}>Blocked Websites</button>
      </div>

      {activeTab === 'apps' ? (
        <>
          {canManage && (
            <div style={styles.card}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10, color: BRAND.white }}>{appForm.id ? 'Edit Application Policy' : 'Add Application Policy'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                <input placeholder="Display name" style={styles.input} value={appForm.displayName} onChange={(e) => setAppForm({ ...appForm, displayName: e.target.value })} />
                <input placeholder="Process name" style={styles.input} value={appForm.processName} onChange={(e) => setAppForm({ ...appForm, processName: e.target.value })} />
                <input placeholder="Reason" style={styles.input} value={appForm.reason} onChange={(e) => setAppForm({ ...appForm, reason: e.target.value })} />
                <select style={styles.input} value={appForm.scopeType} onChange={(e) => setAppForm({ ...appForm, scopeType: e.target.value as ScopeType, employeeEmail: '' })}>
                  <option value="global">All departments</option>
                  <option value="department">Specific department</option>
                  <option value="employee">Specific employee in department</option>
                </select>
                {(appForm.scopeType === 'department' || appForm.scopeType === 'employee') && (
                  <select style={styles.input} value={appForm.departmentId} onChange={(e) => setAppForm({ ...appForm, departmentId: e.target.value, employeeEmail: '' })}>
                    <option value="">Select department</option>
                    {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                  </select>
                )}
                {appForm.scopeType === 'employee' && (
                  <select style={styles.input} value={appForm.employeeEmail} onChange={(e) => setAppForm({ ...appForm, employeeEmail: e.target.value })}>
                    <option value="">Select employee</option>
                    {employeesForAppDepartment.map((employee) => <option key={employee.id} value={employee.email}>{employee.name} ({employee.email})</option>)}
                  </select>
                )}
                <button style={styles.button} onClick={saveApp}>{appForm.id ? 'Update Policy' : 'Add Policy'}</button>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, color: BRAND.muted, fontSize: 13 }}>
                <input type="checkbox" checked={appForm.enabled} onChange={(e) => setAppForm({ ...appForm, enabled: e.target.checked })} /> Enabled
              </label>
            </div>
          )}
          <div style={styles.card}>
            <table style={styles.table}>
              <thead><tr><th style={styles.th}>Name</th><th style={styles.th}>Process</th><th style={styles.th}>Scope</th><th style={styles.th}>Reason</th><th style={styles.th}>Enabled</th>{canManage && <th style={styles.th}>Actions</th>}</tr></thead>
              <tbody>
                {apps.map((item) => {
                  const tone = scopeTone(item.scopeType);
                  return (
                    <tr key={item.id}>
                      <td style={styles.td}>{item.displayName}</td>
                      <td style={styles.td}>{item.processName}</td>
                      <td style={styles.td}><span style={{ ...styles.badge, ...tone }}>{scopeLabel(item)}</span></td>
                      <td style={styles.td}>{item.reason || '-'}</td>
                      <td style={styles.td}>{item.enabled ? 'Enabled' : 'Disabled'}</td>
                      {canManage && (
                        <td style={styles.td}>
                          <button style={styles.secondary} onClick={() => editApp(item)}>Edit</button>
                          <button style={{ ...styles.secondary, marginLeft: 8, color: BRAND.danger }} onClick={() => deleteApp(item.id)}>Delete</button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          {canManage && (
            <div style={styles.card}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10, color: BRAND.white }}>{siteForm.id ? 'Edit Website Policy' : 'Add Website Policy'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                <input placeholder="Domain" style={styles.input} value={siteForm.domain} onChange={(e) => setSiteForm({ ...siteForm, domain: e.target.value })} />
                <input placeholder="Reason" style={styles.input} value={siteForm.reason} onChange={(e) => setSiteForm({ ...siteForm, reason: e.target.value })} />
                <select style={styles.input} value={siteForm.scopeType} onChange={(e) => setSiteForm({ ...siteForm, scopeType: e.target.value as ScopeType, employeeEmail: '' })}>
                  <option value="global">All departments</option>
                  <option value="department">Specific department</option>
                  <option value="employee">Specific employee in department</option>
                </select>
                {(siteForm.scopeType === 'department' || siteForm.scopeType === 'employee') && (
                  <select style={styles.input} value={siteForm.departmentId} onChange={(e) => setSiteForm({ ...siteForm, departmentId: e.target.value, employeeEmail: '' })}>
                    <option value="">Select department</option>
                    {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                  </select>
                )}
                {siteForm.scopeType === 'employee' && (
                  <select style={styles.input} value={siteForm.employeeEmail} onChange={(e) => setSiteForm({ ...siteForm, employeeEmail: e.target.value })}>
                    <option value="">Select employee</option>
                    {employeesForSiteDepartment.map((employee) => <option key={employee.id} value={employee.email}>{employee.name} ({employee.email})</option>)}
                  </select>
                )}
                <button style={styles.button} onClick={saveSite}>{siteForm.id ? 'Update Policy' : 'Add Policy'}</button>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, color: BRAND.muted, fontSize: 13 }}>
                <input type="checkbox" checked={siteForm.enabled} onChange={(e) => setSiteForm({ ...siteForm, enabled: e.target.checked })} /> Enabled
              </label>
            </div>
          )}
          <div style={styles.card}>
            <table style={styles.table}>
              <thead><tr><th style={styles.th}>Domain</th><th style={styles.th}>Scope</th><th style={styles.th}>Reason</th><th style={styles.th}>Enabled</th>{canManage && <th style={styles.th}>Actions</th>}</tr></thead>
              <tbody>
                {websites.map((item) => {
                  const tone = scopeTone(item.scopeType);
                  return (
                    <tr key={item.id}>
                      <td style={styles.td}>{item.domain}</td>
                      <td style={styles.td}><span style={{ ...styles.badge, ...tone }}>{scopeLabel(item)}</span></td>
                      <td style={styles.td}>{item.reason || '-'}</td>
                      <td style={styles.td}>{item.enabled ? 'Enabled' : 'Disabled'}</td>
                      {canManage && (
                        <td style={styles.td}>
                          <button style={styles.secondary} onClick={() => editSite(item)}>Edit</button>
                          <button style={{ ...styles.secondary, marginLeft: 8, color: BRAND.danger }} onClick={() => deleteSite(item.id)}>Delete</button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
