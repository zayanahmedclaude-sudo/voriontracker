import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
// Main-process deps must stay above bootstrap code so CommonJS emits them before use.
import { app } from 'electron';
import {
   BrowserWindow, Tray, Menu, nativeImage,
  ipcMain, powerMonitor, desktopCapturer, screen, shell, dialog, safeStorage
} from 'electron';
import os from 'os';
import https from 'https';
import http from 'http';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import log from 'electron-log/main';
import { autoUpdater } from 'electron-updater';
import { upload as uploadBlob } from '@vercel/blob/client';
import { EMBEDDED_ENV } from './embedded-config';

function getAncestorEnvCandidates(baseDir: string) {
  if (!baseDir) return [];

  const candidates: string[] = [];
  let currentDir = path.resolve(baseDir);

  for (let depth = 0; depth < 4; depth += 1) {
    candidates.push(path.join(currentDir, '.env.local'));
    candidates.push(path.join(currentDir, '.env'));

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return candidates;
}

function loadAgentEnv() {
  // Packaged builds carry generated embedded configuration. Loading .env files
  // from the launch directory lets an unrelated local file redirect credentials.
  if (app.isPackaged) return;
  const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR || '';
  const executableDir = process.execPath ? path.dirname(process.execPath) : '';
  const cwd = process.cwd();
  const candidatePaths = [
    ...getAncestorEnvCandidates(portableExecutableDir),
    ...getAncestorEnvCandidates(executableDir),
    ...getAncestorEnvCandidates(cwd),
    path.resolve(__dirname, '..', '.env.local'),
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '..', '..', '.env.local'),
    path.resolve(__dirname, '..', '..', '.env'),
  ].filter((candidatePath, index, allPaths) => Boolean(candidatePath) && allPaths.indexOf(candidatePath) === index);

  for (const candidatePath of candidatePaths) {
    if (!fs.existsSync(candidatePath)) continue;
    dotenv.config({ path: candidatePath });
  }
}

function normalizeServerUrl(rawValue?: string | null) {
  const trimmedValue = String(rawValue || '').trim();
  if (!trimmedValue) return '';

  const withProtocol = /^[a-z]+:\/\//i.test(trimmedValue) ? trimmedValue : `https://${trimmedValue}`;

  try {
    const normalizedUrl = new URL(withProtocol);
    normalizedUrl.pathname = normalizedUrl.pathname === '/' ? '/' : `${normalizedUrl.pathname.replace(/\/+$/, '')}/`;
    return normalizedUrl.toString();
  } catch {
    return '';
  }
}

