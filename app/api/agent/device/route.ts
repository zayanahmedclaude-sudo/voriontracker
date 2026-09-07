import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/api';
import { getDevicePrincipal } from '@/lib/device-auth';

export async function GET(req: NextRequest) {
  const device = await getDevicePrincipal(req);
  return device ? ok({ device }) : err('Unknown or revoked device token', 401);
}
