import crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { ensureMonitoringSchema } from './schema';
import { sql } from './db';

export const DEVICE_TOKEN_HEADER = 'x-vorion-device-token';
const DEVICE_TOKEN_PATTERN = /^vrt_dev_[A-Za-z0-9_-]{43}$/;

export function getDeviceTokenFromRequest(req: NextRequest) {
  const token = String(req.headers.get(DEVICE_TOKEN_HEADER) || '').trim();
  return DEVICE_TOKEN_PATTERN.test(token) ? token : '';
}

export function hasDeviceCredential(req: NextRequest) {
  return Boolean(req.headers.get(DEVICE_TOKEN_HEADER));
}

export function hashDeviceToken(token: string) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createDeviceToken() {
  return `vrt_dev_${crypto.randomBytes(32).toString('base64url')}`;
}

export type DevicePrincipal = { kind: 'device'; id: string; deviceName: string; assignedEmployeeId: string | null };

export async function getDevicePrincipal(req: NextRequest): Promise<DevicePrincipal | null> {
  const token = getDeviceTokenFromRequest(req);
  if (!token) return null;
  await ensureMonitoringSchema();
  const [device] = await sql`
    UPDATE devices SET last_seen_at = NOW(), updated_at = NOW()
    WHERE token_hash = ${hashDeviceToken(token)} AND status = 'active'
    RETURNING id, device_name, assigned_employee_id
  `;
  if (!device) return null;
  return { kind: 'device', id: String(device.id), deviceName: String(device.device_name), assignedEmployeeId: device.assigned_employee_id ? String(device.assigned_employee_id) : null };
}
