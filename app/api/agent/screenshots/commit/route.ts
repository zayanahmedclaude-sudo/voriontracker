import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/api';
import { getTokenFromRequest } from '@/lib/auth';
import { getDevicePrincipal, hasDeviceCredential } from '@/lib/device-auth';
import { getExistingColumns, sql, withTransaction } from '@/lib/db';
import { emitSocketEvent } from '@/lib/socket';
import { ensureMonitoringSchema, ensureScreenshotThumbnailSchema } from '@/lib/schema';
import { getR2KeyFromUrl, isR2Url } from '@/lib/r2';
import { getCaptureDateFromKey, parseCanonicalScreenshotKey } from '@/lib/screenshot-keys';
import { SCREENSHOT_MAX_BATCH_SIZE, requireAgentProtocol } from '@/lib/screenshot-protocol';
import { agentOk } from '@/lib/agent-version';
import { BUSINESS_TIME_ZONE, getAutoCheckoutCutoffForTimestamp } from '@/lib/shifts';
import { ensureTimelineSchema } from '@/lib/timeline-schema';
import { resolveIngestTime } from '@/lib/ingest-time';

export async function POST(req: NextRequest) {
  const protocolError = requireAgentProtocol(req); if (protocolError) return protocolError;
  if (!process.env.DATABASE_URL) return err('Server misconfigured: DATABASE_URL not set', 500);
  try {
    const input = (await req.json())?.screenshots;
    if (!Array.isArray(input) || input.length < 1 || input.length > SCREENSHOT_MAX_BATCH_SIZE) return err(`screenshots must contain 1 to ${SCREENSHOT_MAX_BATCH_SIZE} items`, 400);
    if (input.some((item: any) => item?.employeeId || item?.deviceRegistrationId)) return err('Client-supplied employee and registered-device identities are not accepted', 400);
    const outside = input.some((item: any) => !item?.sessionId); const inside = input.some((item: any) => Boolean(item?.sessionId));
    if (outside && inside) return err('Mixed session and outside-session batches are not allowed', 400);
    const employeeUser = getTokenFromRequest(req);
    if (req.headers.has('authorization') && hasDeviceCredential(req)) return err('Employee and device credentials cannot be combined', 400);
    const user = outside ? null : employeeUser; const device = outside ? await getDevicePrincipal(req) : null;
    if (outside && !device) return err('A valid active device token is required outside an employee session', 401);
    if (!outside && !user) return err('A valid employee session is required', 401);
    const ownerId = user?.sub || `device-${device!.id}`;
    await ensureMonitoringSchema(); await ensureScreenshotThumbnailSchema();
    const receivedAt = new Date();
    const shots = input.map((item: any) => {
      const timing = resolveIngestTime(item?.capturedAt, receivedAt);
      return { localId:String(item?.localId||''),path:String(item?.path||getR2KeyFromUrl(String(item?.url||''))||''),url:String(item?.url||''),thumbnailPath:String(item?.thumbnailPath||getR2KeyFromUrl(String(item?.thumbnailUrl||''))||''),thumbnailUrl:String(item?.thumbnailUrl||''),checksum:String(item?.checksum||item?.sha256||''),deviceId:item?.deviceId?String(item.deviceId).slice(0,200):null,activeApp:String(item?.activeApp||'Unknown').slice(0,500),activityPct:Math.max(0,Math.min(100,Number.parseInt(String(item?.activityPct||0),10)||0)),capturedAt:timing?.effectiveAt||'',deviceCapturedAt:timing?.deviceAt||'',clockSkewSeconds:timing?.clockSkewSeconds||0,sessionId:item?.sessionId?String(item.sessionId):null };
    });
    if (new Set(shots.map(shot => shot.localId)).size !== shots.length) return err('Duplicate screenshot idempotency key', 400);
    for (const shot of shots) {
      const parsed=parseCanonicalScreenshotKey(shot.path); const thumb=shot.thumbnailPath?parseCanonicalScreenshotKey(shot.thumbnailPath):null; const at=new Date(shot.deviceCapturedAt);
      if (!parsed||parsed.kind!=='regular'||parsed.employeeId!==ownerId||!isR2Url(shot.url)||getR2KeyFromUrl(shot.url)!==shot.path) return err('Invalid R2 screenshot object',400);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(shot.localId) || parsed.captureId !== shot.localId) return err('Invalid screenshot idempotency key',400);
      if (!/^[a-f0-9]{64}$/i.test(shot.checksum)||!shot.capturedAt||Number.isNaN(at.getTime())||getCaptureDateFromKey(shot.path)!==at.toISOString().slice(0,10)) return err('Invalid screenshot metadata',400);
      if (shot.thumbnailPath&&(!thumb||thumb.kind!=='thumbnail'||thumb.employeeId!==ownerId||thumb.captureId!==parsed.captureId||!isR2Url(shot.thumbnailUrl)||getR2KeyFromUrl(shot.thumbnailUrl)!==shot.thumbnailPath)) return err('Invalid screenshot thumbnail',400);
    }
    const available=await getExistingColumns('screenshots',['file_url','thumbnail_url','r2_key','storage_provider','device_id','device_registration_id','capture_context','capture_local_id']);
    if (!available.has('file_url') || !available.has('capture_local_id') || !available.has('r2_key') || !available.has('device_registration_id') || !available.has('capture_context')) throw new Error('screenshots table is missing R2 or durable provenance columns');
    const saved=await withTransaction(async(client)=>{
      if (user) {
        const sessionIds = [...new Set(shots.map(shot => shot.sessionId))];
        if (sessionIds.some(id => !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) throw new Error('INVALID_SESSION');
        const owned = await client.query('SELECT id, check_in, check_out FROM attendance WHERE id = ANY($1::uuid[]) AND employee_id = $2', [sessionIds, user.sub]);
        if (owned.rows.length !== sessionIds.length) throw new Error('INVALID_SESSION');
        const attendanceById = new Map(owned.rows.map((row: any) => [String(row.id), row]));
        for (const shot of shots) {
          const attendance: any = attendanceById.get(String(shot.sessionId));
          const capturedAt = new Date(shot.capturedAt).getTime();
          const startsAt = new Date(attendance.check_in).getTime();
          const checkoutAt = attendance.check_out ? new Date(attendance.check_out).getTime() : Number.POSITIVE_INFINITY;
          const automaticCutoff = getAutoCheckoutCutoffForTimestamp(attendance.check_in, BUSINESS_TIME_ZONE).getTime();
          if (capturedAt < startsAt || capturedAt > Math.min(checkoutAt, automaticCutoff)) throw new Error('INVALID_SESSION');
        }
      }
      const attributedEmployeeId = user?.sub || device?.assignedEmployeeId || null;
      const columns=['employee_id','device_registration_id',...(available.has('device_id')?['device_id']:[]),'file_url',...(available.has('thumbnail_url')?['thumbnail_url']:[]),'r2_key',...(available.has('storage_provider')?['storage_provider']:[]),'capture_context','capture_local_id','captured_at','device_captured_at','clock_skew_seconds','active_app','activity_pct','session_id']; const values:any[]=[];
      const tuples=shots.map(s=>{const row=[attributedEmployeeId,device?.id||null,...(available.has('device_id')?[s.deviceId]:[]),s.url,...(available.has('thumbnail_url')?[s.thumbnailUrl||null]:[]),s.path,...(available.has('storage_provider')?['r2']:[]),user?'employee_session':'device_background',s.localId,s.capturedAt,s.deviceCapturedAt,s.clockSkewSeconds,s.activeApp,s.activityPct,s.sessionId];const start=values.length;values.push(...row);return `(${row.map((_,i)=>`$${start+i+1}`).join(',')})`;});
      const conflict='ON CONFLICT (capture_local_id) WHERE capture_local_id IS NOT NULL DO UPDATE SET capture_local_id=EXCLUDED.capture_local_id WHERE screenshots.r2_key=EXCLUDED.r2_key AND screenshots.employee_id IS NOT DISTINCT FROM EXCLUDED.employee_id AND screenshots.device_registration_id IS NOT DISTINCT FROM EXCLUDED.device_registration_id AND screenshots.capture_context=EXCLUDED.capture_context AND screenshots.session_id IS NOT DISTINCT FROM EXCLUDED.session_id AND screenshots.captured_at=EXCLUDED.captured_at';
      const result=await client.query(`INSERT INTO screenshots (${columns.join(',')}) VALUES ${tuples.join(',')} ${conflict} RETURNING id, capture_local_id`,values);
      const idsByLocalId=new Map(result.rows.map((row:any)=>[String(row.capture_local_id),row.id]));
      if(idsByLocalId.size!==shots.length)throw new Error('INVALID_IDEMPOTENCY');
      if(user){const last=shots[shots.length-1];await client.query("INSERT INTO employee_status(employee_id,current_status,current_app,last_activity,updated_at) VALUES($1,'working',$2,NOW(),NOW()) ON CONFLICT(employee_id) DO UPDATE SET current_app=$2,last_activity=NOW(),updated_at=NOW()",[user.sub,last.activeApp]);}
      return shots.map(shot=>({...shot,id:idsByLocalId.get(shot.localId)}));});
    const attributedEmployeeId = user?.sub || device?.assignedEmployeeId || null;
    await Promise.all(saved.map(shot=>emitSocketEvent('new-screenshot',{userId:attributedEmployeeId,userName:user?.name||device?.deviceName||'Unknown',deviceId:device?.id||shot.deviceId,screenshotId:shot.id,fileUrl:shot.url,thumbnailUrl:shot.thumbnailUrl||shot.url,activeApp:shot.activeApp,activityPct:shot.activityPct,capturedAt:shot.capturedAt,captureContext:user?'employee_session':'device_background'},{toAdmins:true})));
    if (user) {
      await ensureTimelineSchema();
      // Link captures taken at an attempt to the evidence record. The existing
      // retention job preserves screenshots with a screenshot_flags reference.
      for (const shot of saved) await sql`INSERT INTO screenshot_flags(screenshot_id,employee_id,flagged_by,comment)
        SELECT ${shot.id},${user.sub},${user.sub},'System evidence: ' || e.label FROM timeline_events e
        WHERE e.employee_id=${user.sub} AND e.flagged=TRUE
          AND e.created_at BETWEEN ${shot.capturedAt}::timestamptz-INTERVAL '2 minutes' AND ${shot.capturedAt}::timestamptz+INTERVAL '5 seconds'
          AND NOT EXISTS(SELECT 1 FROM screenshot_flags f WHERE f.screenshot_id=${shot.id}) ORDER BY e.created_at DESC LIMIT 1`;
      const latest = saved[saved.length - 1];
      const [presenceState] = await sql`SELECT current_status FROM employee_status WHERE employee_id = ${user.sub}`;
      const presence = { employeeId:user.sub, employeeName:user.name, status:presenceState?.current_status||'working', currentApp:latest.activeApp, activityPct:latest.activityPct, lastActivity:new Date().toISOString(), timestamp:new Date().toISOString() };
      await emitSocketEvent('employee-status', presence, { toAdmins:true });
      await emitSocketEvent('employee-activity-updated', presence, { toAdmins:true });
    }
    return agentOk(req,user,{screenshots:saved.map(s=>({id:s.id,path:s.path})),authContext:user?'employee_session':'device_background'},201);
  } catch(error:any){if(error?.message==='INVALID_SESSION')return err('Screenshot session is invalid or belongs to another employee',403);if(error?.message==='INVALID_IDEMPOTENCY')return err('Screenshot idempotency key conflicts with an existing capture',409);console.error('POST /api/agent/screenshots/commit error:',error?.message||error);return err('Failed to save screenshots',500);}
}
