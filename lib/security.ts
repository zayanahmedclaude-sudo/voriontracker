import { queryRows, sql, withTransaction } from './db';

export type PolicyScopeType = 'global' | 'department' | 'employee';

export interface PolicySettings {
  blockWebsites: boolean;
  blockApps: boolean;
  showWarning: boolean;
  killProcess: boolean;
  updatedAt: string | null;
}

export interface PolicyScopeSettingsRecord {
  id: string;
  scopeType: PolicyScopeType;
  departmentId: string | null;
  departmentName?: string | null;
  employeeEmail: string | null;
  blockWebsites: boolean | null;
  blockApps: boolean | null;
  showWarning: boolean | null;
  killProcess: boolean | null;
  updatedAt: string | null;
}

export interface DepartmentRecord {
  id: string;
  name: string;
  description: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PolicyEmployeeRecord {
  id: string;
  name: string;
  email: string;
  departmentId: string | null;
  departmentName?: string | null;
}

export interface BlockedAppRecord {
  id: string;
  displayName: string;
  processName: string;
  reason: string | null;
  enabled: boolean;
  scopeType: PolicyScopeType;
  departmentId: string | null;
  departmentName?: string | null;
  employeeEmail: string | null;
  createdAt: string;
}

export interface BlockedWebsiteRecord {
  id: string;
  domain: string;
  reason: string | null;
  enabled: boolean;
  scopeType: PolicyScopeType;
  departmentId: string | null;
  departmentName?: string | null;
  employeeEmail: string | null;
  createdAt: string;
}

export interface SecurityEventRecord {
  id: string;
  employeeId: string | null;
  computerName: string | null;
  eventType: string;
  value: string | null;
  actionTaken: string | null;
  createdAt: string;
  employeeName?: string | null;
}

// Schema setup is intentionally lazy to support existing deployments, but it
// must never run for every request. The old behaviour issued dozens of DDL
// statements for each policy/department read (and four copies concurrently on
// the policy dashboard), which caused lock waits and very slow saves.
let securitySchemaReady: Promise<void> | null = null;

function normalizeScopeType(value: unknown): PolicyScopeType {
  const next = String(value || '').trim().toLowerCase();
  if (next === 'department' || next === 'employee') return next;
  return 'global';
}

function normalizeScopedEmail(value: unknown): string | null {
  const next = String(value || '').trim().toLowerCase();
  return next || null;
}

function mapPolicyScopeRow(row: any): PolicyScopeSettingsRecord {
  return {
    id: row.id,
    scopeType: normalizeScopeType(row.scope_type),
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
    employeeEmail: row.employee_email ?? null,
    blockWebsites: row.block_websites ?? null,
    blockApps: row.block_apps ?? null,
    showWarning: row.show_warning ?? null,
    killProcess: row.kill_process ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function mapBlockedAppRow(row: any): BlockedAppRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    processName: row.process_name,
    reason: row.reason,
    enabled: Boolean(row.enabled),
    scopeType: normalizeScopeType(row.scope_type),
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
    employeeEmail: row.employee_email ?? null,
    createdAt: row.created_at,
  };
}

function mapBlockedWebsiteRow(row: any): BlockedWebsiteRecord {
  return {
    id: row.id,
    domain: row.domain,
    reason: row.reason,
    enabled: Boolean(row.enabled),
    scopeType: normalizeScopeType(row.scope_type),
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
    employeeEmail: row.employee_email ?? null,
    createdAt: row.created_at,
  };
}

function applyPolicyOverride(base: PolicySettings, override: PolicyScopeSettingsRecord | null | undefined): PolicySettings {
  if (!override) return base;
  return {
    blockWebsites: override.blockWebsites ?? base.blockWebsites,
    blockApps: override.blockApps ?? base.blockApps,
    showWarning: override.showWarning ?? base.showWarning,
    killProcess: override.killProcess ?? base.killProcess,
    updatedAt: override.updatedAt ?? base.updatedAt,
  };
}

async function assertEmployeeBelongsToDepartment(employeeEmail: string, departmentId: string, client?: { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> }) {
  const text = `
    SELECT p.id, p.email, p.department_id, d.name AS department_name
    FROM public.profiles p
    LEFT JOIN departments d ON d.id = p.department_id
    WHERE LOWER(p.email) = $1
    LIMIT 1
  `;
  const runner = client
    ? await client.query(text, [employeeEmail])
    : { rows: await sql`
        SELECT p.id, p.email, p.department_id, d.name AS department_name
        FROM public.profiles p
        LEFT JOIN departments d ON d.id = p.department_id
        WHERE LOWER(p.email) = ${employeeEmail}
        LIMIT 1
      ` };
  const row = runner.rows?.[0];
  if (!row) throw new Error('Employee email was not found');
  if (!row.department_id) throw new Error('Selected employee is not assigned to any department');
  if (String(row.department_id) !== String(departmentId)) {
    throw new Error(`Selected employee does not belong to the chosen department${row.department_name ? ` (${row.department_name})` : ''}`);
  }
}

async function initializeSecuritySchema(): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;

