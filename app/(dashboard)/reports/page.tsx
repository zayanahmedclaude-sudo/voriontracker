'use client';

import { apiFetch } from '@/lib/api-client';
// app/(dashboard)/reports/page.tsx
import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useAuthStore } from '@/store/auth';
import Link from 'next/link';
import { normalizeRole } from '@/lib/roles';
import { ShieldAlert } from 'lucide-react';
function fmt(s:number){ return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`; }

// ---- Vorion Brand Palette (kept consistent with dashboard/sidebar) ----
const BRAND = {
  black: '#0A0A0A',
  blackSoft: '#F7F8FB',
  white: '#0A0A0A',
  blue: '#0050B0',
  blueSoft: 'rgba(0,80,176,.08)',
  yellow: '#B54708',
  yellowSoft: 'rgba(181,71,8,.10)',
  border: 'rgba(10,10,10,.10)',
  muted: 'rgba(10,10,10,.58)',
  mutedFaint: 'rgba(10,10,10,.38)',
  danger: '#B42318',
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: BRAND.blackSoft,
    color: BRAND.white,
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
    padding: '28px 32px',
  },
  heading: {
    fontSize: 28,
    fontWeight: 700,
    marginBottom: 24,
    color: BRAND.white,
    letterSpacing: '-0.01em',
  },
  cardHeader:{
fontSize:15,
fontWeight:700,
marginBottom:20,
color:BRAND.white,
letterSpacing:'.02em',
},
  card:{
background:'#FFFFFF',
border:`1px solid ${BRAND.border}`,
borderRadius:22,
padding:'24px',
boxShadow:'0 18px 48px rgba(15,23,42,.06)',
transition:'all .25s ease',
},
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 16,
    marginBottom: 16,
  },
  tableCard: {
    border: `1px solid ${BRAND.border}`,
    background: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    marginTop: 16,
    boxShadow: '0 18px 48px rgba(15,23,42,.06)',
  },
  tableHeader: {
    padding: '14px 16px',
    borderBottom: `1px solid ${BRAND.border}`,
    fontSize: 14,
    fontWeight: 600,
    color: BRAND.white,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
  },
  th: {
    padding: '9px 16px',
    textAlign: 'left',
    fontWeight: 500,
    color: BRAND.mutedFaint,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    borderBottom: `1px solid ${BRAND.border}`,
  },
  td: {
    padding: '9px 16px',
    color: BRAND.white,
  },
  emptyState: {
    height: 200,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: BRAND.mutedFaint,
    fontSize: 13,
  },
};

const axisTickStyle = { fontSize: 12, fill: BRAND.muted, fontWeight: 500 };

const tooltipStyle={
background:'#FFFFFF',
border:`1px solid ${BRAND.border}`,
borderRadius:14,
color:BRAND.white,
padding:'10px 14px',
boxShadow:'0 18px 48px rgba(15,23,42,.08)',
};
function SummaryCard({
title,
value,
subtext,
}:{
title:string;
value:any;
subtext?: string;
}){

return(
<div
style={{
background:'#FFFFFF',
border:`1px solid ${BRAND.border}`,
borderRadius:20,
padding:'20px',
boxShadow:'0 18px 48px rgba(15,23,42,.06)',
}}
>

<div
style={{
fontSize:12,
color:BRAND.muted,
textTransform:'uppercase',
}}
>
{title}
</div>

<div
style={{
marginTop:10,
fontSize:30,
fontWeight:800,
background:`linear-gradient(90deg,${BRAND.blue},${BRAND.yellow})`,
WebkitBackgroundClip:'text',
color:'transparent',
}}
>
{value}
</div>
{subtext && <div style={{ marginTop: 6, fontSize: 11, color: BRAND.muted }}>{subtext}</div>}

</div>
)
}
export default function ReportsPage() {
  const { token, user } = useAuthStore();
  const role = normalizeRole(user?.role);
  const [daily,  setDaily]  = useState<any[]>([]);
  const [weekly, setWeekly] = useState<any[]>([]);
  const [chartPage, setChartPage] = useState(0);
  const [chartSort, setChartSort] = useState<'hours' | 'activity' | 'name'>('hours');
  const reportDate = useMemo(() => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()), []);

  useEffect(() => {
    if (!token) return; // wait for the real token instead of firing with null/undefined

    apiFetch<Response>(`/api/reports?type=daily&date=${reportDate}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setDaily(Array.isArray(d?.rows) ? d.rows : []))
      .catch(() => setDaily([]));

    apiFetch<Response>(`/api/reports?type=weekly`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setWeekly(Array.isArray(d) ? d : []))
      .catch(() => setWeekly([]));
  }, [token, reportDate]);

 const allChartDaily = [...daily]
  .map(r => ({
    name: r.name || 'Unknown',
    hours: +(r.total_seconds / 3600).toFixed(1),
    activity: Number(r.avg_activity_pct) || 0,
  }))
  .sort((a, b) => chartSort === 'name'
    ? a.name.localeCompare(b.name)
    : chartSort === 'activity' ? b.activity - a.activity : b.hours - a.hours);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(allChartDaily.length / pageSize));
  const safeChartPage = Math.min(chartPage, pageCount - 1);
  const chartDaily = allChartDaily.slice(safeChartPage * pageSize, (safeChartPage + 1) * pageSize);
  const chartWeekly = weekly.map(w=>({
    day: new Date(w.day).toLocaleDateString('en',{weekday:'short'}),
    hours: +(w.total_seconds/3600).toFixed(1),
    users: w.active_users,
  }));
