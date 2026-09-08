'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TimelineSettings, ExportSchedule, EmployeeSchedule, EmployeeLocation } from './timeline-settings';
import { defaultPreferences, type TimelinePreferences } from '@/lib/timeline-policy';
import { addDays, getTimelineWindowForDate } from '@/lib/shifts';
import { Bell, ChevronLeft, ChevronRight, Settings, Moon, Sun, X, ChevronDown, Trophy } from 'lucide-react';
import { activityMinutes, hourlyHeatmap, type ActivitySegment } from '@/lib/timeline-view';
import type { AuditEvent } from '@/lib/timeline-audit';
import { apiFetch } from '@/lib/api-client';
import styles from './timeline.module.css';
import { canSendAlerts } from '@/lib/roles';
import { useAuthStore } from '@/store/auth';

type Log = { type: string; label: string; startAt: string; endAt: string; durationMinutes: number; app?: string | null; activityPct?: number | null; detail?: string };
type Row = { id: string; name: string; current_status?: string | null; last_active?: string | null; department_id?: string | null; segments: ActivitySegment[]; logs: Log[]; audit?: AuditEvent[]; periodTotals?: {work:number;idle:number;break:number}; periodDays?: number };
type View = { name: string; query: string; status: string; team?: boolean; sort?: string };
const colors = { work: 'var(--work)', idle: 'var(--idle)', break: 'var(--break)', offline: 'var(--offline)' };
const duration = (m: number) => `${Math.floor(m / 60)}h ${Math.floor(m % 60)}m`;
const hourLabel = (h: number) => `${(h + 16) % 12 || 12}${(h + 16) % 24 >= 12 ? 'PM' : 'AM'}`;
const offline = (r: Row) => !['working', 'active', 'idle', 'break', 'on_break'].includes(r.current_status || '');
const status = (r: Row) => offline(r) ? 'Offline' : r.current_status === 'idle' ? 'Idle' : ['break', 'on_break'].includes(r.current_status || '') ? 'Break' : 'Working';
function trail(row: Row): AuditEvent[] {
  return [...(row.audit || []), ...row.logs.filter(l => l.type === 'app' && l.startAt && !(row.audit || []).some(e => e.kind === 'app' || e.kind === 'idle')).map((l, i) => ({ id: `app-${i}`, at: l.startAt, kind: l.activityPct === 0 ? 'idle' as const : 'app' as const, label: l.activityPct === 0 ? 'Idle detected' : l.app || l.label, detail: [l.detail, l.activityPct == null ? '' : `${l.activityPct}% activity`, l.endAt ? `Until ${new Date(l.endAt).toLocaleTimeString()}` : ''].filter(Boolean).join(' - '), flagged: false, durationMinutes: l.durationMinutes }))].sort((a, b) => a.at.localeCompare(b.at));
}
export default function TimelineBoard({ rows, allRows, date, token, userId, teamId, query, statusFilter, onFilter, hourly, nowMinute, loading, error, toolbar, startDate, yesterday, periodDays, sort, onSort }: {
  toolbar: ReactNode; startDate: string; yesterday: Row[]; periodDays: number; sort: string; onSort: (value:string)=>void; rows: Row[]; allRows: Row[]; date: string; token: string | null; userId?: string; teamId?: string | null; query: string; statusFilter: string;
  onFilter: (query: string, status: string) => void; hourly: boolean; nowMinute: number; loading: boolean; error: string;
}) {
  const { user } = useAuthStore();
  const [messageOpen, setMessageOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [expanded, setExpanded] = useState('');
  const [tab, setTab] = useState('Overview');
  const [hour, setHour] = useState(() => Math.max(0, Math.min(14, Math.floor(nowMinute / 60))));
  const initializedHour = useRef(false);
  useEffect(() => { if (!initializedHour.current && nowMinute >= 0) { setHour(Math.min(14, Math.floor(nowMinute / 60))); initializedHour.current = true; } }, [nowMinute]);
  const [checked, setChecked] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [myTeam, setMyTeam] = useState(false);
  const [dark, setDark] = useState(false);
  const [settings, setSettings] = useState(false);
  const [threshold, setThreshold] = useState(15);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [notifications, setNotifications] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [auditFilter, setAuditFilter] = useState('All');
  const [views, setViews] = useState<View[]>([]);
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState('');
  const [notice, setNotice] = useState('');
  const [preferences,setPreferences]=useState<TimelinePreferences>(defaultPreferences);
  const [config,setConfig]=useState<any>({configs:[],locations:[],notifications:[],exports:[]});
  const [recurring,setRecurring]=useState(false);
  const [profileOpen,setProfileOpen]=useState(false);
  const [exportBusy,setExportBusy]=useState(false);
  async function mutate(body:any){if(!token)throw new Error('Please sign in');return apiFetch<any>('/api/timeline',{token,method:'POST',body:JSON.stringify(body),expect:'json'});}
  async function refreshConfig(){if(!token)return;const value=await apiFetch<any>('/api/timeline',{token,expect:'json'});setConfig(value);setPreferences(value.preferences);setThreshold(value.preferences.threshold);setDark(value.preferences.dark);setViews(value.preferences.views);}
  async function persistPreferences(value:TimelinePreferences){await mutate({action:'preferences',preferences:value});setPreferences(value);setThreshold(value.threshold);setDark(value.dark);setViews(value.views);}
  useEffect(()=>{let active=true;const load=()=>{if(token)apiFetch<any>('/api/timeline',{token,expect:'json'}).then(value=>{if(active){setConfig(value);setPreferences(value.preferences);setThreshold(value.preferences.threshold);setDark(value.preferences.dark);setViews(value.preferences.views);}}).catch(e=>{if(active)setNotice(e.message);});};load();const timer=setInterval(load,30000);return()=>{active=false;clearInterval(timer);};},[token]);
  useEffect(()=>{document.documentElement.classList.toggle('timeline-dark',dark);return()=>document.documentElement.classList.remove('timeline-dark');},[dark]);
  async function download(format:string){if(!token||!date||exportBusy)return;setExportBusy(true);try{const ids=checked.length?checked:filtered.map(r=>r.id);if(!ids.length)throw new Error('No employees selected');const response=await apiFetch<Response>(`/api/timeline/export?${new URLSearchParams({start:startDate,end:date,format,ids:ids.join(',')})}`,{token,expect:'response'});const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download=`timeline-${startDate}-${date}.${format}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e:any){setNotice(e.message);}finally{setExportBusy(false);}}

  const [screens, setScreens] = useState<Array<{ id: string; thumbnail_url?: string; captured_at: string; active_app?: string; flagged?: boolean }>>([]);
  const [screenState, setScreenState] = useState('');
  useEffect(() => { setPage(0); }, [query, statusFilter, myTeam]);
  const data = useMemo(() => allRows.map(r => {
    const totals = r.periodTotals || activityMinutes(r.segments);
    const idleSegments = r.segments.filter(s => s.type === 'idle').sort((a,b) => a.startMinute-b.startMinute);
    let longest = 0, start = -1, end = -1;
    for (const s of idleSegments) { if (s.startMinute > end) start = s.startMinute; end = Math.max(end, s.endMinute); longest = Math.max(longest, end-start); }
    const liveIdle = r.current_status === 'idle' && nowMinute >= 0 && end >= nowMinute - 2 ? Math.max(0, Math.min(end, nowMinute) - start) : 0;
    return { ...r, totals, longest, liveIdle, events: trail(r), productivity: totals.work + totals.idle ? Math.round(totals.work / (totals.work + totals.idle) * 100) : null };
  }), [allRows, nowMinute]);
  const rowOrder = new Map(rows.map((row, index) => [row.id, index]));
  const filtered = data
    .filter(row => rowOrder.has(row.id) && (!myTeam || row.department_id === teamId))
    .sort((a, b) => (rowOrder.get(a.id) || 0) - (rowOrder.get(b.id) || 0));
  useEffect(() => { setPage(p => Math.min(p, Math.max(0, Math.ceil(filtered.length / 15) - 1))); }, [filtered.length]);
  const selected = data.find(r => r.id === selectedId) || filtered[0];
  const alerts=config.notifications.filter((n:any)=>!n.dismissed && !n.event_key.startsWith('weekly:')).map((n:any)=>({id:n.id,row:n.employee_id,text:n.message,flagged:n.flagged,unread:!n.read_at}));
  const activeAlerts = preferences.channel==='email' ? [] : alerts.filter((a:any) => !dismissed.includes(a.id));
  const previousTotals=yesterday.map(r=>activityMinutes(r.segments || []));
  const previousWork=previousTotals.reduce((n,r)=>n+r.work+r.idle,0);
  const previousScores=previousTotals.filter(r=>r.work+r.idle>0).map(r=>r.work/(r.work+r.idle)*100);
  const previousProductivity=previousScores.length?previousScores.reduce((a,b)=>a+b,0)/previousScores.length:0;
  const teamWork=data.reduce((n,r)=>n+r.totals.work+r.totals.idle,0);

  const scores = data.filter(r => r.productivity !== null);
  const openEmployee = (id: string, audit = false) => { setSelectedId(id); setExpanded(id); if (audit) setTab('Audit Trail'); };
  async function sendMessages() {
    if (!token || !message.trim() || sending) return;
    setSending(true);
    const results = await Promise.allSettled(checked.map(employee_id => apiFetch('/api/alerts', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_id, alert_type: 'manager_message', title: 'Message from your manager', description: message.trim(), severity: 'low' }) })));
    const failed = checked.filter((_, i) => results[i].status === 'rejected');
    setNotice(`${checked.length - failed.length} message(s) sent.${failed.length ? ` ${failed.length} failed; those recipients remain selected for retry.` : ''}`);
    setChecked(failed); setSending(false);
    if (!failed.length) { setMessageOpen(false); setMessage(''); }
  }
  useEffect(() => {
    if (tab !== 'Screens' || !selected || !token || !date) return;
    const controller = new AbortController(); setScreens([]); setScreenState('Loading screenshots...');
    apiFetch<Array<{ id: string; thumbnail_url?: string; captured_at: string; active_app?: string; flagged?: boolean }>>(`/api/screenshots?${new URLSearchParams({ userId: selected.id, dateFrom: startDate, dateTo: addDays(date,1), timeFrom:'16:00',timeTo:'07:00',limit: '25' })}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, expect: 'json' }).then(result => { if (!controller.signal.aborted) { setScreens(Array.isArray(result) ? result : []); setScreenState(''); } }).catch(e => { if (!controller.signal.aborted) setScreenState(e.message || 'Unable to load screenshots.'); });
    return () => controller.abort();
  }, [selected?.id, tab, token, date, startDate]);
  const shiftWindow = date ? getTimelineWindowForDate(date) : null;
  const withinSelectedHour = (at?: string | null) => {
    if (!hourly || periodDays !== 1 || !shiftWindow || !at) return true;
    const minute = (new Date(at).getTime() - shiftWindow.start.getTime()) / 60000;
    return minute >= hour * 60 && minute < (hour + 1) * 60;
  };
  const events = (selected?.events || []).filter(e => withinSelectedHour(e.at));
  const selectedTotals = selected ? (periodDays>1 ? selected.totals : activityMinutes(selected.segments,hourly ? hour*60 : 0,hourly ? (hour+1)*60 : 900)) : {work:0,idle:0,break:0,offline:0};
  const visibleEvents = events.filter(e => auditFilter === 'All' || (auditFilter === 'Flagged' ? e.flagged : auditFilter === 'Check-in/out' ? e.kind === 'attendance' : auditFilter === 'Breaks' ? e.kind === 'break' : e.kind === 'app' || e.kind === 'idle'));
  const apps = Object.entries((selected?.logs || []).filter(l => l.type === 'app' && (!hourly || periodDays !== 1 || (withinSelectedHour(l.startAt) || withinSelectedHour(l.endAt)))).reduce<Record<string, number>>((acc, l) => { const key = l.app || l.label; acc[key] = (acc[key] || 0) + l.durationMinutes; return acc; }, {})).sort((a,b) => b[1]-a[1]);
  return <section data-timeline-board className={`${styles.board} ${dark ? styles.dark : ''}`}>
    <div className={styles.heading}><div><span className={styles.eyebrow}>WORKSPACE / ACTIVITY</span><h2>Employee Timeline</h2><p>{startDate!==date ? `${startDate} - ${date}` : date || 'Current shift'} - Asia/Karachi - {nowMinute>=0?'Live - ':''}Refreshes every 30 seconds</p></div><div className={styles.actions}><button aria-label="Notifications" onClick={() => {setNotifications(!notifications);void mutate({action:'notification'}).then(refreshConfig).catch(e=>setNotice(e.message));}}><Bell size={16}/> {activeAlerts.filter((a:any)=>a.unread).length}</button><button aria-label="Toggle timeline dark mode" onClick={() => {void persistPreferences({...preferences,dark:!dark}).catch(e=>setNotice(e.message));}}>{dark ? <Sun size={16}/> : <Moon size={16}/>}</button><button onClick={() => setSettings(true)}><Settings size={16}/> Settings</button><button aria-label="Profile menu" onClick={()=>setProfileOpen(!profileOpen)}>{user?.name?.split(" ").map(n=>n[0]).slice(0,2).join("")}</button></div></div>{profileOpen&&<div className={styles.profileMenu}><b>{user?.name}</b><span>{user?.email}</span><button onClick={()=>{setSettings(true);setProfileOpen(false);}}>Team settings</button><button onClick={()=>{useAuthStore.getState().logout();window.location.assign("/login");}}>Sign out</button></div>}
    <div className={styles.kpis}>{[
      ['Team hours tracked', duration(teamWork), periodDays===1 && previousWork ? `${Math.round((teamWork-previousWork)/previousWork*100)}% vs previous shift` : 'Selected period'],
      ['Avg. productivity', scores.length ? `${Math.round(scores.reduce((n,r) => n+(r.productivity || 0),0)/scores.length)}%` : '--', periodDays===1 && previousScores.length && scores.length ? `${Math.round(scores.reduce((n,r)=>n+(r.productivity||0),0)/scores.length-previousProductivity)} points vs previous shift` : 'Work / (work + idle)'],
      ['Active idle alerts', data.filter(r => r.liveIdle >= threshold).length, `${threshold} min threshold - ${data.filter(r=>r.liveIdle>=threshold).length-yesterday.filter(r=>(r.audit||[]).some(e=>e.kind==='idle'&&(e.durationMinutes||0)>=threshold)).length} vs previous shift`],
      ['Currently offline', data.filter(offline).length, `of ${data.length} employees`],
      ['Flagged events', data.reduce((n,r) => n+r.events.filter(e => e.flagged).length,0), 'Recorded attempts this shift'],
    ].map(([label,value,hint]) => <article key={label}><span>{label}</span><strong>{loading ? '--' : value}</strong><small>{hint}</small></article>)}</div>
    {(notifications ? activeAlerts : [activeAlerts.find((a:any)=>!a.flagged),activeAlerts.find((a:any)=>a.flagged)].filter(Boolean)).map((a:any) => <div key={a.id} className={`${styles.alert} ${a.flagged ? styles.flagged : ''}`}><span>{a.text}</span><button onClick={() => openEmployee(a.row,true)}>View trail</button>{!a.flagged && <button onClick={() => setSettings(true)}>Adjust threshold</button>}<button aria-label="Dismiss alert" onClick={() => {setDismissed([...dismissed,a.id]);void mutate({action:'notification',id:a.id,dismissed:true}).catch(e=>setNotice(e.message));}}><X size={14}/></button></div>)}
    {notifications && !activeAlerts.length && <p role="status">No active notifications.</p>}
    {toolbar}
    <div className={styles.actions}>{['All employees','My team','Currently idle','Offline'].map((v,i) => <button key={v} disabled={i===1 && !teamId} aria-pressed={i===1 ? myTeam : !myTeam && statusFilter === ['all','all','idle','offline'][i]} onClick={() => { setMyTeam(i===1); onFilter('', ['all','all','idle','offline'][i]); }}>{v}</button>)}{views.map((v,i) => <button key={i} onClick={() => { setMyTeam(v.team===true); onFilter(v.query,v.status); onSort(v.sort||'most_work'); }}>{v.name}</button>)}<button onClick={() => setSavingView(!savingView)}>+ Save current filter</button></div>
    {savingView && <form className={styles.actions} onSubmit={e=>{e.preventDefault();if(!viewName.trim())return;const next=[...views,{name:viewName.trim(),query,status:statusFilter,team:myTeam,sort}];void persistPreferences({...preferences,views:next}).then(()=>{setSavingView(false);setViewName('');}).catch(e=>setNotice(e.message));}}><input aria-label="Saved view name" required maxLength={40} value={viewName} onChange={e=>setViewName(e.target.value)}/><button>Save view</button></form>}
    {periodDays===1 && <div className={styles.scrubber}><div className={styles.heading}><strong>{hourly ? `${hourLabel(hour)}-${hourLabel(hour+1)}` : 'Full shift'} <small>HR {hour+1}/15</small></strong><div className={styles.actions}><button aria-label="Previous hour" disabled={hour===0} onClick={() => setHour(hour-1)}><ChevronLeft size={16}/></button><button aria-label="Next hour" disabled={hour===14} onClick={() => setHour(hour+1)}><ChevronRight size={16}/></button></div></div><div className={styles.range}>{nowMinute >= 0 && <span className={styles.now} style={{left:`${Math.min(100,nowMinute/900*100)}%`}}>NOW</span>}<input aria-label="Shift hour" type="range" min={0} max={14} value={hour} onChange={e => setHour(Number(e.target.value))}/></div><div className={styles.ticks}><span>4PM</span><span>10PM</span><span>2AM</span><span>7AM</span></div></div>}
    <div className={styles.info}>i Target percentages compare recorded work with a 9-hour target within the 4PM-7AM window. Offline employees have no live data. Heatmap colors show the dominant activity each hour.</div>
    {notice && <p role="status">{notice} <button onClick={() => setNotice('')}>Dismiss</button></p>}
    <details className={styles.quickList}><summary>Team quick-list ({data.length})</summary><div className={styles.actions}>{data.map(r=><button key={r.id} onClick={()=>{openEmployee(r.id);document.querySelector('[aria-label="Employee details"]')?.scrollIntoView({behavior:'smooth',block:'nearest'});}}>{r.name}</button>)}</div></details>
    <div className={styles.layout}><div className={styles.panel}><div className={styles.heading}><h3>Team comparison <small>{filtered.length}</small></h3><div className={styles.actions}><button disabled={exportBusy} onClick={()=>void download('csv')}>{checked.length ? `Export selected (${checked.length})` : 'Export CSV'}</button><button disabled={exportBusy} onClick={()=>void download('pdf')}>PDF summary</button><button onClick={()=>setRecurring(true)}>Schedule export</button></div></div>
      <div className={styles.legend}>{Object.entries(colors).map(([name,color]) => <span key={name}><i style={{background:color}}/>{name}</span>)}</div>
      {checked.length > 0 && <div className={styles.info}>{checked.length} employees selected <button onClick={() => setChecked([])}>Clear selection</button> {user && canSendAlerts(user.role) && <button onClick={() => setMessageOpen(!messageOpen)}>Message selected</button>}</div>}
      {messageOpen && checked.length > 0 && <form className={styles.info} onSubmit={e => { e.preventDefault(); void sendMessages(); }}><label>Message to {checked.length} selected employees<textarea aria-label="Message to selected employees" required maxLength={2000} value={message} onChange={e=>setMessage(e.target.value)} style={{display:'block',width:'100%',minHeight:90,margin:'10px 0'}}/></label><button disabled={sending || !message.trim()}>{sending ? 'Sending...' : 'Send message'}</button><button type="button" onClick={()=>setMessageOpen(false)}>Cancel</button></form>}
      {loading || error || !filtered.length ? <p className={styles.empty}>{loading ? 'Loading employee activity...' : error || 'No employees match this view.'}</p> : filtered.slice(page*15,page*15+15).map(r => <article key={r.id} className={`${styles.employee} ${offline(r)?styles.offlineRow:''} ${selected?.id===r.id ? styles.selected : ''}`}><div className={styles.employeeLine}><input type="checkbox" aria-label={`Select ${r.name}`} checked={checked.includes(r.id)} onChange={e => setChecked(e.target.checked ? [...checked,r.id] : checked.filter(id => id!==r.id))}/><button className={styles.employeeButton} aria-expanded={expanded===r.id} onClick={() => { setSelectedId(r.id); setExpanded(expanded===r.id ? '' : r.id); }}><span className={styles.avatar}>{r.name.split(' ').map(n=>n[0]).slice(0,2).join('')}</span><span><b>{r.name}</b><small style={{color:offline(r) ? 'var(--muted)' : r.current_status==='idle' ? '#bc800e' : '#15996a'}}>* {status(r)}</small></span><span className={styles.total}>{offline(r) ? <><b>No live data</b><small>{r.last_active && new Date(r.last_active).getTime()>0 ? `Last seen ${duration(Math.max(0,(Date.now()-new Date(r.last_active).getTime())/60000))} ago` : 'Last seen unavailable'}</small></> : <><b>{duration(r.totals.work)} {r.liveIdle>=threshold ? '!' : ''}</b><small>{Math.round(r.totals.work/(540*periodDays)*100)}% of target</small></>}</span><ChevronDown size={16}/></button></div><div className={styles.heatmap}>{hourlyHeatmap(r.segments).map((kind,i) => <button key={i} aria-label={`${r.name}, ${hourLabel(i)}: ${kind}`} title={`${hourLabel(i)}-${hourLabel(i+1)}: ${kind}`} style={{background:colors[kind],outline:i===hour && hourly ? '2px solid var(--text)' : undefined}} onClick={() => { setHour(i); openEmployee(r.id); }}/>)}</div>{expanded===r.id && <div className={styles.breakdown}>{Object.entries(periodDays>1?r.totals:activityMinutes(r.segments,hourly ? hour*60 : 0,hourly ? (hour+1)*60 : 900)).filter(([k])=>k!=='offline').map(([kind,m])=><span key={kind}>{kind} <b>{duration(m)}</b></span>)}<small>{hourly ? `${hourLabel(hour)}-${hourLabel(hour+1)}` : periodDays>1?'Selected period':'Full shift'}</small></div>}</article>)}
      {filtered.length>15 && <div className={styles.actions}><button disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button><span>Page {page+1} of {Math.ceil(filtered.length/15)}</span><button disabled={(page+1)*15>=filtered.length} onClick={()=>setPage(page+1)}>Next</button></div>}
      <div className={styles.leaders}><h3><Trophy size={16}/> Top performers this shift</h3>{[...scores].sort((a,b)=>(b.productivity||0)-(a.productivity||0)).slice(0,3).map((r,i)=><button key={r.id} onClick={()=>openEmployee(r.id)}><span>{i+1}. {r.name}</span><b>{r.productivity}%</b></button>)}</div>
    </div><aside className={styles.panel} aria-label="Employee details">{selected ? <><div className={styles.heading}><div><span className={styles.eyebrow}>EMPLOYEE DETAILS</span><h3>{selected.name}</h3><small>{status(selected)} - {offline(selected) ? 'No live data' : `${duration(selected.totals.work)} - ${Math.round(selected.totals.work/(540*periodDays)*100)}% of target`}</small></div></div><div className={styles.tabs} role="tablist">{['Overview','Audit Trail','Apps','Screens','Location','Schedule'].map(t=><button role="tab" aria-selected={tab===t} key={t} onClick={()=>setTab(t)}>{t}</button>)}</div><div role="tabpanel">
      {tab==='Overview' && <><div className={styles.stats}>{(['work','idle','break'] as const).map(k=><div key={k}><i style={{background:colors[k]}}/>{k}<strong>{duration(selectedTotals[k])}</strong></div>)}</div><div className={styles.metric}><span>Productivity score</span><b>{selected.productivity==null ? '--' : `${selected.productivity}/100`}</b></div><div className={styles.metric}><span>Longest recorded idle streak</span><b>{duration(selected.longest)}</b></div><div className={styles.metric}><span>Check-ins this shift</span><b>{events.filter(e=>e.label==='Checked in').length}</b></div><p className={styles.info}>{hourly && periodDays===1 ? `${hourLabel(hour)}-${hourLabel(hour+1)}` : periodDays>1 ? 'Selected period' : 'Full shift'} activity view.</p></>}
      {tab==='Audit Trail' && <><div className={styles.stats}>{[['Check-ins',events.filter(e=>e.label==='Checked in').length],['Check-outs',events.filter(e=>e.label==='Checked out').length],['Breaks',events.filter(e=>e.label==='Break started').length],['Flagged',events.filter(e=>e.flagged).length]].map(([k,v])=><div key={k}>{k}<strong>{v}</strong></div>)}</div><div className={styles.actions}>{['All','Check-in/out','Breaks','Flagged','App activity'].map(f=><button key={f} aria-pressed={auditFilter===f} onClick={()=>setAuditFilter(f)}>{f}</button>)}<button aria-expanded={!collapsed} onClick={()=>setCollapsed(!collapsed)}>{collapsed ? 'Expand' : 'Collapse'}</button></div>{!collapsed && <div className={styles.events}>{visibleEvents.length ? visibleEvents.map(e=><article className={e.flagged ? styles.flagged : ''} key={e.id}><small className={styles.time}>{new Date(e.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</small><b>{e.label} {e.flagged && <em>FLAGGED</em>}</b><p>{e.detail}</p>{e.durationMinutes!=null && <small>{duration(e.durationMinutes)}</small>}</article>) : <p className={styles.empty}>No recorded events match this filter.</p>}</div>}</>}
      {tab==='Apps' && (apps.length ? apps.map(([app,minutes])=><div key={app} className={styles.app}><div className={styles.metric}><b>{app}</b><span>{duration(minutes)}</span></div><progress value={minutes} max={Math.max(1,...apps.map(a=>a[1]))}/></div>) : <p className={styles.empty}>No app activity recorded.</p>)}
      {tab==='Screens' && <><p>Latest 25 captures - <a href={`/screenshots?userId=${selected.id}`}>Open screenshot browser</a></p><div className={styles.screens}>{screens.map(s=><figure key={s.id} className={s.flagged?styles.flagged:undefined}>{s.thumbnail_url ? <img src={s.thumbnail_url} alt={`${s.active_app || 'Screen'} captured at ${s.captured_at}`} loading="lazy" onError={()=>setScreenState('A Cloudflare R2 preview could not be loaded.')}/> : <p>Preview unavailable</p>}<figcaption>{new Date(s.captured_at).toLocaleString()} {s.flagged&&<b>FLAGGED</b>}</figcaption></figure>)}</div>{(screenState || !screens.length) && <p className={styles.empty}>{screenState || 'No screenshots recorded.'}</p>}</>}
      {tab==='Location' && <EmployeeLocation location={config.locations.find((c:any)=>c.employee_id===selected.id)} config={config.configs.find((c:any)=>c.employee_id===selected.id)}/>}
      {tab==='Schedule' && <EmployeeSchedule key={selected.id} config={config.configs.find((c:any)=>c.employee_id===selected.id)} canEdit={config.canEditSchedule} onSave={async value=>{await mutate({action:'schedule',employeeId:selected.id,...value});await refreshConfig();}}/>}
    </div></> : <p className={styles.empty}>Select an employee to view their activity.</p>}</aside></div>
    <TimelineSettings open={settings} onClose={()=>setSettings(false)} value={preferences} onSave={persistPreferences} smtp={config.smtpConfigured}/>
    <ExportSchedule open={recurring} onClose={()=>setRecurring(false)} jobs={config.exports} onSave={async value=>{await mutate({action:'export_schedule',...value});await refreshConfig();}} onDelete={async id=>{await mutate({action:'delete_export',id});await refreshConfig();}}/>

  </section>;
}

