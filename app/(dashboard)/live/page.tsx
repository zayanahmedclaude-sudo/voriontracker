'use client';

import { useEffect, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { LogLevel, Room, RoomEvent, Track, setLogLevel } from 'livekit-client';
import { useAuthStore, canSendAlerts } from '@/store/auth';
import { useRouter } from 'next/navigation';
import { LiveWatchModal } from './components/LiveWatchModal';

const LIVEKIT_RETRY_COOLDOWN_MS = 10000;
const LIVEKIT_RETRY_COOLDOWN_STORAGE_KEY = 'vorion-livekit-viewer-retry-after';
const LIVE_VIEW_AGENT_WAIT_MS = 70000;
const LIVE_VIEW_AGENT_POLL_MS = 2500;

interface Employee {
  id: string;
  name: string;
  account_status?: string | null;
}

interface AgentCard {
  employeeId: string;
  name: string;
  status: string;
  online: boolean;
  lastUrl?: string;
  activeApp?: string;
  lastSeen?: string | null;
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background:
      'radial-gradient(1200px 600px at 20% 0%, rgba(0,80,176,.22), transparent 60%), radial-gradient(900px 500px at 80% 20%, rgba(248,208,0,.12), transparent 55%), #0B0F1A',
    color: '#F8FAFC',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
    padding: '28px 32px',
  },
  topRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 24,
  },
  heading: {
    fontSize: 22,
    fontWeight: 600,
    margin: 0,
    color: '#F8FAFC',
  },
  subtext: {
    fontSize: 13,
    color: 'rgba(248,250,252,.55)',
    marginTop: 4,
  },
  livePill: {
    fontSize: 12,
    color: '#4ADE80',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  onlinePill: {
    fontSize: 12,
    color: 'rgba(248,250,252,.6)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'rgba(248,250,252,.04)',
    border: '1px solid rgba(248,250,252,.08)',
    borderRadius: 999,
    padding: '5px 12px',
  },
  card: {
    border: '1px solid rgba(248,250,252,.10)',
    background: 'rgba(11,15,26,.72)',
    backdropFilter: 'blur(10px)',
    borderRadius: 16,
    boxShadow: '0 8px 24px rgba(0,0,0,.22)',
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'rgba(248,250,252,.45)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid rgba(248,250,252,.12)',
    background: 'rgba(248,250,252,.05)',
    color: '#F8FAFC',
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
    colorScheme: 'dark',
  },
  emptyState: {
    padding: 32,
    textAlign: 'center',
    color: 'rgba(248,250,252,.3)',
    fontSize: 12,
  },
};

