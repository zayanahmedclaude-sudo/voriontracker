import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { err, ok, requireRole } from '@/lib/api';
import { createDeviceToken, hashDeviceToken } from '@/lib/device-auth';
import { ensureMonitoringSchema } from '@/lib/schema';
import { sql, withTransaction } from '@/lib/db';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function GET(req:NextRequest){const user=requireRole(req,'superadmin','admin');if('status'in user)return user;await ensureMonitoringSchema();return ok(await sql`SELECT id,device_name,status,created_at,expires_at FROM pending_device_enrollments WHERE status='pending' AND expires_at>NOW() ORDER BY created_at DESC`);}
export async function POST(req:NextRequest){
  const user=requireRole(req,'superadmin','admin');if('status'in user)return user;const body=await req.json().catch(()=>null);const id=String(body?.id||'');const employee=String(body?.assignedEmployeeId||'')||null;
  if(!UUID.test(id)||employee&&!UUID.test(employee))return err('Invalid approval request',400);await ensureMonitoringSchema();
  try{const device=await withTransaction(async client=>{const pending=(await client.query(`SELECT * FROM pending_device_enrollments WHERE id=$1 AND status='pending' AND expires_at>NOW() FOR UPDATE`,[id])).rows[0];if(!pending)throw new Error('Pending request expired or was already handled');if(employee&&!(await client.query('SELECT id FROM public.profiles WHERE id=$1',[employee])).rowCount)throw new Error('Employee not found');const token=createDeviceToken();const encrypted=crypto.publicEncrypt({key:pending.public_key,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(token)).toString('base64');const created=(await client.query(`INSERT INTO devices(token_hash,device_name,assigned_employee_id) VALUES($1,$2,$3) RETURNING id,device_name,status,assigned_employee_id`,[hashDeviceToken(token),pending.device_name,employee])).rows[0];await client.query(`UPDATE pending_device_enrollments SET status='approved',assigned_employee_id=$2,approved_by=$3,device_id=$4,encrypted_token=$5,approved_at=NOW() WHERE id=$1`,[id,employee,user.sub,created.id,encrypted]);return created;});return ok({device});}catch(error:any){return err(error.message||'Unable to approve device',409);}
}
