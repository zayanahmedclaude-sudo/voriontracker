import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import fs from 'fs';
import path from 'path';

type LiveWatchConfig = {
  employeeId: string;
  sessionId: string;
  authToken: string;
  serverUrl: string;
};

type LiveWatchQuality = {
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
};

type TeardownOptions = {
  authToken?: string;
  serverUrl?: string;
  sessionId?: string;
  stopRoom?: boolean;
};

let captureWindow: BrowserWindow | null = null;
let captureWindowReady = false;
let captureReadyPromise: Promise<void> | null = null;
let resolveCaptureReady: (() => void) | null = null;
let listenersBound = false;
let activeConfigKey = '';
let resolvePublisherStarted: (() => void) | null = null;
let rejectPublisherStarted: ((error: Error) => void) | null = null;

const LOW_RESOURCE_LIVE_QUALITY: LiveWatchQuality = {
  width: 960,
  height: 540,
  frameRate: 15,
  maxBitrate: 650_000,
};

function logErrorWithStack(message: string, error: unknown) {
  console.error(message);
  if (error instanceof Error) {
    console.error(error.stack || error.message);
    return;
  }
  console.error(error);
}

function getCaptureHtmlPath() {
  const candidateHtmlPaths = [
    path.join(__dirname, 'capture.html'),
    path.join(__dirname, '..', 'src', 'capture.html'),
    path.join(__dirname, '..', 'capture.html'),
    path.join(process.resourcesPath || __dirname, 'app.asar', 'dist', 'capture.html'),
    path.join(process.resourcesPath || __dirname, 'app.asar', 'src', 'capture.html'),
    path.join(process.resourcesPath || __dirname, 'app.asar.unpacked', 'src', 'capture.html'),
  ].filter((candidate, index, list) => list.indexOf(candidate) === index);

  return candidateHtmlPaths.find((candidate) => fs.existsSync(candidate)) || '';
}

function bindIpcListeners() {
  if (listenersBound) return;
  listenersBound = true;

  ipcMain.on('livekit:ready', (event) => {
    if (!captureWindow || event.sender.id !== captureWindow.webContents.id) return;
    captureWindowReady = true;
    resolveCaptureReady?.();
    resolveCaptureReady = null;
  });

  ipcMain.on('livekit:log', (event, payload) => {
    if (!captureWindow || event.sender.id !== captureWindow.webContents.id) return;
    console.log('[AGENT][LIVEKIT]', payload);
    if (payload?.state === 'published') {
      resolvePublisherStarted?.();
      resolvePublisherStarted = null;
      rejectPublisherStarted = null;
    }
    if (payload?.state === 'start-failed') {
      rejectPublisherStarted?.(new Error(String(payload?.message || 'LiveKit publisher failed to start')));
      resolvePublisherStarted = null;
      rejectPublisherStarted = null;
    }
  });
}

function getOrCreateCaptureWindow() {
  bindIpcListeners();

  if (captureWindow && !captureWindow.isDestroyed()) {
    return { win: captureWindow, ready: captureReadyPromise || Promise.resolve() };
  }

  const captureHtmlPath = getCaptureHtmlPath();
  const preloadPath = path.join(__dirname, 'capture-preload.js');

  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  captureWindow = win;
  captureWindowReady = false;
  captureReadyPromise = new Promise<void>((resolve) => {
    resolveCaptureReady = resolve;
  });

  win.on('closed', () => {
    if (captureWindow === win) {
      captureWindow = null;
      captureWindowReady = false;
      captureReadyPromise = null;
      resolveCaptureReady = null;
      resolvePublisherStarted = null;
      rejectPublisherStarted = null;
      activeConfigKey = '';
    }
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log('[CAPTURE]', message, { level, line, sourceId });
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    console.error('[livekit] capture window failed to load', {
      errorCode,
      errorDescription,
      validatedURL,
      captureHtmlPath,
    });
  });
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== win.webContents.getURL()) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (!captureHtmlPath) {
    throw new Error('capture.html not found for live publisher window');
  }

  win.loadFile(captureHtmlPath).catch((error) => {
    logErrorWithStack('[livekit] failed to load capture window', error);
  });

  return { win, ready: captureReadyPromise };
}

async function waitForCaptureWindow() {
  if (captureWindowReady) return;
  await Promise.race([
    captureReadyPromise,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for capture renderer')), 8000);
    }),
  ]);
}

async function getScreenSourceId() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 160, height: 90 },
  });

  if (!sources.length) {
    throw new Error('No desktop capture sources available');
  }

  let chosen = sources[0];
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const primaryId = String(primaryDisplay.id);
    const matched = sources.find((source) => {
      const sourceDisplayId = String((source as any).display_id || (source as any).displayId || '');
      return (
        sourceDisplayId === primaryId ||
        source.id.endsWith(primaryId) ||
        /entire/i.test(source.name)
      );
    });
    if (matched) chosen = matched;
  } catch {
    // Fall back to the first available source.
  }

  return chosen.id;
}

async function postStopRoom(options: TeardownOptions) {
  if (!options.stopRoom || !options.serverUrl || !options.authToken || !options.sessionId) {
    return;
  }

  try {
    await fetch(new URL('/api/live/stop', options.serverUrl).toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: options.sessionId }),
    });
  } catch (error) {
    console.warn('[livekit] failed to stop room on server', error);
  }
}

export async function setupLiveWatch(config: LiveWatchConfig | string) {
  if (typeof config === 'string') {
    return;
  }

  if (!config.employeeId || !config.sessionId || !config.authToken) {
    return;
  }

  const nextConfigKey = `${config.employeeId}:${config.sessionId}`;

  const { win } = getOrCreateCaptureWindow();
  await waitForCaptureWindow();

  const sourceId = await getScreenSourceId();
  activeConfigKey = nextConfigKey;
  const publisherStarted = new Promise<void>((resolve, reject) => {
    resolvePublisherStarted = resolve;
    rejectPublisherStarted = reject;
  });
  win.webContents.send('livekit:start', {
    ...config,
    sourceId,
    quality: LOW_RESOURCE_LIVE_QUALITY,
  });
  await Promise.race([
    publisherStarted,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for LiveKit publisher')), 15000);
    }),
  ]);
}

export async function teardownLiveWatch(options: TeardownOptions = {}) {
  activeConfigKey = '';

  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.webContents.send('livekit:stop');
    captureWindow.close();
  }

  captureWindow = null;
  captureWindowReady = false;
  captureReadyPromise = null;
  resolveCaptureReady = null;
  resolvePublisherStarted = null;
  rejectPublisherStarted = null;

  await postStopRoom(options);
}
