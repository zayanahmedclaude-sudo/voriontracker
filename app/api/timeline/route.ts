import { NextRequest } from 'next/server';
import { requireAuth, ok, err } from '@/lib/api';
import { sql } from '@/lib/db';
import { assertEmployeeScope, preferencesFor, timelineDetails, visibleEmployeeIds } from '@/lib/timeline-service';
import { validatePreferences, validateSchedule, nextExportAt } from '@/lib/timeline-policy';
import { hasSmtpConfig } from '@/lib/mailer';
import { canManageUsers, normalizeRole } from '@/lib/roles';
import { collectTimelineNotifications } from '@/lib/timeline-worker';

export async function GET(req: NextRequest) {
  const user = requireAuth(req); if ('status' in user) return user;
  try {
    const preferences = await preferencesFor(user.sub);
    await collectTimelineNotifications(user);
    const ids = await visibleEmployeeIds(user);
    const [details, notifications, exports] = await Promise.all([
      timelineDetails(ids),
      sql`SELECT * FROM timeline_notifications WHERE user_id=${user.sub} AND employee_id=ANY(${ids}::uuid[]) AND created_at>NOW()-INTERVAL '7 days' ORDER BY created_at DESC LIMIT 100`,
      sql`SELECT * FROM timeline_exports WHERE user_id=${user.sub} ORDER BY created_at DESC`,
    ]);
    return ok({ preferences, ...details, notifications, exports, smtpConfigured: hasSmtpConfig(), canEditSchedule: canManageUsers(normalizeRole(user.role)) });
  } catch (e: any) { console.error('Timeline configuration failed', e.message); return err('Unable to load timeline settings', 500); }
}
export async function POST(req: NextRequest) {
  const user = requireAuth(req); if ('status' in user) return user;
  try {
    const body = await req.json(); await preferencesFor(user.sub);
    if (body.action === 'preferences') {
      const preferences = validatePreferences(body.preferences);
      if ((preferences.channel !== 'in-app' || preferences.weeklyEmail) && !hasSmtpConfig()) return err('Configure SMTP before enabling email delivery', 409);
      await sql`INSERT INTO timeline_preferences(user_id,preferences) VALUES(${user.sub},${JSON.stringify(preferences)}::jsonb)
        ON CONFLICT(user_id) DO UPDATE SET preferences=EXCLUDED.preferences,updated_at=NOW()`;
      return ok(preferences);
    }
    if (body.action === 'schedule') {
      await assertEmployeeScope(user,body.employeeId,true);
      const schedule = validateSchedule(body.schedule);
      const fence = body.geofence;
      if (fence && (!Number.isFinite(fence.latitude) || Math.abs(fence.latitude)>90 || !Number.isFinite(fence.longitude) || Math.abs(fence.longitude)>180 || !Number.isFinite(fence.radius) || fence.radius<10 || fence.radius>100000)) return err('Invalid geofence');
      await sql`INSERT INTO timeline_employee_config(employee_id,schedule,geofence) VALUES(${body.employeeId},${JSON.stringify(schedule)}::jsonb,${fence ? JSON.stringify(fence) : null}::jsonb)
        ON CONFLICT(employee_id) DO UPDATE SET schedule=EXCLUDED.schedule,geofence=EXCLUDED.geofence,updated_at=NOW()`;
      return ok({ ok: true });
    }
    if (body.action === 'export_schedule') {
      if (!hasSmtpConfig()) return err('Configure SMTP before scheduling exports',409);
      if (!['daily','weekly','monthly'].includes(body.frequency) || !['pdf','csv'].includes(body.format) || typeof body.recipient !== 'string' || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(body.recipient) || body.recipient.length>254) return err('Invalid export settings');
      const [{count}] = await sql`SELECT COUNT(*)::int AS count FROM timeline_exports WHERE user_id=${user.sub}`;
      if (count>=20) return err('Maximum 20 recurring exports');
      const [row] = await sql`INSERT INTO timeline_exports(user_id,frequency,format,recipient,next_run) VALUES(${user.sub},${body.frequency},${body.format},${body.recipient},${nextExportAt(body.frequency)}) RETURNING *`;
      return ok(row,201);
    }
    if (body.action === 'delete_export') { await sql`DELETE FROM timeline_exports WHERE id=${body.id} AND user_id=${user.sub}`; return ok({ok:true}); }
    if (body.action === 'notification') {
      if (body.id) await sql`UPDATE timeline_notifications SET dismissed=${body.dismissed === true},read_at=NOW() WHERE id=${body.id} AND user_id=${user.sub}`;
      else await sql`UPDATE timeline_notifications SET read_at=NOW() WHERE user_id=${user.sub} AND read_at IS NULL`;
      return ok({ok:true});
    }
    return err('Unknown action');
  } catch (e: any) { return err(e.message === 'Forbidden' ? 'Forbidden' : e.message, e.message === 'Forbidden' ? 403 : 400); }
}
