// app/api/recordings/route.ts
import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, ok, err } from '@/lib/api';
import { canMonitorAll, normalizeRole } from '@/lib/roles';

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  return err('Legacy recording uploads are disabled. Upload video bytes directly to R2, then POST metadata to the recording-specific commit endpoint.', 410);
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  const role = normalizeRole(user.role);

  const { searchParams } = new URL(req.url);
  const filterUserId = searchParams.get('userId');
  const limit = parseInt(searchParams.get('limit') || '60');

  let rows;
  if (role === 'employee') {
    rows = await sql`
      SELECT r.*, p.full_name AS user_name
      FROM recordings r
      JOIN public.profiles p ON p.id = r.user_id
      WHERE r.user_id = ${user.sub}
      ORDER BY r.captured_at DESC
        LIMIT ${limit}
      `;
  } else if (canMonitorAll(role) && filterUserId) {
    rows = await sql`
      SELECT r.*, p.full_name AS user_name
      FROM recordings r
      JOIN public.profiles p ON p.id = r.user_id
      WHERE r.user_id = ${filterUserId}
      ORDER BY r.captured_at DESC
      LIMIT ${limit}
    `;
  } else if (canMonitorAll(role)) {
    rows = await sql`
      SELECT r.*, p.full_name AS user_name
      FROM recordings r
      JOIN public.profiles p ON p.id = r.user_id
      ORDER BY r.captured_at DESC
      LIMIT ${limit}
    `;
  } else {
    return err('Forbidden', 403);
  }

  return ok(rows);
}
