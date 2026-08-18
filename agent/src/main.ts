import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
// Main-process deps must stay above bootstrap code so CommonJS emits them before use.
import { app } from 'electron';
import {
   BrowserWindow, Tray, Menu, nativeImage, Notification,
  ipcMain, powerMonitor, desktopCapturer, screen, shell, dialog, safeStorage
} from 'electron';
import os from 'os';
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { execFile } from 'child_process';
import type { Server as NetServer } from 'net';
import sharp from 'sharp';
import axios from 'axios';
import { io, type Socket } from 'socket.io-client';
import log from 'electron-log/main';
import { autoUpdater } from 'electron-updater';
import { EMBEDDED_ENV } from './embedded-config';
import { isServiceReachable, sendServiceCommand, startServiceCommandServer, type ServiceCommand } from './service-ipc';

const SERVICE_MODE = process.argv.includes('--service');
const SHARED_DATA_ROOT = process.platform === 'win32'
  ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'VorionTracker')
  : '';

if ((SERVICE_MODE || app.isPackaged) && SHARED_DATA_ROOT) {
  app.setPath('userData', SHARED_DATA_ROOT);
}

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
    const logDir = app.isPackaged ? app.getPath('userData') : cwd;
    if (!logDir) return;

    const logPath = path.join(logDir, 'agent-debug.log');
    fs.mkdirSync(logDir, { recursive: true });
    const logStream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8', mode: 0o600 });
    logStream.on('error', () => {
      // Logging must never interfere with the monitoring loop.
    });
    const append = (level: 'LOG' | 'WARN' | 'ERROR', args: unknown[]) => {
      try {
        const line = `[${new Date().toISOString()}] [${level}] ${args.map((arg) => {
          if (arg instanceof Error) return arg.stack || arg.message;
          if (typeof arg === 'string') return arg;
          try { return JSON.stringify(arg); } catch { return String(arg); }
        }).join(' ')}\n`;
        logStream.write(line);
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
  SERVER_URL: Boolean(process.env.WORKTRACK_SERVER || EMBEDDED_ENV.WORKTRACK_SERVER),
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
const localTestEnabled = String(process.env.VORION_LOCAL_TEST || EMBEDDED_ENV.VORION_LOCAL_TEST || '').toLowerCase() === 'true';
const localTestServerUrl = process.env.LOCAL_TEST_SERVER_URL || EMBEDDED_ENV.LOCAL_TEST_SERVER_URL || 'http://localhost:3000';
const configuredServerUrl = process.env.WORKTRACK_SERVER || EMBEDDED_ENV.WORKTRACK_SERVER || '';
const fallbackServerUrl = isDev ? 'http://127.0.0.1:3000/' : 'https://api.vorionsystems.com/';
const SERVER_URL = (() => {
  if (localTestEnabled) {
    const normalizedLocalUrl = normalizeServerUrl(localTestServerUrl);
    if (!normalizedLocalUrl || !isLocalServerUrl(normalizedLocalUrl)) {
      console.warn('[AGENT] VORION_LOCAL_TEST requires a localhost LOCAL_TEST_SERVER_URL');
      return fallbackServerUrl;
    }
    return normalizedLocalUrl;
  }
  const normalizedConfiguredUrl = normalizeServerUrl(configuredServerUrl);

  if (!normalizedConfiguredUrl) return fallbackServerUrl;
  if (!isDev && isLocalServerUrl(normalizedConfiguredUrl)) return 'https://api.vorionsystems.com/';
  if (!isDev && new URL(normalizedConfiguredUrl).protocol !== 'https:') {
    console.warn('[AGENT] refusing non-HTTPS server URL in packaged build');
    return 'https://api.vorionsystems.com/';
  }

  return normalizedConfiguredUrl;
})();
const SOCKET_SERVER_URL = process.env.SOCKET_SERVER_URL || EMBEDDED_ENV.SOCKET_SERVER_URL || '';

// ─── Persistent store ──────────────────────────────────────────────────────
const DATA_DIR   = app.getPath('userData');
const STORE_PATH = path.join(DATA_DIR, 'worktrack-store.json');
const DISCLOSURE_NOTICE_VERSION = '2026-07-26';
const DISCLOSURE_NOTICE_TEXT = 'This company-owned device is monitored for company data protection purposes. Activity such as app usage, screenshots, file and transfer metadata, and device security events may be recorded and reviewed by authorized company personnel.';

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
let monitoringActive = false;
let workSessionActive = false;
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
let alertSyncInterval:  NodeJS.Timeout|null = null;
let liveViewRequestInterval: NodeJS.Timeout|null = null;
const DEFAULT_CAPTURE_INTERVAL_SEC = 5;
const MIN_CAPTURE_INTERVAL_SEC = 5;
function normalizeCaptureIntervalSec(value: unknown) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? Math.max(MIN_CAPTURE_INTERVAL_SEC, parsed) : DEFAULT_CAPTURE_INTERVAL_SEC;
}
let captureIntervalSec = normalizeCaptureIntervalSec(get('captureIntervalSec')); // capture cadence: how often a screenshot is taken locally
const uploadIntervalSec = 60;                                        // metadata manifest cadence after bytes reach R2
const HEARTBEAT_INTERVAL_MS = 120_000;
const LIVE_VIEW_REQUEST_POLL_MS = 60_000;
const ALERT_SYNC_INTERVAL_MS = 120_000;
let lastActiveApp    = 'Unknown';
let lastActivityPct  = 100;
let activeWindowWarningLogged = false;
let alertSyncInFlight = false;
let cachedPolicy:         any   = null;
let cachedBlockedApps:    any[] = [];
let cachedBlockedWebsites:any[] = [];
let policySyncInFlight = false;
let policySocket: Socket | null = null;
let lastPolicyPushAt = 0;
let activeLiveRequestId = '';
let telemetryInterval: NodeJS.Timeout | null = null;
let transferDetectionInterval: NodeJS.Timeout | null = null;
let volumeScanInterval: NodeJS.Timeout | null = null;
const watchedRoots = new Map<string, fs.FSWatcher>();
const recentFileEvents: Array<{ rootType: string; action: string; filePath: string; sizeBytes: number; occurredAt: number }> = [];
const externalUploadDomains = ['airforshare.com', 'wetransfer.com', 'dropbox.com', 'drive.google.com', 'mega.nz', 'sendspace.com', 'transfernow.net', 'wormhole.app'];
const allowedUploadDomains = String(process.env.ALLOWED_UPLOAD_DOMAINS || '')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);
let knownVolumeIds = new Set<string>();
let lastAfterHoursAlertDay = '';
// `attempts` lets a failed upload be retried on the next batch flush without
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
  uploadTarget?: { full: R2UploadTarget; thumbnail: R2UploadTarget };
  activeApp: string;
  activityPct: number;
  capturedAt: string;
  sessionId: string | null;
  attempts: number;
  nextRetryAt?: number;
};
const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_SCREENSHOT_BATCH_SIZE = 60;
const SCREENSHOT_AUTH_WINDOW_SIZE = 60;
const MAX_CONCURRENT_SCREENSHOT_UPLOADS = 2;
const SCREENSHOT_RETRY_BASE_DELAY_MS = 30_000;
const SCREENSHOT_WEBP_QUALITY = 62;
const SCREENSHOT_THUMBNAIL_WIDTH = 360;
const SCREENSHOT_THUMBNAIL_HEIGHT = 203;
const SCREENSHOT_THUMBNAIL_QUALITY = 38;
const STORAGE_ORGANIZATION_SCOPE = 'default';
const SCREENSHOT_PROTOCOL_VERSION = 2;
const SCREENSHOT_PROTOCOL_HEADER = 'X-Vorion-Agent-Protocol';
let screenshotQueue: PendingScreenshot[] = [];
let screenshotManifestQueue: PendingScreenshot[] = [];
let screenshotUploadInFlight = 0;
let screenshotFlushTimer: NodeJS.Timeout | null = null;
let screenshotFlushInFlight = false;
let screenshotAuthWindow: Array<{ localId: string; full: R2UploadTarget; thumbnail: R2UploadTarget }> = [];
let lastBlobTokenDiagnosticAt = 0;
let updaterCheckInFlight = false;
let updaterManualCheckInFlight = false;
let updaterDownloaded = false;
let updaterDownloadedVersion = '';
let updaterSchedulerStarted = false;
let updaterInterval: NodeJS.Timeout | null = null;
let sessionStartedAt = 0;
let serviceCommandServer: NetServer | null = null;
let serviceStatusBridgeInterval: NodeJS.Timeout | null = null;
// tracks which blocked domains we've already reported recently, to avoid spamming events
const recentlyReportedDomains = new Map<string, number>();
// tracks recently handled blocked processes, so repeated scans don't reopen the same warning dialog
const recentlyHandledProcesses = new Map<string, number>();
set('agentId', agentId);

function clearTimer(timer: NodeJS.Timeout | null) {
  if (timer) clearInterval(timer);
  return null;
}

