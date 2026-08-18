'use client';

import { apiFetch } from '@/lib/api-client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { LogLevel, Room, RoomEvent, Track, setLogLevel } from 'livekit-client';
import { useAuthStore, canSendAlerts } from '@/store/auth';
import { LiveWatchModal } from './components/LiveWatchModal';

const LIVEKIT_RETRY_COOLDOWN_MS = 10000;
const LIVEKIT_RETRY_COOLDOWN_STORAGE_KEY = 'vorion-livekit-viewer-retry-after';
const LIVE_VIEW_AGENT_WAIT_MS = 70000;
const LIVE_VIEW_AGENT_POLL_MS = 2500;
const LIVE_AGENT_LIST_REFRESH_MS = 60_000;
const LIVE_VIEWER_HEARTBEAT_MS = 60_000;
const BRAND = {
  ink: '#0A0A0A',
  surface: '#FFFFFF',
  canvas: '#F7F8FB',
  blue: '#0050B0',
  blueSoft: 'rgba(0,80,176,.08)',
  border: 'rgba(10,10,10,.10)',
  muted: 'rgba(10,10,10,.58)',
  mutedFaint: 'rgba(10,10,10,.38)',
  success: '#067647',
  successSoft: 'rgba(6,118,71,.10)',
  warning: '#B54708',
  warningSoft: 'rgba(181,71,8,.10)',
  shadow: '0 18px 48px rgba(15,23,42,.06)',
};

interface Employee {
  id: string;
  name: string;
  account_status?: string | null;
}

interface AgentCard {
  employeeId: string;
  name: string;
  departmentId?: string | null;
  departmentName?: string | null;
  status: string;
  online: boolean;
  lastUrl?: string;
  activeApp?: string;
  lastSeen?: string | null;
}

type ActivityTone = 'working' | 'idle' | 'offline';

const styles: Record<string, React.CSSProperties> = {
  page: {
    color: BRAND.ink,
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
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
    fontSize: 34,
    fontWeight: 800,
    margin: 0,
    color: BRAND.ink,
  },
  subtext: {
    fontSize: 14,
    color: BRAND.muted,
    marginTop: 6,
  },
  livePill: {
    fontSize: 12,
    color: BRAND.blue,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: BRAND.blueSoft,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 999,
    padding: '6px 12px',
  },
  onlinePill: {
    fontSize: 13,
    color: BRAND.muted,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: BRAND.surface,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 999,
    padding: '7px 14px',
  },
  statCard: {
    border: `1px solid ${BRAND.border}`,
    background: BRAND.surface,
    borderRadius: 22,
    boxShadow: BRAND.shadow,
    padding: 18,
  },
  card: {
    border: `1px solid ${BRAND.border}`,
    background: BRAND.surface,
    borderRadius: 22,
    boxShadow: BRAND.shadow,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: BRAND.mutedFaint,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 14,
    border: `1px solid ${BRAND.border}`,
    background: BRAND.surface,
    color: BRAND.ink,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
    colorScheme: 'light',
  },
  emptyState: {
    padding: 32,
    textAlign: 'center',
    color: BRAND.muted,
    fontSize: 13,
  },
};

function getActivityTone(status: string, online: boolean): ActivityTone {
  if (!online) return 'offline';
  const normalized = String(status || '').toLowerCase();
  if (['idle', 'on_break', 'break'].includes(normalized)) return 'idle';
  return 'working';
}

function getActivityLabel(status: string, online: boolean) {
  const tone = getActivityTone(status, online);
  if (tone === 'offline') return 'Offline';
  if (tone === 'idle') return 'Idle';
  return 'Working';
}

function getActivityColors(tone: ActivityTone) {
  if (tone === 'working') {
    return {
      bg: BRAND.successSoft,
      fg: BRAND.success,
      border: 'rgba(6,118,71,.16)',
      dot: BRAND.success,
    };
  }
  if (tone === 'idle') {
    return {
      bg: BRAND.warningSoft,
      fg: BRAND.warning,
      border: 'rgba(181,71,8,.18)',
      dot: BRAND.warning,
    };
  }
  return {
    bg: 'rgba(10,10,10,.04)',
    fg: BRAND.muted,
    border: BRAND.border,
    dot: 'rgba(10,10,10,.36)',
  };
}

