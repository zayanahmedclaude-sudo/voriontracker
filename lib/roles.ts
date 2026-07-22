export type Role =
  | 'superadmin'
  | 'admin'
  | 'hr'
  | 'executive'
  | 'client'
  | 'qa_manager'
  | 'qa_lead'
  | 'qa'
  | 'employee';

export type ShiftType = 'first_half' | 'second_half' | 'full_time';
export type EmploymentType = 'probation' | 'permanent' | 'internship';
export type AccountStatus = 'active' | 'left' | 'terminated';

const ROLE_ALIASES: Record<string, Role> = {
  super_admin: 'superadmin',
  superadmin: 'superadmin',
  admin: 'admin',
  hr: 'hr',
  human_resources: 'hr',
  executive: 'executive',
  client: 'client',
  clients: 'client',
  qa_manager: 'qa_manager',
  qa_lead: 'qa_lead',
  qa: 'qa',
  team_lead: 'qa_lead',
  employee: 'employee',
};

export function normalizeRole(value: unknown): Role {
  const key = String(value || '').trim().toLowerCase();
  return ROLE_ALIASES[key] || 'employee';
}

export function normalizeShiftType(value: unknown): ShiftType {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'first_half' || key === 'second_half' || key === 'full_time') {
    return key;
  }
  return 'full_time';
}

export function normalizeEmploymentType(value: unknown): EmploymentType | null {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'probation' || key === 'permanent' || key === 'internship') return key;
  return null;
}

export function normalizeAccountStatus(value: unknown): AccountStatus | null {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return 'active';
  if (key === 'active' || key === 'left' || key === 'terminated') return key;
  return 'active';
}

export function isInactiveAccountStatus(value: unknown) {
  const status = normalizeAccountStatus(value);
  return status === 'left' || status === 'terminated';
}

export function employmentTypeLabel(value: unknown) {
  const type = normalizeEmploymentType(value);
  if (type === 'probation') return 'Probation';
  if (type === 'permanent') return 'Permanent';
  if (type === 'internship') return 'Internship';
  return '-';
}

export function accountStatusLabel(value: unknown) {
  const status = normalizeAccountStatus(value);
  if (status === 'active') return 'Active';
  if (status === 'left') return 'Left';
  if (status === 'terminated') return 'Terminated';
  return '-';
}

export function roleLabel(role: Role) {
  return {
    superadmin: 'Super Admin',
    admin: 'Admin',
    hr: 'HR',
    executive: 'Executive',
    client: 'Client',
    qa_manager: 'QA Manager',
    qa_lead: 'QA Lead',
    qa: 'QA',
    employee: 'Employee',
  }[role];
}

export function canManageUsers(role: Role) {
  return role === 'superadmin' || role === 'admin' || role === 'hr';
}

export function canViewUserManagement(role: Role) {
  return canManageUsers(role) || role === 'qa_manager';
}

export function canViewDepartmentManagement(role: Role) {
  return canManageUsers(role) || role === 'qa_manager';
}

export function canDeleteRecords(role: Role) {
  return role === 'superadmin';
}

export function canManageSecurity(role: Role) {
  return role === 'superadmin' || role === 'admin';
}

export function canViewSecurity(role: Role) {
  return canManageSecurity(role) || role === 'executive' || role === 'qa_manager';
}

export function canViewAgentDownload(role: Role) {
  return role === 'superadmin' || role === 'admin' || role === 'qa_manager';
}

export function canMonitorAll(role: Role) {
  return ['superadmin', 'admin', 'executive', 'qa_manager', 'qa_lead', 'qa'].includes(role);
}

export function canViewReports(role: Role) {
  return canMonitorAll(role) || role === 'hr';
}

export function canAccessLiveMonitor(role: Role) {
  return canMonitorAll(role);
}

export function canSendAlerts(role: Role) {
  return ['superadmin', 'admin', 'qa_manager'].includes(role);
}

export function canCreateScreenshotFlags(role: Role) {
  return role === 'qa_manager' || role === 'qa_lead';
}

export function canSendFlagReports(role: Role) {
  return role === 'qa_manager';
}

export function canViewFlags(role: Role) {
  return role !== 'client' && role !== 'employee' && role !== 'hr';
}

export function canAccessWebApp(role: Role) {
  return role !== 'employee';
}