const avgActivity =
  allChartDaily.length > 0
    ? Math.round(
        allChartDaily.reduce(
          (sum, item) => sum + Number(item.activity || 0),
          0
        ) / allChartDaily.length
      )
    : 0;
  const hasDaily = allChartDaily.length > 0;
  const meaningfulWeeklyDays = chartWeekly.filter(day => day.hours > 0 || Number(day.users) > 0).length;
  const hasWeekly = meaningfulWeeklyDays > 0;
  const dateLabel = new Date(`${reportDate}T12:00:00+05:00`).toLocaleDateString('en-US', { dateStyle: 'medium' });

  return (
    <div style={styles.page}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1
style={{
    fontSize:34,
    fontWeight:800,
    margin:0,
    color:BRAND.white,
}}
>
📊 Reports & Analytics
</h1>
        {role !== 'hr' && (
        <Link
href="/reports/security"
style={{
padding:'10px 18px',
borderRadius:14,
background:'rgba(245,247,250,.05)',
border:`1px solid ${BRAND.border}`,
backdropFilter:'blur(12px)',
color:BRAND.white,
fontWeight:600,
fontSize:13,
textDecoration:'none',
transition:'all .2s ease',
display:'inline-flex',
alignItems:'center',
gap:8,
}}
>
  <ShieldAlert size={16}/> Security events
</Link>
        )}
      </div>
<div
style={{
display:'grid',
gridTemplateColumns:'repeat(4,1fr)',
gap:18,
marginBottom:22,
}}
>

<SummaryCard
title="Employees"
value={daily.length}
/>

<SummaryCard
title="Hours"
value={allChartDaily.reduce((a,b)=>a+b.hours,0).toFixed(1)}
subtext={`All employees · ${dateLabel}`}
/>

<SummaryCard
title="Avg Activity"
value={`${avgActivity}%`}
subtext="Average across all employees"
/>

<SummaryCard
title="Days With Activity"
value={meaningfulWeeklyDays}
subtext="Current week"
/>

</div>
      <div style={styles.grid}>
        {/* Hours today bar chart */}
        <div
style={styles.card}
onMouseEnter={(e)=>{
e.currentTarget.style.transform='translateY(-6px)';
e.currentTarget.style.boxShadow='0 28px 60px rgba(0,0,0,.45)';
e.currentTarget.style.borderColor=`${BRAND.blue}40`;
}}
onMouseLeave={(e)=>{
e.currentTarget.style.transform='translateY(0)';
e.currentTarget.style.boxShadow='0 20px 50px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.05)';
e.currentTarget.style.borderColor=BRAND.border;
}}
>
          <div style={styles.cardHeader}>Hours worked · {dateLabel}</div>
          {hasDaily ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartDaily} margin={{ top:8, right:8, left:-20, bottom:0 }}>
                <defs>
                  <linearGradient id="hoursGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={BRAND.blue}/>
                    <stop offset="100%" stopColor="#4C8CFF"/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="4 4" stroke={BRAND.border} vertical={false} />
                <XAxis dataKey="name" tick={axisTickStyle} axisLine={false} tickLine={false}/>
                <YAxis tick={axisTickStyle} axisLine={false} tickLine={false}/>
                <Tooltip formatter={(v:any)=>`${v}h`} contentStyle={tooltipStyle} cursor={{ fill: 'rgba(245,247,250,.04)' }}/>
                <Bar dataKey="hours" fill="url(#hoursGradient)" radius={[6,6,0,0]} maxBarSize={48}/>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={styles.emptyState}>📊 No activity recorded yet today</div>
          )}
        </div>

        {/* Activity % bar chart */}
        <div
