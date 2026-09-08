const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('outside-session screenshot commits require an active device credential', () => {
  const route = read('app','api','agent','screenshots','commit','route.ts');
  const schema = read('lib','schema.ts');
  assert.match(route, /outside && !device/);
  assert.match(route, /valid active device token is required outside an employee session/);
  assert.match(route, /device_background/);
  assert.match(route, /Mixed session and outside-session batches are not allowed/);
  assert.match(route, /user\?\.sub \|\| device\?\.assignedEmployeeId \|\| null/);
  assert.match(route, /userId:attributedEmployeeId/);
  assert.match(schema, /SET employee_id=d\.assigned_employee_id FROM devices d WHERE s\.device_registration_id=d\.id AND s\.employee_id IS NULL/);
});

test('screenshot filters and displayed capture times use the same business timezone', () => {
  const page = read('app','(dashboard)','screenshots','page.tsx');
  assert.match(page, /const displayTimeZone = BUSINESS_TIME_ZONE/);
  assert.match(page, /params\.set\('tz', displayTimeZone\)/);
  assert.match(page, /toLocaleTimeString\(\[\], \{ hour: '2-digit', minute: '2-digit', timeZone: displayTimeZone \}\)/);
  assert.match(page, /Timezone: PKT \(Asia\/Karachi\)/);
});

test('agent durably persists captures before enqueue and safely revalidates rejected device credentials', () => {
  const source = read('agent','src','main.ts');
  assert.match(source, /await persistPendingScreenshot\(shot\)[\s\S]*enqueueScreenshotUpload\(shot\)/);
  assert.match(source, /captureContext = sessionId \? 'employee_session' : 'device_background'/);
  assert.match(source, /path\.startsWith\('\/api\/agent\/device'\)\) invalidateDeviceEnrollment/);
  assert.match(source, /revalidateDeviceEnrollmentAfterScreenshotAuthFailure/);
  assert.match(source, /Protected queue unavailable; retaining capture in memory/);
  assert.match(source, /enqueueScreenshotUpload\(shot\)/);
  assert.match(source, /screenshotRequest && status === 401\) invalidateEmployeeCredential/);
  assert.match(source, /permanentFailure: error instanceof HttpError/);
  assert.doesNotMatch(source, /MAX_UPLOAD_ATTEMPTS/);
});

test('agent restores an open attendance session after a supervised restart', () => {
  const agent = read('agent','src','main.ts');
  const sessions = read('app','api','sessions','route.ts');
  assert.match(agent, /async function restoreCurrentSession\(\)/);
  assert.match(agent, /sessionAction\('current'\)/);
  assert.match(agent, /await restoreCurrentSession\(\);[\s\S]*await startMonitoring/);
  assert.match(sessions, /action === 'current'/);
  assert.match(sessions, /a\.employee_id = \$\{user\.sub\} AND a\.check_out IS NULL/);
  assert.match(sessions, /attendance\.on_break \? 'break' : 'active'/);
});

