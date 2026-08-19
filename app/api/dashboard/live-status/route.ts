import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, ok, err } from '@/lib/api';
import { canViewReports, normalizeRole } from '@/lib/roles';
import { ensureMonitoringSchema } from '@/lib/schema';
import { LIVE_HEARTBEAT_STALE_SECONDS, normalizePresenceStatus } from '@/lib/status';
import { BUSINESS_TIME_ZONE, isWithinForcedCheckoutWindow } from '@/lib/shifts';

type LiveStatusRow = {
  id: string;
  name: string;
  current_status: string;
  current_app: string | null;
  last_active: string | null;
  version: string | null;
};

function parseSince(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowToStatus(row: any): LiveStatusRow {
  const forceCheckedOut = isWithinForcedCheckoutWindow(new Date(), BUSINESS_TIME_ZONE);
  const rawStatus = row.last_activity
    && new Date(row.last_activity).getTime() >= Date.now() - LIVE_HEARTBEAT_STALE_SECONDS * 1000
    ? row.current_status
    : 'offline';

  return {
    id: row.id,
    name: row.name,
    current_status: forceCheckedOut ? 'checked_out' : normalizePresenceStatus(rawStatus),
    current_app: forceCheckedOut ? null : (row.current_app || null),
    last_active: row.last_activity || null,
    version: row.status_updated_at || row.last_activity || null,
  };
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  const role = normalizeRole(user.role);
  const isEmployee = role === 'employee';
  const isClient = role === 'client';
  const canViewAll = canViewReports(role);
  if (!isEmployee && !isClient && !canViewAll) return err('Forbidden', 403);

  const { searchParams } = new URL(req.url);
  const since = parseSince(searchParams.get('since'));

  try {
    await ensureMonitoringSchema();

    const rows = isClient
      ? await sql`
          SELECT
            p.id,
            p.full_name AS name,
            es.current_status,
            es.current_app,
            es.last_activity,
            es.updated_at AS status_updated_at
          FROM client_assignments ca
          JOIN public.profiles p ON p.id = ca.employee_id
          LEFT JOIN employee_status es ON es.employee_id = p.id
          WHERE ca.client_id = ${user.sub}
            AND (${since}::timestamptz IS NULL OR es.updated_at > ${since}::timestamptz)
          ORDER BY es.updated_at DESC NULLS LAST
        `
      : await sql`
          SELECT
            p.id,
            p.full_name AS name,
            es.current_status,
            es.current_app,
            es.last_activity,
            es.updated_at AS status_updated_at
          FROM public.profiles p
          LEFT JOIN employee_status es ON es.employee_id = p.id
          WHERE p.role = 'employee'
            AND (
              (${isEmployee} = true AND p.id = ${user.sub})
              OR (${isEmployee} = false)
            )
            AND (${since}::timestamptz IS NULL OR es.updated_at > ${since}::timestamptz)
          ORDER BY es.updated_at DESC NULLS LAST
        `;

    const statuses: LiveStatusRow[] = (rows || []).map(rowToStatus);
    const latestVersion = statuses.reduce((latest: string | null, row) => {
      if (!row.version) return latest;
      if (!latest || new Date(row.version).getTime() > new Date(latest).getTime()) return row.version;
      return latest;
    }, since);

    return ok({ rows: statuses, latestVersion });
  } catch (e: any) {
    console.error('GET /api/dashboard/live-status error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}
