import { activityMinutes, csvCell } from './timeline-view';
import { getDailyReportData } from './reports-handler';
import { isAgentTrackedRole, normalizeRole } from './roles';
import { addDays } from './shifts';
import type { TokenPayload } from './auth';

export function summaryPdf(lines: string[]) {
  const objects: string[] = [];
  const pages: number[] = [];
  objects.push(''); objects.push('');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let offset=0; offset<lines.length; offset+=46) {
    const pageId=objects.length+1, streamId=pageId+1; pages.push(pageId);
    const escape=(s:string)=>s.replace(/[^\x20-\x7e]/g,'?').replace(/([\\()])/g,'\\$1');
    const stream=`BT /F1 10 Tf 42 795 Td 15 TL\n${lines.slice(offset,offset+46).map((line,i)=>`${i?'T* ':''}(${escape(line)}) Tj`).join('\n')}\nET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[0]='<< /Type /Catalog /Pages 2 0 R >>';
  objects[1]=`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map(n=>`${n} 0 R`).join(' ')}] >>`;
  let output='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(output);
  output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}
export async function makeTimelineExport(user: TokenPayload, start: string, end: string, format: string, selected?: string[]) {
  const records: any[]=[];
  for(let date=start;date<=end;date=addDays(date,1)) {
    const report=await getDailyReportData(date,{userSub:user.sub,isEmployee:isAgentTrackedRole(normalizeRole(user.role)),isClient:user.role==='client'});
    for(const row of report.rows) if(!selected?.length || selected.includes(row.id)) {
      const totals=activityMinutes(row.segments || []);
      const attendance = (row.audit || []).filter((e:any)=>e.kind==='attendance');
      const firstIn = attendance.find((e:any)=>e.label==='Checked in')?.at;
      const lastOut = attendance.filter((e:any)=>e.label==='Checked out').at(-1)?.at;
      const localTime = (value?: string) => value ? new Date(value).toLocaleString('en-GB', {timeZone:'Asia/Karachi',hour12:false}) : '';
      const recordedStatus = (row.logs || []).some((log:any)=>log.type==='attendance') ? 'Attendance recorded' : 'No attendance';
      records.push([date,row.name,recordedStatus,Math.round(totals.work),Math.round(totals.idle),Math.round(totals.break),totals.work+totals.idle?Math.round(totals.work/(totals.work+totals.idle)*100):'',(row.audit||[]).filter((e:any)=>e.flagged).length,localTime(firstIn),localTime(lastOut)]);
    }
  }
  const headers=['Shift date','Employee','Attendance','Work min','Idle min','Break min','Productivity %','Flagged','First check-in (Asia/Karachi)','Last check-out (Asia/Karachi)'];
  if(format==='csv') return Buffer.from('\ufeff'+[headers,...records].map(r=>r.map(csvCell).join(',')).join('\r\n'));
  const lines=[`VORION | Employee timeline summary`,`${start} to ${end} | Asia/Karachi | 4PM-7AM | Target: 9 hours`,'', 'Work, idle and break durations are recorded minutes.',''];
  for(const r of records) lines.push(`${r[0]} | ${r[1]}`.slice(0,95),`Status: ${r[2]} | Work: ${r[3]}m | Idle: ${r[4]}m | Break: ${r[5]}m`,`Productivity: ${r[6]===''?'No data':`${r[6]}%`} | Flagged events: ${r[7]}`,'');
  return summaryPdf(lines);
}