function isLocalServerUrl(rawValue?: string | null) {
  const normalizedValue = normalizeServerUrl(rawValue);
  if (!normalizedValue) return false;

  try {
    const { hostname } = new URL(normalizedValue);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function setupFileLogging() {
  try {
    const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR || '';
    const executableDir = process.execPath ? path.dirname(process.execPath) : '';
    const cwd = process.cwd();
    const logDir = app.isPackaged ? (portableExecutableDir || executableDir || cwd) : cwd;
    if (!logDir) return;

    const logPath = path.join(logDir, 'agent-debug.log');
    const append = (level: 'LOG' | 'WARN' | 'ERROR', args: unknown[]) => {
      try {
        const line = `[${new Date().toISOString()}] [${level}] ${args.map((arg) => {
          if (arg instanceof Error) return arg.stack || arg.message;
          if (typeof arg === 'string') return arg;
          try { return JSON.stringify(arg); } catch { return String(arg); }
        }).join(' ')}\n`;
        fs.appendFileSync(logPath, line, 'utf8');
      } catch {
        // Keep normal console behavior if file logging fails.
      }
    };

    const originalLog = console.log.bind(console);
    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);

    console.log = (...args: unknown[]) => {
      append('LOG', args);
      originalLog(...args);
    };
    console.warn = (...args: unknown[]) => {
      append('WARN', args);
      originalWarn(...args);
    };
    console.error = (...args: unknown[]) => {
      append('ERROR', args);
      originalError(...args);
    };

    console.log('[AGENT] file logging enabled', { logPath });
  } catch {
    // Ignore logging bootstrap failures.
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.stack || error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

loadAgentEnv();
setupFileLogging();
process.on('uncaughtException', (error) => {
  console.error('[AGENT] uncaughtException', formatError(error));
});
process.on('unhandledRejection', (reason) => {
  console.error('[AGENT] unhandledRejection', formatError(reason));
});
console.log('[AGENT] env load check', {
  SERVER_URL: Boolean(process.env.WORKTRACK_SERVER || process.env.NEXT_PUBLIC_APP_URL || EMBEDDED_ENV.WORKTRACK_SERVER || EMBEDDED_ENV.NEXT_PUBLIC_APP_URL),
  LIVEKIT_URL: Boolean(process.env.LIVEKIT_URL || EMBEDDED_ENV.LIVEKIT_URL),
});
// FIX: teardownLiveWatch must be imported from './live-watch' — the real
// A local no-op function with the same name used to be declared further
// down in this file, which shadowed this import and meant the real channel
// was never torn down on stopTracking()/logout, leaving an orphaned,
// still-subscribed channel behind every time.
import { setupLiveWatch, teardownLiveWatch } from './live-watch';
import type { IncomingMessage } from 'http';
import { syncProxyBlock, removeProxyBlock } from './websiteBlock';

// ─── Config ────────────────────────────────────────────────────────────────
const isDev = !app.isPackaged;
const UPDATE_RELEASE_OWNER = 'VorionDevTeam';
// Public GitHub Releases repository that hosts latest.yml, the installer, and blockmap.
const UPDATE_RELEASE_REPO = 'tracker-download';
const AUTO_UPDATE_INITIAL_DELAY_MS = 15_000;
const AUTO_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const UPDATE_INSTALL_CLEANUP_TIMEOUT_MS = 45_000;
const configuredServerUrl = process.env.WORKTRACK_SERVER || process.env.NEXT_PUBLIC_APP_URL || EMBEDDED_ENV.WORKTRACK_SERVER || EMBEDDED_ENV.NEXT_PUBLIC_APP_URL || '';
const fallbackServerUrl = isDev ? 'http://127.0.0.1:3000/' : 'https://tracker.vorionsystems.com/';
const SERVER_URL = (() => {
  const normalizedConfiguredUrl = normalizeServerUrl(configuredServerUrl);

  if (!normalizedConfiguredUrl) return fallbackServerUrl;
  if (!isDev && isLocalServerUrl(normalizedConfiguredUrl)) return 'https://tracker.vorionsystems.com/';
  if (!isDev && new URL(normalizedConfiguredUrl).protocol !== 'https:') {
    console.warn('[AGENT] refusing non-HTTPS server URL in packaged build');
    return 'https://tracker.vorionsystems.com/';
  }

  return normalizedConfiguredUrl;
})();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || EMBEDDED_ENV.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || EMBEDDED_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// ─── Persistent store ──────────────────────────────────────────────────────
const DATA_DIR   = app.getPath('userData');
const STORE_PATH = path.join(DATA_DIR, 'worktrack-store.json');

function readStore(): Record<string,any> {
  try { return JSON.parse(fs.readFileSync(STORE_PATH,'utf8')); } catch { return {}; }
}
function writeStore(data: Record<string,any>) {
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(STORE_PATH, JSON.stringify(data,null,2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(STORE_PATH, 0o600); } catch {}
}
function get(key:string)        { return readStore()[key]; }
function set(key:string,val:any){ writeStore({...readStore(),[key]:val}); }
function remove(key:string) {
  const data = readStore();
  delete data[key];
  writeStore(data);
}

function storeAuthToken(nextToken: string) {
  token = nextToken;
  if (!nextToken) {
    remove('token');
    remove('tokenEncrypted');
    return;
  }

  if (safeStorage.isEncryptionAvailable()) {
    set('tokenEncrypted', safeStorage.encryptString(nextToken).toString('base64'));
    remove('token');
    return;
  }

  // Preserve compatibility on Linux desktops without a secret service while
  // restricting the fallback file to the current OS user.
  console.warn('[AUTH] OS credential encryption unavailable; using a user-only token file');
  set('token', nextToken);
  remove('tokenEncrypted');
}

function loadStoredAuthToken() {
  const encrypted = get('tokenEncrypted');
  if (typeof encrypted === 'string' && encrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (error) {
      console.warn('[AUTH] encrypted token could not be decrypted; clearing it', formatError(error));
      remove('tokenEncrypted');
    }
  }

  const legacyToken = get('token');
  if (typeof legacyToken !== 'string' || !legacyToken) return '';
  storeAuthToken(legacyToken);
  return legacyToken;
}

function getEmployeeIdFromUser(user: any): string {
  const candidate = user?.id || user?.employeeId || user?.employee_id || user?.userId || user?.employee?.id || user?.employee?.employeeId || user?.employee?.employee_id || '';
  return String(candidate || '').trim();
}

function getAuthenticatedUserIdFromToken(authToken: string): string {
  try {
    const [, payload] = authToken.split('.');
    if (!payload) return '';
    const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(Buffer.from(normalizedPayload, 'base64').toString('utf8'));
    return String(decoded?.sub || '').trim();
  } catch {
    return '';
  }
}

function persistSessionIdentity(nextToken?: string, nextUserName?: string, nextEmployeeId?: string) {
  if (typeof nextToken === 'string') {
    storeAuthToken(nextToken);
  }
  if (typeof nextUserName === 'string') {
    userName = nextUserName;
    set('userName', userName);
  }
  if (typeof nextEmployeeId === 'string') {
    employeeId = nextEmployeeId;
    set('employeeId', employeeId);
  }
}

// ─── State ─────────────────────────────────────────────────────────────────
let tray:        Tray|null          = null;
let mainWindow:  BrowserWindow|null = null;
let token:       string             = '';
let userName:    string             = get('userName') || '';
let employeeId:  string             = get('employeeId') || '';
let sessionId:   string             = '';
let agentId:     string             = get('agentId') || `agent-${Math.random().toString(36).slice(2,10)}`;
let status:      'offline'|'active'|'break'|'idle' = 'offline';
let tracking     = false;
let isQuitting   = false;
let allowImmediateQuit = false;
let quitInFlight: Promise<void> | null = null;
let ssInterval:         NodeJS.Timeout|null = null;
let uploadInterval:     NodeJS.Timeout|null = null;
let idleInterval:       NodeJS.Timeout|null = null;
let heartbeatInterval:  NodeJS.Timeout|null = null;
let policyInterval:     NodeJS.Timeout|null = null;
let scanInterval:       NodeJS.Timeout|null = null;
let policySyncInterval: NodeJS.Timeout|null = null;
const MIN_CAPTURE_INTERVAL_SEC = 60;
function normalizeCaptureIntervalSec(value: unknown) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? Math.max(MIN_CAPTURE_INTERVAL_SEC, parsed) : MIN_CAPTURE_INTERVAL_SEC;
}
let captureIntervalSec = normalizeCaptureIntervalSec(get('captureIntervalSec')); // capture cadence: how often a screenshot is taken locally
const uploadIntervalSec = 30;                                        // upload cadence: how often the queue is flushed as one batch API call
let lastActiveApp    = 'Unknown';
let lastActivityPct  = 100;
let cachedPolicy:         any   = null;
let cachedBlockedApps:    any[] = [];
let cachedBlockedWebsites:any[] = [];
let policySyncInFlight = false;
let policyRealtimeClient: ReturnType<typeof createClient> | null = null;
let policyRealtimeChannel: any = null;
let lastPolicyPushAt = 0;
// `attempts` lets a failed upload be retried on the next 30s flush without
// growing the queue forever — MAX_UPLOAD_ATTEMPTS below caps and drops it.
// imageBuf/imageExt/imageMime hold whatever format survived compression
// (WebP normally, PNG as a fallback) so the upload step stays format-agnostic.
type PendingScreenshot = {
  localId: string;
  imageBuf?: Buffer;
  imageExt?: 'webp' | 'png';
  imageMime?: string;
  thumbnailBuf?: Buffer;
  thumbnailMime?: string;
  upload?: BlobScreenshotUpload;
  activeApp: string;
  activityPct: number;
  capturedAt: string;
  sessionId: string | null;
  attempts: number;
  nextRetryAt?: number;
};
const MAX_UPLOAD_ATTEMPTS = 3;
const SCREENSHOT_RETRY_BASE_DELAY_MS = 30_000;
let screenshotQueue: PendingScreenshot[] = [];
let screenshotFlushTimer: NodeJS.Timeout | null = null;
let screenshotFlushInFlight = false;
let lastBlobTokenDiagnosticAt = 0;
let updaterCheckInFlight = false;
let updaterDownloaded = false;
let updaterDownloadedVersion = '';
let updaterSchedulerStarted = false;
let updaterInterval: NodeJS.Timeout | null = null;
// tracks which blocked domains we've already reported recently, to avoid spamming events
const recentlyReportedDomains = new Map<string, number>();
// tracks recently handled blocked processes, so repeated scans don't reopen the same warning dialog
const recentlyHandledProcesses = new Map<string, number>();
set('agentId', agentId);

function clearTimer(timer: NodeJS.Timeout | null) {
  if (timer) clearInterval(timer);
  return null;
}

async function requestGracefulQuit() {
  if (quitInFlight) return quitInFlight;

  quitInFlight = (async () => {
    isQuitting = true;

    try {
      if (tracking) {
        await stopTracking();
      } else {
        await teardownLiveWatch();
      }
    } catch (error) {
      console.error('[QUIT] graceful shutdown failed:', error);
    } finally {
      if (updaterInterval) clearInterval(updaterInterval);
      updaterInterval = null;
      removeProxyBlock();
      tray?.destroy();
      tray = null;
      allowImmediateQuit = true;
      quitInFlight = null;
      app.quit();
    }
  })();

  return quitInFlight;
}

// ─── Live streaming state (WebRTC) ──────────────────────────────────────────

// ─── Single instance lock ───────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => mainWindow?.show());

// ─── Auto-start with OS ────────────────────────────────────────────────────
app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('no-pings');

// ─── HTTP helper ────────────────────────────────────────────────────────────
class HttpError extends Error {
  status: number;
  constructor(message:string, status:number) { super(message); this.status = status; }
}

function apiRequest(method:string, path:string, body?:any, isFormData=false): Promise<any> {
  return new Promise((resolve,reject) => {
    const url  = new URL(path, SERVER_URL);
    const mod  = url.protocol==='https:'?https:http;
    const data = body && !isFormData ? Buffer.from(JSON.stringify(body)) : body;
    const headers: Record<string,string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body && !isFormData) { headers['Content-Type']='application/json'; headers['Content-Length']=String(data.length); }
    if (isFormData && body?.getHeaders) Object.assign(headers, body.getHeaders());
    const req = (mod as any).request({ hostname:url.hostname, port:url.port||undefined, path:url.pathname+url.search, method, headers }, (res: IncomingMessage) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => raw += chunk);
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (!raw) {
          if (status >= 200 && status < 300) return resolve({});
          return reject(new Error(`Request failed ${status}`));
        }
        try {
          const parsed = JSON.parse(raw);
          if (status >= 200 && status < 300) return resolve(parsed);
          return reject(new HttpError(parsed?.error || `Request failed ${status}`, status));
        } catch {
          if (status >= 200 && status < 300) return resolve(raw);
          return reject(new HttpError(`Request failed ${status}: ${raw}`, status));
        }
      });
    });
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function requestText(method:string, path:string, body?:any): Promise<{ status: number; text: string }> {
  return new Promise((resolve,reject) => {
    const url  = new URL(path, SERVER_URL);
    const mod  = url.protocol==='https:'?https:http;
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const headers: Record<string,string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (data) { headers['Content-Type']='application/json'; headers['Content-Length']=String(data.length); }
    const req = (mod as any).request({ hostname:url.hostname, port:url.port||undefined, path:url.pathname+url.search, method, headers }, (res: IncomingMessage) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, text: raw }));
    });
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

type BlobScreenshotUpload = {
  path: string;
  url: string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  downloadUrl?: string;
  contentType?: string;
};

async function sessionAction(action:string, payload: Record<string, any> = {}) {
  if (!token) throw new Error('Not authenticated');
  return apiRequest('POST', '/api/sessions', { action, ...payload });
}

async function startSession() {
  if (!token || sessionId) return;
  try {
    const response = await sessionAction('start');
    sessionId = response.sessionId || sessionId;
    await ensureLiveWatchRunning();
  } catch (err:any) {
    console.error('Failed to start session:', err?.message || err);
  }
}

async function ensureLiveWatchRunning() {
  if (!tracking || !token || !employeeId || !sessionId) return;

  try {
    await setupLiveWatch({
      employeeId,
      sessionId,
      authToken: token,
      serverUrl: SERVER_URL,
    });
  } catch (err:any) {
    console.error('Failed to start live watch:', err?.message || err);
  }
}

async function endSession() {
  if (!token) return;
  const sessionIdToClose = sessionId;
  try {
    const payload = sessionIdToClose ? { sessionId: sessionIdToClose } : {};
    await sessionAction('checkout', payload);
  } catch (err:any) {
    console.error('Failed to end session:', err?.message || err);
  } finally {
    await teardownLiveWatch({
      authToken: token,
      serverUrl: SERVER_URL,
      sessionId: sessionIdToClose,
      stopRoom: true,
    });
    sessionId = '';
  }
}

