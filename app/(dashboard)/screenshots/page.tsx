'use client';
// app/(dashboard)/screenshots/page.tsx
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BUSINESS_TIME_ZONE } from '@/lib/shifts';
import { canCreateScreenshotFlags, canSendFlagReports, normalizeRole } from '@/lib/roles';
import { useAuthStore } from '@/store/auth';

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

const SCREENSHOTS_PER_PAGE = 40;
const TODAY = '2026-07-26';

export default function ScreenshotsPage() {
  const { token, user } = useAuthStore();
  const router = useRouter();
  const [shots, setShots] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [userId, setUserId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [activeApp, setActiveApp] = useState('');
  const [appInput, setAppInput] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState('');
  const [flagging, setFlagging] = useState<any | null>(null);
  const [flagComment, setFlagComment] = useState('');
  const [flagTo, setFlagTo] = useState('');
  const [flagCc, setFlagCc] = useState('');
  const [flagPdf, setFlagPdf] = useState<File | null>(null);
  const [sendReport, setSendReport] = useState(false);
  const [flagSaving, setFlagSaving] = useState(false);
  const role = normalizeRole(user?.role);
  const isClient = role === 'client';
  const clientTimeZone = typeof window === 'undefined'
    ? 'America/New_York'
    : Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  const displayTimeZone = isClient ? clientTimeZone : BUSINESS_TIME_ZONE;
  const canFlag = canCreateScreenshotFlags(role);
  const canEmailFlag = canSendFlagReports(role);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    async function loadUsers() {
      try {
        const response = await fetch('/api/users', { headers: { Authorization: `Bearer ${token}` } });
        const text = await response.text();
        const data = text ? JSON.parse(text) : [];

        if (!response.ok) {
          const message = data?.error || text || 'Failed to load users';
          throw new Error(message);
        }

        if (!cancelled) {
          setUsers(Array.isArray(data) ? data.filter((u: any) => u.role === 'employee') : []);
        }
      } catch (loadError: any) {
        console.error('Failed to load screenshot users', loadError);
        if (!cancelled) {
          setUsers([]);
          setError(loadError?.message || 'Failed to load users');
        }
      }
    }

    void loadUsers();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!isClient) return;
    if (users.length === 1) {
      setUserId((current) => current || users[0].id);
    }
  }, [isClient, users]);

  const loadScreenshots = useCallback(async (before?: string) => {
    const appending = Boolean(before);
    if (appending) setLoadingMore(true);
    else setLoading(true);
    setError('');

    if (!token) {
      setError('Not authenticated. Please sign in.');
      if (!appending) setShots([]);
      setLoading(false);
      setLoadingMore(false);
      return;
    }

    const params = new URLSearchParams({ limit: String(SCREENSHOTS_PER_PAGE + 1) });
    if (userId) params.set('userId', userId);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (activeApp) params.set('activeApp', activeApp);
    if (isClient) params.set('tz', clientTimeZone);
    if (before) params.set('before', before);

    try {
      const response = await fetch(`/api/screenshots?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await response.text();
      if (!response.ok) {
        console.error('/api/screenshots failed', response.status, text);
        setError(text || 'Failed to load screenshots');
        if (!appending) setShots([]);
        return;
      }

      const data = JSON.parse(text || '[]');
      const page = Array.isArray(data) ? data.slice(0, SCREENSHOTS_PER_PAGE) : [];
      setHasMore(Array.isArray(data) && data.length > SCREENSHOTS_PER_PAGE);
      setShots((current) => {
        if (!appending) return page;
        const existingIds = new Set(current.map((shot) => shot.id));
        return [...current, ...page.filter((shot: any) => !existingIds.has(shot.id))];
      });
    } catch (loadError) {
      console.error('Failed to load screenshots', loadError);
      setError('Failed to load screenshots');
      if (!appending) setShots([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [activeApp, clientTimeZone, dateFrom, dateTo, isClient, token, userId]);

  useEffect(() => {
    setShots([]);
    setHasMore(true);
    void loadScreenshots();
  }, [loadScreenshots]);

  const filterSummary = [
    userId ? `Employee filtered` : isClient ? 'All assigned VAs' : 'All employees',
    dateFrom || dateTo ? `Range: ${dateFrom || 'start'} to ${dateTo || 'latest'}` : 'Range: all available dates',
    activeApp ? `App: ${activeApp}` : null,
  ].filter(Boolean).join(' | ');

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: BRAND.white, margin: 0, flex: 1 }}>
          {isClient ? 'Assigned VA Screenshots' : 'Screenshots'}
        </h1>
        <button
          type="button"
          onClick={() => {
            setUserId('');
            setDateFrom('');
            setDateTo('');
            setActiveApp('');
            setAppInput('');
          }}
          style={{
            padding: '12px 14px',
            borderRadius: 14,
            border: `1px solid ${BRAND.border}`,
            background: 'rgba(245,247,250,.04)',
            color: BRAND.white,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Reset filters
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10, marginBottom: 12 }}>
        <select
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          style={{
            padding: '12px 14px',
            borderRadius: 14,
            border: `1px solid ${BRAND.border}`,
            background: 'rgba(245,247,250,.05)',
            backdropFilter: 'blur(12px)',
            color: BRAND.white,
            fontSize: 13,
            outline: 'none',
          }}
        >
          <option value="">
            {isClient
              ? (users.length <= 1 ? (users[0]?.name || 'Assigned VA') : 'All assigned VAs')
              : 'All employees'}
          </option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input
          type="date"
          value={dateFrom}
          max={dateTo || TODAY}
          onChange={(event) => setDateFrom(event.target.value)}
          style={{
            padding: '12px 14px',
            borderRadius: 14,
            border: `1px solid ${BRAND.border}`,
            background: 'rgba(245,247,250,.05)',
            backdropFilter: 'blur(12px)',
            color: BRAND.white,
            fontSize: 13,
            outline: 'none',
          }}
          aria-label="From date"
        />
        <input
          type="date"
          value={dateTo}
          min={dateFrom || undefined}
          max={TODAY}
          onChange={(event) => setDateTo(event.target.value)}
          style={{
            padding: '12px 14px',
            borderRadius: 14,
            border: `1px solid ${BRAND.border}`,
            background: 'rgba(245,247,250,.05)',
            backdropFilter: 'blur(12px)',
            color: BRAND.white,
            fontSize: 13,
            outline: 'none',
          }}
          aria-label="To date"
        />
        <input
          value={appInput}
          onChange={(event) => setAppInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              setActiveApp(appInput.trim());
            }
          }}
          placeholder="Filter by app name"
          style={{
            padding: '12px 14px',
            borderRadius: 14,
            border: `1px solid ${BRAND.border}`,
            background: 'rgba(245,247,250,.05)',
            backdropFilter: 'blur(12px)',
            color: BRAND.white,
            fontSize: 13,
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={() => setActiveApp(appInput.trim())}
          style={{
            padding: '12px 14px',
            borderRadius: 14,
            border: `1px solid ${BRAND.blue}55`,
            background: 'rgba(30,90,224,.14)',
            color: BRAND.white,
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Apply app filter
        </button>
      </div>

      <div style={{ marginBottom: 18, color: BRAND.muted, fontSize: 12 }}>
        {shots.length ? `${shots.length}${hasMore ? '+' : ''} screenshots loaded` : 'Showing screenshot history'} | {filterSummary}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: BRAND.mutedFaint, fontSize: 13 }}>Loading screenshots...</div>
      ) : error && shots.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: '16px',
          borderRadius: 14,
          background: 'rgba(255,92,122,.1)',
          border: `1px solid ${BRAND.danger}40`,
          color: BRAND.danger,
          fontWeight: 600,
          fontSize: 13,
        }}>{error}</div>
      ) : (
        <>
          {error && (
            <div style={{
              textAlign: 'center',
              padding: '12px',
              marginBottom: 16,
              borderRadius: 14,
              background: 'rgba(255,92,122,.1)',
              border: `1px solid ${BRAND.danger}40`,
              color: BRAND.danger,
              fontWeight: 600,
              fontSize: 13,
            }}>{error}</div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 20 }}>
            {shots.map((s) => (
              <div
                key={s.id}
                onClick={() => setPreview(s.file_url)}
                onMouseEnter={(event) => {
                  event.currentTarget.style.transform = 'translateY(-6px)';
                  event.currentTarget.style.boxShadow = '0 25px 55px rgba(0,0,0,.45)';
                  event.currentTarget.style.borderColor = `${BRAND.blue}40`;
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.transform = 'translateY(0)';
                  event.currentTarget.style.boxShadow = '0 15px 35px rgba(0,0,0,.35)';
                  event.currentTarget.style.borderColor = BRAND.border;
                }}
                style={{
                  background: 'rgba(16,24,43,.75)',
                  backdropFilter: 'blur(20px)',
                  border: `1px solid ${BRAND.border}`,
                  borderRadius: 18,
                  overflow: 'hidden',
                  cursor: 'pointer',
                  transition: 'all .25s ease',
                  boxShadow: '0 15px 35px rgba(0,0,0,.35)',
                }}
              >
                <div style={{ aspectRatio: '16/9', background: BRAND.black, overflow: 'hidden' }}>
                  <img
                    src={s.thumbnail_url || s.file_url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform .3s ease' }}
                    onMouseEnter={(event) => { event.currentTarget.style.transform = 'scale(1.05)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.transform = 'scale(1)'; }}
                    onError={(event) => { event.currentTarget.style.display = 'none'; }}
                  />
                </div>
                <div style={{ padding: '8px 10px' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.white, marginBottom: 2 }}>{s.user_name}</div>
                  <div style={{ fontSize: 10, color: BRAND.mutedFaint, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.active_app || '-'}</span>
                    <span>{new Date(s.captured_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: displayTimeZone })}</span>
                  </div>
                  <div style={{ marginTop: 4, height: 3, background: BRAND.black, borderRadius: 2 }}>
                    <div
                      style={{
                        height: '100%',
                        borderRadius: 2,
                        width: `${s.activity_pct || 0}%`,
                        background: (s.activity_pct || 0) < 30 ? BRAND.yellow : BRAND.blue,
                      }}
                    />
                  </div>
                  {canFlag && (
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setFlagging(s);
                        setFlagComment('');
                        setFlagTo('');
                        setFlagCc('');
                        setFlagPdf(null);
                        setSendReport(false);
                      }}
                      style={{
                        marginTop: 10,
                        width: '100%',
                        padding: '8px 10px',
                        borderRadius: 10,
                        border: `1px solid ${BRAND.blue}50`,
                        background: 'rgba(30,90,224,.15)',
                        color: BRAND.white,
                        cursor: 'pointer',
                        fontWeight: 700,
                      }}
                    >
                      {canEmailFlag ? 'Flag / Send Report' : 'Flag Screenshot'}
                    </button>
                  )}
                </div>
              </div>
            ))}

            {!shots.length && (
              <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: 60, color: BRAND.mutedFaint, fontSize: 13 }}>
                No screenshots found.
              </div>
            )}
          </div>

          {hasMore && shots.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0 8px' }}>
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => {
                  const cursor = shots[shots.length - 1]?.captured_at;
                  if (cursor) void loadScreenshots(cursor);
                }}
                style={{
                  minWidth: 190,
                  padding: '12px 20px',
                  borderRadius: 12,
                  border: `1px solid ${BRAND.blue}80`,
                  background: loadingMore ? 'rgba(30,90,224,.12)' : BRAND.blue,
                  color: BRAND.white,
                  cursor: loadingMore ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                  fontWeight: 700,
                  opacity: loadingMore ? 0.7 : 1,
                }}
              >
                {loadingMore ? 'Loading more...' : 'Load more screenshots'}
              </button>
            </div>
          )}
        </>
      )}

      {preview && (
        <div
          onClick={() => setPreview(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(10,14,26,.92)',
            backdropFilter: 'blur(12px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999,
            cursor: 'pointer',
          }}
        >
          <img
            src={preview}
            alt="Screenshot preview"
            style={{ maxWidth: '92vw', maxHeight: '92vh', borderRadius: 20, boxShadow: '0 25px 60px rgba(0,0,0,.5)' }}
          />
        </div>
      )}

      {flagging && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(10,14,26,.92)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            style={{
              width: 'min(640px, 100%)',
              background: 'rgba(16,24,43,.96)',
              border: `1px solid ${BRAND.border}`,
              borderRadius: 20,
              padding: 22,
            }}
          >
            <h2 style={{ color: BRAND.white, marginTop: 0 }}>Flag Screenshot</h2>
            <p style={{ color: BRAND.muted, fontSize: 13 }}>
              {flagging.user_name} | {new Date(flagging.captured_at).toLocaleString([], { timeZone: displayTimeZone })}
            </p>
            <textarea
              value={flagComment}
              onChange={(event) => setFlagComment(event.target.value)}
              placeholder="Add your QA notes"
              style={{
                width: '100%',
                minHeight: 110,
                borderRadius: 12,
                border: `1px solid ${BRAND.border}`,
                background: 'rgba(245,247,250,.05)',
                color: BRAND.white,
                padding: 12,
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
            {canEmailFlag && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: BRAND.white, fontSize: 13, marginTop: 14 }}>
                  <input type="checkbox" checked={sendReport} onChange={(event) => setSendReport(event.target.checked)} />
                  Send report email
                </label>
                {sendReport && (
                  <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
                    <input
                      value={flagTo}
                      onChange={(event) => setFlagTo(event.target.value)}
                      placeholder="To (comma separated emails)"
                      style={{
                        width: '100%',
                        borderRadius: 12,
                        border: `1px solid ${BRAND.border}`,
                        background: 'rgba(245,247,250,.05)',
                        color: BRAND.white,
                        padding: 12,
                        boxSizing: 'border-box',
                      }}
                    />
                    <input
                      value={flagCc}
                      onChange={(event) => setFlagCc(event.target.value)}
                      placeholder="CC (optional, comma separated emails)"
                      style={{
                        width: '100%',
                        borderRadius: 12,
                        border: `1px solid ${BRAND.border}`,
                        background: 'rgba(245,247,250,.05)',
                        color: BRAND.white,
                        padding: 12,
                        boxSizing: 'border-box',
                      }}
                    />
                    <input
                      type="file"
                      accept="application/pdf"
                      onChange={(event) => setFlagPdf(event.target.files?.[0] || null)}
                      style={{ color: BRAND.white }}
                    />
                  </div>
                )}
              </>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button
                onClick={async () => {
                  if (!token || !flagComment.trim()) return;
                  setFlagSaving(true);
                  const formData = new FormData();
                  formData.append('screenshotId', flagging.id);
                  formData.append('comment', flagComment.trim());
                  formData.append('sendReport', String(sendReport));
                  if (flagTo) formData.append('to', flagTo);
                  if (flagCc) formData.append('cc', flagCc);
                  if (flagPdf) formData.append('pdf', flagPdf);
                  try {
                    const res = await fetch('/api/screenshot-flags', {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${token}` },
                      body: formData,
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) {
                      setError(data.error || 'Failed to save screenshot flag');
                      return;
                    }
                    if (data.warning) {
                      setError(data.warning);
                    } else {
                      setError('');
                    }
                    setFlagging(null);
                    router.refresh();
                    router.push('/flags');
                  } catch {
                    setError('Failed to save screenshot flag');
                  } finally {
                    setFlagSaving(false);
                  }
                }}
                disabled={flagSaving}
                style={{
                  padding: '10px 16px',
                  borderRadius: 12,
                  border: 'none',
                  background: BRAND.blue,
                  color: '#fff',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {flagSaving ? 'Saving...' : sendReport && canEmailFlag ? 'Save and Send' : 'Save Flag'}
              </button>
              <button
                onClick={() => setFlagging(null)}
                style={{
                  padding: '10px 16px',
                  borderRadius: 12,
                  border: `1px solid ${BRAND.border}`,
                  background: 'transparent',
                  color: BRAND.white,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
