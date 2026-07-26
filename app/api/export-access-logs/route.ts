import { NextRequest } from 'next/server';
import { err, ok, requireAuth } from '@/lib/api';
import { createExportAccessLog, listExportAccessLogs } from '@/lib/export-access';
import { normalizeRole } from '@/lib/roles';

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  if (normalizeRole(user.role) !== 'superadmin') {
    return err('Forbidden', 403);
  }

  try {
    const { searchParams } = new URL(req.url);
    const limit = Number(searchParams.get('limit') || 100);
    const logs = await listExportAccessLogs(limit);
    return ok(logs);
  } catch (error: any) {
    console.error('GET /api/export-access-logs error:', error?.message || error);
    return err('Internal server error', 500);
  }
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  try {
    const body = await req.json();
    const exportType = String(body?.exportType || '').trim();
    if (!exportType) {
      return err('Export type is required', 400);
    }

    const record = await createExportAccessLog({
      actorUserId: user.sub || null,
      actorName: user.name || null,
      actorEmail: null,
      exportType,
      target: body?.target ? String(body.target) : null,
      startDate: body?.startDate ? String(body.startDate) : null,
      endDate: body?.endDate ? String(body.endDate) : null,
      details: body?.details && typeof body.details === 'object' ? body.details : null,
    });
    return ok(record, 201);
  } catch (error: any) {
    console.error('POST /api/export-access-logs error:', error?.message || error);
    return err('Internal server error', 500);
  }
}
