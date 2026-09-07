'use client';
import { useEffect, useMemo, useState, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useAuthStore } from '@/store/auth';
import { activityMinutes, hourlyHeatmap } from '@/lib/timeline-view';
import { addDays, BUSINESS_TIME_ZONE, getTimelineWindowForDate, getWindowDateInTimeZone } from '@/lib/shifts';
import TimelineBoard from './timeline-board';
import styles from './timeline.module.css';
import { isAgentTrackedRole, normalizeRole } from '@/lib/roles';

export default function TimelinePage() {
  const {token,user}=useAuthStore();
  const [date,setDate]=useState('');
  const [zoom,setZoom]=useState('Hourly');
  const [query,setQuery]=useState('');
  const [status,setStatus]=useState('all');
  const [sort,setSort]=useState('most_work');
  const [rows,setRows]=useState<any[]>([]);
  const [yesterday,setYesterday]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [tick,setTick]=useState(0);
  const [now,setNow]=useState(new Date());
  const previousRange=useRef('');
  useEffect(()=>{setDate(getWindowDateInTimeZone(new Date(),16,BUSINESS_TIME_ZONE));const timer=setInterval(()=>{setNow(new Date());setTick(t=>t+1);},30000);return()=>clearInterval(timer);},[]);
  const start= date ? zoom==='Weekly' ? addDays(date,-6) : zoom==='Monthly' ? `${date.slice(0,7)}-01` : date : '';
  useEffect(()=>{
    if(!token||!date)return;
    const controller=new AbortController();const rangeKey=`${start}:${date}`;if(previousRange.current!==rangeKey)setLoading(true);previousRange.current=rangeKey;setError('');
    const range=start!==date;
    const url=range?`/api/reports?type=range&start_date=${start}&end_date=${date}`:`/api/reports?date=${date}`;
    Promise.all([apiFetch<any>(url,{token,expect:'json',signal:controller.signal}),apiFetch<any>(`/api/reports?date=${addDays(date,-1)}`,{token,expect:'json',signal:controller.signal})]).then(([result,previous])=>{
      if(controller.signal.aborted)return;
      const days=range?result.days:[result];
      const merged=new Map<string,any>();
      for(const day of days||[])for(const r of day.rows||[]){
        if(r.role && !isAgentTrackedRole(normalizeRole(r.role)))continue;
        const logs=r.logs||[], segments=[...(r.segments||[])];
        if(!segments.some((s:any)=>s.type==='idle'))segments.push(...logs.filter((l:any)=>l.type==='app'&&l.activityPct===0).map((l:any)=>({type:'idle',startMinute:l.startMinute,endMinute:l.endMinute})));
        const totals=activityMinutes(segments);
        const existing=merged.get(r.id);
        const next={...r,segments,logs,audit:r.audit||[],periodTotals:range?{work:totals.work+(existing?.periodTotals.work||0),idle:totals.idle+(existing?.periodTotals.idle||0),break:totals.break+(existing?.periodTotals.break||0)}:undefined,periodDays:range?days.length:1};
        if(existing){next.audit=[...existing.audit,...next.audit];next.logs=[...existing.logs,...logs];}
        merged.set(r.id,next);
      }
      setRows([...merged.values()]);setYesterday((previous.rows||[]).filter((r:any)=>!r.role||isAgentTrackedRole(normalizeRole(r.role))));setLoading(false);
    }).catch(e=>{if(!controller.signal.aborted){setError(e.message||'Unable to load timeline');setRows([]);setLoading(false);}});
    return()=>controller.abort();
  },[token,date,start,tick]);
  const filtered=useMemo(()=>rows.filter(r=>r.name.toLowerCase().includes(query.toLowerCase())).filter(r=>status==='all'||(status==='offline'?!['active','working','idle','on_break','break'].includes(r.current_status):status==='working'?['active','working'].includes(r.current_status):r.current_status===status)).sort((a,b)=>{
    if(sort==='alphabetical')return a.name.localeCompare(b.name);
    if(sort==='status')return String(a.current_status).localeCompare(String(b.current_status));
    const total=(r:any)=>r.periodTotals||activityMinutes(r.segments);
    return sort==='most_idle'?total(b).idle-total(a).idle:sort==='least_work'?total(a).work-total(b).work:total(b).work-total(a).work;
  }),[rows,query,status,sort]);
  const shift=date?getTimelineWindowForDate(date):null;
  const minute=shift?(now.getTime()-shift.start.getTime())/60000:-1;
  const nowMinute=minute>=0&&minute<=900?minute:-1;
  return <TimelineBoard rows={filtered} allRows={rows} date={date} startDate={start} token={token} userId={user?.id} teamId={user?.teamId} query={query} statusFilter={status} sort={sort} onSort={setSort} onFilter={(q,s)=>{setQuery(q);setStatus(s);}} hourly={zoom==='Hourly'} nowMinute={nowMinute} loading={loading} error={error} yesterday={yesterday} periodDays={start===date?1:Math.round((Date.parse(date)-Date.parse(start))/86400000)+1} toolbar={<div className={styles.toolbar}>
    <label>Search employees<input aria-label="Search employee" type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Name..."/></label>
    <label>Status<select aria-label="Status filter" value={status} onChange={e=>setStatus(e.target.value)}>{[['all','All statuses'],['working','Working'],['idle','Idle'],['on_break','Break'],['offline','Offline']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    <label>Sort<select aria-label="Sort employees" value={sort} onChange={e=>setSort(e.target.value)}>{[['most_work','Most working time'],['least_work','Least working time'],['most_idle','Most idle time'],['alphabetical','Alphabetical'],['status','Status']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    <label>Shift date<input aria-label="Shift date" type="date" value={date} onChange={e=>{if(e.target.value)setDate(e.target.value);}}/></label>
    <div className={styles.actions} aria-label="Timeline period">{['Hourly','Daily','Weekly','Monthly'].map(v=><button key={v} aria-pressed={zoom===v} onClick={()=>setZoom(v)}>{v}</button>)}</div>
  </div>}/>;
}
