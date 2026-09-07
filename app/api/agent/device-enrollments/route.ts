import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/api';
import { ensureMonitoringSchema } from '@/lib/schema';
import { sql } from '@/lib/db';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const attempts=new Map<string,{count:number;reset:number}>();

export async function POST(req:NextRequest){
  const ip=req.headers.get('x-forwarded-for')?.split(',')[0].trim()||'unknown',now=Date.now(),entry=attempts.get(ip);
  if(entry&&entry.reset>now&&entry.count>=5)return err('Too many enrollment requests; try again shortly',429);
  attempts.set(ip,{count:entry&&entry.reset>now?entry.count+1:1,reset:entry&&entry.reset>now?entry.reset:now+60_000});
  const body=await req.json().catch(()=>null);const deviceName=String(body?.deviceName||'').trim();const publicKey=String(body?.publicKey||'').trim();
  if(!deviceName||deviceName.length>120)return err('Computer name is required',400);
  if(publicKey.length>4096)return err('Invalid enrollment public key',400);
  try{const key=crypto.createPublicKey(publicKey);if(key.asymmetricKeyType!=='rsa')throw new Error();}catch{return err('Invalid enrollment public key',400);}
  await ensureMonitoringSchema();
  const [pending]=await sql`INSERT INTO pending_device_enrollments(device_name,public_key) VALUES(${deviceName},${publicKey}) RETURNING id,device_name,status,expires_at`;
  return ok({request:pending},201);
}

export async function GET(req:NextRequest){
  const id=String(req.nextUrl.searchParams.get('id')||'');if(!UUID.test(id))return err('Invalid enrollment request',400);
  await ensureMonitoringSchema();
  const [request]=await sql`UPDATE pending_device_enrollments SET status='expired' WHERE id=${id} AND status='pending' AND expires_at<=NOW() RETURNING id`;
  const [row]=await sql`SELECT id,status,expires_at,encrypted_token FROM pending_device_enrollments WHERE id=${id}`;
  if(!row)return err('Enrollment request not found',404);
  return ok({request:{...row,encrypted_token:row.status==='approved'?row.encrypted_token:null}});
}
