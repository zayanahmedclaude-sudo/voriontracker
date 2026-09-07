import { sql } from './db';
import { ensureTimelineSchema } from './timeline-schema';

export type AuditEvent = {
  id: string; at: string; kind: 'attendance' | 'break' | 'app' | 'idle' | 'security';
  label: string; detail: string; flagged: boolean; durationMinutes?: number;
};

// Match explicit recorded event types, never infer an attempt from a normal exit.
export const FLAGGED_TIMELINE_TYPES = new Set([
  'tracker_close_attempt', 'early_close_attempt', 'early_checkout_attempt',
  'early_check_out_attempt', 'checkout_rejected',
]);

export async function attachTimelineAudit(rows: any[], range: { startIso: string; endIso: string }) {
  if (!rows.length) return rows;
  await ensureTimelineSchema();
  const ids = rows.map(row => row.id);
  const securityPromise = sql`SELECT id, employee_id, type, target, action, details, created_at FROM security_events
      WHERE employee_id = ANY(${ids}::uuid[])
      AND created_at >= ${range.startIso} AND created_at < ${range.endIso}
      ORDER BY created_at ASC`.catch((error: { code?: string }) => {
    // Security events predate schema migrations in some installations. Keep
    // attendance reporting available while those installations are upgraded.
    if (error?.code === '42P01') return [];
    throw error;
  });
  const [attendance, breaks, security, recorded] = await Promise.all([
    sql`SELECT id, employee_id, check_in, check_out FROM attendance
        WHERE employee_id = ANY(${ids}::uuid[])
        AND (check_in >= ${range.startIso} AND check_in < ${range.endIso}
          OR check_out >= ${range.startIso} AND check_out < ${range.endIso})`,
    sql`SELECT b.id, a.employee_id, b.start_time, b.end_time FROM breaks b
        JOIN attendance a ON a.id = b.attendance_id
        WHERE a.employee_id = ANY(${ids}::uuid[])
        AND (b.start_time >= ${range.startIso} AND b.start_time < ${range.endIso}
          OR b.end_time >= ${range.startIso} AND b.end_time < ${range.endIso})`,
    securityPromise,
    sql`SELECT * FROM timeline_events WHERE employee_id=ANY(${ids}::uuid[]) AND created_at>=${range.startIso} AND created_at<${range.endIso} ORDER BY created_at`,
  ]);
  const events = new Map<string, AuditEvent[]>();
  function add(employee: string, event: AuditEvent) {
    if (!event.at) return;
    const at = new Date(event.at).toISOString();
    if (at < range.startIso || at >= range.endIso) return;
    events.set(employee, [...(events.get(employee) || []), { ...event, at }]);
  }
  for (const item of attendance) {
    const evidence=recorded.find((e:any)=>e.event_key===`${item.id}-location`);
    add(item.employee_id, { id: `${item.id}-in`, at: item.check_in, kind: 'attendance', label: 'Checked in', detail: evidence?.detail || 'Location unavailable at check-in', flagged: false });
    if (item.check_out) add(item.employee_id, { id: `${item.id}-out`, at: item.check_out, kind: 'attendance', label: 'Checked out', detail: 'Recorded attendance event', flagged: false });
  }
  for (const item of breaks) {
    add(item.employee_id, { id: `${item.id}-start`, at: item.start_time, kind: 'break', label: 'Break started', detail: 'Self-initiated break', flagged: false });
    if (item.end_time) add(item.employee_id, { id: `${item.id}-end`, at: item.end_time, kind: 'break', label: 'Break ended', detail: 'Recorded break event', flagged: false, durationMinutes: Math.max(0, (new Date(item.end_time).getTime() - new Date(item.start_time).getTime()) / 60000) });
  }
  for (const item of security) add(item.employee_id, {
    id: item.id, at: item.created_at, kind: 'security', label: String(item.type).replace(/_/g, ' '),
    detail: [
      item.target,
      item.action && String(item.action).replace(/_/g, ' '),
      item.details && typeof item.details === 'object'
        ? Object.entries(item.details).map(([key, value]) => `${key.replace(/_/g, ' ')}: ${String(value)}`).join(' · ')
        : item.details,
    ].filter(Boolean).join(' · '),
    flagged: FLAGGED_TIMELINE_TYPES.has(item.type),
  });
  for(const item of recorded) if(item.kind!=='location') add(item.employee_id,{id:item.id,at:item.created_at,kind:item.kind,label:item.label,detail:item.detail,flagged:item.flagged,durationMinutes:item.duration_minutes ?? undefined});
  return rows.map(row => ({ ...row, audit: (events.get(row.id) || []).sort((a, b) => a.at.localeCompare(b.at)) }));
}
