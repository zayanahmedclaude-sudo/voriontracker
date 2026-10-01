'use client';
import { apiFetch } from '@/lib/api-client';
import { useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '@/store/auth';
import { useRouter } from 'next/navigation';

const S: Record<string, React.CSSProperties> = {
  page:{minHeight:'100vh',background:'#F7F8FB',color:'#0A0A0A',padding:'28px 32px'}, card:{border:'1px solid rgba(10,10,10,.1)',background:'#FFF',borderRadius:16,padding:'18px 20px',boxShadow:'0 18px 48px rgba(15,23,42,.06)'}, input:{padding:'8px 10px',borderRadius:10,border:'1px solid rgba(10,10,10,.14)',background:'#FFF',color:'#0A0A0A'}, button:{padding:'9px 14px',borderRadius:10,border:0,background:'#0050B0',color:'#FFF',fontWeight:700,cursor:'pointer'}, table:{width:'100%',borderCollapse:'collapse'}, th:{padding:'10px 12px',textAlign:'left',color:'rgba(10,10,10,.48)',fontSize:11,textTransform:'uppercase',borderBottom:'1px solid #eee'}, td:{padding:12,borderBottom:'1px solid #eee',verticalAlign:'top',fontSize:13}
};
const PAGE_SIZE = 50;
const EXPORT_PAGE_SIZE = 200;
const EXPORT_MAX_PAGES = 50;
const LABELS:Record<string,string>={large_transfer_threshold:'Large transfer',mass_download_detected:'Mass download',mass_copy_to_usb_detected:'Mass USB copy',external_upload_detected:'External upload','Blocked Website':'Blocked website','Blocked App':'Blocked application'};
function threshold(type:string){if(type==='large_transfer_threshold')return [100,'MB'];if(type==='mass_download_detected')return [40,'files'];if(type==='mass_copy_to_usb_detected')return [25,'files'];return null;}
function severity(e:any){const t=threshold(e.eventType),n=parseFloat(String(e.value||''));if(!t||!Number.isFinite(n))return e.eventType==='external_upload_detected'?3:1;const ratio=n/Number(t[0]);return ratio>=5?3:ratio>=2?2:1;}
function groupEvents(events:any[]){const m=new Map<string,any>();for(const e of events){const key=`${e.employeeId||e.employeeName}|${e.eventType}|${Math.floor(new Date(e.createdAt).getTime()/300000)}`,old=m.get(key),sev=severity(e);if(!old)m.set(key,{...e,count:1,severity:sev});else{old.count++;if(sev>old.severity)Object.assign(old,e,{count:old.count,severity:sev});}}return [...m.values()].sort((a,b)=>b.severity-a.severity||+new Date(b.createdAt)-+new Date(a.createdAt));}
function toRow(e:any){return [e.employeeName||e.employeeId||'',new Date(e.createdAt).toLocaleString(),e.eventType,e.value||'',e.count,e.actionTaken||''];}
function escapeHtml(value:string){return value.replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] as string));}

type Filters = { employeeId: string; eventType: string };

