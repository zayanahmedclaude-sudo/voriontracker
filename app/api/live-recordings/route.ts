import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, ok, err } from '@/lib/api';
import { canAccessLiveMonitor, normalizeRole } from '@/lib/roles';

function isVercelBlobUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && (
      url.hostname.endsWith('.blob.vercel-storage.com')
      || url.hostname.endsWith('.public.blob.vercel-storage.com')
      || url.hostname.endsWith('.vercel-storage.com')
    );
  } catch {
    return false;
  }
}

async function canManageLiveRecording(user: any, employeeId: string) {
  if (!canAccessLiveMonitor(normalizeRole(user.role))) return false;
  const rows = await sql`
    SELECT 1
    FROM public.profiles employee
    WHERE employee.id = ${employeeId}
      AND employee.role = 'employee'
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function POST(request: NextRequest) {
  const user = requireAuth(request);
  if ('status' in user) return user;

  try {
    if (!request.headers.get('content-type')?.includes('application/json')) {
      return err('Legacy recording uploads are disabled. Upload video bytes directly to Vercel Blob, then POST recording metadata.', 410);
    }

    const body = await request.json();
    const employeeId = String(body?.employeeId || '');
    if (!employeeId) return err('Employee id is required.', 400);
    if (!(await canManageLiveRecording(user, employeeId))) return err('Forbidden', 403);

    const fileUrl = String(body?.fileUrl || '');
    if (!isVercelBlobUrl(fileUrl)) return err('Invalid recording URL.', 400);

    return ok({
      ok: true,
      employeeId,
      adminId: user.sub,
      startTime: String(body?.startTime || new Date().toISOString()),
      endTime: String(body?.endTime || new Date().toISOString()),
      duration: Number(body?.duration || 0),
      fileUrl,
    });
  } catch (error: any) {
    console.error('[live-recordings] failed', error?.stack || error);
    return err(error?.message || 'Recording upload failed', 500);
  }
}
