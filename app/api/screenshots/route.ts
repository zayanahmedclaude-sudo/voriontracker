// app/api/screenshots/route.ts
import { NextRequest } from 'next/server';
import { del } from '@vercel/blob';
import { getExistingColumns, queryRows, sql } from '@/lib/db';
import { requireAuth, ok, err } from '@/lib/api';
import { emitSocketEvent } from '@/lib/socket';
import { assertSupabaseAdmin } from '@/lib/supabase';
import { canDeleteRecords, canMonitorAll, normalizeRole } from '@/lib/roles';
import {
  BUSINESS_TIME_ZONE,
  getLocalDateInTimeZone,
  getShiftDateInTimeZone,
  getShiftRangeForDate,
  getShiftWindowsForDate,
} from '@/lib/shifts';

function getSupabaseObjectPath(publicUrl: string) {
  try {
    const pathname = new URL(publicUrl).pathname;
    const marker = '/storage/v1/object/public/screenshots/';
    const index = pathname.indexOf(marker);
    if (index === -1) return null;
    return decodeURIComponent(pathname.slice(index + marker.length));
  } catch {
    return null;
  }
}

function getScreenshotUrlExpression(columns: Set<string>, tableAlias = 's') {
  const hasBlobUrl = columns.has('blob_url');
  const hasFileUrl = columns.has('file_url');
  if (hasBlobUrl && hasFileUrl) return `COALESCE(${tableAlias}.blob_url, ${tableAlias}.file_url)`;
  if (hasBlobUrl) return `${tableAlias}.blob_url`;
  if (hasFileUrl) return `${tableAlias}.file_url`;
  throw new Error('screenshots table is missing a URL column');
}

function getThumbnailUrlExpression(columns: Set<string>, fileUrlExpression: string, tableAlias = 's') {
  return columns.has('thumbnail_url')
    ? `COALESCE(${tableAlias}.thumbnail_url, ${fileUrlExpression})`
    : fileUrlExpression;
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  return err('Legacy screenshot uploads are disabled. Upload image bytes directly to Vercel Blob, then POST metadata to /api/agent/screenshots/commit.', 410);
}

