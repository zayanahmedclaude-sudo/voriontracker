'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { type TimelinePreferences, type ScheduleDay } from '@/lib/timeline-policy';
import styles from './timeline.module.css';

export function TimelineSettings({open,onClose,value,onSave,smtp}:{open:boolean;onClose:()=>void;value:TimelinePreferences;onSave:(v:TimelinePreferences)=>Promise<void>;smtp:boolean}) {
  const dialog=useRef<HTMLDialogElement>(null),[draft,setDraft]=useState(value),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(open){setDraft(value);setError('');dialog.current?.showModal();}else dialog.current?.close();},[open,value]);
  const number=(key:'threshold'|'offlineMinutes'|'missedMinutes',label:string)=><label>{label}<input required type="number" min={1} max={240} value={draft[key]} onChange={e=>setDraft({...draft,[key]:Number(e.target.value)})}/></label>;
  return <dialog ref={dialog} className={styles.dialog} onCancel={onClose}><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await onSave(draft);onClose();}catch(e:any){setError(e.message);}finally{setBusy(false);}}}><h3>Alert settings</h3>
    {number('threshold','Idle threshold (minutes)')}{number('offlineMinutes','Offline detection (minutes)')}{number('missedMinutes','Missed check-in grace (minutes)')}
    <label>Notify via<select value={draft.channel} onChange={e=>setDraft({...draft,channel:e.target.value as any})}><option value="in-app">In-app only</option><option value="both">In-app + email</option><option value="email">Email only</option></select></label>
    {([['offlineAlerts','Alert on offline status'],['missedAlerts','Alert on missed check-in'],['weeklyEmail','Weekly summary email']] as const).map(([k,label])=><label key={k}><input type="checkbox" checked={draft[k]} onChange={e=>setDraft({...draft,[k]:e.target.checked})}/> {label}</label>)}
    {!smtp&&<p>Email delivery is not configured on this server. In-app settings can still be saved.</p>}
    <p>Attendance alerts use assigned schedules. Settings and saved views follow your account across browsers.</p>
    <p>Early checkout is rejected until the assigned shift ends. All attempts before shift end are flagged. Screenshots: 14 days; timeline events and notifications: 90 days.</p>
    {error&&<p role="alert">{error}</p>}<div className={styles.actions}><button disabled={busy}>{busy?'Saving...':'Save settings'}</button><button type="button" onClick={onClose}>Cancel</button></div>
  </form></dialog>;
}

