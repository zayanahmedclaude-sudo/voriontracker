'use client';

import { apiFetch } from '@/lib/api-client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { normalizeRole } from '@/lib/roles';
import { useAuthStore } from '@/store/auth';

type AccessLogItem = {
  id: string;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  exportType: string;
  target: string | null;
  startDate: string | null;
  endDate: string | null;
  details: Record<string, any> | null;
  createdAt: string;
};

const COLORS = {
  panel: '#FFFFFF',
  border: 'rgba(10,10,10,.10)',
  text: '#0A0A0A',
  muted: 'rgba(10,10,10,.58)',
  faint: 'rgba(10,10,10,.38)',
  accent: '#0050B0',
};

function fmtDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function exportLabel(value: string) {
  if (value === 'timeline_daily_csv') return 'Timeline daily CSV';
  if (value === 'timeline_range_csv') return 'Timeline range CSV';
  return value;
}

export default function AccessLogsPage() {
  const router = useRouter();
  const { token, user } = useAuthStore();
  const role = normalizeRole(user?.role);
  const canView = role === 'superadmin';

  const [items, setItems] = useState<AccessLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (user && !canView) {
      router.replace('/dashboard');
    }
  }, [canView, router, user]);

  useEffect(() => {
    if (!token || !canView) return;
    setLoading(true);
    apiFetch<Response>('/api/export-access-logs?limit=150', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => response.json())
      .then((data) => {
        const nextItems = Array.isArray(data) ? data : [];
        setItems(nextItems);
        setSelectedId((current) => current || nextItems[0]?.id || null);
        setLoading(false);
      })
      .catch(() => {
        setItems([]);
        setLoading(false);
      });
  }, [canView, token]);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) || items[0] || null,
    [items, selectedId],
  );

  if (!canView) return null;

  return (
    <div>
      <div className="header">
        <div>
          <h1>Access Log</h1>
          <p>Who exported what, when, and across which activity dates.</p>
        </div>
      </div>

      <div className="layout">
        <div className="listCard">
          <div className="listHeader">
            <span>Recent export activity</span>
            <small>{items.length} records</small>
          </div>
          {loading ? (
            <div className="empty">Loading access logs...</div>
          ) : items.length === 0 ? (
            <div className="empty">No export access logs recorded yet.</div>
          ) : (
            <div className="list">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`row ${selected?.id === item.id ? 'active' : ''}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <div className="rowTitle">
                    <strong>{item.actorName || 'Unknown user'}</strong>
                    <span>{exportLabel(item.exportType)}</span>
                  </div>
                  <div className="rowMeta">
                    <span>{item.startDate && item.endDate ? `${item.startDate} to ${item.endDate}` : item.startDate || '-'}</span>
                    <span>{fmtDateTime(item.createdAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="detailCard">
          <div className="detailHeader">
            <span>Details</span>
          </div>
          {selected ? (
            <div className="detailBody">
              <div className="detailBlock">
                <label>User</label>
                <strong>{selected.actorName || 'Unknown user'}</strong>
                <small>{selected.actorEmail || 'No email'}</small>
              </div>
              <div className="detailGrid">
                <div>
                  <label>Export</label>
                  <strong>{exportLabel(selected.exportType)}</strong>
                </div>
                <div>
                  <label>Target</label>
                  <strong>{selected.target || '-'}</strong>
                </div>
                <div>
                  <label>From</label>
                  <strong>{selected.startDate || '-'}</strong>
                </div>
                <div>
                  <label>To</label>
                  <strong>{selected.endDate || '-'}</strong>
                </div>
                <div>
                  <label>When</label>
                  <strong>{fmtDateTime(selected.createdAt)}</strong>
                </div>
                <div>
                  <label>User ID</label>
                  <strong>{selected.actorUserId || '-'}</strong>
                </div>
              </div>
              <div className="detailBlock">
                <label>Payload</label>
                <pre>{JSON.stringify(selected.details || {}, null, 2)}</pre>
              </div>
            </div>
          ) : (
            <div className="empty">Select a log to view its details.</div>
          )}
        </aside>
      </div>

      <style jsx>{`
        .header {
          margin-bottom: 18px;
        }
        h1 {
          margin: 0;
          color: ${COLORS.text};
          font-size: 32px;
          font-weight: 800;
        }
        p {
          margin: 6px 0 0;
          color: ${COLORS.muted};
          font-size: 14px;
          font-weight: 600;
        }
        .layout {
          display: grid;
          grid-template-columns: minmax(0, 1.25fr) 420px;
          gap: 16px;
        }
        .listCard, .detailCard {
          background: ${COLORS.panel};
          border: 1px solid ${COLORS.border};
          border-radius: 12px;
          box-shadow: 0 20px 50px rgba(0,0,0,.28);
        }
        .listHeader, .detailHeader {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 18px;
          border-bottom: 1px solid ${COLORS.border};
          color: ${COLORS.text};
          font-size: 15px;
          font-weight: 800;
        }
        .listHeader small {
          color: ${COLORS.faint};
          font-size: 11px;
          text-transform: uppercase;
        }
        .list {
          display: grid;
          gap: 10px;
          padding: 14px;
          max-height: 70vh;
          overflow: auto;
        }
        .row {
          text-align: left;
          border: 1px solid rgba(245,247,250,.08);
          background: rgba(245,247,250,.03);
          border-radius: 10px;
          padding: 14px;
          cursor: pointer;
        }
        .row.active {
          border-color: rgba(30,90,224,.5);
          background: rgba(30,90,224,.12);
        }
        .rowTitle, .rowMeta {
          display: flex;
          justify-content: space-between;
          gap: 12px;
        }
        .rowTitle strong, .rowMeta span, .detailGrid strong, .detailBlock strong {
          color: ${COLORS.text};
        }
        .rowTitle span, .rowMeta span, .detailBlock small, label {
          color: ${COLORS.muted};
          font-size: 12px;
          font-weight: 700;
        }
        .rowMeta {
          margin-top: 8px;
        }
        .detailBody {
          display: grid;
          gap: 18px;
          padding: 18px;
        }
        .detailGrid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 14px;
        }
        .detailBlock {
          display: grid;
          gap: 6px;
        }
        pre {
          margin: 0;
          padding: 12px;
          border-radius: 10px;
          background: rgba(10,14,26,.6);
          border: 1px solid rgba(245,247,250,.08);
          color: #D8E3FF;
          font-size: 12px;
          overflow: auto;
        }
        .empty {
          padding: 28px;
          text-align: center;
          color: ${COLORS.muted};
          font-size: 14px;
          font-weight: 700;
        }
        @media (max-width: 1100px) {
          .layout {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 760px) {
          .detailGrid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}