  await sql`
    CREATE TABLE IF NOT EXISTS departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE departments ADD COLUMN IF NOT EXISTS description TEXT`;
  await sql`ALTER TABLE departments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`ALTER TABLE departments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;

  await sql`
    CREATE TABLE IF NOT EXISTS policy_scope_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scope_type TEXT NOT NULL DEFAULT 'global',
      department_id UUID NULL REFERENCES departments(id) ON DELETE CASCADE,
      employee_email TEXT NULL,
      block_websites BOOLEAN NULL,
      block_apps BOOLEAN NULL,
      show_warning BOOLEAN NULL,
      kill_process BOOLEAN NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE policy_scope_settings ADD COLUMN IF NOT EXISTS department_id UUID NULL REFERENCES departments(id) ON DELETE CASCADE`;
  await sql`ALTER TABLE policy_scope_settings ADD COLUMN IF NOT EXISTS employee_email TEXT NULL`;
  await sql`ALTER TABLE policy_scope_settings ADD COLUMN IF NOT EXISTS block_websites BOOLEAN NULL`;
  await sql`ALTER TABLE policy_scope_settings ADD COLUMN IF NOT EXISTS block_apps BOOLEAN NULL`;
  await sql`ALTER TABLE policy_scope_settings ADD COLUMN IF NOT EXISTS show_warning BOOLEAN NULL`;
  await sql`ALTER TABLE policy_scope_settings ADD COLUMN IF NOT EXISTS kill_process BOOLEAN NULL`;
  await sql`ALTER TABLE policy_scope_settings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`ALTER TABLE policy_scope_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;

