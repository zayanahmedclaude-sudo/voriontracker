import { sql } from './db';
import { preferencesFor, timelineDetails, visibleEmployeeIds } from './timeline-service';
import { scheduledWindow, nextExportAt } from './timeline-policy';
import { addDays, BUSINESS_TIME_ZONE, getWindowDateInTimeZone } from './shifts';
import { makeTimelineExport } from './timeline-export';
import { sendScreenshotFlagReportEmail, hasSmtpConfig } from './mailer';
import { normalizeRole } from './roles';
import type { TokenPayload } from './auth';
import { ensureTimelineSchema } from './timeline-schema';

export async function collectTimelineNotifications(user: TokenPayload) {
  const prefs=await preferencesFor(user.sub), ids=await visibleEmployeeIds(user);
  if(!ids.length)return;
  const date=getWindowDateInTimeZone(new Date(),16,BUSINESS_TIME_ZONE);
  const {configs}=await timelineDetails(ids);
  const employees=await sql`SELECT p.id,p.full_name,es.current_status,es.last_activity,
    (SELECT MIN(check_in) FROM attendance a WHERE a.employee_id=p.id AND check_in>=${date}::date+INTERVAL '11 hours') AS check_in,
    (SELECT COALESCE(SUM(total_minutes),0) FROM attendance a WHERE a.employee_id=p.id AND check_in>=${date}::date+INTERVAL '11 hours') AS minutes,
    (SELECT created_at FROM timeline_events e WHERE e.employee_id=p.id AND e.label='Idle detected' ORDER BY created_at DESC LIMIT 1) AS idle_start
    FROM public.profiles p LEFT JOIN employee_status es ON es.employee_id=p.id WHERE p.id=ANY(${ids}::uuid[])`;
  const add=async(employee:string,key:string,message:string,flagged=false)=>{
    await sql`INSERT INTO timeline_notifications(user_id,employee_id,event_key,message,flagged) VALUES(${user.sub},${employee},${key},${message},${flagged}) ON CONFLICT(user_id,event_key) DO NOTHING`;
  };
  for(const r of employees){
    const idle=r.current_status==='idle' && r.idle_start ? (Date.now()-new Date(r.idle_start).getTime())/60000:0;
    if(idle>=prefs.threshold)await add(r.id,`${date}:${r.id}:idle:${new Date(r.idle_start).toISOString()}`,`${r.full_name} has been idle for ${Math.floor(idle)} min, above the ${prefs.threshold} min threshold.`);
    const stale=r.last_activity ? (Date.now()-new Date(r.last_activity).getTime())/60000:Infinity;
    if(prefs.offlineAlerts && stale>=prefs.offlineMinutes)await add(r.id,`${date}:${r.id}:offline:${r.last_activity ? new Date(r.last_activity).toISOString():'never'}`,`${r.full_name} is offline; no update within ${prefs.offlineMinutes} minutes.`);
    const schedule=configs.find((c:any)=>c.employee_id===r.id)?.schedule || [];
    const window=scheduledWindow(schedule,date);
    if(prefs.missedAlerts && window && !r.check_in && Date.now()>=window.start.getTime()+prefs.missedMinutes*60000 && Date.now()<window.end.getTime())await add(r.id,`${date}:${r.id}:missed`,`${r.full_name} missed check-in by more than ${prefs.missedMinutes} minutes.`);
    if(Number(r.minutes)>=540)await add(r.id,`${date}:${r.id}:target`,`${r.full_name} reached 100% of the daily work target.`);
  }
  const flags=await sql`SELECT * FROM timeline_events WHERE employee_id=ANY(${ids}::uuid[]) AND flagged=TRUE AND created_at>NOW()-INTERVAL '24 hours'`;
  for(const event of flags){const employee=employees.find((r:any)=>r.id===event.employee_id);await add(event.employee_id,`flag:${event.id}`,`${employee?.full_name || 'Employee'}: ${event.label} at ${new Date(event.created_at).toLocaleTimeString('en-GB',{timeZone:BUSINESS_TIME_ZONE})}. ${event.detail}`,true);}
  if(prefs.weeklyEmail && new Date(`${date}T12:00:00Z`).getUTCDay()===1) await add(user.sub,`weekly:${date}`,`Weekly timeline summary ending ${date}`);
}
export async function runTimelineWorker() {
  await ensureTimelineSchema();
  // Leases keep overlapping invocations from sending the same work concurrently.
  const owners=await sql`SELECT p.id,p.full_name,p.email,p.role,p.department_id FROM timeline_preferences t JOIN public.profiles p ON p.id=t.user_id WHERE COALESCE(p.account_status,'active')='active'`;
  let sent=0,failed=0;
  for(const owner of owners){
    const user:TokenPayload={sub:owner.id,name:owner.full_name,role:normalizeRole(owner.role),teamId:owner.department_id};
    await collectTimelineNotifications(user);
    const prefs=await preferencesFor(owner.id);
    const permittedIds=await visibleEmployeeIds(user);
    if(!hasSmtpConfig())continue;
    const messages=await sql`UPDATE timeline_notifications SET lease_until=NOW()+INTERVAL '10 minutes'
      WHERE id IN (SELECT id FROM timeline_notifications WHERE user_id=${owner.id} AND email_sent_at IS NULL
        AND (employee_id=ANY(${permittedIds}::uuid[]) OR event_key LIKE 'weekly:%')
        AND (${prefs.channel!=='in-app'} OR event_key LIKE 'weekly:%') AND created_at>NOW()-INTERVAL '1 day'
        AND (lease_until IS NULL OR lease_until<NOW()) ORDER BY created_at LIMIT 30 FOR UPDATE SKIP LOCKED) RETURNING *`;
    for(const message of messages){try{
      const attachments=[];
      if(message.event_key.startsWith('weekly:')){const end=message.event_key.slice(7);attachments.push({filename:`timeline-weekly-${end}.pdf`,content:await makeTimelineExport(user,addDays(end,-7),addDays(end,-1),'pdf')});}
      await sendScreenshotFlagReportEmail({to:[owner.email],subject:message.flagged?'Vorion: flagged timeline event':'Vorion timeline notification',text:message.message,html:'',attachments});
      await sql`UPDATE timeline_notifications SET email_sent_at=NOW(),lease_until=NULL WHERE id=${message.id}`;sent++;
    }catch(e:any){failed++;console.error('Timeline notification delivery failed',e.message);}}
  }
  if(hasSmtpConfig()){
    const jobs=await sql`UPDATE timeline_exports SET lease_until=NOW()+INTERVAL '10 minutes' WHERE id IN
      (SELECT id FROM timeline_exports WHERE enabled=TRUE AND next_run<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) ORDER BY next_run LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING *`;
    for(const job of jobs){try{
      const [owner]=await sql`SELECT id,full_name,role,department_id FROM public.profiles WHERE id=${job.user_id} AND COALESCE(account_status,'active')='active'`;
      if(!owner){await sql`UPDATE timeline_exports SET enabled=FALSE,lease_until=NULL WHERE id=${job.id}`;continue;}
      const user:TokenPayload={sub:owner.id,name:owner.full_name,role:normalizeRole(owner.role),teamId:owner.department_id};
      const end=addDays(getWindowDateInTimeZone(new Date(),16,BUSINESS_TIME_ZONE),-1),start=addDays(end,job.frequency==='weekly'?-6:job.frequency==='monthly'?-29:0);
      const content=await makeTimelineExport(user,start,end,job.format);
      await sendScreenshotFlagReportEmail({to:[job.recipient],subject:`Vorion ${job.frequency} timeline report`,text:`Employee timeline for ${start} to ${end}.`,html:'',attachments:[{filename:`timeline-${start}-${end}.${job.format}`,content}]});
      await sql`UPDATE timeline_exports SET next_run=${nextExportAt(job.frequency)},last_sent=NOW(),last_error=NULL,lease_until=NULL WHERE id=${job.id}`;sent++;
    }catch(e:any){failed++;await sql`UPDATE timeline_exports SET last_error=${String(e.message).slice(0,500)} WHERE id=${job.id}`;}}
  }
  // Preserve attendance source records. Only the dedicated timeline evidence/feed expires.
  await sql`DELETE FROM timeline_notifications WHERE created_at<NOW()-INTERVAL '90 days'`;
  await sql`DELETE FROM timeline_events WHERE created_at<NOW()-INTERVAL '90 days'`;
  return {sent,failed};
}
