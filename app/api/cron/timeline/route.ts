import { timingSafeEqual } from 'crypto';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api';
import { runTimelineWorker } from '@/lib/timeline-worker';
export const runtime='nodejs';
export const maxDuration=300;
export async function GET(req:NextRequest){
  const secret=process.env.CRON_SECRET, actual=Buffer.from(req.headers.get('authorization')||''),expected=Buffer.from(`Bearer ${secret}`);
  if(!secret||actual.length!==expected.length||!timingSafeEqual(actual,expected))return err('Unauthorized',401);
  try{return ok(await runTimelineWorker());}catch(e:any){console.error('Timeline worker failed',e.message);return err('Timeline worker failed',500);}
}