export default function LiveMonitorPage() {
  const { token, user } = useAuthStore();
  const router = useRouter();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [alertMsg, setAlertMsg] = useState('');
  const [alertTo, setAlertTo] = useState('');
  const [sending, setSending] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [isConnectingStream, setIsConnectingStream] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamState, setStreamState] = useState('Idle');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [isEnlarged, setIsEnlarged] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const roomRef = useRef<Room | null>(null);
  const pendingRoomRef = useRef<Room | null>(null);
  const connectionAttemptRef = useRef(0);
  const connectionInFlightRef = useRef(false);
  const retryAfterRef = useRef(0);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);
  const recordingStartRef = useRef<number | null>(null);
  const selectedEmployeeRef = useRef<Employee | null>(null);
  const liveRequestIdRef = useRef<string | null>(null);

  function getLiveKitRetryAfter(employeeId: string) {
    if (typeof window === 'undefined') return retryAfterRef.current;
    const stored = Number(window.sessionStorage.getItem(`${LIVEKIT_RETRY_COOLDOWN_STORAGE_KEY}:${employeeId}`) || 0);
    return Math.max(retryAfterRef.current, Number.isFinite(stored) ? stored : 0);
  }

  function setLiveKitRetryAfter(employeeId: string, retryAfter: number) {
    retryAfterRef.current = retryAfter;
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(`${LIVEKIT_RETRY_COOLDOWN_STORAGE_KEY}:${employeeId}`, String(retryAfter));
    }
  }

  useEffect(() => {
    selectedEmployeeRef.current = selectedEmployee;
  }, [selectedEmployee]);

  useEffect(() => {
    setLogLevel(LogLevel.error);
  }, []);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const response = await fetch('/api/users', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return;
        const users = await response.json();
        setEmployees(
          users
            .filter((entry: any) => entry.role === 'employee' && String(entry.account_status || 'active').toLowerCase() !== 'terminated')
            .map((entry: any) => ({ id: entry.id, name: entry.name, account_status: entry.account_status })),
        );
      } catch (error) {
        console.error('Failed to load users', error);
      }
    })();
  }, [token]);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    const loadAgents = async () => {
      try {
        const response = await fetch('/api/live/agents', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (!response.ok) return;
        const payload = await response.json();
        if (!cancelled) {
          setAgents(payload);
        }
      } catch (error) {
        console.error('Failed to load live agents', error);
      }
    };

    void loadAgents();
    const timer = setInterval(() => {
      void loadAgents();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  useEffect(() => {
    return () => {
      void stopLiveViewRequest();
      disconnectRoom();
      stopRecording();
    };
  }, []);

  useEffect(() => {
    if (!token || !selectedEmployee) return;
    const timer = setInterval(() => {
      const requestId = liveRequestIdRef.current;
      if (!requestId) return;
      void fetch('/api/live/request', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requestId, action: 'viewer_heartbeat' }),
      }).catch(() => undefined);
    }, 20000);

    return () => clearInterval(timer);
  }, [selectedEmployee, token]);

  function attachRemoteTrack(track: any) {
    const stream = new MediaStream([track.mediaStreamTrack]);
    remoteStreamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => undefined);
    }
    setIsStreaming(true);
    setIsConnectingStream(false);
    setStreamState('Connected');
    setStreamError(null);
  }

  function disconnectRoom(cancelPending = true) {
    if (cancelPending) {
      connectionAttemptRef.current += 1;
      connectionInFlightRef.current = false;
    }
    pendingRoomRef.current?.disconnect();
    pendingRoomRef.current = null;
    roomRef.current?.disconnect();
    roomRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    remoteStreamRef.current = null;
    setIsStreaming(false);
    setIsConnectingStream(false);
  }

  async function stopLiveViewRequest() {
    const requestId = liveRequestIdRef.current;
    liveRequestIdRef.current = null;
    if (!requestId || !token) return;
    await fetch('/api/live/request', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requestId, action: 'stop' }),
    }).catch(() => undefined);
  }

  async function waitForLiveViewAgent(requestId: string, attemptId: number) {
    const deadline = Date.now() + LIVE_VIEW_AGENT_WAIT_MS;
    while (Date.now() < deadline) {
      if (attemptId !== connectionAttemptRef.current) return false;
      const response = await fetch(`/api/live/request?requestId=${encodeURIComponent(requestId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || 'Unable to check live view request');
      }
      const status = String(payload?.request?.status || '');
      if (status === 'active') return true;
      if (status === 'stopped') {
        throw new Error('Live view request was stopped before the agent started streaming');
      }
      setStreamState('Waiting for employee agent');
      await new Promise((resolve) => setTimeout(resolve, LIVE_VIEW_AGENT_POLL_MS));
    }
    return false;
  }

  async function connectToEmployee(employee: Employee) {
    if (!token) return;
    if (connectionInFlightRef.current) return;
    const cooldownRemainingMs = getLiveKitRetryAfter(employee.id) - Date.now();
    if (cooldownRemainingMs > 0) {
      setSelectedEmployee(employee);
      setAlertTo(employee.id);
      setIsConnectingStream(false);
      setIsStreaming(false);
      setStreamState('Rate limited');
      setStreamError(`LiveKit is cooling down. Try again in ${Math.ceil(cooldownRemainingMs / 1000)}s.`);
      return;
    }

    connectionInFlightRef.current = true;
    const attemptId = connectionAttemptRef.current + 1;
    connectionAttemptRef.current = attemptId;
    disconnectRoom(false);
    setSelectedEmployee(employee);
    setAlertTo(employee.id);
    setIsConnectingStream(true);
    setStreamState('Connecting');
    setStreamError(null);

    try {
      const requestResponse = await fetch('/api/live/request', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ employeeId: employee.id }),
      });
      const requestPayload = await requestResponse.json().catch(() => ({}));
      if (attemptId !== connectionAttemptRef.current) return;
      if (!requestResponse.ok) {
        setIsConnectingStream(false);
        setIsStreaming(false);
        setStreamState('Unavailable');
        setStreamError(requestPayload?.error || 'Unable to request live view');
        return;
      }
      liveRequestIdRef.current = requestPayload.requestId || null;
      if (liveRequestIdRef.current) {
        void fetch('/api/live/request', {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ requestId: liveRequestIdRef.current, action: 'viewer_heartbeat' }),
        }).catch(() => undefined);
      }
      setStreamState('Waiting for employee agent');
      if (liveRequestIdRef.current) {
        const agentAccepted = await waitForLiveViewAgent(liveRequestIdRef.current, attemptId);
        if (attemptId !== connectionAttemptRef.current) return;
        if (!agentAccepted) {
          setIsConnectingStream(false);
          setIsStreaming(false);
          setStreamState('Agent not streaming');
          setStreamError('The employee agent did not start live streaming. Make sure the employee app is updated and running.');
          return;
        }
      }

      const response = await fetch('/api/live/viewer-token', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ employeeId: employee.id, requestId: liveRequestIdRef.current }),
      });

      const payload = await response.json().catch(() => ({}));
      if (attemptId !== connectionAttemptRef.current) return;
      if (!response.ok) {
        if (response.status === 429) {
          const retryAfterMs = Number(payload?.retryAfterMs || LIVEKIT_RETRY_COOLDOWN_MS);
          const retryAfter = Date.now() + Math.max(1000, retryAfterMs);
          setLiveKitRetryAfter(employee.id, retryAfter);
          setIsConnectingStream(false);
          setIsStreaming(false);
          setStreamState('Rate limited');
          setStreamError(`LiveKit is cooling down. Try again in ${Math.ceil((retryAfter - Date.now()) / 1000)}s.`);
          return;
        }
        setIsConnectingStream(false);
        setIsStreaming(false);
        setStreamState('Unavailable');
        setStreamError(payload?.error || 'Employee is not currently streaming');
        return;
      }

      const room = new Room();
      pendingRoomRef.current = room;
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (roomRef.current !== room && pendingRoomRef.current !== room) return;
        setStreamState(String(state));
      });
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (roomRef.current !== room && pendingRoomRef.current !== room) return;
        if (track.kind === Track.Kind.Video) {
          attachRemoteTrack(track);
        }
      });
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return;
        setIsStreaming(false);
        setIsConnectingStream(false);
        if (!streamError) {
          setStreamState('Disconnected');
        }
      });

      await room.connect(payload.livekitUrl, payload.token, {
        maxRetries: 0,
        websocketTimeout: 10000,
      });
      if (attemptId !== connectionAttemptRef.current) {
        room.disconnect();
        return;
      }
      pendingRoomRef.current = null;
      roomRef.current = room;

      const existingVideoPublication = Array.from(room.remoteParticipants.values())
        .flatMap((participant) => Array.from(participant.trackPublications.values()))
        .find((publication: any) => publication.kind === Track.Kind.Video && publication.track);

      if (existingVideoPublication?.track) {
        attachRemoteTrack(existingVideoPublication.track);
      } else {
        setStreamState('Waiting for screen share');
        setIsConnectingStream(false);
        setIsStreaming(false);
      }
    } catch (error: any) {
      if (attemptId !== connectionAttemptRef.current) return;
      setIsConnectingStream(false);
      setIsStreaming(false);
      setStreamState('Error');
      const message = String(error?.message || '');
      const isLiveKitConnectionFailure = /429|too many requests|rate|signal connection|websocket error|connection establishment/i.test(message);
      if (isLiveKitConnectionFailure) {
        setLiveKitRetryAfter(employee.id, Date.now() + LIVEKIT_RETRY_COOLDOWN_MS);
        setStreamError('LiveKit is rate limiting or refusing websocket joins. Wait 10s, then try again.');
      } else {
        setStreamError(message || 'Unable to start the live stream');
      }
    } finally {
      if (attemptId === connectionAttemptRef.current) {
        connectionInFlightRef.current = false;
      }
    }
  }

  async function startRecording() {
    if (!remoteStreamRef.current || !selectedEmployeeRef.current) return;
    try {
      recordedChunksRef.current = [];
      recordingStartRef.current = Date.now();
      setRecordingError(null);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : MediaRecorder.isTypeSupported('video/webm')
          ? 'video/webm'
          : '';
      const recorder = mimeType
        ? new MediaRecorder(remoteStreamRef.current, { mimeType })
        : new MediaRecorder(remoteStreamRef.current);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data);
      };
      recorder.onerror = (event) => {
        setRecordingError(event.error?.message || 'Recording failed');
      };
      recorder.onstop = async () => {
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'video/webm' });
        const durationMs = Date.now() - (recordingStartRef.current || Date.now());
        const employeeId = selectedEmployeeRef.current?.id || '';
        const startTime = new Date(recordingStartRef.current || Date.now()).toISOString();
        const endTime = new Date().toISOString();
        const duration = Math.max(1, Math.round(durationMs / 1000));
        try {
          const uploaded = await upload(`live-recordings/${employeeId}/live-${Date.now()}.webm`, blob, {
            access: 'public',
            contentType: 'video/webm',
            multipart: false,
            handleUploadUrl: '/api/blob/client-upload',
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            clientPayload: JSON.stringify({ kind: 'live-recording', employeeId, attempt: 1, firstAttempt: true }),
          });
          const response = await fetch('/api/live-recordings', {
            method: 'POST',
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              employeeId,
              adminId: user?.id || '',
              startTime,
              endTime,
              duration,
              fileUrl: uploaded.url,
            }),
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data?.error || 'Recording upload failed');
          }
        } catch (error: any) {
          setRecordingError(error?.message || 'Recording upload failed');
        }
      };
      recorder.start();
      setIsRecording(true);
    } catch (error: any) {
      setRecordingError(error?.message || 'Failed to start recording');
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    setIsRecording(false);
  }

  async function sendAlert() {
    if (!alertTo || !alertMsg || !token) return;

    setSending(true);
    try {
      const response = await fetch('/api/alerts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          employee_id: alertTo,
          alert_type: 'live_alert',
          title: 'Live monitor alert',
          description: alertMsg,
          severity: 'medium',
          metadata: {},
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error || 'Failed to send alert');
      }

      setAlertMsg('');
    } catch (error) {
      console.error(error);
    } finally {
      setSending(false);
    }
  }

  const role = user?.role as any;
  const onlineCount = agents.filter((agent) => agent.online).length;

  return (
    <div style={styles.page}>
      <div style={styles.topRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => router.back()}
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              border: '1px solid rgba(248,208,0,.35)',
              background: 'linear-gradient(180deg, rgba(248,208,0,.5), rgba(248,208,0,.3))',
              color: '#0B0F1A',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Back
          </button>
          <div>
            <h1 style={styles.heading}>Live Monitor</h1>
            <p style={styles.subtext}>LiveKit-based employee screen streaming</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={styles.onlinePill}>
            <strong style={{ color: '#4ADE80' }}>{onlineCount}</strong> online
          </span>
          <span style={styles.livePill}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22C55E', display: 'inline-block', boxShadow: '0 0 6px #22C55E' }} />
            LiveKit live view
          </span>
        </div>
      </div>

      {canSendAlerts(role) && (
        <div
          style={{
            ...styles.card,
            padding: '14px 16px',
            marginBottom: 20,
            display: 'flex',
            gap: 10,
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: '1 1 180px' }}>
            <label style={{ ...styles.sectionLabel, display: 'block', marginBottom: 6 }}>Send alert to</label>
            <select value={alertTo} onChange={(event) => setAlertTo(event.target.value)} style={{ ...styles.input, cursor: 'pointer' }}>
              <option value="" style={{ background: '#0B0F1A', color: '#F8FAFC' }}>Select employee...</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id} style={{ background: '#0B0F1A', color: '#F8FAFC' }}>
                  {employee.name}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: '2 1 240px' }}>
            <label style={{ ...styles.sectionLabel, display: 'block', marginBottom: 6 }}>Message</label>
            <input
              value={alertMsg}
              onChange={(event) => setAlertMsg(event.target.value)}
              placeholder="e.g. Please focus on your current task"
              style={styles.input}
            />
          </div>
          <button
            onClick={() => void sendAlert()}
            disabled={sending || !alertTo || !alertMsg}
            style={{
              padding: '9px 18px',
              borderRadius: 10,
              background: 'linear-gradient(180deg, rgba(248,208,0,.5), rgba(248,208,0,.3))',
              border: '1px solid rgba(248,208,0,.5)',
              color: '#0B0F1A',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              opacity: sending || !alertTo || !alertMsg ? 0.5 : 1,
            }}
          >
            {sending ? 'Sending...' : 'Send Alert'}
          </button>
        </div>
      )}

      {agents.length === 0 ? (
        <div style={{ ...styles.card, ...styles.emptyState }}>
          No agents connected yet. Cards will appear here once an employee&apos;s agent comes online.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 14 }}>
          {agents.map((agent) => (
            <button
              key={agent.employeeId}
              onClick={() => {
                if (!agent.online || connectionInFlightRef.current) return;
                void connectToEmployee({ id: agent.employeeId, name: agent.name });
              }}
              style={{
                border: `1px solid ${agent.online ? 'rgba(34,197,94,.3)' : 'rgba(248,250,252,.08)'}`,
                background: 'rgba(11,15,26,.72)',
                backdropFilter: 'blur(10px)',
                borderRadius: 14,
                overflow: 'hidden',
                boxShadow: agent.online ? '0 0 18px rgba(34,197,94,.08)' : '0 8px 20px rgba(0,0,0,.2)',
                textAlign: 'left',
                cursor: agent.online ? 'pointer' : 'default',
              }}
            >
              <div style={{ aspectRatio: '16/9', background: 'rgba(248,250,252,.03)', position: 'relative', overflow: 'hidden' }}>
                {agent.lastUrl ? (
                  <img src={agent.lastUrl} alt="screen" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(248,250,252,.2)', fontSize: 12 }}>
                    {agent.online ? 'Tap to view live screen' : 'Offline'}
                  </div>
                )}
                {agent.online && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 8,
                      left: 8,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      background: 'rgba(0,0,0,.6)',
                      borderRadius: 999,
                      padding: '3px 8px',
                      fontSize: 10,
                      color: '#fff',
                    }}
                  >
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#ef4444', display: 'inline-block', boxShadow: '0 0 4px #ef4444' }} />
                    Live
                  </div>
                )}
              </div>

              <div style={{ padding: '10px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#F8FAFC' }}>{agent.name}</span>
                  <span
                    style={{
                      fontSize: 10,
                      padding: '2px 8px',
                      borderRadius: 999,
                      fontWeight: 600,
                      background: agent.online ? 'rgba(34,197,94,.1)' : 'rgba(248,250,252,.05)',
                      color: agent.online ? '#4ADE80' : 'rgba(248,250,252,.3)',
                      border: `1px solid ${agent.online ? 'rgba(34,197,94,.2)' : 'rgba(248,250,252,.08)'}`,
                    }}
                  >
                    {agent.status}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'rgba(248,250,252,.35)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.activeApp || '-'}</span>
                  <span>{agent.lastSeen ? new Date(agent.lastSeen).toLocaleTimeString() : ''}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {selectedEmployee && (
        <LiveWatchModal
          videoRef={videoRef}
          isConnecting={isConnectingStream}
          isStreaming={isStreaming}
          employeeName={selectedEmployee.name}
          connectionState={streamState}
          error={streamError || recordingError}
          isEnlarged={isEnlarged}
          isRecording={isRecording}
          onClose={() => {
            void stopLiveViewRequest();
            disconnectRoom();
            stopRecording();
            setSelectedEmployee(null);
            setIsEnlarged(false);
          }}
          onRefresh={() => void connectToEmployee(selectedEmployee)}
          onStartRecording={startRecording}
          onStopRecording={stopRecording}
          onFullscreen={() => setIsEnlarged((value) => !value)}
        />
      )}
    </div>
  );
}
