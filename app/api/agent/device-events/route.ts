import { NextRequest } from 'next/server';
import { requireAuth, ok, err } from '@/lib/api';
import { sql } from '@/lib/db';
import { ensureMonitoringSchema } from '@/lib/schema';
import { emitSocketEvent } from '@/lib/socket';

const MAX_BATCH = 200;
const ALERT_DEDUP_WINDOW_MINUTES = 10;

type IncomingEvent = {
  eventType?: unknown;
  category?: unknown;
  severity?: unknown;
  occurredAt?: unknown;
  details?: Record<string, any>;
};

function normalizeTimestamp(value: unknown) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function buildConnectionAlert(event: IncomingEvent, input: { employeeId: string; hostname: string | null; employeeName: string | null; deviceId: string }) {
  const eventType = String(event?.eventType || '').trim().toLowerCase();
  if (!['usb_connected', 'network_drive_connected'].includes(eventType)) return null;

  const details = event?.details && typeof event.details === 'object' ? event.details : {};
  const rootPath = String(details.rootPath || '').trim();
  const volumeId = String(details.volumeId || '').trim();
  const isUsb = eventType === 'usb_connected';
  const deviceKind = isUsb ? 'USB storage device' : 'network drive';
  const employeeLabel = input.employeeName || 'An employee';

  return {
    alertType: isUsb ? 'usb_connected' : 'network_drive_connected',
    severity: isUsb ? 'high' : 'medium',
    title: isUsb ? 'USB device connected' : 'Network drive connected',
    description: `${employeeLabel} connected a ${deviceKind}${input.hostname ? ` on ${input.hostname}` : ''}.`,
    metadata: {
      employeeId: input.employeeId,
      employeeName: input.employeeName,
      hostname: input.hostname,
      deviceId: input.deviceId,
      rootPath: rootPath || null,
      volumeId: volumeId || null,
      occurredAt: normalizeTimestamp(event?.occurredAt),
      sourceEventType: eventType,
    },
    securityEventType: isUsb ? 'usb_device_connected' : 'network_drive_connected',
    securityValue: rootPath || volumeId || input.hostname || input.deviceId,
  };
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  await ensureMonitoringSchema();

  const body = await req.json().catch(() => null);
  const deviceId = String(body?.deviceId || '').trim();
  const hostname = String(body?.hostname || '').trim() || null;
  const appVersion = String(body?.appVersion || '').trim() || null;
  const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_BATCH) : [];

  if (!deviceId) return err('deviceId is required', 400);
  if (!events.length) return err('events are required', 400);

  const employeeRows = await sql`
    SELECT full_name
    FROM public.profiles
    WHERE id = ${user.sub}
    LIMIT 1
  `;
  const employeeName = employeeRows?.[0]?.full_name ? String(employeeRows[0].full_name) : null;

  await sql`
    INSERT INTO device_registrations (device_id, employee_id, hostname, app_version, is_company_device, last_seen_at, updated_at)
    VALUES (${deviceId}, ${user.sub}, ${hostname}, ${appVersion}, TRUE, NOW(), NOW())
    ON CONFLICT (device_id) DO UPDATE SET
      employee_id = EXCLUDED.employee_id,
      hostname = COALESCE(EXCLUDED.hostname, device_registrations.hostname),
      app_version = COALESCE(EXCLUDED.app_version, device_registrations.app_version),
      is_company_device = TRUE,
      last_seen_at = NOW(),
      updated_at = NOW()
  `;

  for (const raw of events) {
    const eventType = String(raw?.eventType || '').trim();
    if (!eventType) continue;
    const occurredAt = normalizeTimestamp(raw?.occurredAt);
    await sql`
      INSERT INTO device_events (
        employee_id, device_id, hostname, event_type, category, severity, occurred_at, details
      )
      VALUES (
        ${user.sub},
        ${deviceId},
        ${hostname},
        ${eventType},
        ${String(raw?.category || 'monitoring')},
        ${String(raw?.severity || 'info')},
        ${occurredAt},
        ${JSON.stringify(raw?.details || {})}::jsonb
      )
    `;

    const alert = buildConnectionAlert(raw, {
      employeeId: user.sub,
      hostname,
      employeeName,
      deviceId,
    });
    if (!alert) continue;

    const insertedAlerts = await sql`
      INSERT INTO device_alerts (
        employee_id, device_id, hostname, alert_type, severity, title, description, metadata, detected_at
      )
      SELECT
        ${user.sub},
        ${deviceId},
        ${hostname},
        ${alert.alertType},
        ${alert.severity},
        ${alert.title},
        ${alert.description},
        ${JSON.stringify(alert.metadata)}::jsonb,
        ${occurredAt}
      WHERE NOT EXISTS (
        SELECT 1
        FROM device_alerts da
        WHERE da.employee_id = ${user.sub}
          AND da.device_id = ${deviceId}
          AND da.alert_type = ${alert.alertType}
          AND da.resolved_at IS NULL
          AND da.detected_at > NOW() - (${ALERT_DEDUP_WINDOW_MINUTES} * INTERVAL '1 minute')
      )
      RETURNING id, detected_at
    `;

    if (!insertedAlerts?.length) continue;

    await sql`
      INSERT INTO security_events (employee_id, computer_name, type, target, action, details)
      VALUES (
        ${user.sub},
        ${hostname},
        ${alert.securityEventType},
        ${alert.securityValue},
        ${'alerted_admins'},
        ${JSON.stringify(alert.metadata)}::jsonb
      )
    `;

    await emitSocketEvent('security-event', {
      id: insertedAlerts[0].id,
      employeeId: user.sub,
      employeeName,
      computerName: hostname,
      eventType: alert.securityEventType,
      value: alert.securityValue,
      actionTaken: 'alerted_admins',
      createdAt: insertedAlerts[0].detected_at ?? occurredAt,
      severity: alert.severity,
      title: alert.title,
      description: alert.description,
      metadata: alert.metadata,
    }, { toAdmins: true });
  }

  return ok({ ok: true, accepted: events.length }, 201);
}