async function getActiveWindowSnapshot() {
  try {
    const activeWinModule = require('active-win');
    return await activeWinModule.default();
  } catch (err:any) {
    console.warn('[AGENT] active-win unavailable, foreground app detection disabled', err?.message || err);
    return null;
  }
}

async function getActiveAppName() {
  const activeWindow = await getActiveWindowSnapshot();
  return activeWindow?.owner?.name || activeWindow?.title?.split(' - ')[0] || 'Unknown';
}


async function compressScreenshot(pngBuffer: Buffer): Promise<{ buffer: Buffer; ext: 'webp' | 'png'; mimeType: string }> {
  try {
    const webpBuffer = await sharp(pngBuffer)
      .webp({
        quality: 78,
        effort: 6,
        smartSubsample: true,
      })
      .toBuffer();

    if (webpBuffer.length > 0 && webpBuffer.length < pngBuffer.length) {
      return { buffer: webpBuffer, ext: 'webp', mimeType: 'image/webp' };
    }

    log.info('[SCREENSHOTS] WebP not smaller than PNG, keeping original', {
      pngBytes: pngBuffer.length,
      webpBytes: webpBuffer.length,
    });
    return { buffer: pngBuffer, ext: 'png', mimeType: 'image/png' };
  } catch (err: any) {
    log.warn('[SCREENSHOTS] WebP compression failed, uploading original PNG', err?.message || err);
    return { buffer: pngBuffer, ext: 'png', mimeType: 'image/png' };
  }
}

async function createScreenshotThumbnail(pngBuffer: Buffer): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const buffer = await sharp(pngBuffer)
      .resize({ width: 480, height: 270, fit: 'cover' })
      .webp({
        quality: 48,
        effort: 4,
        smartSubsample: true,
      })
      .toBuffer();
    return buffer.length > 0 ? { buffer, mimeType: 'image/webp' } : null;
  } catch (err: any) {
    log.warn('[SCREENSHOTS] Thumbnail generation failed; full screenshot will still upload', err?.message || err);
    return null;
  }
}
async function uploadScreenshotFile(shot: PendingScreenshot) {
  if (!token) return;
  if (!employeeId) {
    log.warn('[SCREENSHOTS] Skipping upload - no employeeId in session yet');
    return;
  }

  const form = new FormData();
  if (!shot.imageBuf || !shot.imageExt || !shot.imageMime) return;
  const file = new File([new Uint8Array(shot.imageBuf)], `screenshot-${Date.now()}.${shot.imageExt}`, { type: shot.imageMime });
  form.append('file', file);
  form.append('employeeId', employeeId);
  form.append('deviceId', agentId);
  form.append('activeApp', shot.activeApp);
  form.append('activityPct', String(shot.activityPct));
  form.append('capturedAt', shot.capturedAt);
  if (shot.sessionId) form.append('sessionId', shot.sessionId);

  throw new Error('Legacy screenshot upload is disabled; use signed storage uploads.');
}

// ─── Alerts ────────────────────────────────────────────────────────────────
async function uploadScreenshotToBlob(shot: PendingScreenshot): Promise<BlobScreenshotUpload> {
  if (shot.upload) {
    log.info('[SCREENSHOTS] Skipping Blob upload; retrying commit only', {
      localId: shot.localId,
      attempt: shot.attempts + 1,
      path: shot.upload.path,
    });
    return shot.upload;
  }
  if (!shot.imageBuf || !shot.imageExt || !shot.imageMime) {
    throw new Error('Screenshot has no image bytes or prior Blob upload to commit');
  }
  const authenticatedUserId = getAuthenticatedUserIdFromToken(token);
  const screenshotOwnerId = authenticatedUserId || employeeId;
  const pathname = `screenshots/${screenshotOwnerId}/${shot.localId}.${shot.imageExt}`;
  log.info('[SCREENSHOTS] Starting Blob upload', {
    localId: shot.localId,
    attempt: shot.attempts + 1,
    firstAttempt: shot.attempts === 0,
    pathname,
    employeeId,
    authenticatedUserId: authenticatedUserId || null,
    bytes: shot.imageBuf.length,
  });
  const blob = await uploadBlob(pathname, shot.imageBuf, {
    access: 'public',
    contentType: shot.imageMime,
    handleUploadUrl: new URL('/api/blob/client-upload', SERVER_URL).toString(),
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    clientPayload: JSON.stringify({
      kind: 'screenshot',
      localId: shot.localId,
      attempt: shot.attempts + 1,
      firstAttempt: shot.attempts === 0,
    }),
  });
  log.info('[SCREENSHOTS] Blob upload succeeded', {
    localId: shot.localId,
    attempt: shot.attempts + 1,
    pathname: blob.pathname,
  });

  let thumbnailPath: string | undefined;
  let thumbnailUrl: string | undefined;
  if (shot.thumbnailBuf && shot.thumbnailMime) {
    try {
      const thumbPathname = `screenshots/${screenshotOwnerId}/thumbs/${shot.localId}.webp`;
      const thumbBlob = await uploadBlob(thumbPathname, shot.thumbnailBuf, {
        access: 'public',
        contentType: shot.thumbnailMime,
        handleUploadUrl: new URL('/api/blob/client-upload', SERVER_URL).toString(),
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        clientPayload: JSON.stringify({
          kind: 'screenshot',
          localId: `${shot.localId}-thumb`,
          attempt: shot.attempts + 1,
          firstAttempt: shot.attempts === 0,
        }),
      });
      thumbnailPath = thumbBlob.pathname;
      thumbnailUrl = thumbBlob.url;
      log.info('[SCREENSHOTS] Thumbnail Blob upload succeeded', {
        localId: shot.localId,
        pathname: thumbnailPath,
        bytes: shot.thumbnailBuf.length,
      });
    } catch (error: any) {
      log.warn('[SCREENSHOTS] Thumbnail upload failed; committing full screenshot only', error?.message || error);
    }
  }

  return {
    path: blob.pathname,
    url: blob.url,
    thumbnailPath,
    thumbnailUrl,
    downloadUrl: blob.downloadUrl,
    contentType: blob.contentType,
  };
}

async function diagnoseBlobClientTokenFailure(shot: PendingScreenshot) {
  const now = Date.now();
  if (now - lastBlobTokenDiagnosticAt < 15_000) return;
  lastBlobTokenDiagnosticAt = now;

  const authenticatedUserId = getAuthenticatedUserIdFromToken(token);
  const screenshotOwnerId = authenticatedUserId || employeeId;
  const extension = shot.imageExt || 'webp';
  const pathname = shot.upload?.path || `screenshots/${screenshotOwnerId}/${shot.localId}.${extension}`;
  try {
    const response = await requestText('POST', '/api/blob/client-upload', {
      type: 'blob.generate-client-token',
      payload: {
        pathname,
        clientPayload: JSON.stringify({
          kind: 'screenshot',
          localId: shot.localId,
          attempt: shot.attempts + 1,
          firstAttempt: shot.attempts === 0,
        }),
        multipart: false,
      },
    });
    log.error('[SCREENSHOTS] Blob client-token endpoint diagnostic', {
      status: response.status,
      body: response.text.slice(0, 1000),
      pathname,
      authenticatedUserId: authenticatedUserId || null,
      employeeId,
    });
  } catch (error: any) {
    log.error('[SCREENSHOTS] Blob client-token endpoint diagnostic failed', error?.message || error);
  }
}

async function commitUploadedScreenshots(committed: Array<{ shot: PendingScreenshot; upload: BlobScreenshotUpload }>) {
  if (!committed.length) return;
  await apiRequest('POST', '/api/agent/screenshots/commit', {
    screenshots: committed.map(({ shot, upload }) => ({
      path: upload.path,
      url: upload.url,
      thumbnailPath: upload.thumbnailPath,
      thumbnailUrl: upload.thumbnailUrl,
      deviceId: agentId,
      localId: shot.localId,
      attempt: shot.attempts + 1,
      activeApp: shot.activeApp,
      activityPct: shot.activityPct,
      capturedAt: shot.capturedAt,
      sessionId: shot.sessionId,
    })),
  });
}

async function uploadScreenshotBatch(batch: PendingScreenshot[]) {
  if (!token || !batch.length) return [];
  if (!employeeId) {
    log.warn('[SCREENSHOTS] Skipping upload - no employeeId in session yet');
    return batch;
  }

  const uploadResults = await Promise.allSettled(
    batch.map((shot) => uploadScreenshotToBlob(shot)),
  );
  const committed: Array<{ shot: PendingScreenshot; upload: BlobScreenshotUpload }> = [];
  const failed: PendingScreenshot[] = [];

  uploadResults.forEach((result, index) => {
    if (result.status === 'fulfilled') committed.push({ shot: batch[index], upload: result.value });
    else {
      log.error('[SCREENSHOTS] Blob upload failed:', result.reason?.message || result.reason);
      void diagnoseBlobClientTokenFailure(batch[index]);
      failed.push(batch[index]);
    }
  });

  if (committed.length) {
    try {
      await commitUploadedScreenshots(committed);
    } catch (error) {
      log.error('[SCREENSHOTS] Commit failed after Blob upload; retrying metadata only:', error);
      failed.push(...committed.map(({ shot, upload }) => ({
        ...shot,
        upload,
        imageBuf: undefined,
        imageExt: undefined,
        imageMime: undefined,
        thumbnailBuf: undefined,
        thumbnailMime: undefined,
      })));
    }
  }

  return failed;
}

