import { sql } from './db';
import { AGENT_TRACKED_ROLES, canViewReports, isAgentTrackedRole, normalizeRole, canManageUsers } from './roles';
import type { TokenPayload } from './auth';
import { defaultPreferences, earlyAttempt, geofenceDistance, type TimelinePreferences } from './timeline-policy';
import { ensureTimelineSchema } from './timeline-schema';

export async function visibleEmployeeIds(user: TokenPayload): Promise<string[]> {
  const role = normalizeRole(user.role);
  if (role === 'client') return (await sql`SELECT p.id FROM client_assignments ca JOIN public.profiles p ON p.id=ca.employee_id WHERE ca.client_id=${user.sub} AND p.role=ANY(${AGENT_TRACKED_ROLES}::text[]) AND COALESCE(p.account_status,'active')='active'`).map((r: any) => r.id);
  if (isAgentTrackedRole(role)) return [user.sub];
  if (!canViewReports(role)) return [];
  return (await sql`SELECT id FROM public.profiles WHERE role=ANY(${AGENT_TRACKED_ROLES}::text[]) AND COALESCE(account_status,'active')='active'`).map((r: any) => r.id);
}
export async function assertEmployeeScope(user: TokenPayload, id: string, edit = false) {
  if (edit && !canManageUsers(normalizeRole(user.role))) throw new Error('Forbidden');
  if (edit) { if (!(await sql`SELECT id FROM public.profiles WHERE id=${id} AND role=ANY(${AGENT_TRACKED_ROLES}::text[])`).length) throw new Error('Employee not found'); return; }
  if (!(await visibleEmployeeIds(user)).includes(id)) throw new Error('Forbidden');
}
export async function preferencesFor(id: string): Promise<TimelinePreferences> {
  await ensureTimelineSchema();
  const [row] = await sql`INSERT INTO timeline_preferences(user_id,preferences) VALUES(${id},${JSON.stringify(defaultPreferences)}::jsonb)
    ON CONFLICT(user_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING preferences`;
  return { ...defaultPreferences, ...row.preferences };
}
export async function recordTimelineEvent(employee: string, event: { kind: string; label: string; detail?: string; flagged?: boolean; durationMinutes?: number; metadata?: any; key?: string; at?: string }) {
  await ensureTimelineSchema();
  const [row] = await sql`INSERT INTO timeline_events(employee_id,event_key,kind,label,detail,flagged,duration_minutes,metadata,created_at)
    VALUES(${employee},${event.key || null},${event.kind},${event.label},${event.detail || ''},${event.flagged === true},${event.durationMinutes ?? null},${JSON.stringify(event.metadata || {})}::jsonb,${event.at || new Date().toISOString()})
    ON CONFLICT(employee_id,event_key) DO NOTHING RETURNING id`;
  return row;
}
export async function attemptPolicy(employee: string) {
  await ensureTimelineSchema();
  const [attendance] = await sql`SELECT check_in FROM attendance WHERE employee_id=${employee} AND check_out IS NULL ORDER BY check_in DESC LIMIT 1`;
  const [config] = await sql`SELECT schedule FROM timeline_employee_config WHERE employee_id=${employee}`;
  return attendance ? earlyAttempt(config?.schedule || [], attendance.check_in) : { flagged: false, remainingMinutes: 0, shiftEnd: null };
}
export async function captureLocation(employee: string, value: any) {
  await ensureTimelineSchema();
  if (!value || !Number.isFinite(value.latitude) || Math.abs(value.latitude)>90 || !Number.isFinite(value.longitude) || Math.abs(value.longitude)>180 || !Number.isFinite(value.accuracy) || value.accuracy<0) throw new Error('Invalid location');
  const [config] = await sql`SELECT geofence FROM timeline_employee_config WHERE employee_id=${employee}`;
  const fence = config?.geofence;
  const distance = fence ? geofenceDistance(value.latitude,value.longitude,fence.latitude,fence.longitude) : null;
  // A position whose accuracy overlaps the boundary is explicitly uncertain.
  const within = distance == null ? null : distance + value.accuracy <= fence.radius ? true : distance - value.accuracy > fence.radius ? false : null;
  const label = String(value.label || 'Device location').slice(0,200);
  const [location] = await sql`INSERT INTO timeline_locations(employee_id,latitude,longitude,accuracy,label,within_bounds)
    VALUES(${employee},${value.latitude},${value.longitude},${value.accuracy},${label},${within})
    ON CONFLICT(employee_id) DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,accuracy=EXCLUDED.accuracy,label=EXCLUDED.label,within_bounds=EXCLUDED.within_bounds,captured_at=NOW() RETURNING *`;
  return location;
}
export async function timelineDetails(ids: string[]) {
  await ensureTimelineSchema();
  if (!ids.length) return { configs: [], locations: [] };
  const [configs,locations] = await Promise.all([
    sql`SELECT * FROM timeline_employee_config WHERE employee_id=ANY(${ids}::uuid[])`,
    sql`SELECT * FROM timeline_locations WHERE employee_id=ANY(${ids}::uuid[])`,
  ]);
  return { configs, locations };
}