export async function GET(req: NextRequest) {
  if (!process.env.DATABASE_URL) return err('Server misconfigured: DATABASE_URL not set', 500);
  const user = requireAuth(req);
  if ('status' in user) return user;
  const role = normalizeRole(user.role);
  const { sub } = user;

  try {
    const { searchParams } = new URL(req.url);
    const filterUserId = searchParams.get('userId');
    const requestedDate = searchParams.get('date');
    const requestedLimit = parseInt(searchParams.get('limit') || '60', 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 60;
    const before = searchParams.get('before');
    const beforeDate = before ? new Date(before) : null;
    if (beforeDate && Number.isNaN(beforeDate.getTime())) return err('Invalid pagination cursor', 400);
    const beforeIso = beforeDate?.toISOString() || '9999-12-31T23:59:59.999Z';
    const timeZone     = searchParams.get('tz') || 'America/New_York';
    const effectiveTimeZone = role === 'client' ? BUSINESS_TIME_ZONE : timeZone;
    const date = requestedDate ?? (
      role === 'client'
        ? getShiftDateInTimeZone(new Date(), effectiveTimeZone)
        : getLocalDateInTimeZone(new Date(), effectiveTimeZone)
    );
    const availableColumns = await getExistingColumns('screenshots', ['blob_url', 'file_url', 'thumbnail_url']);
    const screenshotUrlExpression = getScreenshotUrlExpression(availableColumns);
    const thumbnailUrlExpression = getThumbnailUrlExpression(availableColumns, screenshotUrlExpression);

    let rows;

    if (role === 'employee') {
      rows = await queryRows(
        `SELECT s.id, s.employee_id, ${screenshotUrlExpression} AS file_url, ${thumbnailUrlExpression} AS thumbnail_url, s.captured_at, s.created_at, s.active_app, s.activity_pct, p.full_name AS user_name
        FROM screenshots s
        JOIN public.profiles p ON p.id = s.employee_id
        WHERE s.employee_id = $1
          AND DATE(s.captured_at) = $2
          AND s.captured_at < $3
        ORDER BY s.captured_at DESC
        LIMIT $4`,
        [sub, date, beforeIso, limit],
      );
    } else if (role === 'client') {
      const assignedRows = filterUserId
        ? await sql`
            SELECT p.id, ca.shift_type AS assignment_shift_type
            FROM client_assignments ca
            JOIN public.profiles p ON p.id = ca.employee_id
            WHERE ca.client_id = ${sub}
              AND p.id = ${filterUserId}
          `
        : await sql`
            SELECT p.id, ca.shift_type AS assignment_shift_type
            FROM client_assignments ca
            JOIN public.profiles p ON p.id = ca.employee_id
            WHERE ca.client_id = ${sub}
          `;

      if (!assignedRows.length) {
        return ok([]);
      }

      const values: any[] = [];
      const valueRows = assignedRows.map((assigned: any) => {
        const shiftType = assigned.assignment_shift_type || 'full_time';
        const shiftRange = getShiftRangeForDate(date, shiftType);
        const shiftWindows = getShiftWindowsForDate(date, shiftType);
        const firstWindow = shiftWindows[0];
        const secondWindow = shiftWindows[1] || firstWindow;
        const hasSecondWindow = shiftWindows.length > 1;
        const rowValues = [
          assigned.id,
          shiftRange.startIso,
          shiftRange.endIso,
          firstWindow.start.toISOString(),
          firstWindow.end.toISOString(),
          hasSecondWindow,
          secondWindow.start.toISOString(),
          secondWindow.end.toISOString(),
        ];
        values.push(...rowValues);
        const offset = values.length - rowValues.length;
        return `($${offset + 1}::uuid, $${offset + 2}::timestamptz, $${offset + 3}::timestamptz, $${offset + 4}::timestamptz, $${offset + 5}::timestamptz, $${offset + 6}::boolean, $${offset + 7}::timestamptz, $${offset + 8}::timestamptz)`;
      });
      values.push(beforeIso, limit);
      const beforeIndex = values.length - 1;
      const limitIndex = values.length;
      rows = await queryRows(
        `WITH assignment_windows(employee_id, shift_start, shift_end, first_start, first_end, has_second, second_start, second_end) AS (
           VALUES ${valueRows.join(', ')}
         )
         SELECT s.id, s.employee_id, ${screenshotUrlExpression} AS file_url, ${thumbnailUrlExpression} AS thumbnail_url, s.captured_at, s.created_at, s.active_app, s.activity_pct, p.full_name AS user_name
         FROM screenshots s
         JOIN assignment_windows aw ON aw.employee_id = s.employee_id
         JOIN public.profiles p ON p.id = s.employee_id
         WHERE s.captured_at >= aw.shift_start
           AND s.captured_at < aw.shift_end
           AND s.captured_at < $${beforeIndex}::timestamptz
           AND (
             (s.captured_at >= aw.first_start AND s.captured_at < aw.first_end)
             OR (aw.has_second AND s.captured_at >= aw.second_start AND s.captured_at < aw.second_end)
           )
         ORDER BY s.captured_at DESC
         LIMIT $${limitIndex}`,
        values,
      );
    } else if (canMonitorAll(role)) {
      if (filterUserId) {
        rows = await queryRows(
          `SELECT s.id, s.employee_id, ${screenshotUrlExpression} AS file_url, ${thumbnailUrlExpression} AS thumbnail_url, s.captured_at, s.created_at, s.active_app, s.activity_pct, p.full_name AS user_name
          FROM screenshots s
          JOIN public.profiles p ON p.id = s.employee_id
          WHERE s.employee_id = $1
            AND DATE(s.captured_at) = $2
            AND s.captured_at < $3
          ORDER BY s.captured_at DESC
          LIMIT $4`,
          [filterUserId, date, beforeIso, limit],
        );
      } else {
        rows = await queryRows(
          `SELECT s.id, s.employee_id, ${screenshotUrlExpression} AS file_url, ${thumbnailUrlExpression} AS thumbnail_url, s.captured_at, s.created_at, s.active_app, s.activity_pct, p.full_name AS user_name
          FROM screenshots s
          JOIN public.profiles p ON p.id = s.employee_id
          WHERE DATE(s.captured_at) = $1
            AND s.captured_at < $2
          ORDER BY s.captured_at DESC
          LIMIT $3`,
          [date, beforeIso, limit],
        );
      }
    } else {
      return err('Forbidden', 403);
    }

    return ok(rows);
  } catch (e: any) {
    console.error('GET /api/screenshots error', e);
    return err(e?.message || 'Internal server error', 500);
  }
}

export async function DELETE(req: NextRequest) {
  if (!process.env.DATABASE_URL) return err('Server misconfigured: DATABASE_URL not set', 500);
  const authUser = requireAuth(req);
  if ('status' in authUser) return authUser;
  if (!canDeleteRecords(normalizeRole(authUser.role))) return err('Forbidden', 403);

  const { searchParams } = new URL(req.url);
  let id = searchParams.get('id');
  try {
    if (!id) {
      const body = await req.json().catch(() => null);
      id = body?.id;
    }
  } catch {}

  if (!id) return err('Missing screenshot id', 400);

  try {
    const availableColumns = await getExistingColumns('screenshots', ['blob_url', 'file_url', 'thumbnail_url']);
    const screenshotUrlExpression = getScreenshotUrlExpression(availableColumns);
    const thumbnailSelectExpression = availableColumns.has('thumbnail_url') ? 'thumbnail_url' : 'NULL AS thumbnail_url';
    const rows = await queryRows(
      `SELECT id, employee_id, ${screenshotUrlExpression} AS blob_url, ${thumbnailSelectExpression} FROM screenshots WHERE id = $1 LIMIT 1`,
      [id],
    );
    const rec = rows?.[0];
    if (!rec) return err('Screenshot not found', 404);

    try {
      const blobUrl: string = rec.blob_url || '';
      if (blobUrl) {
        if (blobUrl.includes('.blob.vercel-storage.com/')) {
          await del(blobUrl);
        } else {
          const objectPath = getSupabaseObjectPath(blobUrl);
          if (objectPath) {
          const { error: removeError } = await assertSupabaseAdmin().storage.from('screenshots').remove([objectPath]);
          if (removeError) throw removeError;
          }
        }
      }
      const thumbnailUrl: string = rec.thumbnail_url || '';
      if (thumbnailUrl && thumbnailUrl !== blobUrl && thumbnailUrl.includes('.blob.vercel-storage.com/')) {
        await del(thumbnailUrl);
      }
    } catch (e:any) {
      console.warn('Error removing screenshot from storage:', e?.message || e);
    }

    await sql`DELETE FROM screenshots WHERE id = ${id}`;

    try { await emitSocketEvent('screenshot-deleted', { id, employee_id: rec.employee_id }, { toAdmins: true }); } catch {}

    return ok({ ok: true });
  } catch (e:any) {
    console.error('DELETE /api/screenshots error:', e?.message || e);
    return err('Failed to delete screenshot', 500);
  }
}