function getStoredAlerts(): any[] { return get('alerts') || []; }
function setStoredAlerts(alerts: any[]) { set('alerts', alerts); }

function normalizeAlertRecord(raw: any) {
  return {
    id: String(raw?.id || raw?.alert_id || ''),
    title: String(raw?.title ?? raw?.message ?? 'Untitled alert'),
    description: String(raw?.description ?? raw?.message ?? ''),
    severity: String(raw?.severity ?? 'medium'),
    sentAt: raw?.sent_at || raw?.created_at || new Date().toISOString(),
    isRead: Boolean(raw?.is_read ?? raw?.isRead),
    alertType: raw?.alert_type || raw?.alertType || null,
    metadata: raw?.metadata || raw?.meta || null,
    fromUserId: raw?.from_user_id || raw?.fromUserId || null,
  };
}

function mergeAlerts(localAlerts:any[], serverAlerts:any[]) {
  const map = new Map<string, any>();
  serverAlerts.forEach((item:any) => { const n = normalizeAlertRecord(item); map.set(n.id, n); });
  localAlerts.forEach((item:any) => {
    if (!item?.id) return;
    const existing = map.get(item.id);
    if (existing) { existing.isRead = existing.isRead || Boolean(item.isRead); }
    else { map.set(item.id, { ...normalizeAlertRecord(item) }); }
  });
  return Array.from(map.values()).sort((a,b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
}

async function syncAlertsWithServer() {
  if (!token) return getStoredAlerts();
  try {
    const serverAlerts = await apiRequest('GET', '/api/alerts');
    const merged = mergeAlerts(getStoredAlerts(), serverAlerts || []);
    setStoredAlerts(merged);
    return merged;
  } catch (err:any) {
    console.error('Alert sync failed:', err?.message || err);
    return getStoredAlerts();
  }
}

async function persistAlert(raw: any) {
  const alert = normalizeAlertRecord(raw);
  const alerts = getStoredAlerts();
  const exists = alerts.find((item:any) => item.id === alert.id);
  let nextAlerts = exists
    ? alerts.map((item:any) => item.id === alert.id ? { ...item, ...alert } : item)
    : [alert, ...alerts];
  nextAlerts = nextAlerts.sort((a:any,b:any) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
  setStoredAlerts(nextAlerts);
  return alert;
}

async function markAlertRead(id:string) {
  const existingAlerts = getStoredAlerts();
  const updatedAlerts  = existingAlerts.map((alert:any) => alert.id === id ? { ...alert, isRead:true } : alert);
  setStoredAlerts(updatedAlerts);
  if (!token) return updatedAlerts.find((alert:any) => alert.id === id) || null;
  try {
    const updated    = await apiRequest('PATCH', `/api/alerts/${id}/read`);
    const normalized = normalizeAlertRecord(updated);
    const finalAlerts = updatedAlerts.map((alert:any) => alert.id === id ? { ...alert, ...normalized, isRead:true } : alert);
    setStoredAlerts(finalAlerts);
    return finalAlerts.find((alert:any) => alert.id === id) || null;
  } catch (err:any) {
    console.error('Failed to sync read alert state:', err?.message || err);
    return updatedAlerts.find((alert:any) => alert.id === id) || null;
  }
}

// ─── Policy sync ────────────────────────────────────────────────────────────
async function syncPolicies() {
  if (!token) return;
  if (policySyncInFlight) return;
  policySyncInFlight = true;
  try {
    const bundle = await apiRequest('GET', '/api/agent/policy-bundle');
    const nextPolicy          = bundle?.policy ?? null;
    const nextBlockedApps     = Array.isArray(bundle?.blockedApps) ? bundle.blockedApps : [];
    const nextBlockedWebsites = Array.isArray(bundle?.blockedWebsites) ? bundle.blockedWebsites : [];

    const changed =
      JSON.stringify(cachedPolicy)          !== JSON.stringify(nextPolicy) ||
      JSON.stringify(cachedBlockedApps)     !== JSON.stringify(nextBlockedApps) ||
      JSON.stringify(cachedBlockedWebsites) !== JSON.stringify(nextBlockedWebsites);

    // ✅ Pehle update karo, phir proxy sync karo (naye data ke sath)
    cachedPolicy          = nextPolicy;
    cachedBlockedApps     = nextBlockedApps;
    cachedBlockedWebsites = nextBlockedWebsites;

    console.log('[SECURITY] Policies downloaded');
    console.log('[SECURITY] Blocked apps:', cachedBlockedApps.length);
    console.log('[SECURITY] Blocked websites:', cachedBlockedWebsites.length);
    console.log(changed ? 'Policy sync succeeded and updated in-memory policy data' : 'Policy sync succeeded');

    // ✅ Sirf ek baar, naye cache ke sath
    await syncProxyBlock(cachedPolicy, cachedBlockedWebsites);
  } catch (err:any) {
    console.error('[SECURITY] Policy sync failed:', err?.message || err);
  } finally {
    policySyncInFlight = false;
  }
}

async function enforcePolicies() {
  // Scanners enforce cached policy locally. Refresh is startup, a socket push,
  // or the five-minute safety interval below--never the five-second scan loop.
}

function connectPolicyRealtime() {
  if (policyRealtimeChannel || !SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  policyRealtimeClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  policyRealtimeChannel = policyRealtimeClient
    .channel('agent-policy-refresh', { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'policy-updated' }, () => {
      // Public broadcast carries no policy data. Debouncing prevents a noisy
      // channel from becoming a request amplifier; the bundle remains auth-only.
      if (Date.now() - lastPolicyPushAt < 5_000) return;
      lastPolicyPushAt = Date.now();
      console.log('[SECURITY] Supabase policy change received; refreshing');
      void syncPolicies();
    })
    .subscribe((status: string) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[SECURITY] Supabase Realtime unavailable; five-minute refresh remains active:', status);
      }
    });
}

function disconnectPolicyRealtime() {
  if (policyRealtimeClient && policyRealtimeChannel) void policyRealtimeClient.removeChannel(policyRealtimeChannel);
  policyRealtimeChannel = null;
  policyRealtimeClient = null;
}

// ─── Security event reporting ───────────────────────────────────────────────
async function submitSecurityEvent(eventType:string, value:string, actionTaken:string) {
  if (!token) return;
  const payload = { employeeId: employeeId || undefined, computerName: os.hostname(), eventType, value, actionTaken };
  let lastError: any;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await apiRequest('POST', '/api/security/events', payload);
      console.log('Security event reported', { eventType, value, actionTaken, attempt });
      return;
    } catch (err:any) {
      lastError = err;
      const s = typeof err?.status === 'number' ? err.status : 0;
      const shouldRetry = s === 0 || (s >= 500 && s < 600);
      if (!shouldRetry || attempt === 3) {
        console.error('Failed to submit security event:', err?.message || err);
        return;
      }
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  if (lastError) console.error('Security event submission failed:', lastError?.message || lastError);
}

function normalizeProcessName(name:string) {
  return (name || '').trim().toLowerCase().replace(/\.exe$/i, '');
}

async function getRunningProcessNames(): Promise<string[]> {
  const { execFile } = await import('child_process');

  // WMIC was removed from recent Windows 11 installations. A failed WMIC
  // invocation used to make every enforcement scan fail. tasklist is included
  // with supported Windows versions and its CSV output is locale-independent.
  const output = await new Promise<string>((resolve, reject) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { maxBuffer: 1024 * 1024 * 10 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => /^\s*"([^"]+)"/.exec(line)?.[1] || '')
    .filter(Boolean);
}

// ─── Website scan (detection + reporting only — PAC proxy does the actual blocking) ──
async function scanBlockedWebsites() {
  if (!token || !cachedPolicy || !cachedPolicy.blockWebsites || !cachedBlockedWebsites.length) return;
  try {
    const win = await getActiveWindowSnapshot();
    if (!win) return;
    const ownerName = (win?.owner?.name || '').toLowerCase();
    const title     = win?.title || '';
    console.log('[SECURITY] [DEBUG] owner.name=', JSON.stringify(win?.owner?.name), 'title=', JSON.stringify(title));

    const isBrowser = ['chrome', 'msedge', 'edge', 'firefox', 'brave'].some((b) => ownerName.includes(b));
    if (!isBrowser || !title) { console.log('[SECURITY] [DEBUG] Not recognized as browser, skipping'); return; }

    console.log('[SECURITY] Active browser window title:', title);

    const blockedDomains = cachedBlockedWebsites
      .filter((item: any) => item?.enabled)
      .map((item: any) => (item.domain || '').toLowerCase().replace(/^www\./, ''))
      .filter(Boolean);

    if (!blockedDomains.length) return;

    const lowerTitle = title.toLowerCase();
    const matchedDomain = blockedDomains.find((domain: string) => {
      const brand = domain.split('.')[0];
      return lowerTitle.includes(domain) || (brand.length > 2 && lowerTitle.includes(brand));
    });

    if (!matchedDomain) { console.log('[SECURITY] No violations found'); return; }

    console.log('[SECURITY] 🚨 Blocked website attempt detected:', matchedDomain, '(title:', title, ')');

    // Report once per domain per 5-minute window — avoid spamming
    const now           = Date.now();
    const lastReportedAt = recentlyReportedDomains.get(matchedDomain) || 0;
    if (now - lastReportedAt > 5 * 60 * 1000) {
      recentlyReportedDomains.set(matchedDomain, now);
      await submitSecurityEvent('blocked_website', matchedDomain, 'proxy_blocked');
    }
  } catch (err: any) {
    console.error('[SECURITY] Blocked website scan error:', err?.message || err);
  }
}

// ─── App scan ───────────────────────────────────────────────────────────────
async function scanBlockedApps() {
  if (!token || !cachedPolicy || !cachedPolicy.blockApps || !cachedBlockedApps.length) return;
  try {
    const { execFile } = await import('child_process');
    const runningProcesses = await getRunningProcessNames();

    const blockedNames = cachedBlockedApps
      .filter((item: any) => item?.enabled)
      .map((item: any) => normalizeProcessName(item.processName || ''))
      .filter(Boolean);

    console.log(`[SECURITY] Running processes count: ${runningProcesses.length}`);
    console.log(`[SECURITY] Blocked process names: ${blockedNames.join(', ')}`);
    if (!blockedNames.length) return;

    const runningNormalized = new Set(
      runningProcesses
        .map((processName) => normalizeProcessName(processName))
        .filter(Boolean),
    );

    for (const processName of Array.from(recentlyHandledProcesses.keys())) {
      if (!runningNormalized.has(processName)) {
        recentlyHandledProcesses.delete(processName);
      }
    }

    let violationFound = false;
    for (const processName of runningProcesses) {
      const np = normalizeProcessName(processName);
      if (!np || !blockedNames.includes(np)) continue;
      const now = Date.now();
      if (recentlyHandledProcesses.has(np)) continue;

      violationFound = true;
      recentlyHandledProcesses.set(np, now);
      console.log(`[SECURITY] 🚨 Found blocked process: ${processName}`);
      if (cachedPolicy.showWarning) {
        dialog.showMessageBoxSync({
          type:'warning',
          title:'Blocked Application',
          message:`"${processName}" is blocked and was closed by Vorion Tracker.`,
        });
      }
      if (cachedPolicy.killProcess) {
        await new Promise<void>((resolve) => {
          execFile('taskkill', ['/F', '/IM', processName], () => resolve());
        });
        console.log(`[SECURITY] ✅ Process termination requested: ${processName}`);
      }
      await submitSecurityEvent('blocked_app', np, cachedPolicy.killProcess ? 'terminated' : 'warning_shown');
    }
    if (!violationFound) console.log('[SECURITY] No violations found');
  } catch (err: any) {
    console.error('[SECURITY] Blocked app scan error:', err?.message || err);
  }
}

// ─── Live streaming (WebRTC) ────────────────────────────────────────────────
// A hidden BrowserWindow does the actual screen capture + RTCPeerConnection
// work, because RTCPeerConnection / getUserMedia only exist in a renderer
// (Chromium) context, not in this Node.js main process.

// ─────────────────────────────────────────────────────────────────────────
// FIX: previously `liveWatchStarted = true` was set unconditionally, before
// checking whether `employeeId` was actually populated yet. Because
// employeeId is restored asynchronously (via the GET /api/auth call in
// app.whenReady()), it's very possible for startTracking() -> initializeSocket()
// to run once with employeeId still '' — the `if (employeeId)` guard would
// skip setupLiveWatch(), but the flag was already latched to `true`, so
// every subsequent call became a permanent no-op. The live-watch channel
// then never got created for the rest of that process's life, even after
// employeeId became available moments later.
//
// Now we only latch `liveWatchStarted` once we've actually called
// setupLiveWatch() with a real employeeId, so a call made too early can be
// safely retried later (e.g. once boot-time identity restore finishes, or
// the next time startTracking() runs).
// ─────────────────────────────────────────────────────────────────────────

console.log('Vorion Tracker using SERVER_URL=', SERVER_URL);
if (!isDev && configuredServerUrl && isLocalServerUrl(configuredServerUrl)) {
  console.warn('[AGENT] ignoring local-only server URL in packaged build', {
    configuredServerUrl,
    effectiveServerUrl: SERVER_URL,
  });
}

function broadcastStatus(extra: Record<string, any> = {}) {
  // This is a local renderer update, not proof that the API accepted a
  // heartbeat. Only send `heartbeat` after /api/heartbeat succeeds.
  const payload = { agentId, employeeId, userName, status, sessionId, activeApp: lastActiveApp, activityPct: lastActivityPct, capturedAt: new Date().toISOString(), ...extra };
  mainWindow?.webContents.send('status-changed', payload);
}

async function sendHeartbeat() {
  if (!token) return;
  try {
    await apiRequest('POST', '/api/heartbeat', { currentApp: lastActiveApp, activityPct: lastActivityPct, status, timestamp: new Date().toISOString() });
    const heartbeat = new Date().toISOString();
    mainWindow?.webContents.send('status-changed', { status, userName, employeeId, heartbeat });
    void ensureLiveWatchRunning();
  } catch (err:any) { console.error('Heartbeat failed:', err?.message || err); }
}

function getFriendlyRequestError(err: any) {
  const message = err?.message || String(err || 'Unknown error');
  if (!/ECONNREFUSED/i.test(message)) return message;

  if (isLocalServerUrl(SERVER_URL)) {
    return `Agent is configured to use ${SERVER_URL}. Update WORKTRACK_SERVER or NEXT_PUBLIC_APP_URL to your deployed domain and rebuild the agent.`;
  }

  return `Unable to reach ${SERVER_URL}. Confirm the deployed domain is online and accessible from this device.`;
}

function sendUpdaterEvent(channel: string, payload: Record<string, any> = {}) {
  mainWindow?.webContents.send(channel, payload);
}

function getUpdaterStatus() {
  return {
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    releaseOwner: UPDATE_RELEASE_OWNER,
    releaseRepo: UPDATE_RELEASE_REPO,
    checking: updaterCheckInFlight,
    downloaded: updaterDownloaded,
    downloadedVersion: updaterDownloadedVersion,
  };
}

function getUpdaterErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown update error');
  if (/latest\.yml/i.test(message)) return 'The release is missing latest.yml. Upload the Electron Builder release assets and try again.';
  if (/sha512|checksum|hash|corrupt/i.test(message)) return 'The downloaded update could not be verified. Please publish the installer and blockmap again.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network|internet/i.test(message)) return 'Unable to check for updates. Check your internet connection and try again.';
  if (/404|Not Found/i.test(message)) return 'The update release or one of its files was not found on GitHub.';
  return message;
}

function setupAutoUpdater() {
  log.initialize();
  log.transports.file.level = 'info';
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: UPDATE_RELEASE_OWNER,
    repo: UPDATE_RELEASE_REPO,
    private: false,
    releaseType: 'release',
  } as any);

  autoUpdater.on('checking-for-update', () => {
    updaterCheckInFlight = true;
    log.info('[UPDATER] checking for updates', { currentVersion: app.getVersion(), repo: `${UPDATE_RELEASE_OWNER}/${UPDATE_RELEASE_REPO}` });
    sendUpdaterEvent('updater:checking', getUpdaterStatus());
  });

  autoUpdater.on('update-available', (info) => {
    updaterCheckInFlight = false;
    log.info('[UPDATER] update available', { currentVersion: app.getVersion(), availableVersion: info.version });
    sendUpdaterEvent('updater:available', { ...getUpdaterStatus(), version: info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    updaterCheckInFlight = false;
    log.info('[UPDATER] update not available', { currentVersion: app.getVersion(), latestVersion: info.version });
    sendUpdaterEvent('updater:not-available', { ...getUpdaterStatus(), version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    log.info('[UPDATER] download progress', { percent: Math.round(progress.percent), transferred: progress.transferred, total: progress.total });
    sendUpdaterEvent('updater:progress', { ...getUpdaterStatus(), percent: progress.percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updaterCheckInFlight = false;
    updaterDownloaded = true;
    updaterDownloadedVersion = info.version;
    log.info('[UPDATER] update downloaded', { version: info.version });
    sendUpdaterEvent('updater:downloaded', { ...getUpdaterStatus(), version: info.version });
    void promptForDownloadedUpdate(info.version);
  });

  autoUpdater.on('error', (error) => {
    updaterCheckInFlight = false;
    const message = getUpdaterErrorMessage(error);
    log.error('[UPDATER] error', message);
    sendUpdaterEvent('updater:error', { ...getUpdaterStatus(), message });
  });
}

async function checkForUpdates(manual: boolean) {
  if (!app.isPackaged) {
    const message = 'Updates are only available in packaged builds.';
    log.info('[UPDATER] skipped update check in development', { manual });
    sendUpdaterEvent('updater:error', { ...getUpdaterStatus(), message });
    return { ok: false, error: message };
  }

  if (updaterCheckInFlight) {
    const message = 'An update check is already in progress.';
    sendUpdaterEvent('updater:error', { ...getUpdaterStatus(), message });
    return { ok: false, error: message };
  }

  if (updaterDownloaded) {
    sendUpdaterEvent('updater:downloaded', { ...getUpdaterStatus(), version: updaterDownloadedVersion });
    return { ok: true, downloaded: true };
  }

  updaterCheckInFlight = true;
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    updaterCheckInFlight = false;
    const message = getUpdaterErrorMessage(error);
    log.error('[UPDATER] check failed', message);
    sendUpdaterEvent('updater:error', { ...getUpdaterStatus(), message });
    return { ok: false, error: message };
  }
}

function startAutoUpdateScheduler() {
  if (!app.isPackaged || updaterSchedulerStarted) return;
  updaterSchedulerStarted = true;
  setTimeout(() => { void checkForUpdates(false); }, AUTO_UPDATE_INITIAL_DELAY_MS);
  updaterInterval = setInterval(() => { void checkForUpdates(false); }, AUTO_UPDATE_INTERVAL_MS);
  log.info('[UPDATER] automatic update scheduler started', {
    initialDelayMs: AUTO_UPDATE_INITIAL_DELAY_MS,
    intervalMs: AUTO_UPDATE_INTERVAL_MS,
  });
}

async function waitForCondition(condition: () => boolean, timeoutMs: number, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

async function cleanupBeforeUpdateInstall() {
  log.info('[UPDATER] cleanup before restart started', { tracking, queueLength: screenshotQueue.length, sessionId: Boolean(sessionId) });
  const deadline = Date.now() + UPDATE_INSTALL_CLEANUP_TIMEOUT_MS;

  tracking = false;
  status = 'offline';
  ssInterval = clearTimer(ssInterval);
  uploadInterval = clearTimer(uploadInterval);
  idleInterval = clearTimer(idleInterval);
  heartbeatInterval = clearTimer(heartbeatInterval);
  policyInterval = clearTimer(policyInterval);
  scanInterval = clearTimer(scanInterval);
  policySyncInterval = clearTimer(policySyncInterval);
  if (screenshotFlushTimer) clearTimeout(screenshotFlushTimer);
  screenshotFlushTimer = null;
  disconnectPolicyRealtime();

  await waitForCondition(() => !capturingScreenshot, Math.max(0, deadline - Date.now()));

  while ((screenshotQueue.length > 0 || screenshotFlushInFlight) && Date.now() < deadline) {
    if (!screenshotFlushInFlight && screenshotQueue.length > 0) {
      await flushScreenshotQueue();
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (screenshotQueue.length > 0 || screenshotFlushInFlight) {
    log.warn('[UPDATER] cleanup timeout while waiting for screenshot uploads', {
      queueLength: screenshotQueue.length,
      uploadInFlight: screenshotFlushInFlight,
    });
  }

  try {
    if (sessionId) {
      await endSession();
    } else {
      await teardownLiveWatch({ authToken: token, serverUrl: SERVER_URL, stopRoom: false });
    }
  } catch (error) {
    log.error('[UPDATER] cleanup failed while ending session/live watch', getUpdaterErrorMessage(error));
  }

  updateTray();
  mainWindow?.webContents.send('tracking-status', { tracking: false });
  broadcastStatus();
  log.info('[UPDATER] cleanup before restart finished', { queueLength: screenshotQueue.length });
}

async function installDownloadedUpdate() {
  if (!updaterDownloaded) {
    const message = 'No downloaded update is ready to install.';
    sendUpdaterEvent('updater:error', { ...getUpdaterStatus(), message });
    return { ok: false, error: message };
  }

  try {
    await cleanupBeforeUpdateInstall();
  } catch (error) {
    log.error('[UPDATER] cleanup failed before install', getUpdaterErrorMessage(error));
  }

  allowImmediateQuit = true;
  isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
}

async function promptForDownloadedUpdate(version: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Vorion Tracker Update',
    message: `Version ${version} is ready to install.`,
    buttons: ['Restart and Update', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (result.response === 0) {
    await installDownloadedUpdate();
  } else {
    log.info('[UPDATER] user postponed update install', { version });
  }
}

function getScreenshotTargetSize() {
  // Always capture screenshots at the fixed resolution requested by the user.
  return { width: 1280, height: 720 };
}

// ─── Screenshot capture (local only) ────────────────────────────────────────
// captureAndUpload only captures + pushes to the local queue. It no longer
// triggers a flush itself — the fixed 30s `uploadInterval` (set up in
// startTracking) owns the batch-upload cadence, decoupled from the 5s
// capture cadence.
let capturingScreenshot = false;
async function captureAndUpload() {
  if (!tracking || capturingScreenshot) return;
  capturingScreenshot = true;
  try {
    const { width, height } = getScreenshotTargetSize();
    const sources = await desktopCapturer.getSources({ types:['screen'], thumbnailSize:{ width, height } });
    if (!sources.length) return;
    const resizedThumbnail = sources[0].thumbnail.resize({ width, height });
    const pngBuf = resizedThumbnail.toPNG();
    const capturedAt       = new Date().toISOString();
    const activeApp = await getActiveAppName();
    const idleSec = powerMonitor.getSystemIdleTime();
    const actPct  = Math.max(0, Math.min(100, Math.round(100 - (idleSec / 60) * 100)));
    lastActiveApp   = activeApp;
    lastActivityPct = actPct;
    mainWindow?.webContents.send('screenshot-taken', { time:new Date().toLocaleTimeString(), app:activeApp, pct:actPct });
    broadcastStatus({ activeApp, activityPct: actPct, capturedAt });

    // Compress right after capture (PNG → WebP, same resolution) so the
    // queue only ever holds the smaller payload we're actually going to
    // upload. Falls back to the original PNG automatically if compression
    // fails or somehow doesn't shrink the file.
    const { buffer: imageBuf, ext: imageExt, mimeType: imageMime } = await compressScreenshot(pngBuf);
    const thumbnail = await createScreenshotThumbnail(pngBuf);
    log.info('[SCREENSHOTS] Captured & compressed', {
      originalBytes: pngBuf.length,
      finalBytes: imageBuf.length,
      thumbnailBytes: thumbnail?.buffer.length || 0,
      format: imageExt,
      savingsPct: pngBuf.length ? Math.round((1 - imageBuf.length / pngBuf.length) * 100) : 0,
    });

    screenshotQueue.push({
      localId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      imageBuf,
      imageExt,
      imageMime,
      thumbnailBuf: thumbnail?.buffer,
      thumbnailMime: thumbnail?.mimeType,
      activeApp,
      activityPct: actPct,
      capturedAt,
      sessionId: sessionId || null,
      attempts: 0,
    });
    // NOTE: no scheduleScreenshotFlush() here anymore — the fixed 30s
    // uploadInterval owns the batch upload cadence now.
  } catch(e) { log.error('[SCREENSHOTS] Capture error:', e); }
  finally { capturingScreenshot = false; }
}

// ─── Session management ─────────────────────────────────────────────────────
async function startTracking() {
  if (tracking) return;
  tracking = true;
  status = 'active';

  await startSession();
  await ensureLiveWatchRunning();

  ssInterval         = setInterval(captureAndUpload, captureIntervalSec * 1000);         // 5s capture
  uploadInterval      = setInterval(() => { void flushScreenshotQueue(); }, uploadIntervalSec * 1000); // 30s batch upload
  idleInterval       = setInterval(watchIdle, 2000);
  heartbeatInterval  = setInterval(() => sendHeartbeat(), 30000);
  policyInterval     = setInterval(() => { void enforcePolicies(); }, 5000);
  scanInterval       = setInterval(() => { void scanBlockedApps(); void scanBlockedWebsites(); }, 2000);
  policySyncInterval = setInterval(() => { void syncPolicies(); }, 5 * 60 * 1000);

  await captureAndUpload();
  void flushScreenshotQueue();
  void sendHeartbeat();
  void syncPolicies();
  connectPolicyRealtime();
  void scanBlockedApps();
  void scanBlockedWebsites();

  updateTray();
  mainWindow?.webContents.send('tracking-status',{ tracking:true, sessionId });
  broadcastStatus();
}

async function stopTracking() {
  if (!tracking) return;
  tracking = false;
  status = 'offline';

  await endSession();

  ssInterval = clearTimer(ssInterval);
  uploadInterval = clearTimer(uploadInterval);
  idleInterval = clearTimer(idleInterval);
  heartbeatInterval = clearTimer(heartbeatInterval);
  policyInterval = clearTimer(policyInterval);
  scanInterval = clearTimer(scanInterval);
  policySyncInterval = clearTimer(policySyncInterval);
  if (screenshotFlushTimer) clearTimeout(screenshotFlushTimer);
  screenshotFlushTimer = null;
  disconnectPolicyRealtime();
  void flushScreenshotQueue();

  updateTray();
  mainWindow?.webContents.send('tracking-status', { tracking:false });
  broadcastStatus();
}


async function watchIdle() {
  const idleSec = powerMonitor.getSystemIdleTime();
  const isIdle  = idleSec > 60;
  mainWindow?.webContents.send('idle-status',{ isIdle, idleSec });
  if (isIdle && status === 'active')  {
    status = 'idle';
    broadcastStatus();
    void sendHeartbeat();
  }
  if (!isIdle && status === 'idle')   {
    status = 'active';
    broadcastStatus();
    void sendHeartbeat();
  }
}

function scheduleScreenshotFlush() {
  // Kept as a server-side safety net (queue cap) — no longer wired up to
  // captureAndUpload. The fixed uploadInterval (30s) drives normal flushes.
  if (screenshotFlushTimer || screenshotQueue.length >= 10) {
    if (screenshotQueue.length >= 10) void flushScreenshotQueue();
    return;
  }
  screenshotFlushTimer = setTimeout(() => {
    screenshotFlushTimer = null;
    void flushScreenshotQueue();
  }, 60_000);
}

function getScreenshotRetryDelayMs(attempt: number) {
  return SCREENSHOT_RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
}

function dequeueEligibleScreenshots(limit: number) {
  const now = Date.now();
  const batch: PendingScreenshot[] = [];
  for (let index = 0; index < screenshotQueue.length && batch.length < limit;) {
    const shot = screenshotQueue[index];
    if (shot.nextRetryAt && shot.nextRetryAt > now) {
      index += 1;
      continue;
    }
    batch.push(shot);
    screenshotQueue.splice(index, 1);
  }
  return batch;
}

// Flushes the local queue by uploading screenshots directly to Vercel Blob,
// then POSTing only metadata to our backend.
async function flushScreenshotQueue() {
  if (screenshotFlushInFlight || !screenshotQueue.length || !token) return;
  screenshotFlushInFlight = true;
  const batch = dequeueEligibleScreenshots(10);
  if (!batch.length) {
    screenshotFlushInFlight = false;
    return;
  }
  try {
    const failed = await uploadScreenshotBatch(batch);
    for (const shot of failed) {
      const nextAttempts = shot.attempts + 1;
      if (nextAttempts < MAX_UPLOAD_ATTEMPTS) {
        const retryDelayMs = getScreenshotRetryDelayMs(nextAttempts);
        log.warn(`[SCREENSHOTS] Upload/commit failed (attempt ${nextAttempts}/${MAX_UPLOAD_ATTEMPTS}), retrying in ${Math.round(retryDelayMs / 1000)}s`);
        screenshotQueue.push({ ...shot, attempts: nextAttempts, nextRetryAt: Date.now() + retryDelayMs });
      } else {
        log.error('[SCREENSHOTS] Upload/commit failed max attempts, dropping screenshot batch item', {
          capturedAt: shot.capturedAt,
          activeApp: shot.activeApp,
          hasBlobUpload: Boolean(shot.upload),
        });
      }
    }
  } catch (error: any) {
    for (const shot of batch) {
      const nextAttempts = shot.attempts + 1;
      if (nextAttempts < MAX_UPLOAD_ATTEMPTS) {
        const retryDelayMs = getScreenshotRetryDelayMs(nextAttempts);
        log.warn(`[SCREENSHOTS] Batch upload/commit failed (attempt ${nextAttempts}/${MAX_UPLOAD_ATTEMPTS}), retrying in ${Math.round(retryDelayMs / 1000)}s:`, error?.message || error);
        screenshotQueue.push({ ...shot, attempts: nextAttempts, nextRetryAt: Date.now() + retryDelayMs });
      } else {
        log.error('[SCREENSHOTS] Batch upload/commit failed max attempts, dropping screenshot batch item', {
          capturedAt: shot.capturedAt,
          activeApp: shot.activeApp,
          hasBlobUpload: Boolean(shot.upload),
          error: error?.message || error,
        });
      }
    }
  } finally {
    screenshotFlushInFlight = false;
    // NOTE: no self-rescheduling here — uploadInterval already fires every
    // 30s regardless, so re-arming scheduleScreenshotFlush would just create
    // a second, redundant flush path. Left only as the >=10-item safety net.
  }
}

// ─── Tray ───────────────────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tracking ? `● Tracking — ${userName}` : '○ Not tracking', enabled:false },
    { type:'separator' },
    { label: tracking ? 'Stop tracking' : 'Start tracking', click:()=> tracking?stopTracking():startTracking() },
    { label: 'Open window', click:()=>mainWindow?.show() },
    { label: 'Open dashboard in browser', click:()=>shell.openExternal(SERVER_URL) },
    { label: 'Check for Updates', click:()=>{ mainWindow?.show(); void checkForUpdates(true); } },
    { type:'separator' },
    { label: 'Quit', click:()=>{ void requestGracefulQuit(); } },
  ]));
  tray.setToolTip(tracking?`Vorion Tracker — tracking ${userName}`:'Vorion Tracker — not tracking');
}

function getTrayIconCandidates() {
  const platformIcon = process.platform === 'darwin' ? 'icon.icns' : process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const fallbackIcon = 'icon.png';
  const resourcesDir = process.resourcesPath || '';
  const devAssetsDir = path.join(__dirname, '../assets');

  return [
    path.join(resourcesDir, platformIcon),
    path.join(resourcesDir, fallbackIcon),
    path.join(__dirname, platformIcon),
    path.join(__dirname, fallbackIcon),
    path.join(devAssetsDir, platformIcon),
    path.join(devAssetsDir, fallbackIcon),
  ].filter((candidatePath, index, allPaths) => candidatePath && allPaths.indexOf(candidatePath) === index);
}

function loadTrayIcon() {
  for (const iconPath of getTrayIconCandidates()) {
    if (!fs.existsSync(iconPath)) continue;

    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      console.warn('[TRAY] icon file loaded as empty image', { iconPath });
      continue;
    }

    console.log('[TRAY] using icon', { iconPath });
    return process.platform === 'darwin' ? image.resize({ width: 18, height: 18 }) : image;
  }

  console.error('[TRAY] no usable icon found', { candidates: getTrayIconCandidates() });
  return nativeImage.createEmpty();
}

// ─── Window ─────────────────────────────────────────────────────────────────
async function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  const indexPath = path.join(__dirname, 'renderer', 'index.html');
  const iconPath = path.join(__dirname, 'renderer', 'logo.png');
  const hasPreload = fs.existsSync(preloadPath);
  const hasBuiltRenderer = fs.existsSync(indexPath);
  const hasIcon = fs.existsSync(iconPath);

  console.log('[AGENT] createWindow paths', {
    __dirname,
    preloadPath,
    hasPreload,
    indexPath,
    hasBuiltRenderer,
    iconPath,
    hasIcon,
  });

  mainWindow = new BrowserWindow({
    width:560, height:760, resizable:true,
    title:'Vorion Tracker',
    icon: hasIcon ? iconPath : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#020304',
    webPreferences:{
      preload:preloadPath,
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true,
      spellcheck:false,
    },
    show: false,
  });

  mainWindow.webContents.on('did-fail-load', (_, code, desc, url) => {
    console.log('LOAD FAILED:', code, desc, url);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[AGENT] renderer finished load');
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log('[AGENT][renderer console]', { level, message, line, sourceId });
  });
  mainWindow.webContents.on('render-process-gone', (_, details) => {
    console.log('RENDERER CRASHED:', details);
  });
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (isDev) {
    try {
      await mainWindow.loadURL('http://localhost:5174');
      console.log('[AGENT] loaded renderer from Vite dev server');
    } catch (err) {
      console.warn('[AGENT] Vite dev server unavailable, falling back to built renderer', err);
      if (!hasBuiltRenderer) {
        console.error('[AGENT] built renderer not found', { indexPath });
        return;
      }
      console.log('[AGENT] loading renderer from built bundle', { indexPath });
      await mainWindow.loadFile(indexPath);
    }
  } else {
    console.log('Loading index from:', indexPath, '| exists:', hasBuiltRenderer);
    if (!hasBuiltRenderer) {
      console.error('[AGENT] built renderer not found', { indexPath });
      await mainWindow.loadURL(`data:text/html,${encodeURIComponent(`
        <html><body style="font-family:Segoe UI,sans-serif;padding:24px;background:#111827;color:#f8fafc">
          <h2>Vorion Tracker failed to start</h2>
          <p>Built renderer not found.</p>
          <pre>${indexPath}</pre>
        </body></html>
      `)}`);
      return;
    }
    try {
      await mainWindow.loadFile(indexPath);
    } catch (error) {
      console.error('[AGENT] failed to load built renderer', formatError(error));
      await mainWindow.loadURL(`data:text/html,${encodeURIComponent(`
        <html><body style="font-family:Segoe UI,sans-serif;padding:24px;background:#111827;color:#f8fafc">
          <h2>Vorion Tracker failed to load UI</h2>
          <p>${String(formatError(error)).replace(/[<>&]/g, '')}</p>
          <pre>${indexPath}</pre>
          <pre>${preloadPath}</pre>
        </body></html>
      `)}`);
    }
  }

  mainWindow.on('close', (event) => {
    if (isQuitting) return;

    if (tracking) {
      event.preventDefault();
      mainWindow?.hide();
      return;
    }

    isQuitting = true;
    tray?.destroy();
    tray = null;
  });
}

// ─── IPC ────────────────────────────────────────────────────────────────────
function assertMainRenderer(event: Electron.IpcMainInvokeEvent) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('Untrusted IPC sender');
  }
}