export function ExportSchedule({open,onClose,jobs,onSave,onDelete}:{open:boolean;onClose:()=>void;jobs:any[];onSave:(v:any)=>Promise<void>;onDelete:(id:string)=>Promise<void>}) {
  const dialog=useRef<HTMLDialogElement>(null),[frequency,setFrequency]=useState('weekly'),[format,setFormat]=useState('pdf'),[recipient,setRecipient]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close();},[open]);
  return <dialog ref={dialog} className={styles.dialog} onCancel={onClose}><h3>Recurring exports</h3><form onSubmit={async e=>{e.preventDefault();setBusy(true);try{await onSave({frequency,format,recipient});setRecipient('');setError('');}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>
    <label>Frequency<select value={frequency} onChange={e=>setFrequency(e.target.value)}>{['daily','weekly','monthly'].map(v=><option key={v}>{v}</option>)}</select></label>
    <label>Format<select value={format} onChange={e=>setFormat(e.target.value)}><option value="pdf">PDF summary</option><option value="csv">CSV</option></select></label>
    <label>Recipient email<input required type="email" value={recipient} onChange={e=>setRecipient(e.target.value)}/></label><button disabled={busy}>Schedule export</button>
  </form>{error&&<p role="alert">{error}</p>}<div className={styles.events}>{jobs.map(j=><article key={j.id}><b>{j.frequency} - {j.format.toUpperCase()}</b><p>{j.recipient}</p><small>Next: {new Date(j.next_run).toLocaleString()}</small>{j.last_error&&<p role="alert">Last delivery failed: {j.last_error}</p>}<button onClick={()=>onDelete(j.id).catch(e=>setError(e.message))}>Remove schedule</button></article>)}</div><button onClick={onClose}>Close</button></dialog>;
}

export function EmployeeSchedule({config,canEdit,onSave}:{config:any;canEdit:boolean;onSave:(v:any)=>Promise<void>}) {
  const defaults=useMemo<ScheduleDay[]>(()=>Array.from({length:7},(_,i)=>({day:(i+1)%7,start:'16:00',end:'07:00',off:i>=5})),[]);
  const [editing,setEditing]=useState(false),[days,setDays]=useState<ScheduleDay[]>(config?.schedule?.length?config.schedule:defaults),[fence,setFence]=useState(config?.geofence||{latitude:0,longitude:0,radius:100}),[fenceEnabled,setFenceEnabled]=useState(!!config?.geofence),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const configFingerprint=JSON.stringify({schedule:config?.schedule||null,geofence:config?.geofence||null});
  useEffect(()=>{if(editing)return;setDays(config?.schedule?.length?config.schedule:defaults);setFence(config?.geofence||{latitude:0,longitude:0,radius:100});setFenceEnabled(!!config?.geofence);},[configFingerprint,defaults,editing,config?.schedule,config?.geofence]);
  const cancel=()=>{setDays(config?.schedule?.length?config.schedule:defaults);setFence(config?.geofence||{latitude:0,longitude:0,radius:100});setFenceEnabled(!!config?.geofence);setError('');setEditing(false);};
  return <><p>Weekly schedule - Asia/Karachi</p>{!config?.schedule?.length&&!editing?<p>No schedule assigned.</p>:<div className={styles.weekGrid}>{days.map((day,i)=><div key={day.day}><b>{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day.day]}</b>{editing?<><label><input type="checkbox" checked={day.off} onChange={e=>setDays(days.map((d,j)=>j===i?{...d,off:e.target.checked}:d))}/> Off</label>{!day.off&&<><input aria-label={`${day.day} shift start`} type="time" value={day.start} onChange={e=>setDays(days.map((d,j)=>j===i?{...d,start:e.target.value}:d))}/><input aria-label={`${day.day} shift end`} type="time" value={day.end} onChange={e=>setDays(days.map((d,j)=>j===i?{...d,end:e.target.value}:d))}/></>}</>:<span>{day.off?'Off':`${day.start}-${day.end}`}</span>}</div>)}</div>}
  {editing&&<><label><input type="checkbox" checked={fenceEnabled} onChange={e=>setFenceEnabled(e.target.checked)}/> Assigned geofence</label>{fenceEnabled&&(['latitude','longitude','radius'] as const).map(k=><label key={k}>{k}{k==='radius'?' (meters)':''}<input type="number" step="any" value={fence[k]} onChange={e=>setFence({...fence,[k]:Number(e.target.value)})}/></label>)}</>}
  {error&&<p role="alert">{error}</p>}{canEdit&&<div className={styles.actions}>{editing?<><button disabled={busy} onClick={async()=>{setBusy(true);try{await onSave({schedule:days,geofence:fenceEnabled?fence:null});setEditing(false);setError('');}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>Save schedule</button><button onClick={cancel}>Cancel</button></>:<button onClick={()=>setEditing(true)}>Edit schedule & geofence</button>}</div>}</>;
}

export function EmployeeLocation({location,config}:{location:any;config:any}) {
  if(!location)return <p className={styles.empty}>No location received from this employee's device. The next check-in will request device location.</p>;
  const fence=config?.geofence;
  const x=fence?Math.max(15,Math.min(285,150+(location.longitude-fence.longitude)*111320*Math.cos(fence.latitude*Math.PI/180)/fence.radius*75)):150;
  const y=fence?Math.max(15,Math.min(185,100-(location.latitude-fence.latitude)*111320/fence.radius*75)):100;
  return <><svg viewBox="0 0 300 200" className={styles.geoMap} role="img" aria-label="Location relative to assigned geofence"><path d="M0 50H300M0 100H300M0 150H300M75 0V200M150 0V200M225 0V200" stroke="currentColor" opacity=".15"/>{fence&&<circle cx="150" cy="100" r="75" fill="none" stroke="#5886db" strokeDasharray="5 4"/>}<circle cx={x} cy={y} r="7" fill={location.within_bounds===false?'#e65363':'#22a579'}/></svg><p>{location.label}</p><p>{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)} - +/-{Math.round(location.accuracy)}m</p><b>{!fence?'No geofence assigned':location.within_bounds===true?'Within bounds':location.within_bounds===false?'Outside bounds':'Boundary uncertain'}</b><p>Last update: {new Date(location.captured_at).toLocaleString()}</p></>;
}
