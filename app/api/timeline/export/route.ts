import { NextRequest } from 'next/server';
import { requireAuth, err } from '@/lib/api';
import { makeTimelineExport } from '@/lib/timeline-export';
import { visibleEmployeeIds } from '@/lib/timeline-service';
export async function GET(req: NextRequest) {
  const user=requireAuth(req); if('status' in user)return user;
  const p=req.nextUrl.searchParams, start=p.get('start')||'',end=p.get('end')||start,format=p.get('format')||'csv';
  const valid=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
  if(!valid(start)||!valid(end)||end<start||(Date.parse(end)-Date.parse(start))/86400000>30||!['csv','pdf'].includes(format))return err('Invalid export range (maximum 31 days)');
  try {
    const allowed=await visibleEmployeeIds(user), selected=p.get('ids')?.split(',');
    if(selected?.some(id=>!allowed.includes(id)))return err('Forbidden',403);
    const content=await makeTimelineExport(user,start,end,format,selected);
    return new Response(new Uint8Array(content),{headers:{'Content-Type':format==='pdf'?'application/pdf':'text/csv;charset=utf-8','Content-Disposition':`attachment; filename="timeline-${start}-${end}.${format}"`,'Cache-Control':'no-store'}});
  }catch(e:any){console.error('Timeline export failed',e.message);return err('Unable to generate export',500);}
}
