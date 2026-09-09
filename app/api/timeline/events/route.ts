import { NextRequest } from 'next/server';
import { requireAuth, ok, err } from '@/lib/api';
import { attemptPolicy, captureLocation, recordTimelineEvent } from '@/lib/timeline-service';
import { isAgentTrackedRole, normalizeRole } from '@/lib/roles';
import { resolveIngestTime } from '@/lib/ingest-time';
export async function POST(req: NextRequest) {
  const user = requireAuth(req); if ('status' in user) return user;
  if(!isAgentTrackedRole(normalizeRole(user.role)))return err('This account is not tracked',403);
  try {
    const body = await req.json();
    if (body.type === 'location') return ok(await captureLocation(user.sub,body));
    if (body.type === 'close_attempt') {
      const policy = await attemptPolicy(user.sub);
      if (policy.flagged) await recordTimelineEvent(user.sub,{kind:'security',label:'Attempted to close tracker',flagged:true,detail:`${policy.remainingMinutes} minutes before shift end. Close blocked; tracker remained running.`,metadata:policy});
      return ok(policy);
    }
    if (!['app_open','app_close','idle_start','idle_end'].includes(body.type)) return err('Invalid event type');
    if (typeof body.key !== 'string' || body.key.length>100 || typeof body.app !== 'string' || body.app.length>500) return err('Invalid event');
    const duration = Number(body.durationMinutes || 0);
    if (!Number.isFinite(duration) || duration<0 || duration>1440) return err('Invalid duration');
    const pct = Number(body.activityPct);
    const timing=resolveIngestTime(body.at);
    if(!timing)return err('Invalid event timestamp');
    await recordTimelineEvent(user.sub,{at:timing.effectiveAt,key:body.key,kind:body.type.startsWith('idle')?'idle':'app',label:({app_open:'App opened',app_close:'App closed',idle_start:'Idle detected',idle_end:'Idle ended'} as Record<string,string>)[body.type],detail:`${body.app}${Number.isFinite(pct) ? ` · ${Math.max(0,Math.min(100,pct))}% activity` : ''}${body.type.startsWith('app')?' · Foreground app usage':''}`,durationMinutes:duration,metadata:{source:'agent',app:body.app,deviceAt:timing.deviceAt,receivedAt:timing.receivedAt,clockSkewSeconds:timing.clockSkewSeconds,timeCorrected:timing.corrected}});
    return ok({ok:true,timeCorrected:timing.corrected,serverTime:timing.receivedAt});
  } catch (e: any) { console.error('Timeline event failed',e.message); return err('Unable to record timeline event',500); }
}
