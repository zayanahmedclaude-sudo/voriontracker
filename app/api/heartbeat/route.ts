import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, ok, err } from '@/lib/api';
import { emitSocketEvent } from '@/lib/socket';
import { normalizePresenceStatus } from '@/lib/status';
import { ensureMonitoringSchema } from '@/lib/schema';
import { requireAgentProtocol } from '@/lib/screenshot-protocol';

export async function POST(req: NextRequest) {
  const protocolError = requireAgentProtocol(req);
  if (protocolError) return protocolError;
  const user = requireAuth(req);
  if ('status' in user) return user;
  await ensureMonitoringSchema();

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return err('Invalid or empty JSON body', 400);
  }
  const { currentApp, activityPct, status: currentStatus, deviceId, hostname, appVersion, osPlatform, osVersion, installScope } = body;
  // Presence freshness must use the server clock. Agent clocks can be skewed,
  // which otherwise makes one dashboard consider a heartbeat stale while
  // another has just received the corresponding live event.
  const now = new Date().toISOString();

  try {
    const statusValue = normalizePresenceStatus(currentStatus);

    await sql`
      INSERT INTO employee_status(employee_id, current_status, current_app, last_activity, updated_at)
      VALUES(${user.sub}, ${statusValue}, ${currentApp ?? null}, ${now}, NOW())
      ON CONFLICT (employee_id) DO UPDATE
      SET current_status = ${statusValue}, current_app = ${currentApp ?? null}, last_activity = ${now}, updated_at = NOW()
    `;

    if (deviceId) {
      await sql`
        INSERT INTO device_registrations (
          device_id, employee_id, hostname, os_platform, os_version, app_version,
          install_scope, is_company_device, last_seen_at, updated_at
        )
        VALUES (
          ${String(deviceId)}, ${user.sub}, ${hostname || null}, ${osPlatform || null}, ${osVersion || null},
          ${appVersion || null}, ${installScope || null}, TRUE, NOW(), NOW()
        )
        ON CONFLICT (device_id) DO UPDATE SET
          employee_id = EXCLUDED.employee_id,
          hostname = COALESCE(EXCLUDED.hostname, device_registrations.hostname),
          os_platform = COALESCE(EXCLUDED.os_platform, device_registrations.os_platform),
          os_version = COALESCE(EXCLUDED.os_version, device_registrations.os_version),
          app_version = COALESCE(EXCLUDED.app_version, device_registrations.app_version),
          install_scope = COALESCE(EXCLUDED.install_scope, device_registrations.install_scope),
          is_company_device = TRUE,
          last_seen_at = NOW(),
          updated_at = NOW()
      `;
    }

    const payload = {
      employeeId: user.sub,
      employeeName: user.name,
      status: statusValue,
      currentApp: currentApp || null,
      activityPct: activityPct ?? null,
      lastActivity: now,
      timestamp: now,
    };

    await emitSocketEvent('employee-status', payload, { toAdmins: true });
    await emitSocketEvent('employee-activity-updated', payload, { toAdmins: true });

    return ok({ ok: true });
  } catch (e: any) {
    console.error('POST /api/heartbeat error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}
