import { NextRequest } from 'next/server';
import { requireAuth, ok, err } from '@/lib/api';
import { canManageUsers, canMonitorAll, normalizeRole } from '@/lib/roles';
import { createDepartment, deleteDepartment, listDepartments, updateDepartment } from '@/lib/security';
import { invalidatesCache } from '@/lib/cache';

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  const role = normalizeRole(user.role);
  if (!canManageUsers(role) && !canMonitorAll(role)) return err('Forbidden', 403);

  try {
    return ok(await listDepartments());
  } catch (e: any) {
    console.error('GET /api/departments error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}

async function postHandler(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canManageUsers(normalizeRole(user.role))) return err('Forbidden', 403);

  try {
    const body = await req.json();
    if (!String(body?.name || '').trim()) return err('Department name is required', 400);
    const department = await createDepartment({
      name: String(body.name).trim(),
      description: body?.description ? String(body.description).trim() : null,
    });
    return ok(department, 201);
  } catch (e: any) {
    console.error('POST /api/departments error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}

async function patchHandler(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canManageUsers(normalizeRole(user.role))) return err('Forbidden', 403);

  try {
    const body = await req.json();
    if (!body?.id) return err('Department id is required', 400);
    const department = await updateDepartment(String(body.id), {
      name: body?.name !== undefined ? String(body.name).trim() : undefined,
      description: body?.description !== undefined ? (body.description ? String(body.description).trim() : null) : undefined,
    });
    if (!department) return err('Department not found', 404);
    return ok(department);
  } catch (e: any) {
    console.error('PATCH /api/departments error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}

async function deleteHandler(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (normalizeRole(user.role) !== 'superadmin') return err('Forbidden', 403);

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return err('Department id is required', 400);
    const deleted = await deleteDepartment(id);
    if (!deleted) return err('Department not found', 404);
    return ok({ success: true });
  } catch (e: any) {
    console.error('DELETE /api/departments error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}

// Users and departments feed the cached user lists; clear them after writes.
export const POST = invalidatesCache(['users'], postHandler);
export const PATCH = invalidatesCache(['users'], patchHandler);
export const DELETE = invalidatesCache(['users'], deleteHandler);
