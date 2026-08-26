'use client';

import { apiFetch } from '@/lib/api-client';

import { useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '@/store/auth';
import { canMonitorAll, isAgentTrackedRole, normalizeRole } from '@/lib/roles';

type SecurityEventRecord = {
  id: string;
  employeeId?: string | null;
  employeeName?: string | null;
  computerName?: string | null;
  eventType: string;
  value?: string | null;
  actionTaken?: string | null;
  createdAt: string;
};

type UserOption = {
  id: string;
  name: string;
};

const DEVICE_EVENT_OPTIONS = [
  { value: '', label: 'All device alerts' },
  { value: 'usb_device_connected', label: 'USB connected' },
  { value: 'network_drive_connected', label: 'Network drive connected' },
  { value: 'usb_mass_write', label: 'USB mass write' },
  { value: 'mass_copy_to_usb_detected', label: 'Mass copy to USB' },
] as const;

const EVENT_TONES: Record<string, { background: string; color: string; border: string }> = {
  usb_device_connected: { background: 'rgba(255,92,122,.12)', color: '#FF8FA5', border: 'rgba(255,92,122,.2)' },
  network_drive_connected: { background: 'rgba(30,90,224,.14)', color: '#95B6FF', border: 'rgba(30,90,224,.28)' },
  usb_mass_write: { background: 'rgba(245,196,0,.16)', color: '#F5C400', border: 'rgba(245,196,0,.25)' },
  mass_copy_to_usb_detected: { background: 'rgba(245,196,0,.16)', color: '#F5C400', border: 'rgba(245,196,0,.25)' },
};

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
    background: 'transparent',
    color: BRAND.white,
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
  },
  hero: {
    border: `1px solid ${BRAND.border}`,
    background: '#FFFFFF',
    borderRadius: 24,
    padding: '24px 26px',
    marginBottom: 18,
    boxShadow: '0 18px 48px rgba(15,23,42,.06)',
  },
  title: { margin: 0, fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em' },
  sub: { margin: '10px 0 0', fontSize: 14, color: BRAND.muted, maxWidth: 760, lineHeight: 1.6 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 },
  stat: {
    border: `1px solid ${BRAND.border}`,
    borderRadius: 20,
    padding: '18px 18px 16px',
    background: '#FFFFFF',
  },
  statLabel: { fontSize: 11, color: BRAND.mutedFaint, textTransform: 'uppercase', letterSpacing: '0.08em' },
  statValue: { marginTop: 10, fontSize: 26, fontWeight: 800, color: BRAND.white },
  card: {
    border: `1px solid ${BRAND.border}`,
    background: '#FFFFFF',
    borderRadius: 22,
    padding: '20px 22px',
  },
  cardTitle: { margin: 0, fontSize: 18, fontWeight: 700 },
  cardSub: { margin: '8px 0 16px', fontSize: 13, color: BRAND.muted },
  controls: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 16 },
  input: {
    width: '100%',
    padding: '11px 12px',
    borderRadius: 12,
    border: `1px solid ${BRAND.border}`,
    background: '#FFFFFF',
    color: BRAND.white,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
  },
  button: {
    padding: '11px 16px',
    borderRadius: 12,
    border: 'none',
    background: 'linear-gradient(90deg, #1E5AE0, #4C8CFF)',
    color: '#fff',
    fontWeight: 700,
    cursor: 'pointer',
  },
  secondaryButton: {
    padding: '11px 16px',
    borderRadius: 12,
    border: `1px solid ${BRAND.border}`,
    background: '#FFFFFF',
    color: BRAND.white,
    fontWeight: 600,
    cursor: 'pointer',
  },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    padding: '12px 10px',
    textAlign: 'left',
    color: BRAND.mutedFaint,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    borderBottom: `1px solid ${BRAND.border}`,
  },
  td: {
    padding: '14px 10px',
    borderBottom: `1px solid ${BRAND.border}`,
    verticalAlign: 'top',
    color: BRAND.white,
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    borderRadius: 999,
    border: `1px solid ${BRAND.border}`,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.03em',
  },
  muted: { color: BRAND.muted },
  empty: {
    padding: '28px 12px 10px',
    textAlign: 'center',
    color: BRAND.muted,
    fontSize: 14,
  },
};

