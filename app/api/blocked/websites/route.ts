import { NextRequest } from 'next/server';
import { cachedOk, requireAuth, ok, err } from '@/lib/api';
import { createBlockedWebsite, deleteBlockedWebsite, listBlockedWebsites, listEffectiveBlockedWebsites, updateBlockedWebsite } from '@/lib/security';
import { canManageSecurity, normalizeRole } from '@/lib/roles';
import { sql } from '@/lib/db';
import { notifyPolicyChanged } from '@/lib/policy-notify';

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  try {
    const role = normalizeRole(user.role);
    const sites = role === 'employee'
      ? await (async () => {
          const rows = await sql`SELECT email, department_id FROM public.profiles WHERE id = ${user.sub} LIMIT 1`;
          const profile = rows?.[0];
          return listEffectiveBlockedWebsites({ departmentId: profile?.department_id || null, employeeEmail: profile?.email || null });
        })()
      : await listBlockedWebsites(true);
    return cachedOk(sites, 300);
  } catch (e: any) {
    console.error('GET /api/blocked/websites error:', e?.message || e);
    return err('Internal server error', 500);
  }
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canManageSecurity(normalizeRole(user.role))) return err('Forbidden', 403);

  try {
    const body = await req.json();
    const site = await createBlockedWebsite({
      domain: String(body?.domain || '').trim(),
      reason: body?.reason ? String(body.reason) : null,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : true,
      scopeType: body?.scopeType,
      departmentId: body?.departmentId || null,
      employeeEmail: body?.employeeEmail || null,
    });
    await notifyPolicyChanged();
    return ok(site, 201);
  } catch (e: any) {
    console.error('POST /api/blocked/websites error:', e?.message || e);
    if (e?.code === '23505') return err('This website is already blocked for the selected scope', 409);
    return err(e?.message || 'Internal server error', 500);
  }
}

export async function PUT(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canManageSecurity(normalizeRole(user.role))) return err('Forbidden', 403);

  try {
    const body = await req.json();
    const site = await updateBlockedWebsite(String(body?.id || ''), {
      domain: body?.domain !== undefined ? String(body.domain).trim() : undefined,
      reason: body?.reason !== undefined ? (body.reason ? String(body.reason) : null) : undefined,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : undefined,
      scopeType: body?.scopeType !== undefined ? body.scopeType : undefined,
      departmentId: body?.departmentId !== undefined ? body.departmentId || null : undefined,
      employeeEmail: body?.employeeEmail !== undefined ? body.employeeEmail || null : undefined,
    });
    if (!site) return err('Website not found', 404);
    await notifyPolicyChanged();
    return ok(site);
  } catch (e: any) {
    console.error('PUT /api/blocked/websites error:', e?.message || e);
    if (e?.code === '23505') return err('This website is already blocked for the selected scope', 409);
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
    const deleted = await deleteBlockedWebsite(id);
    if (!deleted) return err('Website not found', 404);
    await notifyPolicyChanged();
    return ok({ success: true });
  } catch (e: any) {
    console.error('DELETE /api/blocked/websites error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}