function formatLastSeen(lastSeen?: string | null, online?: boolean) {
  if (online) return 'Active now';
  if (!lastSeen) return 'No recent heartbeat';
  return `Last seen ${new Date(lastSeen).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

export default function LiveMonitorPage() {
  const { token, user } = useAuthStore();
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
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchFilter, setSearchFilter] = useState('');
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
        const response = await apiFetch<Response>('/api/users', {
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
        const response = await apiFetch<Response>('/api/live/agents', {
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
    }, LIVE_AGENT_LIST_REFRESH_MS);

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
      void apiFetch<Response>('/api/live/request', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requestId, action: 'viewer_heartbeat' }),
      }).catch(() => undefined);
    }, LIVE_VIEWER_HEARTBEAT_MS);

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
    await apiFetch<Response>('/api/live/request', {
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
      const response = await apiFetch<Response>(`/api/live/request?requestId=${encodeURIComponent(requestId)}`, {
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
      const requestResponse = await apiFetch<Response>('/api/live/request', {
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
        void apiFetch<Response>('/api/live/request', {
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

      const response = await apiFetch<Response>('/api/live/viewer-token', {
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
          const key = `live-recordings/${employeeId}/live-${Date.now()}.webm`;
          const targetResponse = await apiFetch<Response>('/api/r2/client-upload', {
            method: 'POST',
            headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'live-recording', employeeId, key, contentType: 'video/webm' }),
          });
          if (!targetResponse.ok) throw new Error('Could not authorize R2 upload');
          const uploaded = await targetResponse.json();
          const putResponse = await fetch(uploaded.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: blob });
          if (!putResponse.ok) throw new Error('R2 upload failed');
          const response = await apiFetch<Response>('/api/live-recordings', {
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
      const response = await apiFetch<Response>('/api/alerts', {
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
  const offlineCount = agents.length - onlineCount;
  const activeDepartments = new Set(agents.map((agent) => agent.departmentId || '__unassigned__')).size;
  const departments = useMemo(() => {
    const byId = new Map<string, string>();
    for (const agent of agents) {
      const id = agent.departmentId || '__unassigned__';
      const name = agent.departmentName || 'Unassigned';
      byId.set(id, name);
    }
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [agents]);
  const filteredAgents = useMemo(() => {
    const query = searchFilter.trim().toLowerCase();
    return agents.filter((agent) => {
      if (statusFilter === 'online' && !agent.online) return false;
      if (statusFilter === 'offline' && agent.online) return false;
      if (departmentFilter) {
        const agentDepartmentId = agent.departmentId || '__unassigned__';
        if (agentDepartmentId !== departmentFilter) return false;
      }
      if (employeeFilter && agent.employeeId !== employeeFilter) return false;
      if (query) {
        const haystack = [
          agent.name,
          agent.departmentName || 'Unassigned',
          agent.activeApp || '',
          agent.status || '',
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [agents, departmentFilter, employeeFilter, searchFilter, statusFilter]);
  const filteredOnlineCount = filteredAgents.filter((agent) => agent.online).length;

  return (
    <div style={styles.page}>
      <div style={styles.topRow}>
        <div>
          <h1 style={styles.heading}>Live Monitor</h1>
          <p style={styles.subtext}>Monitor active workstations, review availability, and open live sessions when needed.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={styles.onlinePill}>
            <strong style={{ color: BRAND.success }}>{onlineCount}</strong> online
          </span>
          <span style={styles.onlinePill}>
            <strong style={{ color: BRAND.warning }}>{offlineCount}</strong> offline
          </span>
          <span style={styles.livePill}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: BRAND.blue, display: 'inline-block' }} />
            Real-time session access
          </span>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 14,
          marginBottom: 20,
        }}
      >
        <div style={styles.statCard}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: BRAND.mutedFaint, marginBottom: 8 }}>
            Workforce Online
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, color: BRAND.ink }}>{onlineCount}</div>
          <div style={{ fontSize: 13, color: BRAND.muted, marginTop: 6 }}>Employees ready for live monitoring</div>
        </div>
        <div style={styles.statCard}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: BRAND.mutedFaint, marginBottom: 8 }}>
            Offline
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, color: BRAND.ink }}>{offlineCount}</div>
          <div style={{ fontSize: 13, color: BRAND.muted, marginTop: 6 }}>Agents currently not reachable</div>
        </div>
        <div style={styles.statCard}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: BRAND.mutedFaint, marginBottom: 8 }}>
            Departments
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, color: BRAND.ink }}>{activeDepartments}</div>
          <div style={{ fontSize: 13, color: BRAND.muted, marginTop: 6 }}>Teams represented in the live grid</div>
        </div>
        <div style={styles.statCard}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: BRAND.mutedFaint, marginBottom: 8 }}>
            Filtered Results
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, color: BRAND.ink }}>{filteredAgents.length}</div>
          <div style={{ fontSize: 13, color: BRAND.muted, marginTop: 6 }}>{filteredOnlineCount} online in the current selection</div>
        </div>
      </div>

      <div
        style={{
          ...styles.card,
          padding: 18,
          marginBottom: 20,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
          alignItems: 'end',
        }}
      >
        <div>
          <label style={{ ...styles.sectionLabel, display: 'block', marginBottom: 6 }}>Search</label>
          <input
            value={searchFilter}
            onChange={(event) => setSearchFilter(event.target.value)}
            placeholder="Search employee, department, or app"
            style={styles.input}
          />
        </div>
        <div>
          <label style={{ ...styles.sectionLabel, display: 'block', marginBottom: 6 }}>Availability</label>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={{ ...styles.input, cursor: 'pointer' }}>
            <option value="all" style={{ background: BRAND.surface, color: BRAND.ink }}>All statuses</option>
            <option value="online" style={{ background: BRAND.surface, color: BRAND.ink }}>Online only</option>
            <option value="offline" style={{ background: BRAND.surface, color: BRAND.ink }}>Offline only</option>
          </select>
        </div>
        <div>
          <label style={{ ...styles.sectionLabel, display: 'block', marginBottom: 6 }}>Department</label>
          <select
            value={departmentFilter}
            onChange={(event) => {
              setDepartmentFilter(event.target.value);
              setEmployeeFilter('');
            }}
            style={{ ...styles.input, cursor: 'pointer' }}
          >
            <option value="" style={{ background: BRAND.surface, color: BRAND.ink }}>All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id} style={{ background: BRAND.surface, color: BRAND.ink }}>
                {department.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ ...styles.sectionLabel, display: 'block', marginBottom: 6 }}>Employee</label>
          <select value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)} style={{ ...styles.input, cursor: 'pointer' }}>
            <option value="" style={{ background: BRAND.surface, color: BRAND.ink }}>All employees</option>
            {agents
              .filter((agent) => !departmentFilter || (agent.departmentId || '__unassigned__') === departmentFilter)
              .map((agent) => (
                <option key={agent.employeeId} value={agent.employeeId} style={{ background: BRAND.surface, color: BRAND.ink }}>
                  {agent.name}
                </option>
              ))}
          </select>
        </div>
        {(departmentFilter || employeeFilter || statusFilter !== 'all' || searchFilter) && (
          <button
            onClick={() => {
              setDepartmentFilter('');
              setEmployeeFilter('');
              setStatusFilter('all');
              setSearchFilter('');
            }}
            style={{
              padding: '12px 14px',
              borderRadius: 14,
              border: `1px solid ${BRAND.border}`,
              background: BRAND.canvas,
              color: BRAND.ink,
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {canSendAlerts(role) && (
        <div
          style={{
            ...styles.card,
            padding: '18px 20px',
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
              <option value="" style={{ background: BRAND.surface, color: BRAND.ink }}>Select employee...</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id} style={{ background: BRAND.surface, color: BRAND.ink }}>
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
              padding: '11px 18px',
              borderRadius: 14,
              background: BRAND.blue,
              border: `1px solid ${BRAND.blue}`,
              color: '#FFFFFF',
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
      ) : filteredAgents.length === 0 ? (
        <div style={{ ...styles.card, ...styles.emptyState }}>
          No employees match the selected filters.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 14 }}>
          {filteredAgents.map((agent) => (
            (() => {
              const activityTone = getActivityTone(agent.status, agent.online);
              const activityLabel = getActivityLabel(agent.status, agent.online);
              const activityColors = getActivityColors(activityTone);
              const lastSeenLabel = formatLastSeen(agent.lastSeen, agent.online);
              const currentAppLabel = agent.activeApp || 'No active app.';
              const secondaryLabel = agent.departmentName || 'Unassigned';
              const isInteractive = agent.online && !connectionInFlightRef.current;

              return (
                <button
                  key={agent.employeeId}
                  onClick={() => {
                    if (!agent.online || connectionInFlightRef.current) return;
                    void connectToEmployee({ id: agent.employeeId, name: agent.name });
                  }}
                  disabled={!agent.online}
                  aria-label={agent.online ? `Monitor live for ${agent.name}` : `${agent.name} is offline`}
                  title={agent.online ? `Monitor live: ${agent.name}` : `${agent.name} is offline`}
                  style={{
                    border: `1px solid ${activityColors.border}`,
                    background: BRAND.surface,
                    borderRadius: 18,
                    overflow: 'hidden',
                    boxShadow: agent.online ? '0 18px 40px rgba(6,118,71,.08)' : '0 18px 40px rgba(15,23,42,.05)',
                    textAlign: 'left',
                    cursor: isInteractive ? 'pointer' : 'default',
                    transition: 'transform .18s ease, box-shadow .18s ease, border-color .18s ease',
                    padding: 0,
                    opacity: agent.online ? 1 : 0.92,
                    outlineOffset: 3,
                  }}
                >
              <div style={{ aspectRatio: '16/9', background: BRAND.canvas, position: 'relative', overflow: 'hidden' }}>
                {agent.lastUrl ? (
                  <img src={agent.lastUrl} alt={`Latest preview for ${agent.name}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: BRAND.muted,
                      fontSize: 12,
                      background: 'linear-gradient(180deg, rgba(247,248,251,.7), rgba(247,248,251,1))',
                      gap: 8,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 999,
                        display: 'grid',
                        placeItems: 'center',
                        background: 'rgba(255,255,255,.75)',
                        border: `1px solid ${BRAND.border}`,
                        fontSize: 18,
                      }}
                    >
                      +
                    </span>
                    <span>Preview unavailable</span>
                  </div>
                )}
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(180deg, rgba(10,10,10,.08) 0%, rgba(10,10,10,.16) 24%, rgba(10,10,10,.34) 52%, rgba(10,10,10,.74) 82%, rgba(10,10,10,.9) 100%)',
                    pointerEvents: 'none',
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    inset: 'auto 12px 12px 12px',
                    background: 'linear-gradient(180deg, rgba(10,10,10,.08), rgba(10,10,10,.76))',
                    borderRadius: 14,
                    padding: '40px 12px 12px',
                    color: '#FFFFFF',
                    boxShadow: 'inset 0 -1px 0 rgba(255,255,255,.08)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 800, textShadow: '0 2px 10px rgba(0,0,0,.45)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={agent.name}>{agent.name}</div>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,.94)', textShadow: '0 2px 8px rgba(0,0,0,.42)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 4 }} title={secondaryLabel}>
                        {secondaryLabel}
                      </div>
                      <div style={{ fontSize: 11, color: '#FFFFFF', textShadow: '0 2px 8px rgba(0,0,0,.42)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 3 }} title={currentAppLabel}>
                        {currentAppLabel}
                      </div>
                    </div>
                    <div
                      style={{
                        flexShrink: 0,
                        fontSize: 10,
                        fontWeight: 800,
                        letterSpacing: '.04em',
                        textTransform: 'uppercase',
                        padding: '6px 9px',
                        borderRadius: 999,
                        background: activityColors.bg,
                        color: activityTone === 'offline' ? BRAND.ink : activityColors.fg,
                        border: `1px solid ${activityColors.border}`,
                        backdropFilter: 'blur(8px)',
                        boxShadow: '0 10px 22px rgba(0,0,0,.22)',
                      }}
                      aria-label={`Activity status: ${activityLabel}`}
                    >
                      {activityLabel}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ padding: '14px 14px 15px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.mutedFaint }}>Session status</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: BRAND.muted }} aria-label={`Connection state: ${agent.status}`}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: activityColors.dot, display: 'inline-block' }} />
                    {activityLabel}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: BRAND.muted, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span>{lastSeenLabel}</span>
                  <span
                    style={{
                      color: agent.online ? BRAND.blue : BRAND.mutedFaint,
                      fontWeight: 700,
                      textDecoration: agent.online ? 'underline' : 'none',
                      textUnderlineOffset: 3,
                    }}
                  >
                    {agent.online ? 'Monitor live' : 'Unavailable'}
                  </span>
                </div>
              </div>
                </button>
              );
            })()
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
