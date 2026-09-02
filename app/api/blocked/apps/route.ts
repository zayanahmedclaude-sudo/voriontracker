import { NextRequest } from 'next/server';
import { cachedOk, requireAuth, ok, err } from '@/lib/api';
import { createBlockedApp, deleteBlockedApp, listBlockedApps, updateBlockedApp } from '@/lib/security';
import { canManageSecurity, canViewSecurity, normalizeRole } from '@/lib/roles';
import { notifyPolicyChanged } from '@/lib/policy-notify';

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (req.headers.get('x-vorion-agent-id')) return err('agent_policy_endpoint_retired', 426);

  try {
    const role = normalizeRole(user.role);
    if (!canViewSecurity(role)) return err('Forbidden', 403);
    const apps = await listBlockedApps(true);
    return cachedOk(apps, 300);
  } catch (e: any) {
    console.error('GET /api/blocked/apps error:', e?.message || e);
    return err('Internal server error', 500);
  }
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canManageSecurity(normalizeRole(user.role))) return err('Forbidden', 403);

  try {
    const body = await req.json();
    const app = await createBlockedApp({
      displayName: String(body?.displayName || '').trim(),
      processName: String(body?.processName || '').trim(),
      reason: body?.reason ? String(body.reason) : null,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : true,
      scopeType: body?.scopeType,
      departmentId: body?.departmentId || null,
      employeeEmail: body?.employeeEmail || null,
    });
    await notifyPolicyChanged();
    return ok(app, 201);
  } catch (e: any) {
    console.error('POST /api/blocked/apps error:', e?.message || e);
    if (e?.code === '23505') return err('This application is already blocked for the selected scope', 409);
    return err(e?.message || 'Internal server error', 500);
  }
}

export async function PUT(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canManageSecurity(normalizeRole(user.role))) return err('Forbidden', 403);

  try {
    const body = await req.json();
    const app = await updateBlockedApp(String(body?.id || ''), {
      displayName: body?.displayName !== undefined ? String(body.displayName).trim() : undefined,
      processName: body?.processName !== undefined ? String(body.processName).trim() : undefined,
      reason: body?.reason !== undefined ? (body.reason ? String(body.reason) : null) : undefined,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : undefined,
      scopeType: body?.scopeType !== undefined ? body.scopeType : undefined,
      departmentId: body?.departmentId !== undefined ? body.departmentId || null : undefined,
      employeeEmail: body?.employeeEmail !== undefined ? body.employeeEmail || null : undefined,
    });
    if (!app) return err('App not found', 404);
    await notifyPolicyChanged();
    return ok(app);
  } catch (e: any) {
    console.error('PUT /api/blocked/apps error:', e?.message || e);
    if (e?.code === '23505') return err('This application is already blocked for the selected scope', 409);
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
    const deleted = await deleteBlockedApp(id);
    if (!deleted) return err('App not found', 404);
    await notifyPolicyChanged();
    return ok({ success: true });
  } catch (e: any) {
    console.error('DELETE /api/blocked/apps error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}