test('durable screenshot records round-trip bytes without credentials and bind to their original principal', () => {
  const ts = require('typescript');
  const source = read('agent','src','durable-screenshot-queue.ts');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const loaded = { exports: {} };
  new Function('module', 'exports', 'Buffer', output)(loaded, loaded.exports, Buffer);
  const employeeShot = {
    localId: 'capture-one', imageBuf: Buffer.from('full-image'), imageExt: 'webp', imageMime: 'image/webp',
    thumbnailBuf: Buffer.from('thumb'), thumbnailMime: 'image/webp', activeApp: 'Editor', activityPct: 73,
    capturedAt: '2026-09-07T10:00:00.000Z', sessionId: 'session-1', captureContext: 'employee_session',
    employeeId: 'employee-1', deviceRegistrationId: null, attempts: 2, nextRetryAt: 1234,
  };
  const record = loaded.exports.serializePendingScreenshot(employeeShot);
  assert.equal(JSON.stringify(record).includes('Bearer'), false);
  assert.deepEqual(Object.keys(record).filter(key => /token|authorization|password/i.test(key)), []);
  const restored = loaded.exports.deserializePendingScreenshot(record);
  assert.equal(restored.imageBuf.equals(employeeShot.imageBuf), true);
  assert.equal(restored.thumbnailBuf.equals(employeeShot.thumbnailBuf), true);
  assert.equal(loaded.exports.canAuthenticateScreenshot(restored, 'employee-1', true, '', false), true);
  assert.equal(loaded.exports.canAuthenticateScreenshot(restored, 'employee-2', true, '', false), false);
  assert.equal(loaded.exports.deserializePendingScreenshot({ ...record, deviceRegistrationId: 'device-1' }), null);

  const deviceRecord = loaded.exports.serializePendingScreenshot({
    ...employeeShot, localId: 'capture-two', sessionId: null, captureContext: 'device_background',
    employeeId: null, deviceRegistrationId: 'device-1', permanentFailure: undefined,
  });
  const deviceShot = loaded.exports.deserializePendingScreenshot(deviceRecord);
  assert.equal(loaded.exports.canAuthenticateScreenshot(deviceShot, '', false, 'device-1', true), true);
  assert.equal(loaded.exports.canAuthenticateScreenshot(deviceShot, '', false, 'device-2', true), false);
  assert.equal(loaded.exports.canAuthenticateScreenshot({ ...deviceShot, permanentFailure: 'commit_rejected_403' }, '', false, 'device-1', true), false);
});

