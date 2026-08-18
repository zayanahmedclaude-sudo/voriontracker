'use client';

import { apiFetch } from '@/lib/api-client';
import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/auth';
import { useRouter } from 'next/navigation';
const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#F7F8FB', color: '#0A0A0A', fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif', padding: '28px 32px' },
  card: { border: '1px solid rgba(10,10,10,.10)', background: '#FFFFFF', borderRadius: 16, padding: '18px 20px', boxShadow: '0 18px 48px rgba(15,23,42,.06)', marginBottom: 16 },
  header: { fontSize: 20, fontWeight: 700, marginBottom: 8 },
  sub: { fontSize: 13, color: 'rgba(10,10,10,.45)', marginBottom: 12 },
  input: { padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(10,10,10,.10)', background: '#FFFFFF', color: '#0A0A0A', fontSize: 13 },
  button: { padding: '9px 14px', borderRadius: 10, border: '1px solid rgba(0,80,176,.24)', background: '#0050B0', color: '#FFFFFF', fontWeight: 700, cursor: 'pointer' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th: { padding: '10px 12px', textAlign: 'left' as const, color: 'rgba(10,10,10,.45)', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.06em', borderBottom: '1px solid rgba(10,10,10,.08)' },
  td: { padding: '10px 12px', borderBottom: '1px solid rgba(10,10,10,.06)' },
};

export default function SecurityReportPage() {
  const { token } = useAuthStore();
  const [events, setEvents] = useState<any[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [eventType, setEventType] = useState('');
  const [users, setUsers] = useState<any[]>([]);

  useEffect(() => {
    if (!token) return;
    apiFetch<Response>('/api/users', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).then(d => setUsers(Array.isArray(d) ? d : []));
  }, [token]);

  const loadEvents = async () => {
    if (!token) return;
    const params = new URLSearchParams();
    if (employeeId) params.set('employeeId', employeeId);
    if (eventType) params.set('eventType', eventType);
    params.set('limit', '100');
    const res = await apiFetch<Response>(`/api/security-events?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setEvents(await res.json());
  };

  useEffect(() => { loadEvents(); }, [token]);

  const exportCsv = () => {
    const rows = [['Employee', 'Time', 'Event Type', 'Value', 'Action']] as any[];
    events.forEach(e => rows.push([e.employeeName || e.employeeId || '', new Date(e.createdAt).toLocaleString(), e.eventType, e.value || '', e.actionTaken || '']));
    const csv = rows.map(r => r.map((cell: any) => '"' + String(cell).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'security-report.csv'; a.click(); URL.revokeObjectURL(url);
  };

  const exportPdf = () => {
    const printWindow = window.open('', '_blank', 'width=800,height=800');
    if (!printWindow) return;
    printWindow.document.write('<html><body><h2>Security Report</h2><pre>' + JSON.stringify(events, null, 2) + '</pre></body></html>');
    printWindow.document.close(); printWindow.print();
  };
const router = useRouter();
  return (
    
    <div style={styles.page}>
      <div style={{ marginBottom: 16 }}>
  <button
    style={{
      ...styles.button,
      marginRight: 10,
    }}
    onClick={() => router.back()}
  >
    ← Back
  </button>
</div>
      <h1 style={styles.header}>Security Report</h1>
      <p style={styles.sub}>Review blocked website and application events.</p>
      <div style={styles.card}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <select style={styles.input} value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
            <option value="">All Employees</option>
            {users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
          <select style={styles.input} value={eventType} onChange={e => setEventType(e.target.value)}>
            <option value="">All Event Types</option>
            <option value="Blocked Website">Blocked Website</option>
            <option value="Blocked App">Blocked App</option>
          </select>
          <button style={styles.button} onClick={loadEvents}>Apply</button>
          <button style={styles.button} onClick={exportCsv}>Export CSV</button>
          <button style={styles.button} onClick={exportPdf}>Export PDF</button>
        </div>
        <table style={styles.table}>
          <thead><tr><th style={styles.th}>Employee</th><th style={styles.th}>Time</th><th style={styles.th}>Event Type</th><th style={styles.th}>Value</th><th style={styles.th}>Action</th></tr></thead>
          <tbody>{events.map(event => <tr key={event.id}><td style={styles.td}>{event.employeeName || event.employeeId || '—'}</td><td style={styles.td}>{new Date(event.createdAt).toLocaleString()}</td><td style={styles.td}>{event.eventType}</td><td style={styles.td}>{event.value || '—'}</td><td style={styles.td}>{event.actionTaken || '—'}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
