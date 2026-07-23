/// <reference path="./capture-renderer.d.ts" />
import { LocalVideoTrack, Room, RoomEvent, Track } from 'livekit-client';

const globalScope = window as Window & typeof globalThis & {
  __worktrackCaptureRendererInitialized?: boolean;
  __worktrackLivePublisher?: Window['livePublisher'];
};

type PublisherStartPayload = {
  sourceId: string;
  employeeId: string;
  sessionId: string;
  authToken: string;
  serverUrl: string;
};

let room: Room | null = null;
let localTrack: LocalVideoTrack | null = null;
let mediaStream: MediaStream | null = null;
let currentSessionKey = '';
let desiredConfig: PublisherStartPayload | null = null;

function log(payload: Record<string, unknown>) {
  try {
    globalScope.__worktrackLivePublisher?.log(payload);
  } catch {
    console.log('[AGENT][LIVEKIT]', payload);
  }
}

async function stopPublishing() {
  desiredConfig = null;
  currentSessionKey = '';

  if (room && localTrack) {
    try {
      await room.localParticipant.unpublishTrack(localTrack);
    } catch (error) {
      console.warn('[AGENT][LIVEKIT] failed to unpublish track', error);
    }
  }

  localTrack?.stop();
  mediaStream?.getTracks().forEach((track) => track.stop());
  localTrack = null;
  mediaStream = null;

  if (room) {
    room.disconnect();
    room = null;
  }
}

async function fetchPublisherToken(config: PublisherStartPayload) {
  const response = await fetch(new URL('/api/live/publisher-token', config.serverUrl).toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sessionId: config.sessionId }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Failed to fetch publisher token (${response.status})`);
  }

  return payload as {
    token: string;
    livekitUrl: string;
    roomName: string;
  };
}

async function createScreenTrack(sourceId: string) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: 15,
        minWidth: 1280,
        maxWidth: 1920,
        minHeight: 720,
        maxHeight: 1080,
      },
    } as any,
  } as any);

  const track = stream.getVideoTracks()[0];
  if (!track) {
    throw new Error('Desktop capture track was not created');
  }

  const liveTrack = new LocalVideoTrack(track, undefined, true);
  liveTrack.source = Track.Source.ScreenShare;

  mediaStream = stream;
  localTrack = liveTrack;
  return liveTrack;
}

async function startPublishing(config: PublisherStartPayload) {
  desiredConfig = config;
  const nextSessionKey = `${config.employeeId}:${config.sessionId}`;

  if (currentSessionKey === nextSessionKey && room && localTrack) {
    return;
  }

  await stopPublishing();
  desiredConfig = config;

  const tokenResponse = await fetchPublisherToken(config);
  const nextRoom = new Room();

  nextRoom.on(RoomEvent.Connected, () => {
    log({ state: 'connected', room: tokenResponse.roomName, sessionId: config.sessionId });
  });
  nextRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
    log({ state: 'connection-state', value: state, sessionId: config.sessionId });
  });
  nextRoom.on(RoomEvent.Disconnected, (reason) => {
    log({ state: 'disconnected', reason, sessionId: config.sessionId });
  });

  await nextRoom.connect(tokenResponse.livekitUrl, tokenResponse.token);
  const track = await createScreenTrack(config.sourceId);
  await nextRoom.localParticipant.publishTrack(track, {
    source: Track.Source.ScreenShare,
  });

  room = nextRoom;
  currentSessionKey = nextSessionKey;
  log({ state: 'published', room: tokenResponse.roomName, sessionId: config.sessionId });

  track.mediaStreamTrack.addEventListener('ended', () => {
    if (desiredConfig && currentSessionKey === nextSessionKey) {
      log({ state: 'track-ended', sessionId: config.sessionId });
      void stopPublishing();
    }
  });
}

if (globalScope.__worktrackCaptureRendererInitialized) {
  console.log('[AGENT] capture renderer already initialized');
} else {
  globalScope.__worktrackCaptureRendererInitialized = true;
  globalScope.__worktrackLivePublisher = window.livePublisher;

  if (!window.livePublisher) {
    console.error('[AGENT][LIVEKIT] preload bridge missing');
  } else {
    window.livePublisher.onStart((payload) => {
      startPublishing(payload).catch((error) => {
        log({ state: 'start-failed', message: error instanceof Error ? error.message : String(error) });
      });
    });

    window.livePublisher.onStop(() => {
      void stopPublishing();
    });

    window.livePublisher.sendReady();
    log({ state: 'ready' });
  }
}