ipcMain.handle('login', async (event, email:string, password:string) => {
  assertMainRenderer(event);
  try {
    const res = await apiRequest('POST','/api/auth',{ email, password, context: 'agent' });
    if (!res?.token) throw new Error(res?.error || 'Login failed');

    const nextEmployeeId = getEmployeeIdFromUser(res?.user || res?.profile || null);
    const nextUserName = res?.user?.name || res?.user?.full_name || res?.user?.fullName || '';

    persistSessionIdentity(res.token, nextUserName, nextEmployeeId);

    if (!employeeId) {
      console.warn('[AUTH] Login response did not contain an employeeId', { responseKeys: Object.keys(res || {}) });
    }

    status = 'offline';
    mainWindow?.webContents.send('status-changed', { status, userName, employeeId });
    return { ok:true, user:res.user };
  } catch (error:any) {
    console.error('Login failed:', error);
    return { ok:false, error: getFriendlyRequestError(error) };
  }
});
ipcMain.handle('logout', async (event) => {
  assertMainRenderer(event);
  await stopTracking();

  if (token) {
    void sessionAction('logout').catch((err:any) => {
      console.error('Logout action failed:', err?.message || err);
    });
  }

  storeAuthToken(''); userName=''; employeeId='';
  set('userName',''); set('employeeId','');
  status='offline';
  mainWindow?.webContents.send('status-changed',{ status:'offline' });
  mainWindow?.show();
  return { ok:true };
});
ipcMain.handle('get-status',       (event) => { assertMainRenderer(event); return { tracking, status, sessionId, userName, captureIntervalSec, idleSec: powerMonitor.getSystemIdleTime(), startedAt: status !== 'offline' ? Date.now() : null }; });
ipcMain.handle('updater:status',   (event) => { assertMainRenderer(event); return getUpdaterStatus(); });
ipcMain.handle('updater:check',    async (event) => { assertMainRenderer(event); return checkForUpdates(true); });
ipcMain.handle('updater:install',  async (event) => { assertMainRenderer(event); return installDownloadedUpdate(); });
ipcMain.handle('get-alerts',       async (event) => { assertMainRenderer(event); return getStoredAlerts(); });
ipcMain.handle('sync-alerts',      async (event) => { assertMainRenderer(event); return syncAlertsWithServer(); });
ipcMain.handle('mark-alert-read',  async (event, id:string) => { assertMainRenderer(event); return markAlertRead(id); });
ipcMain.handle('store-alert',      async (event, alert:any) => { assertMainRenderer(event); const saved = await persistAlert(alert); mainWindow?.webContents.send('new-alert', saved); return saved; });
ipcMain.handle('manual-shot',      (event) => { assertMainRenderer(event); return captureAndUpload(); });
ipcMain.handle('stop-tracking',    (event) => { assertMainRenderer(event); return stopTracking(); });
ipcMain.handle('start-tracking',   (event) => { assertMainRenderer(event); status = 'active'; return startTracking(); });
ipcMain.handle('start-work',       async (event) => { assertMainRenderer(event); status = 'active'; await startTracking(); return { ok: true }; });
ipcMain.handle('start-break',      async (event) => {
  assertMainRenderer(event);
  status = 'break';
  ssInterval = clearTimer(ssInterval);
  uploadInterval = clearTimer(uploadInterval);
  heartbeatInterval = clearTimer(heartbeatInterval);
  await sessionAction('start_break', { sessionId });
  broadcastStatus();
  return { ok: true };
});
ipcMain.handle('end-break', async (event) => {
  assertMainRenderer(event);
  status = 'active';
  await sessionAction('end_break', { sessionId });
  ssInterval = clearTimer(ssInterval);
  uploadInterval = clearTimer(uploadInterval);
  heartbeatInterval = clearTimer(heartbeatInterval);
  ssInterval        = setInterval(captureAndUpload, captureIntervalSec * 1000);
  uploadInterval    = setInterval(() => { void flushScreenshotQueue(); }, uploadIntervalSec * 1000);
  heartbeatInterval = setInterval(() => sendHeartbeat(), 30000);
  broadcastStatus();
  return { ok: true };
});
ipcMain.handle('checkout', async (event) => {
  assertMainRenderer(event);
  if (tracking) {
    await stopTracking();
    return { ok: true };
  }

  void endSession();
  return { ok: true };
});
app.commandLine.appendSwitch('disable-features', 'DesktopCaptureUseDxgi,SpareRendererForSitePerProcess,CalculateNativeWinOcclusion');
// ─── Boot ────────────────────────────────────────────────────────────────────
app.whenReady().then(async ()=>{
  setupAutoUpdater();
  await createWindow();
  tray = new Tray(loadTrayIcon());
  tray.on('double-click',()=>mainWindow?.show());
  updateTray();
  mainWindow?.show();
  status = 'offline';
  const storedToken = loadStoredAuthToken();
  const storedUserName = get('userName') || '';
  const storedEmployeeId = get('employeeId') || '';
  if (storedToken) {
    try {
      persistSessionIdentity(storedToken, storedUserName, storedEmployeeId);
      console.log('[AUTH] restored session identity from local store', { employeeId, userName, hasToken: Boolean(token) });
      status = 'offline';
      mainWindow?.webContents.send('status-changed', { status, userName, employeeId });
    } catch {
      console.log('Stored token invalid/expired — clearing, user must log in again');
      storeAuthToken(''); userName=''; employeeId='';
      set('userName',''); set('employeeId','');
      status = 'offline';
      mainWindow?.webContents.send('status-changed', { status:'offline' });
    }

    void (async () => {
      try {
        const authRes = await apiRequest('GET', '/api/auth');
        const nextEmployeeId = getEmployeeIdFromUser(authRes?.user || authRes?.profile || null);
        const nextUserName = authRes?.user?.name || authRes?.user?.full_name || authRes?.user?.fullName || '';
        persistSessionIdentity(token, nextUserName, nextEmployeeId);
        console.log('[AUTH] refreshed session identity', { employeeId, userName, hasToken: Boolean(token) });
        mainWindow?.webContents.send('status-changed', { status, userName, employeeId });
      } catch (error: any) {
        if (error?.status === 401 || error?.status === 403) {
          console.log('[AUTH] background auth refresh rejected saved session; clearing cached identity');
          storeAuthToken(''); userName=''; employeeId='';
          set('userName',''); set('employeeId','');
          status = 'offline';
          mainWindow?.webContents.send('status-changed', { status:'offline' });
          return;
        }
        console.log('[AUTH] background auth refresh failed — keeping cached identity');
      }
    })();
  } else {
    mainWindow?.webContents.send('status-changed', { status: 'offline' });
  }
  startAutoUpdateScheduler();
});

app.on('window-all-closed', () => {
  if (tracking) return;
  isQuitting = true;
  app.quit();
});
app.on('before-quit', (event) => {
  if (allowImmediateQuit) {
    isQuitting = true;
    return;
  }

  event.preventDefault();
  void requestGracefulQuit();
});
