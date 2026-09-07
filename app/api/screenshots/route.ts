// app/api/screenshots/route.ts
import { NextRequest } from 'next/server';
import { getExistingColumns, queryRows, sql } from '@/lib/db';
import { cachedOk, requireAuth, ok, err } from '@/lib/api';
import { emitSocketEvent } from '@/lib/socket';
import { deleteR2Objects, getR2KeyFromUrl } from '@/lib/r2';
import { canDeleteRecords, canMonitorAll, normalizeRole } from '@/lib/roles';
import {
  BUSINESS_TIME_ZONE,
  getBusinessShiftDatesForUtcRange,
  getLocalDateInTimeZone,
  getShiftDateInTimeZone,
  getShiftRangeForDate,
  getShiftWindowsForDate,
  getUtcRangeForLocalDate,
  isValidTimeZone,
  zonedDateTimeToUtc,
} from '@/lib/shifts';
import { ensureMonitoringSchema } from '@/lib/schema';

function getScreenshotUrlExpression(columns: Set<string>, tableAlias = 's') {
  if (columns.has('file_url')) return `${tableAlias}.file_url`;
  throw new Error('screenshots table is missing its R2 URL column');
}

function getThumbnailUrlExpression(columns: Set<string>, tableAlias = 's') {
  return columns.has('thumbnail_url') ? `${tableAlias}.thumbnail_url` : 'NULL::text';
}

function getScreenshotListSelect({
  screenshotUrlExpression,
  thumbnailUrlExpression,
  storageExpiredExpression,
}: {
  screenshotUrlExpression: string;
  thumbnailUrlExpression: string;
  storageExpiredExpression: string;
}) {
  return `s.id, s.employee_id, s.device_registration_id, s.capture_context, ${screenshotUrlExpression} AS file_url, ${thumbnailUrlExpression} AS thumbnail_url, ${storageExpiredExpression} AS "storageExpired", s.captured_at, s.active_app, s.activity_pct, EXISTS(SELECT 1 FROM screenshot_flags sf WHERE sf.screenshot_id=s.id) AS flagged, COALESCE(p.full_name, d.device_name, 'Unassigned device') AS user_name, d.device_name`;
}

function normalizeTimeInput(value: string | null) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return /^\d{2}:\d{2}$/.test(normalized) ? `${normalized}:00` : '';
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  return err('Legacy screenshot uploads are disabled. Upload image bytes directly to R2, then POST metadata to /api/agent/screenshots/commit.', 410);
}

