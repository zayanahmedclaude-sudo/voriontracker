'use client';

import { apiFetch } from '@/lib/api-client';

import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/auth';

const BRAND = {
  black: '#0A0E1A',
  blackSoft: '#10182B',
  white: '#F5F7FA',
  blue: '#1E5AE0',
  border: 'rgba(245,247,250,.08)',
  muted: 'rgba(245,247,250,.5)',
};

export default function FlagsPage() {
  const { token } = useAuthStore();
  const [flags, setFlags] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    apiFetch<Response>('/api/screenshot-flags', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        const data = await res.json().catch(() => ([]));
        if (!res.ok) {
          setError(data?.error || 'Failed to load screenshot flags');
          setFlags([]);
          return;
        }
        setError('');
        setFlags(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        setError('Failed to load screenshot flags');
        setFlags([]);
      })
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div>
      <h1 style={{ fontSize: 30, fontWeight: 800, color: BRAND.white, marginTop: 0 }}>Flagged Screenshots</h1>
      <p style={{ color: BRAND.muted, marginTop: 0, marginBottom: 18 }}>
        Review all screenshot flags raised by QA teams.
      </p>

      <div style={{
        border: `1px solid ${BRAND.border}`,
        background: 'rgba(16,24,43,.78)',
        borderRadius: 20,
        overflow: 'hidden',
      }}>
        {loading ? (
          <div style={{ padding: 28, color: BRAND.muted }}>Loading flags...</div>
        ) : error ? (
          <div style={{ padding: 28, color: '#FF5C7A' }}>{error}</div>
        ) : flags.length === 0 ? (
          <div style={{ padding: 28, color: BRAND.muted }}>No screenshot flags found.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Screenshot', 'Employee', 'Flagged By', 'Captured', 'Comment', 'PDF', 'Email'].map((heading) => (
                  <th key={heading} style={{
                    textAlign: 'left',
                    padding: '12px 16px',
                    color: BRAND.muted,
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    borderBottom: `1px solid ${BRAND.border}`,
                  }}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {flags.map((flag) => (
                <tr key={flag.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                  <td style={{ padding: '14px 16px', color: BRAND.white }}>
                    {flag.screenshot_url ? (
                      <a href={flag.screenshot_url} target="_blank" rel="noopener noreferrer">
                        <img
                          src={flag.screenshot_url}
                          alt={flag.employee_name || 'Flagged screenshot'}
                          style={{ width: 120, height: 68, objectFit: 'cover', borderRadius: 10, border: `1px solid ${BRAND.border}` }}
                        />
                      </a>
                    ) : '—'}
                  </td>
                  <td style={{ padding: '14px 16px', color: BRAND.white }}>{flag.employee_name}</td>
                  <td style={{ padding: '14px 16px', color: BRAND.white }}>{flag.flagged_by_name}</td>
                  <td style={{ padding: '14px 16px', color: BRAND.white }}>{new Date(flag.captured_at).toLocaleString()}</td>
                  <td style={{ padding: '14px 16px', color: BRAND.white }}>{flag.comment}</td>
                  <td style={{ padding: '14px 16px', color: BRAND.white }}>
                    {flag.pdf_url ? <a href={flag.pdf_url} target="_blank" rel="noopener noreferrer" style={{ color: '#93C5FD' }}>{flag.pdf_name || 'Open PDF'}</a> : '—'}
                  </td>
                  <td style={{ padding: '14px 16px', color: BRAND.white }}>
                    {flag.email_sent_at ? `Sent ${new Date(flag.email_sent_at).toLocaleString()}` : 'Not sent'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