function buildStatusPayload() {
  return {
    tracking: monitoringActive,
    monitoringActive,
    workSessionActive,
    status,
    sessionId,
    userName,
    employeeId,
    captureIntervalSec,
    idleSec: powerMonitor.getSystemIdleTime(),
    startedAt: sessionStartedAt || null,
  };
}

async function requestGracefulQuit() {
  if (quitInFlight) return quitInFlight;

  quitInFlight = (async () => {
    isQuitting = true;

    try {
      if (monitoringActive) {
        await stopMonitoring();
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
if (!SERVICE_MODE) {
  if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
  app.on('second-instance', () => mainWindow?.show());
}

// ─── Auto-start with OS ────────────────────────────────────────────────────
if (!SERVICE_MODE) {
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
}
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
    headers['X-Agent-Version'] = getAgentAppVersion();
    headers['User-Agent'] = `VorionTracker-Agent/${getAgentAppVersion()}`;
    if (
      path.startsWith('/api/r2/screenshot-upload-urls') ||
      path.startsWith('/api/agent/screenshots/commit') ||
      path.startsWith('/api/heartbeat') ||
      path.startsWith('/api/agent/policy-bundle') ||
      path.startsWith('/api/security/policies') ||
      path.startsWith('/api/blocked/apps') ||
      path.startsWith('/api/blocked/websites')
    ) {
      headers[SCREENSHOT_PROTOCOL_HEADER] = String(SCREENSHOT_PROTOCOL_VERSION);
      headers['X-Vorion-Agent-Id'] = agentId;
    }
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
          if (status >= 200 && status < 300) handleAgentUpdateRequired(parsed, path);
          if (status >= 200 && status < 300) return resolve(parsed);
          if (status === 426) {
            set('agentUpdateRequired', true);
            log.error('[UPDATER] Agent protocol upgrade required', {
              minimumProtocolVersion: parsed?.minimumProtocolVersion || null,
              downloadUrl: parsed?.downloadUrl || null,
            });
            return reject(new HttpError(parsed?.error || 'agent_upgrade_required', status));
          }
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

function getDisclosureAckVersion() {
  return String(get('disclosureNoticeVersion') || '');
}

function isDisclosureAcknowledged() {
  return getDisclosureAckVersion() === DISCLOSURE_NOTICE_VERSION;
}

function markDisclosureAcknowledgedLocally() {
  set('disclosureNoticeVersion', DISCLOSURE_NOTICE_VERSION);
  set('disclosureAcknowledgedAt', new Date().toISOString());
}

function clearPendingDisclosureSync() {
  remove('disclosureSyncPending');
}

function markPendingDisclosureSync() {
  set('disclosureSyncPending', true);
}

function hasPendingDisclosureSync() {
  return Boolean(get('disclosureSyncPending'));
}

function getInstallScope() {
  if (process.platform === 'darwin') return 'launch-agent';
  if (process.platform === 'win32') return 'user-install';
  return 'desktop-app';
}

function getAgentAppVersion() {
  try { return app.getVersion(); } catch { return '0.0.0'; }
}

let lastAgentUpdateRequiredNoticeAt = 0;
function handleAgentUpdateRequired(payload: any, path: string) {
  if (!payload?.updateRequired) return;
  set('agentUpdateRequired', true);
  const minimumVersion = String(payload?.minimumSupportedAgentVersion || '').trim();
  const now = Date.now();
  if (now - lastAgentUpdateRequiredNoticeAt < 10 * 60 * 1000) return;
  lastAgentUpdateRequiredNoticeAt = now;
  const message = minimumVersion
    ? `Please update Vorion Tracker. Minimum supported agent version is ${minimumVersion}.`
    : 'Please update Vorion Tracker. This installed agent is no longer current.';
  log.warn('[UPDATER] Agent update recommended by server', {
    currentVersion: getAgentAppVersion(),
    minimumVersion: minimumVersion || null,
    path,
  });
  sendUpdaterEvent('updater:available', { ...getUpdaterStatus(), version: minimumVersion || undefined, message });
}

function queueRecentFileEvent(rootType: string, action: string, filePath: string) {
  let sizeBytes = 0;
  try {
    const stat = fs.statSync(filePath);
    sizeBytes = stat.isFile() ? stat.size : 0;
  } catch {}
  recentFileEvents.push({ rootType, action, filePath, sizeBytes, occurredAt: Date.now() });
  while (recentFileEvents.length > 500) recentFileEvents.shift();
}

function getUserWatchRoots() {
  const home = os.homedir();
  return [
    { rootType: 'desktop', rootPath: path.join(home, 'Desktop') },
    { rootType: 'documents', rootPath: path.join(home, 'Documents') },
    { rootType: 'downloads', rootPath: path.join(home, 'Downloads') },
  ];
}

async function listWindowsMountedVolumes(): Promise<Array<{ id: string; rootPath: string; kind: 'usb' | 'network' }>> {
  if (process.platform !== 'win32') return [];
  const result = await runPowerShellJson(`
$items = @()
Get-CimInstance Win32_LogicalDisk | ForEach-Object {
  if ($_.DriveType -eq 2 -and $_.DeviceID) {
    $items += [pscustomobject]@{ id = $_.VolumeSerialNumber; rootPath = "$($_.DeviceID)\\"; kind = "usb" }
  }
  if ($_.DriveType -eq 4 -and $_.DeviceID) {
    $items += [pscustomobject]@{ id = $_.ProviderName; rootPath = "$($_.DeviceID)\\"; kind = "network" }
  }
}
$items | ConvertTo-Json -Compress
`);
  return Array.isArray(result) ? result : (result ? [result] : []);
}

function startFsWatcher(rootPath: string, rootType: string) {
  if (!rootPath || watchedRoots.has(rootPath) || !fs.existsSync(rootPath)) return;
  try {
    const watcher = fs.watch(rootPath, { recursive: process.platform !== 'linux' }, (eventType, filename) => {
      const nextPath = filename ? path.join(rootPath, String(filename)) : rootPath;
      const action = eventType === 'rename' ? 'rename' : 'change';
      queueRecentFileEvent(rootType, action, nextPath);
    });
    watchedRoots.set(rootPath, watcher);
  } catch (error) {
    console.warn('[TELEMETRY] Failed to watch root', { rootPath, rootType, error: formatError(error) });
  }
}

function stopFsWatchers() {
  for (const watcher of watchedRoots.values()) {
    try { watcher.close(); } catch {}
  }
  watchedRoots.clear();
}

async function refreshWatchedRoots() {
  for (const root of getUserWatchRoots()) startFsWatcher(root.rootPath, root.rootType);
  const mounted = await listWindowsMountedVolumes();
  for (const volume of mounted) startFsWatcher(volume.rootPath, volume.kind);
}

function requestText(method:string, path:string, body?:any): Promise<{ status: number; text: string }> {
  return new Promise((resolve,reject) => {
    const url  = new URL(path, SERVER_URL);
    const mod  = url.protocol==='https:'?https:http;
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const headers: Record<string,string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    headers['X-Agent-Version'] = getAgentAppVersion();
    headers['User-Agent'] = `VorionTracker-Agent/${getAgentAppVersion()}`;
    if (
      path.startsWith('/api/r2/screenshot-upload-urls') ||
      path.startsWith('/api/agent/screenshots/commit') ||
      path.startsWith('/api/heartbeat') ||
      path.startsWith('/api/agent/policy-bundle') ||
      path.startsWith('/api/security/policies') ||
      path.startsWith('/api/blocked/apps') ||
      path.startsWith('/api/blocked/websites')
    ) {
      headers[SCREENSHOT_PROTOCOL_HEADER] = String(SCREENSHOT_PROTOCOL_VERSION);
      headers['X-Vorion-Agent-Id'] = agentId;
    }
    if (data) { headers['Content-Type']='application/json'; headers['Content-Length']=String(data.length); }
    const req = (mod as any).request({ hostname:url.hostname, port:url.port||undefined, path:url.pathname+url.search, method, headers }, (res: IncomingMessage) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => raw += chunk);
      res.on('end', () => {
        if (String(res.headers['x-agent-update-required'] || '').toLowerCase() === 'true') {
          handleAgentUpdateRequired({
            updateRequired: true,
            minimumSupportedAgentVersion: res.headers['x-min-supported-agent-version'],
          }, path);
        }
        resolve({ status: res.statusCode || 0, text: raw });
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

type BlobScreenshotUpload = {
  path: string;
  url: string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  downloadUrl?: string;
  contentType?: string;
  checksum?: string;
};

type ScreenshotBlobPaths = {
  pathname: string;
  thumbnailPathname?: string;
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
    workSessionActive = Boolean(sessionId);
    sessionStartedAt = Date.now();
    await checkLiveViewRequest();
  } catch (err:any) {
    console.error('Failed to start session:', err?.message || err);
  }
}

async function startLiveWatchForRequest(requestId: string) {
  if (!monitoringActive || !token || !employeeId || !sessionId) return;
  if (activeLiveRequestId === requestId) return;
  if (activeLiveRequestId) {
    await stopLiveWatchForRequest();
  }

  try {
    console.log('[LIVE_VIEW] starting requested LiveKit stream', { requestId, employeeId, sessionId });
    await setupLiveWatch({
      employeeId,
      sessionId,
      authToken: token,
      serverUrl: SERVER_URL,
    });
    activeLiveRequestId = requestId;
    await apiRequest('PATCH', '/api/live/request', { requestId, action: 'accept' }).catch(() => undefined);
    console.log('[LIVE_VIEW] accepted live view request', { requestId, employeeId, sessionId });
  } catch (err:any) {
    console.error('Failed to start live watch:', err?.message || err);
  }
}

async function stopLiveWatchForRequest(requestId = activeLiveRequestId) {
  if (!activeLiveRequestId && !requestId) return;
  const requestToStop = requestId || activeLiveRequestId;
  activeLiveRequestId = '';
  try {
    console.log('[LIVE_VIEW] stopping requested LiveKit stream', { requestId: requestToStop, employeeId, sessionId });
    await teardownLiveWatch({ authToken: token, serverUrl: SERVER_URL, sessionId, stopRoom: false });
  } catch (err:any) {
    console.error('Failed to stop live watch:', err?.message || err);
  }
  if (requestToStop) {
    await apiRequest('PATCH', '/api/live/request', { requestId: requestToStop, action: 'stop' }).catch(() => undefined);
  }
}

async function checkLiveViewRequest() {
  if (!monitoringActive || !token || !employeeId || !sessionId) {
    if (activeLiveRequestId) await stopLiveWatchForRequest();
    return;
  }

  try {
    const response = await apiRequest('GET', '/api/live/request');
    const request = response?.request;
    if (request?.id) {
      console.log('[LIVE_VIEW] request found', { requestId: request.id, status: request.status, employeeId, sessionId });
      await startLiveWatchForRequest(String(request.id));
      return;
    }
    if (activeLiveRequestId) {
      await stopLiveWatchForRequest();
    }
  } catch (err:any) {
    console.error('Live view request check failed:', err?.message || err);
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
    const requestToStop = activeLiveRequestId;
    activeLiveRequestId = '';
    await teardownLiveWatch({
      authToken: token,
      serverUrl: SERVER_URL,
      sessionId: sessionIdToClose,
      stopRoom: true,
    });
    if (requestToStop) {
      await apiRequest('PATCH', '/api/live/request', { requestId: requestToStop, action: 'stop' }).catch(() => undefined);
    }
    sessionId = '';
    workSessionActive = false;
    sessionStartedAt = 0;
  }
}

async function getActiveWindowSnapshot() {
  const now = Date.now();
  if (activeWindowSnapshotPromise && now - activeWindowSnapshotStartedAt < ACTIVE_WINDOW_CACHE_MS) {
    return activeWindowSnapshotPromise;
  }
  activeWindowSnapshotStartedAt = now;
  activeWindowSnapshotPromise = queryActiveWindowSnapshot();
  return activeWindowSnapshotPromise;
}

// Coalesce only near-simultaneous callers without making foreground-window
// reporting observably stale.
const ACTIVE_WINDOW_CACHE_MS = 500;
let activeWindowSnapshotStartedAt = 0;
let activeWindowSnapshotPromise: Promise<any | null> | null = null;
let activeWinModuleUnavailable = false;

async function queryActiveWindowSnapshot() {
  try {
    if (!activeWinModuleUnavailable) {
      const activeWinModule = require('active-win');
      return await activeWinModule.default();
    }
  } catch (err:any) {
    activeWinModuleUnavailable = true;
    if (!activeWindowWarningLogged) {
      activeWindowWarningLogged = true;
      console.warn('[AGENT] active-win unavailable, using platform fallback if possible', err?.message || err);
    }
  }
  return null;
}

function normalizeAppName(value: unknown) {
  const appName = String(value || '').trim();
  if (!appName || appName.toLowerCase() === 'unknown') return '';
  return appName.slice(0, 500);
}

function runPowerShellJson(script: string): Promise<any | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          resolve(JSON.parse(String(stdout || '').trim()));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

async function getWindowsActiveAppName() {
  if (process.platform !== 'win32') return '';

  const result = await runPowerShellJson(`
Add-Type -Namespace Vorion -Name ForegroundWindow -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int count);
'@
$handle = [Vorion.ForegroundWindow]::GetForegroundWindow()
$processId = 0
[void][Vorion.ForegroundWindow]::GetWindowThreadProcessId($handle, [ref]$processId)
$title = New-Object System.Text.StringBuilder 1024
[void][Vorion.ForegroundWindow]::GetWindowText($handle, $title, $title.Capacity)
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
[pscustomobject]@{
  processName = if ($process) { $process.ProcessName } else { "" }
  title = $title.ToString()
} | ConvertTo-Json -Compress
`);

  return normalizeAppName(result?.processName)
    || normalizeAppName(String(result?.title || '').split(' - ')[0]);
}

async function getActiveAppName() {
  const activeWindow = await getActiveWindowSnapshot();
  const detectedApp = normalizeAppName(activeWindow?.owner?.name)
    || normalizeAppName(activeWindow?.title?.split(' - ')[0])
    || await getWindowsActiveAppName();

  return detectedApp || normalizeAppName(lastActiveApp) || 'Unknown';
}


async function compressScreenshot(pngBuffer: Buffer): Promise<{ buffer: Buffer; ext: 'webp'; mimeType: string }> {
  try {
    const webpBuffer = await sharp(pngBuffer)
      .webp({
        quality: SCREENSHOT_WEBP_QUALITY,
        // Effort 2 is substantially cheaper than 6 on employee machines and
        // only modestly increases the upload size at this resolution.
        effort: 2,
        smartSubsample: true,
      })
      .toBuffer();

    if (webpBuffer.length > 0) return { buffer: webpBuffer, ext: 'webp', mimeType: 'image/webp' };
    throw new Error('WebP encoder returned an empty buffer');
  } catch (err: any) {
    log.warn('[SCREENSHOTS] WebP compression failed, using PNG decode fallback through Sharp', err?.message || err);
    const buffer = await sharp(pngBuffer).webp({ quality: SCREENSHOT_WEBP_QUALITY, effort: 1 }).toBuffer();
    return { buffer, ext: 'webp', mimeType: 'image/webp' };
  }
}

async function createScreenshotThumbnail(pngBuffer: Buffer): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const buffer = await sharp(pngBuffer)
      .resize({ width: SCREENSHOT_THUMBNAIL_WIDTH, height: SCREENSHOT_THUMBNAIL_HEIGHT, fit: 'cover' })
      .webp({
        quality: SCREENSHOT_THUMBNAIL_QUALITY,
        effort: 1,
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
function getScreenshotBlobPaths(shot: PendingScreenshot, screenshotOwnerId: string): ScreenshotBlobPaths {
  const extension = shot.imageExt || 'webp';
  const datePath = new Date(shot.capturedAt || Date.now()).toISOString().slice(0, 10).replace(/-/g, '/');
  return {
    pathname: `screenshots/regular/${STORAGE_ORGANIZATION_SCOPE}/${screenshotOwnerId}/${datePath}/${shot.localId}.${extension}`,
    thumbnailPathname: shot.thumbnailBuf ? `screenshots/thumbnails/${STORAGE_ORGANIZATION_SCOPE}/${screenshotOwnerId}/${datePath}/${shot.localId}.webp` : undefined,
  };
}

type R2UploadTarget = { uploadUrl: string; url: string };

async function ensureScreenshotAuthWindow() {
  if (screenshotAuthWindow.length) return;
  const authenticatedUserId = getAuthenticatedUserIdFromToken(token);
  const screenshotOwnerId = authenticatedUserId || employeeId;
  if (!token || !screenshotOwnerId) throw new Error('Cannot authorize screenshots without an authenticated employee');

  const reservations = Array.from({ length: SCREENSHOT_AUTH_WINDOW_SIZE }, () => {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const datePath = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return {
      localId,
      pathname: `screenshots/regular/${STORAGE_ORGANIZATION_SCOPE}/${screenshotOwnerId}/${datePath}/${localId}.webp`,
      thumbnailPathname: `screenshots/thumbnails/${STORAGE_ORGANIZATION_SCOPE}/${screenshotOwnerId}/${datePath}/${localId}.webp`,
    };
  });
  const response = await apiRequest('POST', '/api/r2/screenshot-upload-urls', {
    uploads: reservations.flatMap((item) => [
      { pathname: item.pathname, contentType: 'image/webp' },
      { pathname: item.thumbnailPathname, contentType: 'image/webp' },
    ]),
  });
  const targets = new Map<string, R2UploadTarget>();
  for (const item of response?.targets || []) {
    if (item?.pathname && item?.uploadUrl && item?.url) {
      targets.set(String(item.pathname), { uploadUrl: String(item.uploadUrl), url: String(item.url) });
    }
  }
  screenshotAuthWindow = reservations.map((item) => {
    const full = targets.get(item.pathname);
    const thumbnail = targets.get(item.thumbnailPathname);
    if (!full || !thumbnail) throw new Error(`Missing screenshot upload reservation for ${item.localId}`);
    return { localId: item.localId, full, thumbnail };
  });
}

async function reserveScreenshotUpload() {
  await ensureScreenshotAuthWindow();
  const reservation = screenshotAuthWindow.shift();
  if (!reservation) throw new Error('No screenshot upload reservation available');
  return reservation;
}

async function requestScreenshotUploadTokens(batch: PendingScreenshot[]) {
  const authenticatedUserId = getAuthenticatedUserIdFromToken(token);
  const screenshotOwnerId = authenticatedUserId || employeeId;
  const uploads: Array<{ pathname: string; contentType: string }> = [];

  for (const shot of batch) {
    if (shot.upload) continue;
    if (!shot.imageBuf || !shot.imageExt || !shot.imageMime) continue;
    const paths = getScreenshotBlobPaths(shot, screenshotOwnerId);
    uploads.push({ pathname: paths.pathname, contentType: shot.imageMime });
    if (paths.thumbnailPathname && shot.thumbnailMime) {
      uploads.push({ pathname: paths.thumbnailPathname, contentType: shot.thumbnailMime });
    }
  }

  if (!uploads.length) return new Map<string, R2UploadTarget>();

  const response = await apiRequest('POST', '/api/r2/screenshot-upload-urls', { uploads });
  const uploadTokens = new Map<string, R2UploadTarget>();
  for (const item of response?.targets || []) {
    if (item?.pathname && item?.uploadUrl && item?.url) {
      uploadTokens.set(String(item.pathname), { uploadUrl: String(item.uploadUrl), url: String(item.url) });
    }
  }
  return uploadTokens;
}

async function uploadScreenshotToBlob(shot: PendingScreenshot, uploadTokens: Map<string, R2UploadTarget>): Promise<BlobScreenshotUpload> {
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
  const { pathname, thumbnailPathname } = getScreenshotBlobPaths(shot, screenshotOwnerId);
  const uploadTarget = uploadTokens.get(pathname);
  if (!uploadTarget) throw new Error(`Missing screenshot upload URL for ${pathname}`);
  log.info('[SCREENSHOTS] Starting Blob upload', {
    localId: shot.localId,
    attempt: shot.attempts + 1,
    firstAttempt: shot.attempts === 0,
    pathname,
    employeeId,
    authenticatedUserId: authenticatedUserId || null,
    bytes: shot.imageBuf.length,
  });
  await axios.put(uploadTarget.uploadUrl, shot.imageBuf, { headers: { 'Content-Type': shot.imageMime } });
  const blob = { pathname, url: uploadTarget.url, downloadUrl: uploadTarget.url, contentType: shot.imageMime };
  const checksum = crypto.createHash('sha256').update(shot.imageBuf).digest('hex');
  log.info('[SCREENSHOTS] Blob upload succeeded', {
    localId: shot.localId,
    attempt: shot.attempts + 1,
    pathname: blob.pathname,
  });

  let thumbnailPath: string | undefined;
  let thumbnailUrl: string | undefined;
  if (shot.thumbnailBuf && shot.thumbnailMime) {
    try {
      if (!thumbnailPathname) throw new Error('Missing thumbnail pathname');
      const thumbnailTarget = uploadTokens.get(thumbnailPathname);
      if (!thumbnailTarget) throw new Error(`Missing thumbnail upload URL for ${thumbnailPathname}`);
      await axios.put(thumbnailTarget.uploadUrl, shot.thumbnailBuf, { headers: { 'Content-Type': shot.thumbnailMime } });
      const thumbBlob = { pathname: thumbnailPathname, url: thumbnailTarget.url };
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
    checksum,
  };
}

async function diagnoseBlobClientTokenFailure(shot: PendingScreenshot) {
  const now = Date.now();
  if (now - lastBlobTokenDiagnosticAt < 15_000) return;
  lastBlobTokenDiagnosticAt = now;

  const authenticatedUserId = getAuthenticatedUserIdFromToken(token);
  const screenshotOwnerId = authenticatedUserId || employeeId;
  const pathname = shot.upload?.path || getScreenshotBlobPaths(shot, screenshotOwnerId).pathname;
  try {
    const response = await requestText('POST', '/api/r2/screenshot-upload-urls', {
      uploads: [
        {
          pathname,
          contentType: shot.imageMime || 'image/webp',
        },
      ],
    });
    log.error('[SCREENSHOTS] Blob batch-token endpoint diagnostic', {
      status: response.status,
      body: response.text.slice(0, 1000),
      pathname,
      authenticatedUserId: authenticatedUserId || null,
      employeeId,
    });
  } catch (error: any) {
    log.error('[SCREENSHOTS] Blob batch-token endpoint diagnostic failed', error?.message || error);
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
      checksum: upload.checksum || (shot.imageBuf ? crypto.createHash('sha256').update(shot.imageBuf).digest('hex') : undefined),
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

  let uploadTokens: Map<string, R2UploadTarget>;
  try {
    uploadTokens = await requestScreenshotUploadTokens(batch);
  } catch (error: any) {
    log.error('[SCREENSHOTS] Batch upload token request failed:', error?.message || error);
    batch.forEach((shot) => void diagnoseBlobClientTokenFailure(shot));
    return batch;
  }

  const uploadResults = await Promise.allSettled(
    batch.map((shot) => uploadScreenshotToBlob(shot, uploadTokens)),
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
    notifiedAt: raw?.notifiedAt || raw?.notified_at || null,
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
    const local = normalizeAlertRecord(item);
    const existing = map.get(item.id);
    if (existing) {
      existing.isRead = existing.isRead || Boolean(local.isRead);
      existing.notifiedAt = existing.notifiedAt || local.notifiedAt || null;
    } else {
      map.set(item.id, { ...local });
    }
  });
  return Array.from(map.values()).sort((a,b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
}

function playAlertSound() {
  try {
    shell.beep();
  } catch {
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[console]::beep(880,180)'], { windowsHide: true }, () => undefined);
    }
  }
}

function getNotificationIconPath() {
  return getTrayIconCandidates().find((candidate) => fs.existsSync(candidate)) || undefined;
}

function notifyEmployeeAlert(alert: any) {
  const normalized = normalizeAlertRecord(alert);
  const title = normalized.title || 'New alert';
  const body = normalized.description || 'You have a new message from your admin.';

  playAlertSound();

  if (Notification.isSupported()) {
    const notification = new Notification({
      title,
      body,
      icon: getNotificationIconPath(),
      silent: false,
    });
    notification.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.flashFrame(false);
    });
    notification.show();
  }

  if (mainWindow) {
    mainWindow.flashFrame(true);
    if (mainWindow.isMinimized()) mainWindow.showInactive();
  }
  tray?.displayBalloon?.({
    title,
    content: body,
    icon: getNotificationIconPath(),
  });
}

async function syncAlertsWithServer(options: { notifyNew?: boolean } = {}) {
  if (!token) {
    console.warn('[ALERTS] sync skipped - no auth token');
    return getStoredAlerts();
  }
  try {
    const serverAlerts = await apiRequest('GET', '/api/alerts');
    console.log('[ALERTS] sync response', {
      count: Array.isArray(serverAlerts) ? serverAlerts.length : 0,
      notifyNew: Boolean(options.notifyNew),
      employeeId,
    });
    let merged = mergeAlerts(getStoredAlerts(), serverAlerts || []);
    if (options.notifyNew) {
      let didNotify = false;
      merged = merged.map((alert) => {
        const normalized = normalizeAlertRecord(alert);
        if (normalized.isRead || normalized.notifiedAt) return normalized;
        console.log('[ALERTS] notifying new alert', { id: normalized.id, title: normalized.title });
        notifyEmployeeAlert(normalized);
        mainWindow?.webContents.send('new-alert', normalized);
        didNotify = true;
        return { ...normalized, notifiedAt: new Date().toISOString() };
      });
      if (didNotify) mainWindow?.webContents.send('alerts-updated', merged);
    }
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

async function pollAlerts() {
  if (alertSyncInFlight || !token) return;
  alertSyncInFlight = true;
  try {
    await syncAlertsWithServer({ notifyNew: true });
  } finally {
    alertSyncInFlight = false;
  }
}

function startAlertSync() {
  if (!token) {
    console.warn('[ALERTS] sync timer not started - no auth token');
    return;
  }
  if (alertSyncInterval) return;
  console.log('[ALERTS] sync timer started', { employeeId, intervalMs: ALERT_SYNC_INTERVAL_MS });
  void pollAlerts();
  alertSyncInterval = setInterval(() => { void pollAlerts(); }, ALERT_SYNC_INTERVAL_MS);
}

function stopAlertSync() {
  if (alertSyncInterval) console.log('[ALERTS] sync timer stopped');
  alertSyncInterval = clearTimer(alertSyncInterval);
}

async function markAlertRead(id:string) {
  const existingAlerts = getStoredAlerts();
  const updatedAlerts  = existingAlerts.map((alert:any) => alert.id === id ? { ...alert, isRead:true } : alert);
  setStoredAlerts(updatedAlerts);
  if (!token) return updatedAlerts.find((alert:any) => alert.id === id) || null;
  try {
    const updated    = await apiRequest('PATCH', `/api/alerts/${id}`);
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
    const [nextPolicy, appsResponse, websitesResponse] = await Promise.all([
      apiRequest('GET', '/api/security/policies'),
      apiRequest('GET', '/api/blocked/apps'),
      apiRequest('GET', '/api/blocked/websites'),
    ]);
    const nextBlockedApps     = Array.isArray(appsResponse) ? appsResponse : [];
    const nextBlockedWebsites = Array.isArray(websitesResponse) ? websitesResponse : [];

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
  if (policySocket || !SOCKET_SERVER_URL || !token) return;
  policySocket = io(SOCKET_SERVER_URL, { auth: { token }, transports: ['websocket', 'polling'] });
  policySocket.on('connect', () => policySocket?.emit('register', { token, employeeId }));
  policySocket.on('policy-updated', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const event = payload as Record<string, unknown>;
    if (typeof event.updatedAt !== 'string' || typeof event.version !== 'number') return;
    if (Date.now() - lastPolicyPushAt < 5_000) return;
    lastPolicyPushAt = Date.now();
    console.log('[SECURITY] Policy change received; refreshing');
    void syncPolicies();
  });
  policySocket.on('connect_error', () => {
    console.warn('[SECURITY] Policy socket unavailable; five-minute refresh remains active');
  });
}

async function uploadSingleScreenshotImmediately(shot: PendingScreenshot, reservation?: { full: R2UploadTarget; thumbnail: R2UploadTarget }) {
  if (!shot.imageBuf || !shot.imageMime) throw new Error('Screenshot has no image bytes');
  const authenticatedUserId = getAuthenticatedUserIdFromToken(token);
  const screenshotOwnerId = authenticatedUserId || employeeId;
  const paths = getScreenshotBlobPaths(shot, screenshotOwnerId);
  const fullTarget = reservation?.full || shot.uploadTarget?.full;
  const thumbnailTarget = reservation?.thumbnail || shot.uploadTarget?.thumbnail;
  if (!fullTarget || !thumbnailTarget || !paths.thumbnailPathname) throw new Error('Missing screenshot upload reservation');

  try {
    await axios.put(fullTarget.uploadUrl, shot.imageBuf, { headers: { 'Content-Type': shot.imageMime } });
    if (shot.thumbnailBuf && shot.thumbnailMime) {
      await axios.put(thumbnailTarget.uploadUrl, shot.thumbnailBuf, { headers: { 'Content-Type': shot.thumbnailMime } });
    }
    screenshotManifestQueue.push({
      ...shot,
      upload: {
        path: paths.pathname,
        url: fullTarget.url,
        thumbnailPath: paths.thumbnailPathname,
        thumbnailUrl: thumbnailTarget.url,
        downloadUrl: fullTarget.url,
        contentType: shot.imageMime,
        checksum: crypto.createHash('sha256').update(shot.imageBuf).digest('hex'),
      },
      imageBuf: undefined,
      imageExt: undefined,
      imageMime: undefined,
      thumbnailBuf: undefined,
      thumbnailMime: undefined,
      uploadTarget: undefined,
    });
    scheduleScreenshotFlush(10_000);
  } finally {
    shot.imageBuf = undefined;
    shot.imageExt = undefined;
    shot.imageMime = undefined;
    shot.thumbnailBuf = undefined;
    shot.thumbnailMime = undefined;
  }
}

function enqueueScreenshotUpload(shot: PendingScreenshot, reservation?: { full: R2UploadTarget; thumbnail: R2UploadTarget }) {
  if (screenshotUploadInFlight >= MAX_CONCURRENT_SCREENSHOT_UPLOADS) {
    screenshotQueue.push({ ...shot, uploadTarget: reservation });
    return;
  }
  screenshotUploadInFlight += 1;
  void uploadSingleScreenshotImmediately(shot, reservation)
    .catch((error: any) => {
      log.warn('[SCREENSHOTS] Immediate R2 upload failed; queued for retry', error?.message || error);
      screenshotQueue.push({ ...shot, attempts: shot.attempts + 1, nextRetryAt: Date.now() + getScreenshotRetryDelayMs(1) });
    })
    .finally(() => {
      screenshotUploadInFlight -= 1;
      drainScreenshotUploadBacklog();
    });
}

function drainScreenshotUploadBacklog() {
  while (screenshotUploadInFlight < MAX_CONCURRENT_SCREENSHOT_UPLOADS) {
    const [shot] = dequeueEligibleScreenshots(1);
    if (!shot) break;
    void (async () => {
      try {
        const reservation = shot.uploadTarget || await reserveScreenshotUpload();
        enqueueScreenshotUpload(shot, reservation);
      } catch (error: any) {
        log.warn('[SCREENSHOTS] Could not authorize queued screenshot upload', error?.message || error);
        screenshotQueue.push({ ...shot, nextRetryAt: Date.now() + getScreenshotRetryDelayMs(shot.attempts + 1) });
      }
    })();
    break;
  }
}

function disconnectPolicyRealtime() {
  policySocket?.removeAllListeners();
  policySocket?.disconnect();
  policySocket = null;
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
    const isBrowser = ['chrome', 'msedge', 'edge', 'firefox', 'brave'].some((b) => ownerName.includes(b));
    if (!isBrowser || !title) return;

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

    if (!matchedDomain) return;

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

    for (const processName of runningProcesses) {
      const np = normalizeProcessName(processName);
      if (!np || !blockedNames.includes(np)) continue;
      const now = Date.now();
      if (recentlyHandledProcesses.has(np)) continue;

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
if (!localTestEnabled && !isDev && configuredServerUrl && isLocalServerUrl(configuredServerUrl)) {
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
    lastActiveApp = await getActiveAppName();
    await apiRequest('POST', '/api/heartbeat', {
      currentApp: lastActiveApp,
      activityPct: lastActivityPct,
      status,
      timestamp: new Date().toISOString(),
      deviceId: agentId,
      hostname: os.hostname(),
      appVersion: getAgentAppVersion(),
      osPlatform: process.platform,
      osVersion: os.release(),
      installScope: getInstallScope(),
    });
    const heartbeat = new Date().toISOString();
    mainWindow?.webContents.send('status-changed', { status, userName, employeeId, activeApp: lastActiveApp, heartbeat });
    void detectAfterHoursActivity();
  } catch (err:any) { console.error('Heartbeat failed:', err?.message || err); }
}

async function getDisclosureState() {
  if (!token) {
    return {
      noticeText: DISCLOSURE_NOTICE_TEXT,
      noticeVersion: DISCLOSURE_NOTICE_VERSION,
      acknowledged: isDisclosureAcknowledged(),
    };
  }
  try {
    const response = await apiRequest('GET', `/api/agent/disclosure?deviceId=${encodeURIComponent(agentId)}`);
    if (response?.acknowledged) markDisclosureAcknowledgedLocally();
    return response;
  } catch {
    return {
      noticeText: DISCLOSURE_NOTICE_TEXT,
      noticeVersion: DISCLOSURE_NOTICE_VERSION,
      acknowledged: isDisclosureAcknowledged(),
    };
  }
}

async function acknowledgeDisclosure() {
  markDisclosureAcknowledgedLocally();
  if (!token) {
    markPendingDisclosureSync();
    return { ok: true, synced: false };
  }
  await apiRequest('POST', '/api/agent/disclosure', {
    deviceId: agentId,
    hostname: os.hostname(),
    appVersion: getAgentAppVersion(),
    osPlatform: process.platform,
    osVersion: os.release(),
    installScope: getInstallScope(),
  });
  clearPendingDisclosureSync();
  return { ok: true, synced: true };
}

async function syncPendingDisclosureAck() {
  if (!token || !isDisclosureAcknowledged() || !hasPendingDisclosureSync()) return;
  try {
    await apiRequest('POST', '/api/agent/disclosure', {
      deviceId: agentId,
      hostname: os.hostname(),
      appVersion: getAgentAppVersion(),
      osPlatform: process.platform,
      osVersion: os.release(),
      installScope: getInstallScope(),
    });
    clearPendingDisclosureSync();
  } catch (error) {
    console.warn('[DISCLOSURE] pending acknowledgment sync failed', formatError(error));
  }
}

async function flushDeviceEvents(events: Array<{ eventType: string; category?: string; severity?: string; occurredAt?: string; details?: Record<string, any> }>) {
  if (!token || !events.length) return;
  try {
    await apiRequest('POST', '/api/agent/device-events', {
      deviceId: agentId,
      hostname: os.hostname(),
      appVersion: getAgentAppVersion(),
      events,
    });
  } catch (error) {
    console.warn('[TELEMETRY] device event upload failed', formatError(error));
  }
}

async function flushRecentFileTelemetry() {
  const cutoff = Date.now() - 60_000;
  const batch = recentFileEvents.filter((event) => event.occurredAt >= cutoff);
  if (!batch.length) return;

  const grouped = new Map<string, { rootType: string; count: number; totalBytes: number; samples: string[]; latestAt: number }>();
  for (const event of batch) {
    const key = `${event.rootType}:${event.action}`;
    const current = grouped.get(key) || { rootType: event.rootType, count: 0, totalBytes: 0, samples: [], latestAt: event.occurredAt };
    current.count += 1;
    current.totalBytes += event.sizeBytes;
    current.latestAt = Math.max(current.latestAt, event.occurredAt);
    if (current.samples.length < 5) current.samples.push(event.filePath);
    grouped.set(key, current);
  }

  const outgoing = Array.from(grouped.entries()).map(([key, value]) => ({
    eventType: key.startsWith('usb:') ? 'usb_file_activity' : key.startsWith('network:') ? 'network_drive_file_activity' : 'file_activity',
    category: 'file',
    severity: value.count >= 25 || value.totalBytes >= 50 * 1024 * 1024 ? 'high' : 'info',
    occurredAt: new Date(value.latestAt).toISOString(),
    details: {
      rootType: value.rootType,
      count: value.count,
      totalBytes: value.totalBytes,
      action: key.split(':')[1],
      samples: value.samples,
    },
  }));
  await flushDeviceEvents(outgoing);

  const largeUsbWrites = outgoing.find((event) => event.details?.rootType === 'usb' && Number(event.details?.count || 0) >= 25);
  if (largeUsbWrites) {
    await submitSecurityEvent('usb_mass_write', `${largeUsbWrites.details?.count || 0} files`, 'flagged_for_review');
  }
}

async function scanVolumeChanges() {
  const nextVolumes = await listWindowsMountedVolumes();
  const nextIds = new Set(nextVolumes.map((item) => `${item.kind}:${item.id}`));

  for (const item of nextVolumes) {
    const id = `${item.kind}:${item.id}`;
    if (!knownVolumeIds.has(id)) {
      await flushDeviceEvents([{ eventType: item.kind === 'usb' ? 'usb_connected' : 'network_drive_connected', category: 'device', occurredAt: new Date().toISOString(), details: { rootPath: item.rootPath, volumeId: item.id } }]);
    }
  }

  for (const id of Array.from(knownVolumeIds)) {
    if (!nextIds.has(id)) {
      const [kind, volumeId] = id.split(':', 2);
      await flushDeviceEvents([{ eventType: kind === 'usb' ? 'usb_disconnected' : 'network_drive_disconnected', category: 'device', occurredAt: new Date().toISOString(), details: { volumeId } }]);
    }
  }

  knownVolumeIds = nextIds;
  await refreshWatchedRoots();
}

async function scanTransferIndicators() {
  const activeWindow = await getActiveWindowSnapshot();
  const title = String(activeWindow?.title || '').toLowerCase();
  if (!title) return;
  const matchedDomain = externalUploadDomains.find((domain) => title.includes(domain));
  if (!matchedDomain) return;
  if (allowedUploadDomains.includes(matchedDomain)) return;

  await flushDeviceEvents([{
    eventType: 'external_upload_detected',
    category: 'transfer',
    severity: 'high',
    occurredAt: new Date().toISOString(),
    details: {
      domain: matchedDomain,
      title: activeWindow?.title || '',
      allowlisted: false,
    },
  }]);
  await submitSecurityEvent('external_upload_detected', matchedDomain, 'flagged_for_review');
}

async function detectThresholdAlerts() {
  const windowStart = Date.now() - 10 * 60 * 1000;
  const recent = recentFileEvents.filter((event) => event.occurredAt >= windowStart);
  const totalBytes = recent.reduce((sum, event) => sum + event.sizeBytes, 0);
  const downloadEvents = recent.filter((event) => event.rootType === 'downloads');
  const usbEvents = recent.filter((event) => event.rootType === 'usb');

  if (totalBytes >= 100 * 1024 * 1024) {
    await submitSecurityEvent('large_transfer_threshold', `${Math.round(totalBytes / (1024 * 1024))}MB`, 'flagged_for_review');
  }
  if (downloadEvents.length >= 40) {
    await submitSecurityEvent('mass_download_detected', `${downloadEvents.length} files`, 'flagged_for_review');
  }
  if (usbEvents.length >= 25) {
    await submitSecurityEvent('mass_copy_to_usb_detected', `${usbEvents.length} files`, 'flagged_for_review');
  }
}

function isAfterHours() {
  const now = new Date();
  const hour = now.getHours();
  return hour < 8 || hour >= 19;
}

async function detectAfterHoursActivity() {
  if (!isAfterHours() || !monitoringActive) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastAfterHoursAlertDay === today) return;
  lastAfterHoursAlertDay = today;
  await submitSecurityEvent('after_hours_activity', os.hostname(), 'flagged_for_review');
  await flushDeviceEvents([{
    eventType: 'after_hours_activity',
    category: 'schedule',
    severity: 'medium',
    occurredAt: new Date().toISOString(),
    details: { hostname: os.hostname(), activeApp: lastActiveApp },
  }]);
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
  if (/504|502|503|5\d\d|Gateway Time-out|Unable to find latest version on GitHub|Cannot parse releases feed/i.test(message)) return 'GitHub was temporarily unavailable while checking for updates. The agent will retry automatically.';
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
    if (updaterManualCheckInFlight) {
      sendUpdaterEvent('updater:checking', getUpdaterStatus());
    }
  });

  autoUpdater.on('update-available', (info) => {
    updaterCheckInFlight = false;
    updaterManualCheckInFlight = false;
    log.info('[UPDATER] update available', { currentVersion: app.getVersion(), availableVersion: info.version });
    sendUpdaterEvent('updater:available', { ...getUpdaterStatus(), version: info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    updaterCheckInFlight = false;
    const shouldNotify = updaterManualCheckInFlight;
    updaterManualCheckInFlight = false;
    log.info('[UPDATER] update not available', { currentVersion: app.getVersion(), latestVersion: info.version });
    if (shouldNotify) {
      sendUpdaterEvent('updater:not-available', { ...getUpdaterStatus(), version: info.version });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    log.info('[UPDATER] download progress', { percent: Math.round(progress.percent), transferred: progress.transferred, total: progress.total });
    sendUpdaterEvent('updater:progress', { ...getUpdaterStatus(), percent: progress.percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updaterCheckInFlight = false;
    updaterManualCheckInFlight = false;
    updaterDownloaded = true;
    updaterDownloadedVersion = info.version;
    log.info('[UPDATER] update downloaded', { version: info.version });
    sendUpdaterEvent('updater:downloaded', { ...getUpdaterStatus(), version: info.version });
    void promptForDownloadedUpdate(info.version);
  });

  autoUpdater.on('error', (error) => {
    updaterCheckInFlight = false;
    const shouldNotify = updaterManualCheckInFlight;
    updaterManualCheckInFlight = false;
    const message = getUpdaterErrorMessage(error);
    log.error('[UPDATER] error', message);
    if (shouldNotify) {
      sendUpdaterEvent('updater:error', { ...getUpdaterStatus(), message });
    }
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
  updaterManualCheckInFlight = manual;
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    updaterCheckInFlight = false;
    const shouldNotify = updaterManualCheckInFlight;
    updaterManualCheckInFlight = false;
    const message = getUpdaterErrorMessage(error);
    log.error('[UPDATER] check failed', message);
    if (shouldNotify) {
      sendUpdaterEvent('updater:error', { ...getUpdaterStatus(), message });
    }
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
  log.info('[UPDATER] cleanup before restart started', { monitoringActive, queueLength: screenshotQueue.length, manifestQueueLength: screenshotManifestQueue.length, sessionId: Boolean(sessionId) });
  const deadline = Date.now() + UPDATE_INSTALL_CLEANUP_TIMEOUT_MS;

  monitoringActive = false;
  workSessionActive = false;
  status = 'offline';
  ssInterval = clearTimer(ssInterval);
  uploadInterval = clearTimer(uploadInterval);
  idleInterval = clearTimer(idleInterval);
  heartbeatInterval = clearTimer(heartbeatInterval);
  liveViewRequestInterval = clearTimer(liveViewRequestInterval);
  policyInterval = clearTimer(policyInterval);
  scanInterval = clearTimer(scanInterval);
  policySyncInterval = clearTimer(policySyncInterval);
  if (screenshotFlushTimer) clearTimeout(screenshotFlushTimer);
  screenshotFlushTimer = null;
  disconnectPolicyRealtime();

  await waitForCondition(() => !capturingScreenshot, Math.max(0, deadline - Date.now()));

  while ((screenshotQueue.length > 0 || screenshotManifestQueue.length > 0 || screenshotUploadInFlight > 0 || screenshotFlushInFlight) && Date.now() < deadline) {
    drainScreenshotUploadBacklog();
    if (!screenshotFlushInFlight && screenshotManifestQueue.length > 0) {
      await flushScreenshotQueue();
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (screenshotQueue.length > 0 || screenshotManifestQueue.length > 0 || screenshotUploadInFlight > 0 || screenshotFlushInFlight) {
    log.warn('[UPDATER] cleanup timeout while waiting for screenshot uploads', {
      queueLength: screenshotQueue.length,
      manifestQueueLength: screenshotManifestQueue.length,
      uploadInFlight: screenshotUploadInFlight,
      commitInFlight: screenshotFlushInFlight,
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
  log.info('[UPDATER] cleanup before restart finished', { queueLength: screenshotQueue.length, manifestQueueLength: screenshotManifestQueue.length });
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
// triggers a flush itself — the fixed 60s `uploadInterval` (set up in
// startTracking) owns the batch-upload cadence, decoupled from the 5s
// capture cadence.
let capturingScreenshot = false;
async function captureAndUpload() {
  if (!monitoringActive || capturingScreenshot) return;
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
    const reservation = await reserveScreenshotUpload();
    const { buffer: imageBuf, ext: imageExt, mimeType: imageMime } = await compressScreenshot(pngBuf);
    const thumbnail = await createScreenshotThumbnail(pngBuf);
    enqueueScreenshotUpload({
      localId: reservation.localId,
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
    }, reservation);
    // NOTE: no scheduleScreenshotFlush() here anymore — the fixed 60s
    // uploadInterval owns the batch upload cadence now.
  } catch(e) { log.error('[SCREENSHOTS] Capture error:', e); }
  finally { capturingScreenshot = false; }
}

// ─── Session management ─────────────────────────────────────────────────────
async function startMonitoring() {
  if (monitoringActive) return;
  if (!sessionId) {
    status = 'active';
    await startSession();
  }
  monitoringActive = true;
  workSessionActive = Boolean(sessionId);
  sessionStartedAt = sessionStartedAt || Date.now();

  ssInterval         = setInterval(captureAndUpload, captureIntervalSec * 1000);
  uploadInterval      = setInterval(() => { void flushScreenshotQueue(); }, uploadIntervalSec * 1000);
  idleInterval       = setInterval(watchIdle, 2000);
  heartbeatInterval  = setInterval(() => sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  liveViewRequestInterval = setInterval(() => { void checkLiveViewRequest(); }, LIVE_VIEW_REQUEST_POLL_MS);
  // Policy enforcement happens in the app/site scanners below. Do not keep a
  // wake-up timer for the intentionally empty compatibility hook.
  policyInterval     = null;
  scanInterval       = setInterval(() => { void scanBlockedApps(); void scanBlockedWebsites(); }, 60_000);
  policySyncInterval = setInterval(() => { void syncPolicies(); }, 5 * 60 * 1000);
  telemetryInterval  = setInterval(() => { void flushRecentFileTelemetry(); void detectThresholdAlerts(); }, 60_000);
  transferDetectionInterval = setInterval(() => { void scanTransferIndicators(); }, 40_000);
  volumeScanInterval = setInterval(() => { void scanVolumeChanges(); }, 60_000);

  await captureAndUpload();
  void sendHeartbeat();
  void checkLiveViewRequest();
  void syncPolicies();
  connectPolicyRealtime();
  void scanBlockedApps();
  void scanBlockedWebsites();
  void refreshWatchedRoots();
  void scanVolumeChanges();
  void scanTransferIndicators();

  updateTray();
  mainWindow?.webContents.send('tracking-status',{ tracking:true, sessionId, monitoringActive: true, workSessionActive });
  broadcastStatus();
}

async function stopMonitoring() {
  if (!monitoringActive) return;
  monitoringActive = false;
  workSessionActive = false;
  status = 'offline';

  await endSession();

  ssInterval = clearTimer(ssInterval);
  uploadInterval = clearTimer(uploadInterval);
  idleInterval = clearTimer(idleInterval);
  heartbeatInterval = clearTimer(heartbeatInterval);
  liveViewRequestInterval = clearTimer(liveViewRequestInterval);
  policyInterval = clearTimer(policyInterval);
  scanInterval = clearTimer(scanInterval);
  policySyncInterval = clearTimer(policySyncInterval);
  telemetryInterval = clearTimer(telemetryInterval);
  transferDetectionInterval = clearTimer(transferDetectionInterval);
  volumeScanInterval = clearTimer(volumeScanInterval);
  stopFsWatchers();
  if (screenshotFlushTimer) clearTimeout(screenshotFlushTimer);
  screenshotFlushTimer = null;
  disconnectPolicyRealtime();
  void flushScreenshotQueue();
  await stopLiveWatchForRequest();

  updateTray();
  mainWindow?.webContents.send('tracking-status', { tracking:false, monitoringActive: false, workSessionActive: false });
  broadcastStatus();
}

async function startWorkSession() {
  if (!monitoringActive) {
    await startMonitoring();
  }
  if (!workSessionActive) {
    status = 'active';
    if (!sessionId) {
      await startSession();
    }
    workSessionActive = Boolean(sessionId);
    sessionStartedAt = sessionStartedAt || Date.now();
    broadcastStatus();
    mainWindow?.webContents.send('tracking-status', { tracking: true, monitoringActive: true, workSessionActive: true, sessionId });
  }
  return { ok: true };
}

async function checkoutWorkSession() {
  if (workSessionActive || sessionId) {
    await endSession();
  }
  status = 'offline';
  workSessionActive = false;
  sessionStartedAt = 0;
  broadcastStatus();
  mainWindow?.webContents.send('tracking-status', { tracking: monitoringActive, monitoringActive, workSessionActive: false, sessionId: '' });
  return { ok: true };
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

function scheduleScreenshotFlush(delayMs = uploadIntervalSec * 1000) {
  // Commit metadata soon after bytes reach R2, while keeping the fixed
  // interval as a safety net for retries.
  if (screenshotFlushTimer || screenshotManifestQueue.length >= MAX_SCREENSHOT_BATCH_SIZE) {
    if (screenshotManifestQueue.length >= MAX_SCREENSHOT_BATCH_SIZE) void flushScreenshotQueue();
    return;
  }
  screenshotFlushTimer = setTimeout(() => {
    screenshotFlushTimer = null;
    void flushScreenshotQueue();
  }, delayMs);
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

// Flushes the local queue by uploading screenshots directly to Cloudflare R2,
// then POSTing only metadata to our backend.
async function flushScreenshotQueue() {
  drainScreenshotUploadBacklog();
  if (screenshotFlushInFlight || !screenshotManifestQueue.length || !token) return;
  screenshotFlushInFlight = true;
  const batch = screenshotManifestQueue.splice(0, MAX_SCREENSHOT_BATCH_SIZE);
  if (!batch.length) {
    screenshotFlushInFlight = false;
    return;
  }
  try {
    await commitUploadedScreenshots(batch.flatMap((shot) => shot.upload ? [{ shot, upload: shot.upload }] : []));
  } catch (error: any) {
    for (const shot of batch) {
      const nextAttempts = shot.attempts + 1;
      if (nextAttempts < MAX_UPLOAD_ATTEMPTS) {
        const retryDelayMs = getScreenshotRetryDelayMs(nextAttempts);
        log.warn(`[SCREENSHOTS] Metadata commit failed (attempt ${nextAttempts}/${MAX_UPLOAD_ATTEMPTS}), retrying in ${Math.round(retryDelayMs / 1000)}s:`, error?.message || error);
        screenshotManifestQueue.push({ ...shot, attempts: nextAttempts, nextRetryAt: Date.now() + retryDelayMs });
      } else {
        log.error('[SCREENSHOTS] Metadata commit failed max attempts, dropping screenshot manifest item', {
          capturedAt: shot.capturedAt,
          activeApp: shot.activeApp,
          hasBlobUpload: Boolean(shot.upload),
          error: error?.message || error,
        });
      }
    }
  } finally {
    screenshotFlushInFlight = false;
    // NOTE: no self-rescheduling here — uploadInterval already fires on the
    // configured cadence, so re-arming scheduleScreenshotFlush would just create
    // a second, redundant flush path. Left only as the >=10-item safety net.
  }
}

// ─── Tray ───────────────────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: monitoringActive ? `● Monitoring — ${userName || 'signed in'}` : '○ Monitoring off', enabled:false },
    { type:'separator' },
    { label: 'Open window', click:()=>mainWindow?.show() },
    { label: 'Check for Updates', click:()=>{ mainWindow?.show(); void checkForUpdates(true); } },
  ]));
  tray.setToolTip(monitoringActive ? `Vorion Tracker — monitoring ${userName || 'device'}` : 'Vorion Tracker — monitoring off');
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
  const iconPath = path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
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
    event.preventDefault();
    mainWindow?.hide();
  });
}

// ─── IPC ────────────────────────────────────────────────────────────────────
function assertMainRenderer(event: Electron.IpcMainInvokeEvent) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('Untrusted IPC sender');
  }
}

async function loginAgent(email: string, password: string) {
  try {
    const res = await apiRequest('POST','/api/auth',{ email, password, context: 'agent' });
    if (!res?.token) throw new Error(res?.error || 'Login failed');

    const nextEmployeeId = getEmployeeIdFromUser(res?.user || res?.profile || null);
    const nextUserName = res?.user?.name || res?.user?.full_name || res?.user?.fullName || '';

    persistSessionIdentity(res.token, nextUserName, nextEmployeeId);
    startAlertSync();
    await syncPendingDisclosureAck();
    await apiRequest('POST', '/api/heartbeat', {
      currentApp: lastActiveApp,
      activityPct: lastActivityPct,
      status: 'offline',
      deviceId: agentId,
      hostname: os.hostname(),
      appVersion: getAgentAppVersion(),
      osPlatform: process.platform,
      osVersion: os.release(),
      installScope: getInstallScope(),
    }).catch(() => undefined);

    if (!employeeId) {
      console.warn('[AUTH] Login response did not contain an employeeId', { responseKeys: Object.keys(res || {}) });
    }

    status = 'offline';
    mainWindow?.webContents.send('status-changed', { status, userName, employeeId });
    await startMonitoring().catch((monitorError) => {
      console.error('[MONITORING] auto-start after login failed', formatError(monitorError));
    });
    return { ok:true, user:res.user };
  } catch (error:any) {
    console.error('Login failed:', error);
    return { ok:false, error: getFriendlyRequestError(error) };
  }
}

async function logoutAgent() {
  await stopMonitoring();

  if (token) {
    void sessionAction('logout').catch((err:any) => {
      console.error('Logout action failed:', err?.message || err);
    });
  }

  storeAuthToken('');
  userName = '';
  employeeId = '';
  set('userName','');
  set('employeeId','');
  stopAlertSync();
  status = 'offline';
  mainWindow?.webContents.send('status-changed',{ status:'offline' });
  if (!SERVICE_MODE) mainWindow?.show();
  return { ok:true };
}

async function startBreakSession() {
  if (!workSessionActive || !sessionId) return { ok: false, error: 'No active work session' };
  status = 'break';
  await sessionAction('start_break', { sessionId });
  broadcastStatus();
  return { ok: true };
}

async function endBreakSession() {
  if (!workSessionActive || !sessionId) return { ok: false, error: 'No active work session' };
  status = 'active';
  await sessionAction('end_break', { sessionId });
  broadcastStatus();
  return { ok: true };
}

async function handleServiceCommand(command: ServiceCommand) {
  switch (command.command) {
    case 'ping':
      return { mode: SERVICE_MODE ? 'service' : 'ui', ok: true };
    case 'get-status':
      return buildStatusPayload();
    case 'login':
      return loginAgent(command.email, command.password);
    case 'logout':
      return logoutAgent();
    case 'start-work':
      return startWorkSession();
    case 'start-break':
      return startBreakSession();
    case 'end-break':
      return endBreakSession();
    case 'checkout':
      return checkoutWorkSession();
    default:
      throw new Error(`Unsupported service command: ${(command as any)?.command || 'unknown'}`);
  }
}

async function invokeServiceIfAvailable<T>(command: ServiceCommand, fallback: () => Promise<T>) {
  if (!SERVICE_MODE && await isServiceReachable()) {
    const response = await sendServiceCommand(command);
    if (!response.ok) {
      throw new Error(response.error || 'Service command failed');
    }
    return response.result as T;
  }
  return fallback();
}

function startServiceStatusBridge() {
  if (SERVICE_MODE || serviceStatusBridgeInterval) return;
  serviceStatusBridgeInterval = setInterval(async () => {
    try {
      if (!await isServiceReachable()) return;
      const response = await sendServiceCommand({ command: 'get-status' }, 2000);
      if (response.ok && response.result) {
        mainWindow?.webContents.send('status-changed', response.result);
      }
    } catch {
      // Keep the UI resilient when the service is not installed or restarting.
    }
  }, 3000);
}

ipcMain.handle('login', async (event, email:string, password:string) => {
  assertMainRenderer(event);
  return invokeServiceIfAvailable({ command: 'login', email, password }, () => loginAgent(email, password));
});
ipcMain.handle('logout', async (event) => {
  assertMainRenderer(event);
  return invokeServiceIfAvailable({ command: 'logout' }, () => logoutAgent());
});
 ipcMain.handle('get-status',       async (event) => { assertMainRenderer(event); return invokeServiceIfAvailable({ command: 'get-status' }, async () => buildStatusPayload()); });
ipcMain.handle('updater:status',   (event) => { assertMainRenderer(event); return getUpdaterStatus(); });
ipcMain.handle('updater:check',    async (event) => { assertMainRenderer(event); return checkForUpdates(true); });
ipcMain.handle('updater:install',  async (event) => { assertMainRenderer(event); return installDownloadedUpdate(); });
ipcMain.handle('get-alerts',       async (event) => { assertMainRenderer(event); return getStoredAlerts(); });
ipcMain.handle('sync-alerts',      async (event) => {
  assertMainRenderer(event);
  startAlertSync();
  return syncAlertsWithServer({ notifyNew: true });
});
ipcMain.handle('mark-alert-read',  async (event, id:string) => { assertMainRenderer(event); return markAlertRead(id); });
ipcMain.handle('store-alert',      async (event, alert:any) => { assertMainRenderer(event); const saved = await persistAlert(alert); mainWindow?.webContents.send('new-alert', saved); return saved; });
ipcMain.handle('manual-shot',      (event) => { assertMainRenderer(event); return captureAndUpload(); });
 ipcMain.handle('start-work',       async (event) => { assertMainRenderer(event); return invokeServiceIfAvailable({ command: 'start-work' }, () => startWorkSession()); });
ipcMain.handle('start-break',      async (event) => {
  assertMainRenderer(event);
  return invokeServiceIfAvailable({ command: 'start-break' }, () => startBreakSession());
});
ipcMain.handle('end-break', async (event) => {
  assertMainRenderer(event);
  return invokeServiceIfAvailable({ command: 'end-break' }, () => endBreakSession());
});
ipcMain.handle('checkout', async (event) => {
  assertMainRenderer(event);
  return invokeServiceIfAvailable({ command: 'checkout' }, () => checkoutWorkSession());
});
app.commandLine.appendSwitch('disable-features', 'DesktopCaptureUseDxgi,SpareRendererForSitePerProcess,CalculateNativeWinOcclusion');
// ─── Boot ────────────────────────────────────────────────────────────────────
app.whenReady().then(async ()=>{
  if (!SERVICE_MODE) {
    setupAutoUpdater();
  }
  if (SERVICE_MODE) {
    serviceCommandServer = await startServiceCommandServer(handleServiceCommand);
    console.log('[SERVICE] control pipe listening');
  } else {
    await createWindow();
    tray = new Tray(loadTrayIcon());
    tray.on('double-click',()=>mainWindow?.show());
    updateTray();
    mainWindow?.show();
    startServiceStatusBridge();
  }
  status = 'offline';
  const storedToken = loadStoredAuthToken();
  const storedUserName = get('userName') || '';
  const storedEmployeeId = get('employeeId') || '';
  if (storedToken) {
    try {
        persistSessionIdentity(storedToken, storedUserName, storedEmployeeId);
        console.log('[AUTH] restored session identity from local store', { employeeId, userName, hasToken: Boolean(token) });
        startAlertSync();
        status = 'offline';
        mainWindow?.webContents.send('status-changed', { status, userName, employeeId });
      } catch {
        console.log('Stored token invalid/expired — clearing, user must log in again');
        storeAuthToken(''); userName=''; employeeId='';
        set('userName',''); set('employeeId','');
        stopAlertSync();
      status = 'offline';
      mainWindow?.webContents.send('status-changed', { status:'offline' });
    }

    void (async () => {
      try {
        const authRes = await apiRequest('GET', '/api/auth');
        const nextEmployeeId = getEmployeeIdFromUser(authRes?.user || authRes?.profile || null);
        const nextUserName = authRes?.user?.name || authRes?.user?.full_name || authRes?.user?.fullName || '';
        persistSessionIdentity(token, nextUserName, nextEmployeeId);
        await syncPendingDisclosureAck();
        console.log('[AUTH] refreshed session identity', { employeeId, userName, hasToken: Boolean(token) });
        mainWindow?.webContents.send('status-changed', { status, userName, employeeId });
        await startMonitoring().catch((error) => console.error('[MONITORING] auto-start failed', formatError(error)));
      } catch (error: any) {
        if (error?.status === 401 || error?.status === 403) {
          console.log('[AUTH] background auth refresh rejected saved session; clearing cached identity');
          storeAuthToken(''); userName=''; employeeId='';
          set('userName',''); set('employeeId','');
          stopAlertSync();
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
    if (!SERVICE_MODE) {
      startAutoUpdateScheduler();
    }
  });

app.on('window-all-closed', () => {
  // Keep the agent resident in the tray even if the user closes the window.
  return;
});
app.on('before-quit', (event) => {
  if (allowImmediateQuit) {
    isQuitting = true;
    return;
  }

  event.preventDefault();
  void requestGracefulQuit();
});
