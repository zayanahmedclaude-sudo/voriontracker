'use client';
// app/(dashboard)/reports/page.tsx
import { useEffect, useState } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useAuthStore } from '@/store/auth';
import Link from 'next/link';
import { normalizeRole } from '@/lib/roles';
function fmt(s:number){ return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`; }

// ---- Vorion Brand Palette (kept consistent with dashboard/sidebar) ----
const BRAND = {
  black: '#0A0E1A',
  blackSoft: '#10182B',
  white: '#F5F7FA',
  blue: '#1E5AE0',
  blueSoft: 'rgba(30,90,224,.16)',
  yellow: '#F5C400',
  yellowSoft: 'rgba(245,196,0,.12)',
  border: 'rgba(245,247,250,.08)',
  muted: 'rgba(245,247,250,.5)',
  mutedFaint: 'rgba(245,247,250,.3)',
  danger: '#FF5C7A',
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: `
linear-gradient(180deg,${BRAND.black},${BRAND.blackSoft}),
radial-gradient(circle at top left,${BRAND.blueSoft} 0%,transparent 35%),
radial-gradient(circle at bottom right,${BRAND.yellowSoft} 0%,transparent 40%)
`,
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
background:'rgba(16,24,43,.75)',
backdropFilter:'blur(20px)',
WebkitBackdropFilter:'blur(20px)',
border:`1px solid ${BRAND.border}`,
borderRadius:22,
padding:'24px',
boxShadow:'0 20px 50px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.05)',
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
    background: 'rgba(16,24,43,.78)',
    backdropFilter: 'blur(10px)',
    borderRadius: 16,
    overflow: 'hidden',
    marginTop: 16,
    boxShadow: '0 8px 24px rgba(0,0,0,.22)',
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
background:'rgba(10,14,26,.95)',
border:`1px solid ${BRAND.border}`,
borderRadius:14,
backdropFilter:'blur(12px)',
color:BRAND.white,
padding:'10px 14px',
boxShadow:'0 15px 35px rgba(0,0,0,.45)',
};
function SummaryCard({
title,
value,
}:{
title:string;
value:any;
}){

return(
<div
style={{
background:'rgba(16,24,43,.75)',
backdropFilter:'blur(20px)',
border:`1px solid ${BRAND.border}`,
borderRadius:20,
padding:'20px',
boxShadow:'0 15px 40px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.05)',
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

</div>
)
}
export default function ReportsPage() {
  const { token, user } = useAuthStore();
  const role = normalizeRole(user?.role);
  const [daily,  setDaily]  = useState<any[]>([]);
  const [weekly, setWeekly] = useState<any[]>([]);

  useEffect(() => {
    if (!token) return; // wait for the real token instead of firing with null/undefined

    const date = new Date().toISOString().slice(0, 10);

    fetch(`/api/reports?type=daily&date=${date}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setDaily(Array.isArray(d?.rows) ? d.rows : []))
      .catch(() => setDaily([]));

    fetch(`/api/reports?type=weekly`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setWeekly(Array.isArray(d) ? d : []))
      .catch(() => setWeekly([]));
  }, [token]);

 const chartDaily = daily
  .sort((a, b) => (b.total_seconds || 0) - (a.total_seconds || 0))
  .slice(0, 10)
  .map(r => ({
    name: r.name.split(' ')[0],
    hours: +(r.total_seconds / 3600).toFixed(1),
    activity: Number(r.avg_activity_pct) || 0,
  }));
  const chartWeekly = weekly.map(w=>({
    day: new Date(w.day).toLocaleDateString('en',{weekday:'short'}),
    hours: +(w.total_seconds/3600).toFixed(1),
    users: w.active_users,
  }));
const avgActivity =
  chartDaily.length > 0
    ? Math.round(
        chartDaily.reduce(
          (sum, item) => sum + Number(item.activity || 0),
          0
        ) / chartDaily.length
      )
    : 0;
  const hasDaily = chartDaily.length > 0;
  const hasWeekly = chartWeekly.length > 0;

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
}}
>
  Security Report
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
value={chartDaily.reduce((a,b)=>a+b.hours,0).toFixed(1)}
/>

<SummaryCard
title="Avg Activity"
value={`${avgActivity}%`}
/>

<SummaryCard
title="Weekly Days"
value={weekly.length}
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
          <div style={styles.cardHeader}>Hours worked today</div>
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
          <div style={styles.cardHeader}>Activity level today (%)</div>
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
          <div style={styles.emptyState}>📈 Weekly analytics will appear after data is collected. — check back after a few days of activity</div>
        )}
      </div>
    </div>
  );
}