export async function GET(req: NextRequest) {
  if (!process.env.DATABASE_URL) return err('Server misconfigured: DATABASE_URL not set', 500);
  const user = requireAuth(req);
  if ('status' in user) return user;
  const role = normalizeRole(user.role);
  const { sub } = user;

  try {
    await ensureMonitoringSchema();
    const { searchParams } = new URL(req.url);
    const filterUserId = searchParams.get('userId');
    const requestedDate = searchParams.get('date');
    const dateFrom = searchParams.get('dateFrom');
    const dateTo = searchParams.get('dateTo');
    const timeFrom = normalizeTimeInput(searchParams.get('timeFrom'));
    const timeTo = normalizeTimeInput(searchParams.get('timeTo'));
    const activeAppQuery = searchParams.get('activeApp')?.trim();
    const requestedLimit = parseInt(searchParams.get('limit') || '20', 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 25) : 20;
    const before = searchParams.get('before');
    const beforeDate = before ? new Date(before) : null;
    if (beforeDate && Number.isNaN(beforeDate.getTime())) return err('Invalid pagination cursor', 400);
    const beforeIso = beforeDate?.toISOString() || '9999-12-31T23:59:59.999Z';
    const requestedTimeZone = searchParams.get('tz') || BUSINESS_TIME_ZONE;
    const timeZone = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : BUSINESS_TIME_ZONE;
    const filterTimeZone = timeZone;
    const normalizedDateFrom = requestedDate || dateFrom || '';
    const normalizedDateTo = requestedDate || dateTo || '';

    const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (normalizedDateFrom && !isoDatePattern.test(normalizedDateFrom)) return err('Invalid dateFrom value', 400);
    if (normalizedDateTo && !isoDatePattern.test(normalizedDateTo)) return err('Invalid dateTo value', 400);
    if (searchParams.get('timeFrom') && !timeFrom) return err('Invalid timeFrom value', 400);
    if (searchParams.get('timeTo') && !timeTo) return err('Invalid timeTo value', 400);
    if (normalizedDateFrom && normalizedDateTo && normalizedDateFrom > normalizedDateTo) return err('dateFrom cannot be after dateTo', 400);

    const requestedSingleDate = requestedDate || '';
    const hasExplicitDateFilter = Boolean(requestedSingleDate || normalizedDateFrom || normalizedDateTo);
    const defaultDate = role === 'client'
      ? getShiftDateInTimeZone(new Date(), BUSINESS_TIME_ZONE)
      : getLocalDateInTimeZone(new Date(), filterTimeZone);
    const effectiveDateFrom = normalizedDateFrom || (!hasExplicitDateFilter ? defaultDate : '');
    const effectiveDateTo = normalizedDateTo || (!hasExplicitDateFilter ? defaultDate : (effectiveDateFrom && timeFrom ? effectiveDateFrom : ''));
    const effectiveStartIso = effectiveDateFrom
      ? (timeFrom ? zonedDateTimeToUtc(effectiveDateFrom, timeFrom, filterTimeZone).toISOString() : getUtcRangeForLocalDate(effectiveDateFrom, filterTimeZone).startIso)
      : '';
    const effectiveEndIso = effectiveDateTo
      ? (timeTo ? zonedDateTimeToUtc(effectiveDateTo, timeTo, filterTimeZone).toISOString() : getUtcRangeForLocalDate(effectiveDateTo, filterTimeZone).endIso)
      : '';
    if (effectiveStartIso && effectiveEndIso && effectiveStartIso >= effectiveEndIso) return err('Start time must be before end time', 400);
    const clientDates = effectiveStartIso && effectiveEndIso
      ? getBusinessShiftDatesForUtcRange(new Date(effectiveStartIso), new Date(effectiveEndIso))
      : [getShiftDateInTimeZone(new Date(), BUSINESS_TIME_ZONE)];
    const activeAppLike = activeAppQuery ? `%${activeAppQuery.replace(/[%_]/g, '\\$&')}%` : '';
    const availableColumns = await getExistingColumns('screenshots', ['file_url', 'thumbnail_url', 'storage_expired_at']);
    const screenshotUrlExpression = getScreenshotUrlExpression(availableColumns);
    const thumbnailUrlExpression = getThumbnailUrlExpression(availableColumns);
    const storageExpiredExpression = availableColumns.has('storage_expired_at')
      ? `(${screenshotUrlExpression} IS NULL OR s.storage_expired_at IS NOT NULL)`
      : `(${screenshotUrlExpression} IS NULL)`;
    const listSelect = getScreenshotListSelect({ screenshotUrlExpression, thumbnailUrlExpression, storageExpiredExpression });

    let rows;

    if (role === 'employee') {
      const conditions = ['s.employee_id = $1', 's.captured_at < $2'];
      const values: any[] = [sub, beforeIso];
      if (effectiveStartIso) {
        values.push(effectiveStartIso);
        conditions.push(`s.captured_at >= $${values.length}`);
      }
      if (effectiveEndIso) {
        values.push(effectiveEndIso);
        conditions.push(`s.captured_at < $${values.length}`);
      }
      if (activeAppLike) {
        values.push(activeAppLike);
        conditions.push(`COALESCE(s.active_app, '') ILIKE $${values.length} ESCAPE '\\'`);
      }
      values.push(limit);
      rows = await queryRows(
        `SELECT ${listSelect}
        FROM screenshots s
        JOIN public.profiles p ON p.id = s.employee_id
        LEFT JOIN devices d ON d.id = s.device_registration_id
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY s.captured_at DESC
        LIMIT $${values.length}`,
        values,
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
        return cachedOk([], 300);
      }

      const values: any[] = [];
      const valueRows = assignedRows.flatMap((assigned: any) => {
        const shiftType = assigned.assignment_shift_type || 'full_time';
        return clientDates.map((clientDate) => {
          const shiftRange = getShiftRangeForDate(clientDate, shiftType);
          const shiftWindows = getShiftWindowsForDate(clientDate, shiftType);
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
      });
      const conditions = [
        `s.captured_at >= aw.shift_start`,
        `s.captured_at < aw.shift_end`,
        `( (s.captured_at >= aw.first_start AND s.captured_at < aw.first_end) OR (aw.has_second AND s.captured_at >= aw.second_start AND s.captured_at < aw.second_end) )`,
      ];
      values.push(beforeIso);
      conditions.push(`s.captured_at < $${values.length}::timestamptz`);
      if (effectiveStartIso) {
        values.push(effectiveStartIso);
        conditions.push(`s.captured_at >= $${values.length}::timestamptz`);
      }
      if (effectiveEndIso) {
        values.push(effectiveEndIso);
        conditions.push(`s.captured_at < $${values.length}::timestamptz`);
      }
      if (activeAppLike) {
        values.push(activeAppLike);
        conditions.push(`COALESCE(s.active_app, '') ILIKE $${values.length} ESCAPE '\\'`);
      }
      const limitIndex = values.push(limit);
      rows = await queryRows(
        `WITH assignment_windows(employee_id, shift_start, shift_end, first_start, first_end, has_second, second_start, second_end) AS (
           VALUES ${valueRows.join(', ')}
         )
         SELECT ${listSelect}
         FROM screenshots s
         JOIN assignment_windows aw ON aw.employee_id = s.employee_id
         JOIN public.profiles p ON p.id = s.employee_id
         LEFT JOIN devices d ON d.id = s.device_registration_id
         WHERE ${conditions.join('\n           AND ')}
         ORDER BY s.captured_at DESC
         LIMIT $${limitIndex}`,
        values,
      );
    } else if (canMonitorAll(role)) {
      const conditions = ['s.captured_at < $1'];
      const values: any[] = [beforeIso];
      if (filterUserId) {
        values.push(filterUserId);
        conditions.push(`s.employee_id = $${values.length}`);
      }
      if (effectiveStartIso) {
        values.push(effectiveStartIso);
        conditions.push(`s.captured_at >= $${values.length}`);
      }
      if (effectiveEndIso) {
        values.push(effectiveEndIso);
        conditions.push(`s.captured_at < $${values.length}`);
      }
      if (activeAppLike) {
        values.push(activeAppLike);
        conditions.push(`COALESCE(s.active_app, '') ILIKE $${values.length} ESCAPE '\\'`);
      }
      values.push(limit);
      if (filterUserId) {
        // fall through to shared query below
      }
      rows = await queryRows(
        `SELECT ${listSelect}
        FROM screenshots s
        LEFT JOIN public.profiles p ON p.id = s.employee_id
        LEFT JOIN devices d ON d.id = s.device_registration_id
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY s.captured_at DESC
        LIMIT $${values.length}`,
        values,
      );
    } else {
      return err('Forbidden', 403);
    }

    return cachedOk(rows, 300);
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
    const availableColumns = await getExistingColumns('screenshots', ['file_url', 'thumbnail_url']);
    const screenshotUrlExpression = getScreenshotUrlExpression(availableColumns);
    const thumbnailSelectExpression = availableColumns.has('thumbnail_url') ? 'thumbnail_url' : 'NULL AS thumbnail_url';
    const rows = await queryRows(
      `SELECT id, employee_id, ${screenshotUrlExpression} AS r2_url, ${thumbnailSelectExpression} FROM screenshots WHERE id = $1 LIMIT 1`,
      [id],
    );
    const rec = rows?.[0];
    if (!rec) return err('Screenshot not found', 404);

    try {
      const r2Url: string = rec.r2_url || '';
      const thumbnailUrl: string = rec.thumbnail_url || '';
      const keys = [r2Url, thumbnailUrl].map(getR2KeyFromUrl).filter(Boolean);
      if (keys.length) await deleteR2Objects([...new Set(keys)]);
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