function formatEventType(value: string) {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function downloadCsv(rows: SecurityEventRecord[]) {
  const csvRows = [
    ['Employee', 'Computer', 'Time', 'Event Type', 'Value', 'Action'],
    ...rows.map((event) => [
      event.employeeName || event.employeeId || '',
      event.computerName || '',
      new Date(event.createdAt).toLocaleString(),
      event.eventType,
      event.value || '',
      event.actionTaken || '',
    ]),
  ];

  const csv = csvRows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'device-alerts.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function DeviceAlertsPage() {
  const { token, user } = useAuthStore();
  const [events, setEvents] = useState<SecurityEventRecord[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [eventType, setEventType] = useState('');
  const [loading, setLoading] = useState(false);

  const normalizedRole = normalizeRole(user?.role);
  const canView = canMonitorAll(normalizedRole);
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  const summary = useMemo(() => {
    const usbConnected = events.filter((event) => event.eventType === 'usb_device_connected').length;
    const networkConnected = events.filter((event) => event.eventType === 'network_drive_connected').length;
    const criticalTransfers = events.filter((event) => ['usb_mass_write', 'mass_copy_to_usb_detected'].includes(event.eventType)).length;
    return {
      total: events.length,
      usbConnected,
      networkConnected,
      criticalTransfers,
    };
  }, [events]);

  const loadUsers = async () => {
    if (!headers) return;
    const response = await apiFetch<Response>('/api/users', { headers });
    if (!response.ok) return;
    const payload = await response.json();
    const nextUsers = Array.isArray(payload)
      ? payload
          .filter((item) => isAgentTrackedRole(normalizeRole(item?.role)))
          .map((item) => ({ id: String(item.id), name: String(item.name || item.full_name || item.email || item.id) }))
      : [];
    setUsers(nextUsers);
  };

  const loadEvents = async () => {
    if (!headers) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (employeeId) params.set('employeeId', employeeId);
      if (eventType) {
        params.set('eventType', eventType);
      }
      params.set('limit', '100');
      const response = await apiFetch<Response>(`/api/security-events?${params.toString()}`, { headers });
      if (!response.ok) return;
      const payload = await response.json();
      const allowedTypes = new Set<string>(DEVICE_EVENT_OPTIONS.slice(1).map((item) => item.value));
      const nextEvents = Array.isArray(payload)
        ? payload.filter((item) => allowedTypes.has(String(item?.eventType || '')))
        : [];
      setEvents(nextEvents);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!token || !canView) return;
    void loadUsers();
  }, [token, canView]);

  useEffect(() => {
    if (!token || !canView) return;
    void loadEvents();
  }, [token, canView]);

  if (!canView) {
    return (
      <div style={styles.page}>
        <div style={styles.hero}>
          <h1 style={styles.title}>Device Alerts</h1>
          <p style={styles.sub}>Only monitoring roles can access USB and network drive alerts.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <section style={styles.hero}>
        <h1 style={styles.title}>Device Alerts</h1>
        <p style={styles.sub}>
          Review USB connections, network drive mounts, and suspicious copy activity from employee machines in one dedicated view.
        </p>
      </section>

      <section style={styles.grid}>
        <div style={styles.stat}>
          <div style={styles.statLabel}>Total Alerts</div>
          <div style={styles.statValue}>{summary.total}</div>
        </div>
        <div style={styles.stat}>
          <div style={styles.statLabel}>USB Connected</div>
          <div style={styles.statValue}>{summary.usbConnected}</div>
        </div>
        <div style={styles.stat}>
          <div style={styles.statLabel}>Network Drives</div>
          <div style={styles.statValue}>{summary.networkConnected}</div>
        </div>
        <div style={styles.stat}>
          <div style={styles.statLabel}>High-Risk Transfers</div>
          <div style={styles.statValue}>{summary.criticalTransfers}</div>
        </div>
      </section>

      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Alert Feed</h2>
        <p style={styles.cardSub}>Filter the last 100 matching events and export them when needed.</p>

        <div style={styles.controls}>
          <select style={styles.input} value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="">All employees</option>
            {users.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>

          <select style={styles.input} value={eventType} onChange={(event) => setEventType(event.target.value)}>
            {DEVICE_EVENT_OPTIONS.map((option) => (
              <option key={option.value || 'all'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <button style={styles.button} onClick={() => void loadEvents()} disabled={loading}>
            {loading ? 'Loading...' : 'Apply Filters'}
          </button>

          <button style={styles.secondaryButton} onClick={() => downloadCsv(events)} disabled={!events.length}>
            Export CSV
          </button>
        </div>

        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Employee</th>
                <th style={styles.th}>Computer</th>
                <th style={styles.th}>Alert Type</th>
                <th style={styles.th}>Value</th>
                <th style={styles.th}>Action</th>
                <th style={styles.th}>Time</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const tone = EVENT_TONES[event.eventType] || {
                  background: BRAND.blueSoft,
                  color: BRAND.white,
                  border: BRAND.border,
                };

                return (
                  <tr key={event.id}>
                    <td style={styles.td}>
                      <div>{event.employeeName || event.employeeId || 'Unknown employee'}</div>
                    </td>
                    <td style={styles.td}>
                      <div>{event.computerName || 'Unknown device'}</div>
                    </td>
                    <td style={styles.td}>
                      <span style={{ ...styles.badge, background: tone.background, color: tone.color, borderColor: tone.border }}>
                        {formatEventType(event.eventType)}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <div style={styles.muted}>{event.value || 'N/A'}</div>
                    </td>
                    <td style={styles.td}>
                      <div>{event.actionTaken || 'Logged'}</div>
                    </td>
                    <td style={styles.td}>
                      <div>{new Date(event.createdAt).toLocaleString()}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && events.length === 0 ? (
          <div style={styles.empty}>No device alerts found for the selected filters.</div>
        ) : null}
      </section>
    </div>
  );
}
