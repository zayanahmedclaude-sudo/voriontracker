'use client';
import React, { useEffect, useState } from 'react';

declare const window: any;

type AgentStatus = 'active' | 'break' | 'idle' | 'offline';

type AlertRecord = {
  id: string;
  title: string;
  description: string;
  severity: string;
  sentAt: string;
  isRead: boolean;
};

type UpdaterState = {
  currentVersion: string;
  message: string;
  downloaded: boolean;
  checking: boolean;
  progress: number | null;
  error: string;
};

type ActionFeedback = { kind: 'success' | 'error'; message: string } | null;

const LABELS: Record<AgentStatus, string> = {
  active: 'Active',
  break: 'Break',
  idle: 'Idle',
  offline: 'Offline',
};

export default function App() {
  const [status, setStatus] = useState<AgentStatus>('offline');
  const [elapsed, setElapsed] = useState('00:00:00');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [idle, setIdle] = useState(false);
  const [heartbeat, setHeartbeat] = useState('');
  const [userName, setUserName] = useState('');
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [loggedEmail, setLoggedEmail] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [checkedIn, setCheckedIn] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback>(null);
  const [actionPending, setActionPending] = useState(false);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [activeAlert, setActiveAlert] = useState<AlertRecord | null>(null);
  const [updater, setUpdater] = useState<UpdaterState>({
    currentVersion: '',
    message: '',
    downloaded: false,
    checking: false,
    progress: null,
    error: '',
  });
  const unreadCount = alerts.filter((alert) => !alert.isRead).length;

  const normalizeAlert = (raw: any): AlertRecord => ({
    id: String(raw?.id ?? raw?.alert_id ?? `${Date.now()}-${Math.random()}`),
    title: String(raw?.title ?? raw?.description ?? 'New alert'),
    description: String(raw?.description ?? raw?.title ?? ''),
    severity: String(raw?.severity ?? 'medium'),
    sentAt: raw?.sentAt || raw?.created_at || new Date().toISOString(),
    isRead: Boolean(raw?.isRead ?? raw?.is_read ?? false),
  });

  const refreshAlerts = async () => {
    try {
      const stored = await window.agent?.getAlerts();
      setAlerts(stored?.map(normalizeAlert) ?? []);
    } catch (error) {
      console.error('Failed to refresh alerts', error);
    }
  };

  const markAlertRead = async (id: string) => {
    try {
      const updated = await window.agent?.markAlertRead(id);
      if (updated) {
        setAlerts((prev) => prev.map((alert) => alert.id === id ? normalizeAlert(updated) : alert));
        setActiveAlert((prev) => prev?.id === id ? null : prev);
      }
    } catch (error) {
      console.error('Failed to mark alert read', error);
    }
  };

  useEffect(() => {
    const timer = setInterval(() => {
      if (!startedAt) return;
      const d = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(`${String(Math.floor(d / 3600)).padStart(2, '0')}:${String(Math.floor((d % 3600) / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}`);
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  useEffect(() => {
    if (!actionFeedback) return;
    const timer = setTimeout(() => setActionFeedback(null), 4000);
    return () => clearTimeout(timer);
  }, [actionFeedback]);

  useEffect(() => {
    window.agent?.onStatus((data:any) => {
      if (data?.status) {
        setStatus(data.status);
        setCheckedIn(Boolean(data.workSessionActive ?? data.sessionId ?? (data.status !== 'offline')));
        if (data.status === 'active' || data.status === 'break') {
          setIdle(false);
          setStartedAt((prev) => prev ?? Date.now());
        }
        if (data.status === 'idle') {
          setIdle(true);
        }
        if (data.status === 'offline') {
          setIdle(false);
          setStartedAt(null);
          setElapsed('00:00:00');
        }
      }
      if (data?.heartbeat) {
        setHeartbeat(new Date(data.heartbeat).toLocaleTimeString());
      }
      if (data?.userName) {
        setUserName(data.userName);
        setLoggedIn(true);
      }
    });

    window.agent?.getStatus().then((s:any) => {
      if (s?.userName) {
        setUserName(s.userName);
        setLoggedIn(true);
      }
      if (s?.status) {
        setStatus(s.status);
        setCheckedIn(Boolean(s.workSessionActive ?? s.sessionId ?? (s.status !== 'offline')));
        if (s.status === 'active' || s.status === 'break') {
          setStartedAt(s.startedAt || Date.now());
        }
        if (s.status === 'idle') setIdle(true);
      }
      if (s?.heartbeat) setHeartbeat(new Date(s.heartbeat).toLocaleTimeString());
    });

    refreshAlerts();

    window.agent?.onAlert((raw:any) => {
      const alert = normalizeAlert(raw);
      setAlerts((prev) => {
        const exists = prev.some((item) => item.id === alert.id);
        const next = exists ? prev.map((item) => item.id === alert.id ? alert : item) : [alert, ...prev];
        return next.slice(0, 20);
      });
      if (!alert.isRead) setActiveAlert(alert);
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    window.agent?.updater?.getStatus?.().then((statusData:any) => {
      if (!mounted) return;
      setUpdater((prev) => ({
        ...prev,
        currentVersion: statusData?.currentVersion || '',
        downloaded: Boolean(statusData?.downloaded),
        checking: Boolean(statusData?.checking),
        message: statusData?.downloadedVersion ? 'Update downloaded. Restart to install.' : prev.message,
      }));
    });

    const subscriptions = [
      window.agent?.updater?.on?.('updater:checking', (data:any) => {
        setUpdater((prev) => ({ ...prev, currentVersion: data?.currentVersion || prev.currentVersion, checking: true, error: '', progress: null, message: 'Checking for updates...' }));
      }),
      window.agent?.updater?.on?.('updater:available', (data:any) => {
        setUpdater((prev) => ({ ...prev, currentVersion: data?.currentVersion || prev.currentVersion, checking: false, error: '', message: `Version ${data?.version || ''} is available.`.trim() }));
      }),
      window.agent?.updater?.on?.('updater:not-available', (data:any) => {
        setUpdater((prev) => ({ ...prev, currentVersion: data?.currentVersion || prev.currentVersion, checking: false, error: '', progress: null, message: 'You are using the latest version.' }));
      }),
      window.agent?.updater?.on?.('updater:progress', (data:any) => {
        const percent = Number(data?.percent || 0);
        setUpdater((prev) => ({ ...prev, checking: false, error: '', progress: percent, message: `Downloading update ${Math.round(percent)}%` }));
      }),
      window.agent?.updater?.on?.('updater:downloaded', (data:any) => {
        setUpdater((prev) => ({ ...prev, currentVersion: data?.currentVersion || prev.currentVersion, checking: false, downloaded: true, progress: 100, error: '', message: 'Update downloaded. Restart to install.' }));
      }),
      window.agent?.updater?.on?.('updater:error', (data:any) => {
        setUpdater((prev) => ({ ...prev, currentVersion: data?.currentVersion || prev.currentVersion, checking: false, error: data?.message || 'Update check failed.', message: '' }));
      }),
    ].filter(Boolean);

    return () => {
      mounted = false;
      subscriptions.forEach((unsubscribe:any) => unsubscribe?.());
    };
  }, []);

  const checkForUpdates = async () => {
    setUpdater((prev) => ({ ...prev, checking: true, error: '', progress: null, message: 'Checking for updates...' }));
    const result = await window.agent?.updater?.check?.();
    if (result?.error) {
      setUpdater((prev) => ({ ...prev, checking: false, error: result.error, message: '' }));
    }
  };

  const installUpdate = async () => {
    const result = await window.agent?.updater?.install?.();
    if (result?.error) {
      setUpdater((prev) => ({ ...prev, error: result.error }));
    }
  };

  const runSessionAction = async (
    action: () => Promise<any>,
    successMessage: string,
    nextStatus: AgentStatus,
  ) => {
    if (actionPending) return;
    setActionPending(true);
    setActionFeedback(null);
    try {
      const result = await action();
      if (result?.ok === false) throw new Error(result.error || 'The action could not be completed.');
      setStatus(nextStatus);
      setCheckedIn(nextStatus !== 'offline');
      setIdle(false);
      if (nextStatus === 'active') setStartedAt((previous) => previous ?? Date.now());
      if (nextStatus === 'offline') {
        setStartedAt(null);
        setElapsed('00:00:00');
      }
      setActionFeedback({ kind: 'success', message: successMessage });
    } catch (error:any) {
      setActionFeedback({ kind: 'error', message: error?.message || 'Something went wrong. Please try again.' });
    } finally {
      setActionPending(false);
    }
  };

  return (
    <div className="vorion-app" style={{ fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', minHeight:'100vh', padding:20 }}>
      {activeAlert && (
        <div className="alert-backdrop" style={{ position:'fixed', inset:0, zIndex:50, display:'flex', alignItems:'center', justifyContent:'center', padding:20, backdropFilter:'blur(10px)' }}>
          <div className="alert-dialog" role="alertdialog" aria-modal="true" aria-labelledby="active-alert-title" style={{ width:'min(420px, 100%)', padding:22 }}>
            <div style={{ fontSize:11, fontWeight:800, color:'#f8d000', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:10 }}>New message</div>
            <h2 id="active-alert-title" style={{ margin:'0 0 10px', fontSize:22, lineHeight:1.25, color:'#f8fafc' }}>{activeAlert.title}</h2>
            <div style={{ fontSize:14, lineHeight:1.6, color:'#cbd5e1', whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{activeAlert.description}</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginTop:20 }}>
              <button onClick={() => setActiveAlert(null)} style={{ border:'1px solid rgba(255,255,255,0.14)', borderRadius:12, background:'rgba(255,255,255,0.05)', color:'#f8fafc', padding:'12px 14px', cursor:'pointer', fontSize:13, fontWeight:800 }}>
                Dismiss
              </button>
              <button onClick={() => markAlertRead(activeAlert.id)} style={{ border:'1px solid rgba(248,208,0,0.34)', borderRadius:12, background:'rgba(248,208,0,0.16)', color:'#fef9c3', padding:'12px 14px', cursor:'pointer', fontSize:13, fontWeight:800 }}>
                Mark Read
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="vorion-shell" style={{ maxWidth:480, margin:'0 auto', padding:28 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, marginBottom:8 }}>
          <div style={{ display:'flex', alignItems:'center', gap:14 }}>
            <img
              src="./logo.png"
              alt="Vorion Agent logo"
              style={{ width:52, height:52, objectFit:'contain', borderRadius:14, background:'rgba(255,255,255,0.04)', padding:6, boxShadow:'inset 0 1px 0 rgba(255,255,255,0.05)' }}
            />
            <div>
              <h1 style={{ margin:0, fontSize:26, fontWeight:700, color:'#f8fafc', textShadow:'0 0 12px rgba(248,250,252,0.16)' }}>Vorion Tracker</h1>
            </div>
          </div>
          {loggedIn && (
            <button onClick={async () => {
              await window.agent?.logout();
              setLoggedIn(false);
              setUserName('');
              setLoggedEmail('');
              setStatus('offline');
              setCheckedIn(false);
              setElapsed('00:00:00');
            }} style={{ border:'1px solid rgba(255,255,255,0.14)', borderRadius:999, background:'rgba(255,255,255,0.04)', color:'#f8fafc', padding:'8px 12px', cursor:'pointer', fontSize:12, fontWeight:700, boxShadow:'inset 0 1px 0 rgba(255,255,255,0.06)' }}>
              Logout
            </button>
          )}
        </div>

        {loggedIn ? (
          <>
            <div style={{ marginBottom:20, padding:20, borderRadius:20, background:'rgba(248,250,252,0.04)', border:'1px solid rgba(255,255,255,0.08)', boxShadow:'inset 0 1px 0 rgba(255,255,255,0.05)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <div>
                  <div style={{ fontSize:12, fontWeight:600, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.08em' }}>Status</div>
                  <div style={{ fontSize:22, fontWeight:700, color:'#f8fafc' }}>{LABELS[status]}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontSize:11, color:'#94a3b8' }}>Heartbeat</div>
                  <div style={{ fontSize:14, fontWeight:600, color:'#f8fafc' }}>{heartbeat || '--:--:--'}</div>
                </div>
              </div>
              <div style={{ display:'grid', gap:10, marginTop:10 }}>
                <div style={{ padding:'14px 16px', borderRadius:16, background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.08)', boxShadow:'inset 0 1px 0 rgba(255,255,255,0.05)' }}>
                  <div style={{ fontSize:11, color:'#94a3b8', marginBottom:6 }}>Session timer</div>
                  <div style={{ fontSize:28, fontWeight:700, color:'#f8fafc' }}>{elapsed}</div>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                  <span className={`activity-chip ${idle ? 'idle' : 'active'}`}>{idle ? 'Idle' : 'Active'}</span>
                  <span className="background-task-chip">Tracking background tasks</span>
                </div>
              </div>
            </div>

            <div style={{ marginBottom:16, padding:'14px 16px', borderRadius:16, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', boxShadow:'inset 0 1px 0 rgba(255,255,255,0.05)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', gap:8, alignItems:'center', marginBottom:8 }}>
                <div>
                  <div style={{ fontSize:13, fontWeight:700, color:'#f8fafc' }}>{userName || 'Employee'}</div>
                  <div style={{ fontSize:12, color:'#94a3b8' }}>{loggedEmail || 'Signed in user'}</div>
                </div>
                <button onClick={() => setAlertsOpen((prev) => !prev)} style={{ border:'1px solid rgba(255,255,255,0.14)', borderRadius:999, background:'rgba(255,255,255,0.04)', color:'#f8fafc', padding:'8px 12px', cursor:'pointer', fontSize:12, fontWeight:700 }}>
                  Messages {unreadCount > 0 ? `(${unreadCount})` : ''}
                </button>
              </div>
              {alertsOpen && (
                <div style={{ marginTop:12, display:'grid', gap:8 }}>
                  {alerts.length === 0 ? (
                    <div style={{ fontSize:12, color:'#94a3b8' }}>No messages yet.</div>
                  ) : alerts.map((alert) => (
                    <button key={alert.id} onClick={() => markAlertRead(alert.id)} style={{ textAlign:'left', border:'1px solid rgba(255,255,255,0.08)', borderRadius:12, padding:10, background: alert.isRead ? 'rgba(255,255,255,0.04)' : 'rgba(248,208,0,0.14)', cursor:'pointer' }}>
                      <div style={{ fontSize:12, fontWeight:700, color:'#f8fafc' }}>{alert.title}</div>
                      <div style={{ fontSize:11, color:'#cbd5e1', marginTop:4 }}>{alert.description}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display:'grid', gap:12 }}>
              {actionFeedback && (
                <div className={`action-feedback ${actionFeedback.kind}`} role="status" aria-live="polite">
                  <span className="action-feedback-icon" aria-hidden="true">{actionFeedback.kind === 'success' ? '✓' : '!'}</span>
                  {actionFeedback.message}
                </div>
              )}
              <button className="primary-action" disabled={checkedIn || actionPending} onClick={() => runSessionAction(() => window.agent.startWork(), 'You are checked in.', 'active')} style={{ width:'100%', padding:16, fontSize:15, fontWeight:700 }}>Check In</button>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <button className="secondary-action" disabled={!checkedIn || status === 'break' || actionPending} onClick={() => runSessionAction(() => window.agent.startBreak(), 'Your break has started.', 'break')} style={{ width:'100%', padding:14, fontSize:14, fontWeight:700 }}>Start Break</button>
                <button className="secondary-action" disabled={!checkedIn || status !== 'break' || actionPending} onClick={() => runSessionAction(() => window.agent.endBreak(), 'Your break has ended. You are checked in.', 'active')} style={{ width:'100%', padding:14, fontSize:14, fontWeight:700 }}>End Break</button>
              </div>
              <button className="checkout-action" disabled={!checkedIn || actionPending} onClick={() => runSessionAction(() => window.agent.checkout(), 'You are checked out. Have a great day!', 'offline')} style={{ width:'100%', padding:16, fontSize:15, fontWeight:700 }}>Checkout</button>
            </div>

            <p style={{ marginTop:22, fontSize:12, color:'#64748b', lineHeight:1.75 }}>Use the workday controls to keep your time accurate.</p>
          </>
        ) : (
          <div style={{ display:'grid', gap:12 }}>
            <div style={{ padding:'22px', borderRadius:20, background:'rgba(248,250,252,0.04)', border:'1px solid rgba(255,255,255,0.08)', boxShadow:'inset 0 1px 0 rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize:15, fontWeight:700, marginBottom:14, color:'#f8fafc' }}>Employee sign in</div>
              <label style={{ display:'block', marginBottom:14, color:'#cbd5e1', fontSize:13, fontWeight:600 }}>
                <span style={{ display:'block', marginBottom:8 }}>Email</span>
                <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Enter your email" style={{ width:'100%', marginTop:0, padding:'12px 14px', borderRadius:12, border:'1px solid rgba(255,255,255,0.14)', background:'rgba(255,255,255,0.06)', color:'#f8fafc', outline:'none', fontSize:13, boxSizing:'border-box' }} />
              </label>
              <label style={{ display:'block', marginBottom:14, color:'#cbd5e1', fontSize:13, fontWeight:600 }}>
                <span style={{ display:'block', marginBottom:8 }}>Password</span>
                <input type='password' value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" style={{ width:'100%', marginTop:0, padding:'12px 14px', borderRadius:12, border:'1px solid rgba(255,255,255,0.14)', background:'rgba(255,255,255,0.06)', color:'#f8fafc', outline:'none', fontSize:13, boxSizing:'border-box' }} />
              </label>
              {loginError && <div style={{ color:'#fda4af', marginBottom:10, fontSize:12, fontWeight:600 }}>{loginError}</div>}
              <button onClick={async () => {
                setLoginError('');
                const result = await window.agent?.login(email, password);
                if (result?.ok) {
                  setUserName(result.user?.name || 'Employee');
                  setLoggedIn(true);
                  setStatus('offline');
                  setCheckedIn(false);
                  setStartedAt(null);
                } else {
                  setLoginError(result?.error || 'Login failed');
                }
              }} style={{ width:'100%', padding:16, borderRadius:16, border:'1px solid rgba(248,208,0,0.25)', background:'linear-gradient(135deg, #111827 0%, #1f2937 100%)', color:'#fff', fontSize:15, fontWeight:700, cursor:'pointer', boxShadow:'0 0 16px rgba(248,208,0,0.16)' }}>Sign in</button>
            </div>
          </div>
        )}

        <div style={{ marginTop:18, padding:'14px 16px', borderRadius:16, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', boxShadow:'inset 0 1px 0 rgba(255,255,255,0.05)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:12, fontWeight:700, color:'#f8fafc' }}>Vorion Tracker {updater.currentVersion || ''}</div>
              <div style={{ fontSize:12, color: updater.error ? '#fda4af' : '#94a3b8', marginTop:4 }}>{updater.error || updater.message || 'Updates are checked automatically in the installed app.'}</div>
            </div>
            {updater.downloaded ? (
              <button onClick={installUpdate} style={{ border:'1px solid rgba(34,197,94,0.32)', borderRadius:12, background:'rgba(34,197,94,0.16)', color:'#dcfce7', padding:'9px 12px', cursor:'pointer', fontSize:12, fontWeight:700 }}>
                Restart and Update
              </button>
            ) : (
              <button disabled={updater.checking} onClick={checkForUpdates} style={{ border:'1px solid rgba(255,255,255,0.14)', borderRadius:12, background:'rgba(255,255,255,0.04)', color:'#f8fafc', padding:'9px 12px', cursor: updater.checking ? 'default' : 'pointer', fontSize:12, fontWeight:700, opacity: updater.checking ? 0.7 : 1 }}>
                {updater.checking ? 'Checking...' : 'Check for Updates'}
              </button>
            )}
          </div>
          {updater.progress !== null && updater.progress < 100 && (
            <div style={{ height:6, borderRadius:999, background:'rgba(255,255,255,0.08)', overflow:'hidden', marginTop:12 }}>
              <div style={{ height:'100%', width:`${Math.max(0, Math.min(100, updater.progress))}%`, background:'#f8d000' }} />
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