style={styles.card}
onMouseEnter={(e)=>{
e.currentTarget.style.transform='translateY(-6px)';
e.currentTarget.style.boxShadow='0 28px 60px rgba(0,0,0,.45)';
e.currentTarget.style.borderColor=`${BRAND.yellow}40`;
}}
onMouseLeave={(e)=>{
e.currentTarget.style.transform='translateY(0)';
e.currentTarget.style.boxShadow='0 20px 50px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.05)';
e.currentTarget.style.borderColor=BRAND.border;
}}
>
          <div style={styles.cardHeader}>Activity level · {dateLabel} (%)</div>
          {hasDaily ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartDaily} margin={{ top:8, right:8, left:-20, bottom:0 }}>
                <defs>
                  <linearGradient id="activityGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={BRAND.yellow}/>
                    <stop offset="100%" stopColor="#FFE066"/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="4 4" stroke={BRAND.border} vertical={false} />
                <XAxis dataKey="name" tick={axisTickStyle} axisLine={false} tickLine={false}/>
                <YAxis tick={axisTickStyle} axisLine={false} tickLine={false} domain={[0,100]}/>
                <Tooltip formatter={(v:any)=>`${v}%`} contentStyle={tooltipStyle} cursor={{ fill: 'rgba(245,247,250,.04)' }}/>
                <Bar dataKey="activity" fill="url(#activityGradient)" radius={[6,6,0,0]} maxBarSize={48}/>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={styles.emptyState}>No activity recorded yet today</div>
          )}
        </div>
      </div>

      {hasDaily && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '-2px 0 18px', color: BRAND.muted, fontSize: 12 }}>
          <span>Showing {safeChartPage * pageSize + 1}–{Math.min((safeChartPage + 1) * pageSize, allChartDaily.length)} of {allChartDaily.length} employees</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label htmlFor="report-sort">Sort by</label>
            <select id="report-sort" value={chartSort} onChange={event => { setChartSort(event.target.value as typeof chartSort); setChartPage(0); }} style={{ padding: '7px 9px', borderRadius: 9, border: `1px solid ${BRAND.border}`, background: '#fff' }}>
              <option value="hours">Most hours</option><option value="activity">Highest activity</option><option value="name">Employee name</option>
            </select>
            <button disabled={safeChartPage === 0} onClick={() => setChartPage(page => Math.max(0, page - 1))}>Previous</button>
            <button disabled={safeChartPage >= pageCount - 1} onClick={() => setChartPage(page => Math.min(pageCount - 1, page + 1))}>Next</button>
          </div>
        </div>
      )}

      {/* Weekly trend line chart */}
      <div
style={styles.card}
onMouseEnter={(e)=>{
e.currentTarget.style.transform='translateY(-6px)';
e.currentTarget.style.boxShadow='0 28px 60px rgba(0,0,0,.45)';
e.currentTarget.style.borderColor=`${BRAND.blue}40`;
}}
onMouseLeave={(e)=>{
e.currentTarget.style.transform='translateY(0)';
e.currentTarget.style.boxShadow='0 20px 50px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.05)';
e.currentTarget.style.borderColor=BRAND.border;
}}
>
        <div style={styles.cardHeader}>Weekly trend — hours logged per day</div>
        {hasWeekly ? (
          <>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={chartWeekly} margin={{ top:8, right:8, left:-20, bottom:0 }}>
                <CartesianGrid strokeDasharray="4 4" stroke={BRAND.border} vertical={false} />
                <XAxis dataKey="day" tick={axisTickStyle} axisLine={false} tickLine={false}/>
                <YAxis tick={axisTickStyle} axisLine={false} tickLine={false}/>
                <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: 'rgba(245,247,250,.15)' }}/>
                <Line type="monotone" dataKey="hours" stroke={BRAND.blue} strokeWidth={4} dot={{
fill:BRAND.blue,
r:6,
stroke:BRAND.white,
strokeWidth:2
}} activeDot={{ r: 6 }}/>
                <Line type="monotone" dataKey="users" stroke={BRAND.yellow} strokeWidth={4} dot={{
fill:BRAND.yellow,
r:6,
stroke:BRAND.white,
strokeWidth:2
}} activeDot={{ r: 6 }}/>
              </LineChart>
            </ResponsiveContainer>
            <div style={{ display:'flex',
gap:28,
marginTop:20,
justifyContent:'center', }}>
              <span style={{ fontSize:12, color: BRAND.muted, display:'flex', alignItems:'center', gap:6 }}>
                <span style={{ width:10, height:10, borderRadius:'50%', background: BRAND.blue, display:'inline-block' }}/> Hours
              </span>
              <span style={{ fontSize:12, color: BRAND.muted, display:'flex', alignItems:'center', gap:6 }}>
                <span style={{ width:10, height:10, borderRadius:'50%', background: BRAND.yellow, display:'inline-block' }}/> Active users
              </span>
            </div>
          </>
        ) : (
          <div style={{ ...styles.emptyState, height: 92 }}>Weekly analytics will appear after work activity is recorded.</div>
        )}
      </div>
    </div>
  );
}
