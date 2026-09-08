import { NextRequest } from 'next/server';
import { err, ok, requireRole } from '@/lib/api';
import { createDeviceToken, hashDeviceToken } from '@/lib/device-auth';
import { ensureMonitoringSchema } from '@/lib/schema';
import { sql } from '@/lib/db';
import { createSecurityEvent } from '@/lib/security';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const user = requireRole(req, 'superadmin', 'admin'); if ('status' in user) return user;
  await ensureMonitoringSchema();
  return ok(await sql`SELECT d.id, d.device_name, d.status, d.created_at, d.revoked_at, d.last_seen_at, d.assigned_employee_id, p.full_name AS assigned_employee_name, p.email AS assigned_employee_email, p.employee_code AS assigned_employee_code FROM devices d LEFT JOIN public.profiles p ON p.id = d.assigned_employee_id ORDER BY d.created_at DESC`);
}

export async function POST(req: NextRequest) {
  const user = requireRole(req, 'superadmin', 'admin'); if ('status' in user) return user;
  const body = await req.json().catch(() => null); const deviceName = String(body?.deviceName || '').trim();
  const assignedEmployeeId = String(body?.assignedEmployeeId || '').trim() || null;
  if (!deviceName || deviceName.length > 120) return err('Device name is required (maximum 120 characters)', 400);
  if (assignedEmployeeId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assignedEmployeeId)) return err('Assigned employee id is invalid', 400);
  await ensureMonitoringSchema();
  if (assignedEmployeeId) {
    const [employee] = await sql`SELECT id FROM public.profiles WHERE id = ${assignedEmployeeId} AND role NOT IN ('superadmin', 'super_admin', 'admin', 'executive')`;
    if (!employee) return err('The selected account cannot be assigned to a device', 400);
  }
  const token = createDeviceToken();
  const [device] = await sql`INSERT INTO devices(token_hash, device_name, assigned_employee_id) VALUES(${hashDeviceToken(token)}, ${deviceName}, ${assignedEmployeeId}) RETURNING id, device_name, assigned_employee_id, status, created_at`;
  await createSecurityEvent({ employeeId:user.sub, computerName:deviceName, eventType:'device_enrolled', value:String(device.id), actionTaken:'registered' }).catch(error => console.error('Device enrollment audit failed', error));
  return ok({ device, token }, 201);
}

export async function PATCH(req: NextRequest) {
  const user = requireRole(req, 'superadmin', 'admin'); if ('status' in user) return user;
  const body = await req.json().catch(() => null); const id = String(body?.id || '').trim();
  if (!UUID.test(id)) return err('Device id is invalid', 400);
  await ensureMonitoringSchema();
  if (body?.action === 'edit') {
    if (user.role !== 'superadmin') return err('Only super admins can edit devices', 403);
    const deviceName = String(body?.deviceName || '').trim();
    const assignedEmployeeId = String(body?.assignedEmployeeId || '').trim() || null;
    if (!deviceName || deviceName.length > 120) return err('Device name is required (maximum 120 characters)', 400);
    if (assignedEmployeeId && !UUID.test(assignedEmployeeId)) return err('Assigned employee id is invalid', 400);
    if (assignedEmployeeId) {
      const [employee] = await sql`SELECT id FROM public.profiles WHERE id=${assignedEmployeeId} AND role NOT IN ('superadmin', 'super_admin', 'admin', 'executive')`;
      if (!employee) return err('The selected account cannot be assigned to a device', 400);
    }
    const [device] = await sql`UPDATE devices SET device_name=${deviceName}, assigned_employee_id=${assignedEmployeeId}, updated_at=NOW() WHERE id=${id} RETURNING id, device_name, assigned_employee_id, status, updated_at`;
    if (!device) return err('Device not found', 404);
    await createSecurityEvent({ employeeId:user.sub, computerName:deviceName, eventType:'device_edited', value:id, actionTaken:'updated' }).catch(error => console.error('Device edit audit failed', error));
    return ok(device);
  }
  if (body?.action !== 'revoke') return err('A valid device action is required', 400);
  const [device] = await sql`UPDATE devices SET status='revoked', revoked_at=NOW(), updated_at=NOW() WHERE id=${id} AND status <> 'revoked' RETURNING id, status, revoked_at`;
  if (device) await createSecurityEvent({ employeeId:user.sub, computerName:null, eventType:'device_revoked', value:id, actionTaken:'revoked' }).catch(error => console.error('Device revocation audit failed', error));
  return device ? ok(device) : err('Active device not found', 404);
}

export async function DELETE(req: NextRequest) {
  const user = requireRole(req, 'superadmin'); if ('status' in user) return user;
  const body = await req.json().catch(() => null); const id = String(body?.id || '').trim();
  if (!UUID.test(id)) return err('Device id is invalid', 400);
  await ensureMonitoringSchema();
  const [device] = await sql`DELETE FROM devices WHERE id=${id} RETURNING id, device_name`;
  if (!device) return err('Device not found', 404);
  await createSecurityEvent({ employeeId:user.sub, computerName:device.device_name, eventType:'device_deleted', value:id, actionTaken:'deleted' }).catch(error => console.error('Device deletion audit failed', error));
  return ok({ deleted:true, id });
}
