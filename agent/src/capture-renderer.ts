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
  quality?: {
    width: number;
    height: number;
    frameRate: number;
    maxBitrate: number;
  };
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

const DEFAULT_LIVE_QUALITY = {
  width: 960,
  height: 540,
  frameRate: 15,
  maxBitrate: 650_000,
};

function normalizeLiveQuality(config: PublisherStartPayload) {
  const quality = config.quality || DEFAULT_LIVE_QUALITY;
  return {
    width: Math.max(640, Math.min(1280, Number(quality.width) || DEFAULT_LIVE_QUALITY.width)),
    height: Math.max(360, Math.min(720, Number(quality.height) || DEFAULT_LIVE_QUALITY.height)),
    frameRate: Math.max(5, Math.min(15, Number(quality.frameRate) || DEFAULT_LIVE_QUALITY.frameRate)),
    maxBitrate: Math.max(250_000, Math.min(1_200_000, Number(quality.maxBitrate) || DEFAULT_LIVE_QUALITY.maxBitrate)),
  };
}

async function createScreenTrack(config: PublisherStartPayload) {
  const quality = normalizeLiveQuality(config);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: config.sourceId,
        minFrameRate: quality.frameRate,
        maxFrameRate: quality.frameRate,
        minWidth: quality.width,
        maxWidth: quality.width,
        minHeight: quality.height,
        maxHeight: quality.height,
      },
    } as any,
  } as any);

  const track = stream.getVideoTracks()[0];
  if (!track) {
    throw new Error('Desktop capture track was not created');
  }
  track.contentHint = 'detail';

  const liveTrack = new LocalVideoTrack(track, undefined, true);
  liveTrack.source = Track.Source.ScreenShare;

  mediaStream = stream;
  localTrack = liveTrack;
  return { liveTrack, quality };
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
  const { liveTrack, quality } = await createScreenTrack(config);
  const publication = await nextRoom.localParticipant.publishTrack(liveTrack, {
    source: Track.Source.ScreenShare,
    screenShareEncoding: {
      maxBitrate: quality.maxBitrate,
      maxFramerate: quality.frameRate,
    },
    simulcast: false,
  } as any);

  const sender = publication?.track?.sender;
  if (sender) {
    const parameters = sender.getParameters();
    parameters.encodings = [{
      ...(parameters.encodings?.[0] || {}),
      maxBitrate: quality.maxBitrate,
      maxFramerate: quality.frameRate,
      scaleResolutionDownBy: 1,
    }];
    await sender.setParameters(parameters).catch((error) => {
      console.warn('[AGENT][LIVEKIT] failed to apply low-resource sender params', error);
    });
  }

  room = nextRoom;
  currentSessionKey = nextSessionKey;
  log({ state: 'published', room: tokenResponse.roomName, sessionId: config.sessionId, quality });

  liveTrack.mediaStreamTrack.addEventListener('ended', () => {
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
