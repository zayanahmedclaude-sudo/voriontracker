import { NextRequest } from 'next/server';
import { requireAuth, ok, err } from '@/lib/api';
import { deletePolicyScopeSettings, getPolicySettings, listDepartments, listPolicyEmployees, listPolicyScopeSettings, savePolicyScopeSettings, updatePolicySettings } from '@/lib/security';
import { canManageSecurity, canViewSecurity, normalizeRole } from '@/lib/roles';
import { notifyPolicyChanged } from '@/lib/policy-notify';

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canViewSecurity(normalizeRole(user.role))) return err('Forbidden', 403);

  try {
    const [policy, overrides, departments, employees] = await Promise.all([
      getPolicySettings(),
      listPolicyScopeSettings(),
      listDepartments(),
      listPolicyEmployees(),
    ]);
    return ok({
      blockApps: policy.blockApps,
      blockWebsites: policy.blockWebsites,
      killProcess: policy.killProcess,
      showWarning: policy.showWarning,
      overrides,
      departments,
      employees,
    });
  } catch (e: any) {
    console.error('GET /api/policies error:', e?.message || e);
    return err('Internal server error', 500);
  }
}

export async function PUT(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canManageSecurity(normalizeRole(user.role))) return err('Forbidden', 403);

  try {
    const body = await req.json();
    const policy = await updatePolicySettings({
      blockWebsites: body?.blockWebsites !== undefined ? Boolean(body.blockWebsites) : undefined,
      blockApps: body?.blockApps !== undefined ? Boolean(body.blockApps) : undefined,
      showWarning: body?.showWarning !== undefined ? Boolean(body.showWarning) : undefined,
      killProcess: body?.killProcess !== undefined ? Boolean(body.killProcess) : undefined,
    });
    await notifyPolicyChanged();
    return ok(policy);
  } catch (e: any) {
    console.error('PUT /api/policies error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canManageSecurity(normalizeRole(user.role))) return err('Forbidden', 403);

  try {
    const body = await req.json();
    const policy = await savePolicyScopeSettings({
      id: body?.id || null,
      scopeType: body?.scopeType,
      departmentId: body?.departmentId || null,
      employeeEmail: body?.employeeEmail || null,
      blockWebsites: body?.blockWebsites === undefined ? null : Boolean(body.blockWebsites),
      blockApps: body?.blockApps === undefined ? null : Boolean(body.blockApps),
      showWarning: body?.showWarning === undefined ? null : Boolean(body.showWarning),
      killProcess: body?.killProcess === undefined ? null : Boolean(body.killProcess),
    });
    await notifyPolicyChanged();
    return ok(policy, body?.id ? 200 : 201);
  } catch (e: any) {
    console.error('POST /api/policies error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}

export async function DELETE(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canManageSecurity(normalizeRole(user.role))) return err('Forbidden', 403);

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return err('id is required', 400);
    const deleted = await deletePolicyScopeSettings(id);
    if (!deleted) return err('Policy override not found', 404);
    await notifyPolicyChanged();
    return ok({ success: true });
  } catch (e: any) {
    console.error('DELETE /api/policies error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}