  await sql`ALTER TABLE blocked_applications ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'global'`;
  await sql`ALTER TABLE blocked_applications ADD COLUMN IF NOT EXISTS department_id UUID NULL REFERENCES departments(id) ON DELETE CASCADE`;
  await sql`ALTER TABLE blocked_applications ADD COLUMN IF NOT EXISTS employee_email TEXT NULL`;
  await sql`ALTER TABLE blocked_websites ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'global'`;
  await sql`ALTER TABLE blocked_websites ADD COLUMN IF NOT EXISTS department_id UUID NULL REFERENCES departments(id) ON DELETE CASCADE`;
  await sql`ALTER TABLE blocked_websites ADD COLUMN IF NOT EXISTS employee_email TEXT NULL`;
  await sql`ALTER TABLE blocked_websites DROP CONSTRAINT IF EXISTS blocked_websites_domain_key`;
  await sql`ALTER TABLE blocked_applications DROP CONSTRAINT IF EXISTS blocked_applications_process_name_key`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS blocked_websites_scope_domain_key
    ON blocked_websites (
      scope_type,
      COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(employee_email, ''),
      domain
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS blocked_applications_scope_process_key
    ON blocked_applications (
      scope_type,
      COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(employee_email, ''),
      process_name
    )
  `;

  await sql`
    INSERT INTO policy_settings (id, block_websites, block_apps, show_warning, kill_process, updated_at)
    SELECT 1, true, true, true, true, NOW()
    WHERE NOT EXISTS (SELECT 1 FROM policy_settings WHERE id = 1)
  `;
}

export function ensureSecuritySchema(): Promise<void> {
  if (!securitySchemaReady) {
    securitySchemaReady = initializeSecuritySchema().catch((error) => {
      // Do not permanently cache a failed initialization. A transient database
      // failure should be retried by the next request.
      securitySchemaReady = null;
      throw error;
    });
  }
  return securitySchemaReady;
}

export async function listDepartments(): Promise<DepartmentRecord[]> {
  await ensureSecuritySchema();
  const rows = await sql`
    SELECT id, name, description, created_at, updated_at
    FROM departments
    ORDER BY name ASC
  `;
  return (rows || []).map((row: any) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }));
}

export async function listPolicyEmployees(): Promise<PolicyEmployeeRecord[]> {
  await ensureSecuritySchema();
  const rows = await sql`
    SELECT p.id, p.full_name, p.email, p.department_id, d.name AS department_name
    FROM public.profiles p
    LEFT JOIN departments d ON d.id = p.department_id
    WHERE p.email IS NOT NULL AND p.role = 'employee'
    ORDER BY d.name ASC NULLS LAST, p.full_name ASC
  `;
  return (rows || []).map((row: any) => ({
    id: row.id,
    name: row.full_name,
    email: row.email,
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
  }));
}

export async function createDepartment(input: { name: string; description?: string | null }): Promise<DepartmentRecord> {
  await ensureSecuritySchema();
  const rows = await sql`
    INSERT INTO departments (name, description)
    VALUES (${String(input.name || '').trim()}, ${input.description ? String(input.description).trim() : null})
    RETURNING id, name, description, created_at, updated_at
  `;
  const row = rows?.[0];
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export async function updateDepartment(id: string, input: { name?: string; description?: string | null }): Promise<DepartmentRecord | null> {
  await ensureSecuritySchema();
  const currentRows = await sql`SELECT id, name, description, created_at, updated_at FROM departments WHERE id = ${id} LIMIT 1`;
  const current = currentRows?.[0];
  if (!current) return null;
  const rows = await sql`
    UPDATE departments
    SET
      name = ${input.name !== undefined ? String(input.name).trim() : current.name},
      description = ${input.description !== undefined ? (input.description ? String(input.description).trim() : null) : current.description},
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, name, description, created_at, updated_at
  `;
  const row = rows?.[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export async function deleteDepartment(id: string): Promise<boolean> {
  await ensureSecuritySchema();
  const rows = await sql`DELETE FROM departments WHERE id = ${id} RETURNING id`;
  return Boolean(rows?.[0]);
}

export async function getPolicySettings(): Promise<PolicySettings> {
  await ensureSecuritySchema();
  const rows = await sql`
    SELECT block_websites, block_apps, show_warning, kill_process, updated_at
    FROM policy_settings
    WHERE id = 1
    LIMIT 1
  `;
  const row = rows?.[0];
  return {
    blockWebsites: Boolean(row?.block_websites ?? true),
    blockApps: Boolean(row?.block_apps ?? true),
    showWarning: Boolean(row?.show_warning ?? true),
    killProcess: Boolean(row?.kill_process ?? true),
    updatedAt: row?.updated_at ?? null,
  };
}

export async function updatePolicySettings(input: Partial<PolicySettings>): Promise<PolicySettings> {
  await ensureSecuritySchema();
  const current = await getPolicySettings();
  const next = {
    blockWebsites: input.blockWebsites ?? current.blockWebsites,
    blockApps: input.blockApps ?? current.blockApps,
    showWarning: input.showWarning ?? current.showWarning,
    killProcess: input.killProcess ?? current.killProcess,
  };

  await sql`
    INSERT INTO policy_settings (id, block_websites, block_apps, show_warning, kill_process, updated_at)
    VALUES (1, ${next.blockWebsites}, ${next.blockApps}, ${next.showWarning}, ${next.killProcess}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      block_websites = EXCLUDED.block_websites,
      block_apps = EXCLUDED.block_apps,
      show_warning = EXCLUDED.show_warning,
      kill_process = EXCLUDED.kill_process,
      updated_at = NOW()
  `;

  return { ...next, updatedAt: new Date().toISOString() };
}

export async function listPolicyScopeSettings(): Promise<PolicyScopeSettingsRecord[]> {
  await ensureSecuritySchema();
  const rows = await sql`
    SELECT pss.*, d.name AS department_name
    FROM policy_scope_settings pss
    LEFT JOIN departments d ON d.id = pss.department_id
    ORDER BY
      CASE pss.scope_type WHEN 'global' THEN 0 WHEN 'department' THEN 1 ELSE 2 END,
      d.name ASC NULLS LAST,
      pss.employee_email ASC NULLS LAST,
      pss.updated_at DESC
  `;
  return (rows || []).map(mapPolicyScopeRow);
}

export async function savePolicyScopeSettings(input: {
  id?: string | null;
  scopeType: PolicyScopeType;
  departmentId?: string | null;
  employeeEmail?: string | null;
  blockWebsites?: boolean | null;
  blockApps?: boolean | null;
  showWarning?: boolean | null;
  killProcess?: boolean | null;
}): Promise<PolicyScopeSettingsRecord> {
  await ensureSecuritySchema();
  const scopeType = normalizeScopeType(input.scopeType);
  const departmentId = scopeType === 'global' ? null : (input.departmentId || null);
  const employeeEmail = scopeType === 'employee' ? normalizeScopedEmail(input.employeeEmail) : null;

  if (scopeType === 'department' && !departmentId) throw new Error('Department is required for department policy overrides');
  if (scopeType === 'employee' && !departmentId) throw new Error('Department is required for employee policy overrides');
  if (scopeType === 'employee' && !employeeEmail) throw new Error('Employee email is required for employee policy overrides');
  if (scopeType === 'employee' && departmentId && employeeEmail) {
    await assertEmployeeBelongsToDepartment(employeeEmail, departmentId);
  }

  return withTransaction(async (client) => {
    if (input.id) {
      if (scopeType === 'employee' && departmentId && employeeEmail) {
        await assertEmployeeBelongsToDepartment(employeeEmail, departmentId, client);
      }
      const result = await client.query(
        `UPDATE policy_scope_settings
         SET
           scope_type = $2,
           department_id = $3,
           employee_email = $4,
           block_websites = $5,
           block_apps = $6,
           show_warning = $7,
           kill_process = $8,
           updated_at = NOW()
         WHERE id = $1
         RETURNING id, scope_type, department_id, employee_email, block_websites, block_apps, show_warning, kill_process, updated_at`,
        [
          input.id,
          scopeType,
          departmentId,
          employeeEmail,
          input.blockWebsites ?? null,
          input.blockApps ?? null,
          input.showWarning ?? null,
          input.killProcess ?? null,
        ]
      );
      const row = result.rows?.[0];
      if (!row) throw new Error('Policy override not found');
      const dept = row.department_id
        ? (await client.query(`SELECT name FROM departments WHERE id = $1 LIMIT 1`, [row.department_id])).rows?.[0]
        : null;
      return mapPolicyScopeRow({ ...row, department_name: dept?.name ?? null });
    }

    await client.query(
      `DELETE FROM policy_scope_settings
       WHERE scope_type = $1
         AND COALESCE(department_id::text, '') = COALESCE($2::text, '')
         AND COALESCE(employee_email, '') = COALESCE($3, '')`,
      [scopeType, departmentId, employeeEmail]
    );

    const result = await client.query(
      `INSERT INTO policy_scope_settings
         (scope_type, department_id, employee_email, block_websites, block_apps, show_warning, kill_process)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, scope_type, department_id, employee_email, block_websites, block_apps, show_warning, kill_process, updated_at`,
      [
        scopeType,
        departmentId,
        employeeEmail,
        input.blockWebsites ?? null,
        input.blockApps ?? null,
        input.showWarning ?? null,
        input.killProcess ?? null,
      ]
    );
    const row = result.rows?.[0];
    const dept = row.department_id
      ? (await client.query(`SELECT name FROM departments WHERE id = $1 LIMIT 1`, [row.department_id])).rows?.[0]
      : null;
    return mapPolicyScopeRow({ ...row, department_name: dept?.name ?? null });
  });
}

export async function deletePolicyScopeSettings(id: string): Promise<boolean> {
  await ensureSecuritySchema();
  const rows = await sql`DELETE FROM policy_scope_settings WHERE id = ${id} RETURNING id`;
  return Boolean(rows?.[0]);
}

export async function getEffectivePolicyForEmployee(input: {
  employeeId?: string | null;
  employeeEmail?: string | null;
  departmentId?: string | null;
}): Promise<PolicySettings> {
  await ensureSecuritySchema();
  const base = await getPolicySettings();
  const employeeEmail = normalizeScopedEmail(input.employeeEmail);

  const rows = await sql`
    SELECT *
    FROM policy_scope_settings
    WHERE
      (scope_type = 'department' AND department_id = ${input.departmentId || null})
      OR (scope_type = 'employee' AND employee_email = ${employeeEmail} AND department_id = ${input.departmentId || null})
    ORDER BY
      CASE scope_type WHEN 'department' THEN 0 ELSE 1 END,
      updated_at DESC
  `;

  const departmentOverride = (rows || []).find((row: any) => normalizeScopeType(row.scope_type) === 'department');
  const employeeOverride = (rows || []).find((row: any) => normalizeScopeType(row.scope_type) === 'employee');

  return applyPolicyOverride(
    applyPolicyOverride(base, departmentOverride ? mapPolicyScopeRow(departmentOverride) : null),
    employeeOverride ? mapPolicyScopeRow(employeeOverride) : null
  );
}

export async function listBlockedApps(includeDisabled = false): Promise<BlockedAppRecord[]> {
  await ensureSecuritySchema();
  const rows = await sql`
    SELECT ba.*, d.name AS department_name
    FROM blocked_applications ba
    LEFT JOIN departments d ON d.id = ba.department_id
    ORDER BY ba.display_name ASC
  `;
  const items = (rows || []).map(mapBlockedAppRow);
  return includeDisabled ? items : items.filter((item: BlockedAppRecord) => item.enabled);
}

export async function listEffectiveBlockedApps(input: { departmentId?: string | null; employeeEmail?: string | null }): Promise<BlockedAppRecord[]> {
  await ensureSecuritySchema();
  const email = normalizeScopedEmail(input.employeeEmail);
  const rows = await sql`
    SELECT ba.*, d.name AS department_name
    FROM blocked_applications ba
    LEFT JOIN departments d ON d.id = ba.department_id
    WHERE ba.enabled = TRUE
      AND (
        ba.scope_type = 'global'
        OR (ba.scope_type = 'department' AND ba.department_id = ${input.departmentId || null})
        OR (ba.scope_type = 'employee' AND ba.employee_email = ${email} AND ba.department_id = ${input.departmentId || null})
      )
    ORDER BY ba.display_name ASC
  `;
  return (rows || []).map(mapBlockedAppRow);
}

export async function createBlockedApp(input: {
  displayName: string;
  processName: string;
  reason?: string | null;
  enabled?: boolean;
  scopeType?: PolicyScopeType;
  departmentId?: string | null;
  employeeEmail?: string | null;
}): Promise<BlockedAppRecord> {
  await ensureSecuritySchema();
  const scopeType = normalizeScopeType(input.scopeType);
  const departmentId = scopeType === 'global' ? null : (input.departmentId || null);
  const employeeEmail = scopeType === 'employee' ? normalizeScopedEmail(input.employeeEmail) : null;
  if (scopeType === 'department' && !departmentId) throw new Error('Department is required for department application policies');
  if (scopeType === 'employee' && !departmentId) throw new Error('Department is required for employee application policies');
  if (scopeType === 'employee' && !employeeEmail) throw new Error('Employee email is required for employee application policies');
  if (scopeType === 'employee' && departmentId && employeeEmail) await assertEmployeeBelongsToDepartment(employeeEmail, departmentId);
  const rows = await sql`
    INSERT INTO blocked_applications (display_name, process_name, reason, enabled, scope_type, department_id, employee_email)
    VALUES (
      ${input.displayName},
      ${input.processName},
      ${input.reason || null},
      ${input.enabled ?? true},
      ${scopeType},
      ${departmentId},
      ${employeeEmail}
    )
    RETURNING id, display_name, process_name, reason, enabled, scope_type, department_id, employee_email, created_at
  `;
  const row = rows?.[0];
  return mapBlockedAppRow({ ...row, department_name: null });
}

export async function updateBlockedApp(
  id: string,
  input: Partial<{
    displayName: string;
    processName: string;
    reason: string | null;
    enabled: boolean;
    scopeType: PolicyScopeType;
    departmentId: string | null;
    employeeEmail: string | null;
  }>
): Promise<BlockedAppRecord | null> {
  await ensureSecuritySchema();
  const currentRows = await sql`SELECT * FROM blocked_applications WHERE id = ${id} LIMIT 1`;
  const current = currentRows?.[0];
  if (!current) return null;

  const scopeType = input.scopeType !== undefined ? normalizeScopeType(input.scopeType) : normalizeScopeType(current.scope_type);
  const departmentId = scopeType === 'global'
    ? null
    : (
      scopeType === 'department'
    ? (input.departmentId !== undefined ? input.departmentId : current.department_id)
    : (input.departmentId !== undefined ? input.departmentId : current.department_id)
    );
  const employeeEmail = scopeType === 'employee'
    ? (input.employeeEmail !== undefined ? normalizeScopedEmail(input.employeeEmail) : current.employee_email)
    : null;
  if (scopeType === 'department' && !departmentId) throw new Error('Department is required for department application policies');
  if (scopeType === 'employee' && !departmentId) throw new Error('Department is required for employee application policies');
  if (scopeType === 'employee' && !employeeEmail) throw new Error('Employee email is required for employee application policies');
  if (scopeType === 'employee' && departmentId && employeeEmail) await assertEmployeeBelongsToDepartment(employeeEmail, departmentId);

  const rows = await sql`
    UPDATE blocked_applications
    SET
      display_name = COALESCE(${input.displayName ?? null}, display_name),
      process_name = COALESCE(${input.processName ?? null}, process_name),
      reason = ${input.reason !== undefined ? input.reason : current.reason},
      enabled = COALESCE(${input.enabled ?? null}, enabled),
      scope_type = ${scopeType},
      department_id = ${departmentId},
      employee_email = ${employeeEmail}
    WHERE id = ${id}
    RETURNING id, display_name, process_name, reason, enabled, scope_type, department_id, employee_email, created_at
  `;
  const row = rows?.[0];
  if (!row) return null;
  const dept = row.department_id ? (await sql`SELECT name FROM departments WHERE id = ${row.department_id} LIMIT 1`)?.[0] : null;
  return mapBlockedAppRow({ ...row, department_name: dept?.name ?? null });
}

export async function deleteBlockedApp(id: string): Promise<boolean> {
  await ensureSecuritySchema();
  const rows = await sql`DELETE FROM blocked_applications WHERE id = ${id} RETURNING id`;
  return Boolean(rows?.[0]);
}

export async function listBlockedWebsites(includeDisabled = false): Promise<BlockedWebsiteRecord[]> {
  await ensureSecuritySchema();
  const rows = await sql`
    SELECT bw.*, d.name AS department_name
    FROM blocked_websites bw
    LEFT JOIN departments d ON d.id = bw.department_id
    ORDER BY bw.domain ASC
  `;
  const items = (rows || []).map(mapBlockedWebsiteRow);
  return includeDisabled ? items : items.filter((item: BlockedWebsiteRecord) => item.enabled);
}

export async function listEffectiveBlockedWebsites(input: { departmentId?: string | null; employeeEmail?: string | null }): Promise<BlockedWebsiteRecord[]> {
  await ensureSecuritySchema();
  const email = normalizeScopedEmail(input.employeeEmail);
  const rows = await sql`
    SELECT bw.*, d.name AS department_name
    FROM blocked_websites bw
    LEFT JOIN departments d ON d.id = bw.department_id
    WHERE bw.enabled = TRUE
      AND (
        bw.scope_type = 'global'
        OR (bw.scope_type = 'department' AND bw.department_id = ${input.departmentId || null})
        OR (bw.scope_type = 'employee' AND bw.employee_email = ${email} AND bw.department_id = ${input.departmentId || null})
      )
    ORDER BY bw.domain ASC
  `;
  return (rows || []).map(mapBlockedWebsiteRow);
}

export async function createBlockedWebsite(input: {
  domain: string;
  reason?: string | null;
  enabled?: boolean;
  scopeType?: PolicyScopeType;
  departmentId?: string | null;
  employeeEmail?: string | null;
}): Promise<BlockedWebsiteRecord> {
  await ensureSecuritySchema();
  const scopeType = normalizeScopeType(input.scopeType);
  const departmentId = scopeType === 'global' ? null : (input.departmentId || null);
  const employeeEmail = scopeType === 'employee' ? normalizeScopedEmail(input.employeeEmail) : null;
  if (scopeType === 'department' && !departmentId) throw new Error('Department is required for department website policies');
  if (scopeType === 'employee' && !departmentId) throw new Error('Department is required for employee website policies');
  if (scopeType === 'employee' && !employeeEmail) throw new Error('Employee email is required for employee website policies');
  if (scopeType === 'employee' && departmentId && employeeEmail) await assertEmployeeBelongsToDepartment(employeeEmail, departmentId);
  const rows = await sql`
    INSERT INTO blocked_websites (domain, reason, enabled, scope_type, department_id, employee_email)
    VALUES (${input.domain}, ${input.reason || null}, ${input.enabled ?? true}, ${scopeType}, ${departmentId}, ${employeeEmail})
    RETURNING id, domain, reason, enabled, scope_type, department_id, employee_email, created_at
  `;
  const row = rows?.[0];
  return mapBlockedWebsiteRow({ ...row, department_name: null });
}

export async function updateBlockedWebsite(
  id: string,
  input: Partial<{ domain: string; reason: string | null; enabled: boolean; scopeType: PolicyScopeType; departmentId: string | null; employeeEmail: string | null }>
): Promise<BlockedWebsiteRecord | null> {
  await ensureSecuritySchema();
  const currentRows = await sql`SELECT * FROM blocked_websites WHERE id = ${id} LIMIT 1`;
  const current = currentRows?.[0];
  if (!current) return null;

  const scopeType = input.scopeType !== undefined ? normalizeScopeType(input.scopeType) : normalizeScopeType(current.scope_type);
  const departmentId = scopeType === 'global'
    ? null
    : (
      scopeType === 'department'
    ? (input.departmentId !== undefined ? input.departmentId : current.department_id)
    : (input.departmentId !== undefined ? input.departmentId : current.department_id)
    );
  const employeeEmail = scopeType === 'employee'
    ? (input.employeeEmail !== undefined ? normalizeScopedEmail(input.employeeEmail) : current.employee_email)
    : null;
  if (scopeType === 'department' && !departmentId) throw new Error('Department is required for department website policies');
  if (scopeType === 'employee' && !departmentId) throw new Error('Department is required for employee website policies');
  if (scopeType === 'employee' && !employeeEmail) throw new Error('Employee email is required for employee website policies');
  if (scopeType === 'employee' && departmentId && employeeEmail) await assertEmployeeBelongsToDepartment(employeeEmail, departmentId);

  const rows = await sql`
    UPDATE blocked_websites
    SET
      domain = COALESCE(${input.domain ?? null}, domain),
      reason = ${input.reason !== undefined ? input.reason : current.reason},
      enabled = COALESCE(${input.enabled ?? null}, enabled),
      scope_type = ${scopeType},
      department_id = ${departmentId},
      employee_email = ${employeeEmail}
    WHERE id = ${id}
    RETURNING id, domain, reason, enabled, scope_type, department_id, employee_email, created_at
  `;
  const row = rows?.[0];
  if (!row) return null;
  const dept = row.department_id ? (await sql`SELECT name FROM departments WHERE id = ${row.department_id} LIMIT 1`)?.[0] : null;
  return mapBlockedWebsiteRow({ ...row, department_name: dept?.name ?? null });
}

export async function deleteBlockedWebsite(id: string): Promise<boolean> {
  await ensureSecuritySchema();
  const rows = await sql`DELETE FROM blocked_websites WHERE id = ${id} RETURNING id`;
  return Boolean(rows?.[0]);
}

export async function createSecurityEvent(input: { employeeId: string | null; computerName: string | null; eventType: string; value: string | null; actionTaken: string | null }): Promise<SecurityEventRecord> {
  await ensureSecuritySchema();
  const rows = await sql`
    INSERT INTO security_events (employee_id, computer_name, type, target, action, details)
    VALUES (${input.employeeId}, ${input.computerName}, ${input.eventType}, ${input.value}, ${input.actionTaken}, ${null})
    RETURNING id, employee_id, computer_name, type, target, action, details, created_at
  `;
  const row = rows?.[0];
  return {
    id: row.id,
    employeeId: row.employee_id,
    computerName: row.computer_name,
    eventType: row.type,
    value: row.target,
    actionTaken: row.action,
    createdAt: row.created_at,
  };
}

type SecurityEventFilters = { employeeId?: string | null; date?: string | null; eventType?: string | null; viewAs?: string | null; departmentId?: string | null };

export async function listSecurityEventsPage(options: SecurityEventFilters & { limit?: number | null; offset?: number | null }): Promise<{ events: SecurityEventRecord[]; total: number }> {
  await ensureSecuritySchema();
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 200));
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));

  // Filter in SQL so every matching row is reachable, not just the newest page.
  const values: any[] = [];
  const filters: string[] = [];
  if (options.employeeId) {
    values.push(options.employeeId);
    filters.push(`se.employee_id = $${values.length}`);
  }
  if (options.departmentId) {
    values.push(options.departmentId);
    filters.push(`p.department_id = $${values.length}`);
  }
  if (options.eventType) {
    values.push(options.eventType);
    filters.push(`se.type = $${values.length}`);
  }
  if (options.date) {
    values.push(options.date);
    filters.push(`(se.created_at AT TIME ZONE 'UTC')::date = $${values.length}::date`);
  }
  values.push(limit, offset);

  const rows = await queryRows(`
    SELECT
      se.id,
      se.employee_id,
      se.computer_name,
      se.type,
      se.target,
      se.action,
      se.created_at,
      p.full_name AS employee_name,
      COUNT(*) OVER()::int AS total_count
    FROM security_events se
    LEFT JOIN public.profiles p ON p.id = se.employee_id
    ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
    ORDER BY se.created_at DESC, se.id DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}
  `, values);

  let total = rows[0]?.total_count ?? 0;
  if (!rows.length && offset > 0) {
    // Past the last page: still report the real total so the UI can recover.
    const countValues = values.slice(0, -2);
    const [countRow] = await queryRows(`
      SELECT COUNT(*)::int AS total
      FROM security_events se
      LEFT JOIN public.profiles p ON p.id = se.employee_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
    `, countValues);
    total = countRow?.total ?? 0;
  }

  return {
    total,
    events: rows.map((row: any) => ({
      id: row.id,
      employeeId: row.employee_id,
      computerName: row.computer_name,
      eventType: row.type,
      value: row.target,
      actionTaken: row.action,
      createdAt: row.created_at,
      employeeName: row.employee_name,
    })),
  };
}

export async function listSecurityEvents(options: SecurityEventFilters & { limit?: number | null }): Promise<SecurityEventRecord[]> {
  const { events } = await listSecurityEventsPage({ ...options, limit: options.limit ? Math.min(Number(options.limit), 100) : 20 });
  return events;
}