export default function SecurityReportPage(){
  const {token}=useAuthStore(),router=useRouter();
  const [events,setEvents]=useState<any[]>([]),[users,setUsers]=useState<any[]>([]),[employeeId,setEmployeeId]=useState(''),[eventType,setEventType]=useState(''),[applied,setApplied]=useState<Filters>({employeeId:'',eventType:''});
  const [page,setPage]=useState(1),[total,setTotal]=useState(0),[loading,setLoading]=useState(false),[exporting,setExporting]=useState(false),[error,setError]=useState('');
  const pageCount=Math.max(1,Math.ceil(total/PAGE_SIZE));
  useEffect(()=>{if(token)apiFetch<Response>('/api/users',{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json()).then(d=>setUsers(Array.isArray(d)?d:[]));},[token]);

  async function fetchPage(filters:Filters,pageNumber:number,size:number){
    const p=new URLSearchParams({page:String(pageNumber),pageSize:String(size)});
    if(filters.employeeId)p.set('employeeId',filters.employeeId);
    if(filters.eventType)p.set('eventType',filters.eventType);
    const r=await apiFetch<Response>(`/api/security-events?${p}`,{headers:{Authorization:`Bearer ${token}`}});
    if(!r.ok)throw new Error(`Failed to load security events (${r.status})`);
    const d=await r.json();
    return {events:Array.isArray(d?.events)?d.events:[],total:Number(d?.total)||0};
  }
  async function load(filters:Filters,pageNumber:number){
    if(!token)return;
    setLoading(true);
    try{const d=await fetchPage(filters,pageNumber,PAGE_SIZE);setEvents(d.events);setTotal(d.total);setPage(pageNumber);setApplied(filters);setError('');}
    catch(e){console.error(e);setError('Unable to load security events. Please retry.');}
    finally{setLoading(false);}
  }
  useEffect(()=>{void load(applied,1);},[token]);

  // Exports cover every filtered event, not just the page on screen.
  async function exportRows(){
    setExporting(true);
    try{
      const all:any[]=[];
      for(let n=1;n<=EXPORT_MAX_PAGES;n++){const d=await fetchPage(applied,n,EXPORT_PAGE_SIZE);all.push(...d.events);if(all.length>=d.total||!d.events.length)break;}
      return groupEvents(all).map(toRow);
    }finally{setExporting(false);}
  }
  async function csv(){const all=await exportRows();const data=[['Employee','Time','Event Type','Value','Occurrences','Status'],...all].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'),url=URL.createObjectURL(new Blob([data],{type:'text/csv'})),a=document.createElement('a');a.href=url;a.download='security-report-filtered.csv';a.click();URL.revokeObjectURL(url);}
  async function pdf(){const w=window.open('','_blank','width=900,height=800');if(!w)return;w.document.write('<p>Preparing report…</p>');const all=await exportRows();w.document.open();w.document.write(`<h2>Security Report — filtered results</h2><table border="1" cellspacing="0" cellpadding="6">${all.map(r=>`<tr>${r.map(v=>`<td>${escapeHtml(String(v))}</td>`).join('')}</tr>`).join('')}</table>`);w.document.close();w.print();}

  const types=useMemo(()=>Array.from(new Set(['large_transfer_threshold','mass_download_detected','mass_copy_to_usb_detected','external_upload_detected',...events.map(e=>e.eventType).filter(Boolean)])),[events]);
  const grouped=useMemo(()=>groupEvents(events),[events]);
  const person=users.find(u=>u.id===applied.employeeId)?.name;
  const first=total?(page-1)*PAGE_SIZE+1:0,last=Math.min(page*PAGE_SIZE,total);
  const pager=<Pager page={page} pageCount={pageCount} first={first} last={last} total={total} loading={loading} onPage={n=>load(applied,n)}/>;

  return <div style={S.page}><button style={S.button} onClick={()=>router.back()}>← Back to Reports</button><h1>Security Report</h1><p style={{color:'#667085'}}>Prioritized security events. Repeated events within five minutes are grouped.</p><div style={S.card}>
    <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}><select style={S.input} value={employeeId} onChange={e=>setEmployeeId(e.target.value)}><option value="">All employees</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select><select style={S.input} value={eventType} onChange={e=>setEventType(e.target.value)}><option value="">All event types</option>{types.map(t=><option key={t} value={t}>{LABELS[t]||t.replaceAll('_',' ')}</option>)}</select><button style={S.button} onClick={()=>load({employeeId,eventType},1)}>Apply filters</button><button style={{...S.button,opacity:exporting||!total?.5:1}} disabled={exporting||!total} onClick={csv}>Export CSV</button><button style={{...S.button,opacity:exporting||!total?.5:1}} disabled={exporting||!total} onClick={pdf}>Export PDF</button>{exporting&&<span style={{fontSize:12,color:'#667085'}}>Preparing export…</span>}</div>
    <p style={{fontSize:12,color:'#667085'}}>Active filters: {person||'All employees'} · {LABELS[applied.eventType]||applied.eventType.replaceAll('_',' ')||'All event types'} · Exports contain all filtered, grouped results.</p>
    {error&&<p role="alert" style={{color:'#B42318',fontSize:13}}>{error}</p>}
    {pager}
    <div style={{overflowX:'auto',opacity:loading?.55:1}}><table style={S.table}><thead><tr><th style={S.th}>Priority</th><th style={S.th}>Employee</th><th style={S.th}>Latest event</th><th style={S.th}>Event type</th><th style={S.th}>Value / threshold</th><th style={S.th}>Status</th></tr></thead><tbody>{grouped.map(e=>{const t=threshold(e.eventType),color=e.severity===3?['#FEE4E2','#B42318']:e.severity===2?['#FEF0C7','#B54708']:['#E8F1FF','#0050B0'];return <tr key={`${e.id}-${e.count}`}><td style={S.td}><span style={{background:color[0],color:color[1],borderRadius:99,padding:'4px 8px',fontWeight:700}}>{e.severity===3?'High':e.severity===2?'Medium':'Review'}</span></td><td style={{...S.td,fontWeight:650}}>{e.employeeName||e.employeeId||'—'}</td><td style={S.td}>{new Date(e.createdAt).toLocaleString()}{e.count>1&&<div style={{color:'#B54708',fontWeight:700}}>{e.count} similar events</div>}</td><td style={S.td}>{LABELS[e.eventType]||e.eventType.replaceAll('_',' ')}</td><td style={S.td}><strong>{e.value||'—'}</strong>{t&&<div style={{color:'#667085'}}>Trigger: {t[0]} {t[1]}</div>}</td><td style={S.td}>{String(e.actionTaken||'Pending review').replaceAll('_',' ')}</td></tr>;})}{!grouped.length&&<tr><td style={{...S.td,textAlign:'center',padding:36}} colSpan={6}>{loading?'Loading security events…':'No security events match these filters.'}</td></tr>}</tbody></table></div>
    {total>PAGE_SIZE&&pager}
  </div></div>;
}

function Pager({page,pageCount,first,last,total,loading,onPage}:{page:number;pageCount:number;first:number;last:number;total:number;loading:boolean;onPage:(n:number)=>void}){
  const atStart=loading||page<=1,atEnd=loading||page>=pageCount;
  const btn=(disabled:boolean):React.CSSProperties=>({...S.input,cursor:disabled?'not-allowed':'pointer',opacity:disabled?.45:1});
  return <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap',margin:'12px 0',fontSize:12,color:'#667085'}}>
    <span>{total?`Showing ${first}–${last} of ${total.toLocaleString()} events`:'No events'}</span>
    <div style={{display:'flex',gap:6,alignItems:'center'}}>
      <button style={btn(atStart)} disabled={atStart} onClick={()=>onPage(1)}>« First</button>
      <button style={btn(atStart)} disabled={atStart} onClick={()=>onPage(page-1)}>‹ Previous</button>
      <span style={{padding:'0 6px',color:'#0A0A0A',fontWeight:600}}>Page {page} of {pageCount}</span>
      <button style={btn(atEnd)} disabled={atEnd} onClick={()=>onPage(page+1)}>Next ›</button>
      <button style={btn(atEnd)} disabled={atEnd} onClick={()=>onPage(pageCount)}>Last »</button>
    </div>
  </div>;
}
