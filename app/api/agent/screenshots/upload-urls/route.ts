import { NextRequest } from 'next/server';
import { requireAuth, err } from '@/lib/api';

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  return err('Legacy screenshot upload endpoint is disabled. Use /api/r2/screenshot-upload-urls.', 410);
}
