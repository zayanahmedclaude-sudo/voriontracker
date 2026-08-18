'use client';

import { apiFetch } from '@/lib/api-client';
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

const PAGE = {
  ink: '#0A0A0A',
  surface: '#FFFFFF',
  canvas: '#F7F8FB',
  blue: '#0050B0',
  blueSoft: 'rgba(0,80,176,.08)',
  border: 'rgba(10,10,10,.10)',
  muted: 'rgba(10,10,10,.58)',
  mutedFaint: 'rgba(10,10,10,.38)',
  danger: '#B42318',
  dangerSoft: 'rgba(180,35,24,.08)',
  shadow: '0 18px 48px rgba(15,23,42,.06)',
};

const SCREENSHOTS_PER_PAGE = 20;

function getDateInputValue(date = new Date()) {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day}`;
}

export default function ScreenshotsPage() {
  const { token, user, logout, hasHydrated } = useAuthStore();
  const router = useRouter();
  const today = getDateInputValue();
  const [shots, setShots] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [userId, setUserId] = useState('');
  const [dateFrom, setDateFrom] = useState(() => getDateInputValue());
  const [dateTo, setDateTo] = useState(() => getDateInputValue());
  const [timeFrom, setTimeFrom] = useState('');
  const [timeTo, setTimeTo] = useState('');
  const [activeApp, setActiveApp] = useState('');
  const [appInput, setAppInput] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
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
    if (!hasHydrated || !token) return;
    let cancelled = false;

    async function loadUsers() {
      try {
        const response = await apiFetch<Response>('/api/users', { headers: { Authorization: `Bearer ${token}` } });
        const text = await response.text();
        const data = text ? JSON.parse(text) : [];

        if (response.status === 401) {
          logout();
          router.replace('/login');
          return;
        }

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
  }, [hasHydrated, logout, router, token]);

  useEffect(() => {
    if (!isClient) return;
    if (users.length === 1) {
      setUserId((current) => current || users[0].id);
    }
  }, [isClient, users]);

  const openPreview = useCallback(async (shot: any) => {
    if (!token || shot.storageExpired) return;
    if (shot.file_url) {
      setPreview(shot.file_url);
      return;
    }
    setPreviewLoadingId(shot.id);
    try {
      const response = await apiFetch<Response>(`/api/screenshots/${encodeURIComponent(shot.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.file_url) {
        setError(payload.error || 'Failed to load screenshot preview');
        return;
      }
      setPreview(payload.file_url);
      setShots((current) => current.map((item) => item.id === shot.id ? { ...item, file_url: payload.file_url } : item));
    } catch {
      setError('Failed to load screenshot preview');
    } finally {
      setPreviewLoadingId(null);
    }
  }, [token]);

  const loadScreenshots = useCallback(async (before?: string, nextActiveApp = activeApp) => {
    const appending = Boolean(before);
    if (appending) setLoadingMore(true);
    else setLoading(true);
    setError('');

    if (!hasHydrated) {
      setLoading(false);
      setLoadingMore(false);
      return;
    }

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
    if (timeFrom) params.set('timeFrom', timeFrom);
    if (timeTo) params.set('timeTo', timeTo);
    if (nextActiveApp) params.set('activeApp', nextActiveApp);
    if (isClient) params.set('tz', clientTimeZone);
    if (before) params.set('before', before);

    try {
      const response = await apiFetch<Response>(`/api/screenshots?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await response.text();
      if (response.status === 401) {
        logout();
        router.replace('/login');
        return;
      }
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
  }, [activeApp, clientTimeZone, dateFrom, dateTo, hasHydrated, isClient, logout, router, timeFrom, timeTo, token, userId]);

  const searchScreenshots = useCallback(() => {
    const nextActiveApp = appInput.trim();
    setActiveApp(nextActiveApp);
    setShots([]);
    setHasMore(true);
    setHasSearched(true);
    void loadScreenshots(undefined, nextActiveApp);
  }, [appInput, loadScreenshots]);

  const filterSummary = [
    userId ? `Employee filtered` : isClient ? 'All assigned VAs' : 'All employees',
    dateFrom || dateTo ? `Range: ${dateFrom || 'start'} ${timeFrom || '00:00'} to ${dateTo || 'latest'} ${timeTo || '23:59'}` : 'Range: choose filters',
    activeApp ? `App: ${activeApp}` : null,
  ].filter(Boolean).join(' | ');
  const filterInputStyle: React.CSSProperties = {
    padding: '12px 14px',
    borderRadius: 14,
    border: `1px solid ${PAGE.border}`,
    background: PAGE.surface,
    color: PAGE.ink,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
  };
  const pagePanelStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
    gap: 10,
    marginBottom: 12,
    padding: 18,
    borderRadius: 22,
    background: PAGE.surface,
    border: `1px solid ${PAGE.border}`,
    boxShadow: PAGE.shadow,
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: PAGE.ink, margin: 0, flex: 1 }}>
          {isClient ? 'Assigned VA Screenshots' : 'Screenshots'}
        </h1>
        <button
          type="button"
          onClick={() => {
            setUserId('');
            setDateFrom(today);
            setDateTo(today);
            setTimeFrom('');
            setTimeTo('');
            setActiveApp('');
            setAppInput('');
            setShots([]);
            setHasMore(true);
            setHasSearched(false);
          }}
          style={{
            padding: '12px 14px',
            borderRadius: 14,
            border: `1px solid ${PAGE.border}`,
            background: PAGE.surface,
            color: PAGE.ink,
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: PAGE.shadow,
          }}
        >
          Reset filters
        </button>
      </div>

      <div style={pagePanelStyle}>
        <select
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          style={filterInputStyle}
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
          max={dateTo || today}
          onChange={(event) => setDateFrom(event.target.value)}
          style={filterInputStyle}
          aria-label="From date"
        />
        <input
          type="time"
          value={timeFrom}
          onChange={(event) => setTimeFrom(event.target.value)}
          style={filterInputStyle}
          aria-label="From time"
        />
        <input
          type="date"
          value={dateTo}
          min={dateFrom || undefined}
          max={today}
          onChange={(event) => setDateTo(event.target.value)}
          style={filterInputStyle}
          aria-label="To date"
        />
        <input
          type="time"
          value={timeTo}
          onChange={(event) => setTimeTo(event.target.value)}
          style={filterInputStyle}
          aria-label="To time"
        />
        <input
          value={appInput}
          onChange={(event) => setAppInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              searchScreenshots();
            }
          }}
          placeholder="Filter by app name"
          style={filterInputStyle}
        />
        <button
          type="button"
          onClick={searchScreenshots}
          style={{
            padding: '12px 14px',
            borderRadius: 14,
            border: `1px solid ${PAGE.blue}`,
            background: PAGE.blue,
            color: '#FFFFFF',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Search screenshots
        </button>
      </div>

      <div style={{ marginBottom: 18, color: PAGE.muted, fontSize: 12 }}>
        {shots.length ? `${shots.length}${hasMore ? '+' : ''} screenshots loaded` : hasSearched ? 'No screenshots found' : 'Choose filters, then search'} | {filterSummary}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: PAGE.mutedFaint, fontSize: 13 }}>Loading screenshots...</div>
      ) : error && shots.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: '16px',
          borderRadius: 14,
          background: PAGE.dangerSoft,
          border: `1px solid ${PAGE.danger}33`,
          color: PAGE.danger,
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
              background: PAGE.dangerSoft,
              border: `1px solid ${PAGE.danger}33`,
              color: PAGE.danger,
              fontWeight: 600,
              fontSize: 13,
            }}>{error}</div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 20 }}>
            {shots.map((s) => (
              <div
                key={s.id}
                onClick={() => { void openPreview(s); }}
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
                  cursor: s.storageExpired ? 'default' : 'pointer',
                  transition: 'all .25s ease',
                  boxShadow: '0 15px 35px rgba(0,0,0,.35)',
                }}
              >
                <div style={{ aspectRatio: '16/9', background: BRAND.black, overflow: 'hidden' }}>
                  {s.storageExpired || !s.thumbnail_url ? (
                    <div
                      role="img"
                      aria-label="Screenshot expired after the 14-day retention period"
                      style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}
                    >
                      Screenshot expired after the 14-day retention period
                    </div>
                  ) : (
                    <img
                      src={s.thumbnail_url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform .3s ease' }}
                      onMouseEnter={(event) => { event.currentTarget.style.transform = 'scale(1.05)'; }}
                      onMouseLeave={(event) => { event.currentTarget.style.transform = 'scale(1)'; }}
                      onError={(event) => { event.currentTarget.style.display = 'none'; }}
                    />
                  )}
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
                        if (s.storageExpired) return;
                        setFlagging(s);
                        setFlagComment('');
                        setFlagTo('');
                        setFlagCc('');
                        setFlagPdf(null);
                        setSendReport(false);
                      }}
                      disabled={Boolean(s.storageExpired)}
                      style={{
                        marginTop: 10,
                        width: '100%',
                        padding: '8px 10px',
                        borderRadius: 10,
                        border: `1px solid ${BRAND.blue}50`,
                        background: 'rgba(30,90,224,.15)',
                        color: BRAND.white,
                        cursor: s.storageExpired ? 'not-allowed' : 'pointer',
                        opacity: s.storageExpired ? 0.55 : 1,
                        fontWeight: 700,
                      }}
                    >
                      {canEmailFlag ? 'Flag / Send Report' : 'Flag Screenshot'}
                    </button>
                  )}
                  {previewLoadingId === s.id && (
                    <div style={{ marginTop: 8, fontSize: 11, color: BRAND.muted }}>Loading preview...</div>
                  )}
                </div>
              </div>
            ))}

            {!shots.length && (
              <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: 60, color: PAGE.mutedFaint, fontSize: 13 }}>
                {hasSearched ? 'No screenshots found for this filter.' : 'No screenshots loaded yet. Choose a date/time range and search.'}
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
                  border: `1px solid ${PAGE.blue}`,
                  background: loadingMore ? PAGE.blueSoft : PAGE.blue,
                  color: loadingMore ? PAGE.blue : '#FFFFFF',
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
            background: 'rgba(15,23,42,.42)',
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
            background: 'rgba(15,23,42,.42)',
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
              background: PAGE.surface,
              border: `1px solid ${PAGE.border}`,
              borderRadius: 20,
              padding: 22,
              boxShadow: PAGE.shadow,
            }}
          >
            <h2 style={{ color: PAGE.ink, marginTop: 0 }}>Flag Screenshot</h2>
            <p style={{ color: PAGE.muted, fontSize: 13 }}>
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
                border: `1px solid ${PAGE.border}`,
                background: PAGE.surface,
                color: PAGE.ink,
                padding: 12,
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
            {canEmailFlag && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: PAGE.ink, fontSize: 13, marginTop: 14 }}>
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
                        border: `1px solid ${PAGE.border}`,
                        background: PAGE.surface,
                        color: PAGE.ink,
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
                        border: `1px solid ${PAGE.border}`,
                        background: PAGE.surface,
                        color: PAGE.ink,
                        padding: 12,
                        boxSizing: 'border-box',
                      }}
                    />
                    <input
                      type="file"
                      accept="application/pdf"
                      onChange={(event) => setFlagPdf(event.target.files?.[0] || null)}
                      style={{ color: PAGE.ink }}
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
                    const res = await apiFetch<Response>('/api/screenshot-flags', {
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
                  background: PAGE.blue,
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
                  border: `1px solid ${PAGE.border}`,
                  background: PAGE.surface,
                  color: PAGE.ink,
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