test('device secrets are hash-only in the database and reveal-once in the API', () => {
  const schema = read('lib','schema.ts'); const route = read('app','api','devices','route.ts');
  assert.match(schema, /token_hash TEXT NOT NULL UNIQUE/);
  assert.doesNotMatch(schema, /device_token TEXT/);
  assert.match(route, /hashDeviceToken\(token\)/);
  assert.match(route, /return ok\(\{ device, token \}/);
});

test('device tokens are high entropy and deterministically hashed', () => {
  const ts = require('typescript');
  const source = read('lib','device-auth.ts');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  const fakeRequire = name => name === 'crypto' ? require('crypto') : name === './schema' ? { ensureMonitoringSchema: async () => {} } : name === './db' ? { sql: async () => [] } : require(name);
  new Function('require', 'module', 'exports', output)(fakeRequire, loaded, loaded.exports);
  const first = loaded.exports.createDeviceToken(); const second = loaded.exports.createDeviceToken();
  assert.match(first, /^vrt_dev_[A-Za-z0-9_-]{43}$/); assert.notEqual(first, second);
  assert.equal(loaded.exports.hashDeviceToken(first), require('crypto').createHash('sha256').update(first).digest('hex'));
});

test('device authentication accepts only active tokens and records last seen', async () => {
  const ts = require('typescript');
  const source = read('lib','device-auth.ts');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const crypto = require('crypto');
  const activeToken = `vrt_dev_${crypto.randomBytes(32).toString('base64url')}`;
  const revokedToken = `vrt_dev_${crypto.randomBytes(32).toString('base64url')}`;
  const activeHash = crypto.createHash('sha256').update(activeToken).digest('hex');
  const revokedHash = crypto.createHash('sha256').update(revokedToken).digest('hex');
  const seenHashes = [];
  const fakeSql = async (_strings, hash) => {
    seenHashes.push(hash);
    if (hash === activeHash) return [{ id: 'device-1', device_name: 'Front Desk', assigned_employee_id: null }];
    if (hash === revokedHash) return []; // production query filters status = active
    return [];
  };
  const loaded = { exports: {} };
  const fakeRequire = name => name === 'crypto' ? crypto : name === './schema' ? { ensureMonitoringSchema: async () => {} } : name === './db' ? { sql: fakeSql } : require(name);
  new Function('require', 'module', 'exports', output)(fakeRequire, loaded, loaded.exports);
  const request = token => ({ headers: { get: name => name === 'x-vorion-device-token' ? token : null } });

  assert.deepEqual(await loaded.exports.getDevicePrincipal(request(activeToken)), { kind: 'device', id: 'device-1', deviceName: 'Front Desk', assignedEmployeeId: null });
  assert.equal(await loaded.exports.getDevicePrincipal(request(revokedToken)), null);
  assert.equal(await loaded.exports.getDevicePrincipal(request(`vrt_dev_${crypto.randomBytes(32).toString('base64url')}`)), null);
  assert.equal(await loaded.exports.getDevicePrincipal(request('malformed')), null);
  assert.deepEqual(seenHashes.slice(0, 2), [activeHash, revokedHash]);
  assert.equal(seenHashes.length, 3, 'malformed credentials must not reach the database');
  assert.match(source, /UPDATE devices SET last_seen_at = NOW\(\), updated_at = NOW\(\)/);
});

test('device registration reveals once, permits no assignment, and revokes immediately', () => {
  const route = read('app','api','devices','route.ts');
  const auth = read('lib','device-auth.ts');
  assert.match(route, /assignedEmployeeId[^\n]+\|\| null/);
  assert.match(route, /return ok\(\{ device, token \}/);
  assert.doesNotMatch(route.match(/export async function GET[\s\S]*?export async function POST/)[0], /token_hash|token\s*[,}]/);
  assert.match(route, /status='revoked', revoked_at=NOW\(\)/);
  assert.match(auth, /WHERE token_hash = \$\{hashDeviceToken\(token\)\} AND status = 'active'/);
  assert.match(auth, /SET last_seen_at = NOW\(\)/);
});

test('device editing and deletion are restricted to super admins', () => {
  const route = read('app','api','devices','route.ts');
  assert.match(route, /body\?\.action === 'edit'[\s\S]*user\.role !== 'superadmin'[\s\S]*UPDATE devices SET device_name=/);
  assert.match(route, /export async function DELETE[\s\S]*requireRole\(req, 'superadmin'\)[\s\S]*DELETE FROM devices/);
  assert.match(route, /eventType:'device_edited'/);
  assert.match(route, /eventType:'device_deleted'/);
});

test('Windows supervisor enforces PID-attested IPC, DPAPI secret storage, and delayed restart', () => {
  const source = read('agent','supervisor','Program.cs');
  assert.match(source, /GetNamedPipeClientProcessId/);
  assert.match(source, /clientPid!=\(uint\)allowed/);
  assert.match(source, /TryAdoptInstalledAgent/);
  assert.match(source, /candidate\.SessionId!=activeSession/);
  assert.match(source, /Path\.GetFullPath\(candidatePath/);
  assert.match(source, /ProtectedData\.Protect/);
  assert.match(source, /DataProtectionScope\.LocalMachine/);
  assert.match(source, /Task\.Delay\(delay/);
  assert.match(source, /sdset/);
  assert.match(source, /WaitForAdminApproval\(server,employeeName\).*SecretStore\.Write\(token,server\)/s);
  assert.match(source, /new\{deviceName=Environment\.MachineName,employeeName,publicKey\}/);
  assert.match(source, /RSAEncryptionPadding\.OaepSHA256/);
  assert.match(source, /Math\.Min\(60, Math\.Pow\(2/);
  assert.match(source, /WTSEnumerateSessions/);
  assert.match(source, /CreateEnvironmentBlock/);
  assert.match(source, /IsSessionLocked/);
  assert.match(source, /class QueueStore/);
  assert.match(source, /queue-upsert/);
  assert.match(source, /queue-list/);
  assert.match(source, /queue-delete/);
  assert.match(source, /ProtectedData\.Protect\(clear,Entropy,DataProtectionScope\.LocalMachine\)/);
  assert.match(source, /FileOptions\.WriteThrough/);
  assert.match(source, /stream\.Flush\(true\)/);
  assert.match(source, /MaxBytes=1024L\*1024\*1024/);
  assert.match(source, /MaxRecords=2000/);
  assert.match(source, /Credentials are forbidden in queue records/);
  assert.match(source, /GetEnvironmentVariable\("VORION_DEVICE_TOKEN"\)/);
  assert.doesNotMatch(source, /Value\(args,"--token"\)/);
  const ipc = read('agent','src','service-ipc.ts');
  assert.doesNotMatch(ipc, /startServiceCommandServer|command: 'logout'|command: 'checkout'/);
});

test('lock state applies grace, cancels short locks, and resumes immediately', () => {
  const ts = require('typescript');
  const source = read('agent','src','lock-state.ts');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const loaded = { exports: {} };
  new Function('module', 'exports', output)(loaded, loaded.exports);
  let scheduled = null; const events = [];
  const clock = { setTimeout(callback, delay) { scheduled = { callback, delay }; return scheduled; }, clearTimeout(timer) { if (scheduled === timer) scheduled = null; } };
  const state = new loaded.exports.LockCaptureState(20_000, { onPause: reason => events.push(`pause:${reason}`), onResume: reason => events.push(`resume:${reason}`) }, clock);
  state.lock(); assert.equal(scheduled.delay, 20_000); state.lock(); state.unlock(); assert.equal(scheduled, null); assert.deepEqual(events, []);
  state.lock(); scheduled.callback(); assert.equal(state.isPaused(), true); state.unlock(); assert.deepEqual(events, ['pause:lock', 'resume:unlock']);
  state.suspend(); state.resume(); assert.deepEqual(events.slice(-2), ['pause:suspend', 'resume:resume']);
});

test('capture lock state uses native Electron events rather than supervisor lock polling', () => {
  const source = read('agent','src','main.ts');
  const heartbeat = source.match(/function startSupervisorHeartbeat\(\)[\s\S]*?ipcMain\.handle\('login'/)[0];
  assert.doesNotMatch(heartbeat, /response\.result\?\.locked/);
  assert.match(source, /powerMonitor\.on\('lock-screen'/);
  assert.match(source, /powerMonitor\.on\('unlock-screen'/);
});

test('a screenshot auth failure revalidates before disabling device capture', () => {
  const source = read('agent','src','main.ts');
  assert.match(source, /revalidateDeviceEnrollmentAfterScreenshotAuthFailure/);
  assert.match(source, /screenshot authentication failed; revalidating enrollment/);
  assert.match(source, /path\.startsWith\('\/api\/agent\/device'\)\) invalidateDeviceEnrollment/);
});

test('screenshot routes reject mixed identities and verify session ownership', () => {
  const commit = read('app','api','agent','screenshots','commit','route.ts');
  const presign = read('app','api','r2','screenshot-upload-urls','route.ts');
  assert.match(commit, /Employee and device credentials cannot be combined/);
  assert.match(presign, /Employee and device credentials cannot be combined/);
  assert.match(commit, /headers\.has\('authorization'\) && hasDeviceCredential/);
  assert.match(presign, /headers\.has\('authorization'\) && hasDeviceCredential/);
  assert.match(commit, /FROM attendance WHERE id = ANY\(\$1::uuid\[\]\) AND employee_id = \$2/);
  assert.match(commit, /device_background/);
  assert.match(commit, /capture_local_id/);
  assert.match(commit, /ON CONFLICT \(capture_local_id\)/);
  assert.match(commit, /SELECT id, check_in, check_out FROM attendance/);
  assert.match(commit, /capturedAt < startsAt \|\| capturedAt > Math\.min\(checkoutAt, automaticCutoff\)/);
  assert.match(commit, /parsed\.captureId !== shot\.localId/);
});

test('installer keeps enrollment out of the supervisor and service command lines', () => {
  const nsis = read('agent','scripts','installer.nsh');
  const serviceInstall = read('agent','scripts','install-windows-service.ps1');
  assert.match(nsis, /SetEnvironmentVariable\(t "VORION_DEVICE_TOKEN"/);
  assert.doesNotMatch(nsis, /--install --token/);
  assert.match(serviceInstall, /EnvironmentVariables\['VORION_DEVICE_TOKEN'\] = \$DeviceToken/);
  assert.doesNotMatch(serviceInstall, /--install --token/);
});

test('manual signing refreshes electron updater metadata after changing installer bytes', () => {
  const signing = read('agent','scripts','sign-release.ps1');
  assert.match(signing, /SHA512.*ComputeHash/s);
  assert.match(signing, /latest\.yml/);
  assert.match(signing, /installerSha512/);
  assert.match(signing, /installerSize/);
  assert.match(signing, /WriteAllText\(\$latestYmlPath/);
  assert.match(signing, /\[A-Z\]:\\\\\.\*\?\\\.exe/);
  assert.match(signing, /InstallerPath must point to a \.exe installer/);
});

test('release includes a pinned self-signed certificate trust helper', () => {
  const helper = read('agent','scripts','trust-vorion-installer.ps1');
  const launcher = read('agent','scripts','Trust-VorionInstaller.cmd');
  const builder = read('agent','scripts','run-electron-builder.cjs');
  assert.match(helper, /EABAC223190E145442463C71B7BD8E7DD7FAAEAE/);
  assert.match(helper, /Get-AuthenticodeSignature/);
  assert.match(helper, /@\('Root', 'TrustedPublisher'\)/);
  assert.match(helper, /LocalMachine/);
  assert.match(helper, /Start-Process powershell\.exe -Verb RunAs/);
  assert.match(builder, /Trust-VorionInstaller\.ps1/);
  assert.match(launcher, /-ExecutionPolicy Bypass/);
  assert.match(launcher, /%~dp0VorionTrackerSetup\.exe/);
  assert.match(builder, /Trust-VorionInstaller\.cmd/);
});

test('supervised updates suppress watchdog restart while NSIS replaces the agent', () => {
  const agent = read('agent','src','main.ts');
  const ipc = read('agent','src','service-ipc.ts');
  const supervisor = read('agent','supervisor','Program.cs');
  assert.match(agent, /command: 'begin-update'/);
  assert.match(agent, /setupAutoUpdater\(\)/);
  assert.match(agent, /startAutoUpdateScheduler\(\)/);
  assert.match(ipc, /'begin-update'/);
  assert.match(supervisor, /updateWindowUntil=DateTime\.UtcNow\.AddMinutes\(10\)/);
  assert.match(supervisor, /restart && !updateInProgress/);
  const cleanup = agent.match(/async function cleanupBeforeUpdateInstall\(\)[\s\S]*?async function installDownloadedUpdate/)[0];
  assert.match(cleanup, /finishTimelineActivity\(\)/);
  assert.match(cleanup, /flushTimelineEvents\(\)/);
  assert.doesNotMatch(cleanup, /endSession\(\)/);
});

test('screenshots and recordings use Cloudflare R2 without legacy storage-provider paths', () => {
  const r2 = read('lib', 'r2.ts');
  const commit = read('app', 'api', 'agent', 'screenshots', 'commit', 'route.ts');
  const screenshotList = read('app', 'api', 'screenshots', 'route.ts');
  const live = read('app', '(dashboard)', 'live', 'page.tsx');
  const config = read('next.config.js');
  assert.match(r2, /S3Client/);
  assert.match(r2, /\.r2\.cloudflarestorage\.com/);
  assert.match(r2, /R2_ACCESS_KEY_ID/);
  assert.match(commit, /'r2_key'/);
  assert.match(commit, /'file_url'/);
  assert.match(commit, /storage_provider/);
  assert.match(live, /\/api\/r2\/client-upload/);
  assert.match(screenshotList, /deleteR2Objects/);
  for (const source of [commit, screenshotList, config, read('lib', 'schema.ts'), read('lib', 'screenshot-retention.ts')]) {
    assert.doesNotMatch(source, /@vercel\/blob|BLOB_READ_WRITE_TOKEN|blob_url|blob_path|vercel-storage/i);
  }
});

test('screenshot views treat an R2 thumbnail as available when the full image URL is absent', () => {
  const listRoute = read('app/api/screenshots/route.ts');
  const detailRoute = read('app/api/screenshots/[id]/route.ts');
  const page = read('app/(dashboard)/screenshots/page.tsx');
  assert.match(listRoute, /COALESCE\(\$\{tableAlias\}\.file_url, \$\{tableAlias\}\.thumbnail_url\)/);
  assert.match(detailRoute, /COALESCE\(\$\{tableAlias\}\.file_url, \$\{tableAlias\}\.thumbnail_url\)/);
  assert.match(page, /!s\.thumbnail_url && !s\.file_url/);
  assert.match(page, /s\.thumbnail_url \|\| s\.file_url/);
});
