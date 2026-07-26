import { NextRequest } from 'next/server';
import { requireAuth, ok, err } from '@/lib/api';
import { sql } from '@/lib/db';
import { ensureMonitoringSchema } from '@/lib/schema';

const NOTICE_VERSION = '2026-07-26';
const NOTICE_TEXT = 'This company-owned device is monitored for company data protection purposes. Activity such as app usage, screenshots, file and transfer metadata, and device security events may be recorded and reviewed by authorized company personnel.';

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  await ensureMonitoringSchema();

  const deviceId = String(new URL(req.url).searchParams.get('deviceId') || '').trim();
  if (!deviceId) return err('deviceId is required', 400);

  const rows = await sql`
    SELECT disclosure_acknowledged_at, disclosure_version
    FROM device_registrations
    WHERE device_id = ${deviceId}
    LIMIT 1
  `;
  const record = rows?.[0];

  return ok({
    noticeText: NOTICE_TEXT,
    noticeVersion: NOTICE_VERSION,
    acknowledged: Boolean(record?.disclosure_acknowledged_at && record?.disclosure_version === NOTICE_VERSION),
    acknowledgedAt: record?.disclosure_acknowledged_at ?? null,
  });
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  await ensureMonitoringSchema();

  const body = await req.json().catch(() => null);
  const deviceId = String(body?.deviceId || '').trim();
  const hostname = String(body?.hostname || '').trim() || null;
  const appVersion = String(body?.appVersion || '').trim() || null;
  const osPlatform = String(body?.osPlatform || '').trim() || null;
  const osVersion = String(body?.osVersion || '').trim() || null;
  const installScope = String(body?.installScope || '').trim() || null;

  if (!deviceId) return err('deviceId is required', 400);

  await sql`
    INSERT INTO device_registrations (
      device_id, employee_id, hostname, os_platform, os_version, app_version,
      install_scope, disclosure_acknowledged_at, disclosure_acknowledged_by,
      disclosure_version, is_company_device, last_seen_at, updated_at
    )
    VALUES (
      ${deviceId}, ${user.sub}, ${hostname}, ${osPlatform}, ${osVersion}, ${appVersion},
      ${installScope}, NOW(), ${user.sub}, ${NOTICE_VERSION}, TRUE, NOW(), NOW()
    )
    ON CONFLICT (device_id) DO UPDATE SET
      employee_id = EXCLUDED.employee_id,
      hostname = COALESCE(EXCLUDED.hostname, device_registrations.hostname),
      os_platform = COALESCE(EXCLUDED.os_platform, device_registrations.os_platform),
      os_version = COALESCE(EXCLUDED.os_version, device_registrations.os_version),
      app_version = COALESCE(EXCLUDED.app_version, device_registrations.app_version),
      install_scope = COALESCE(EXCLUDED.install_scope, device_registrations.install_scope),
      disclosure_acknowledged_at = NOW(),
      disclosure_acknowledged_by = EXCLUDED.disclosure_acknowledged_by,
      disclosure_version = EXCLUDED.disclosure_version,
      is_company_device = TRUE,
      last_seen_at = NOW(),
      updated_at = NOW()
  `;

  await sql`
    INSERT INTO device_monitoring_acknowledgments (
      device_id, employee_id, hostname, notice_text, notice_version
    )
    VALUES (${deviceId}, ${user.sub}, ${hostname}, ${NOTICE_TEXT}, ${NOTICE_VERSION})
  `;

  return ok({ ok: true, noticeVersion: NOTICE_VERSION });
}
