const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../agent/src/main.ts'), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const log = { warn() {}, info() {} };

test('background second instances preserve the minimized window; explicit launches open it', () => {
  const statement = ast.statements.find(node => node.getText(ast).startsWith("app.on('second-instance'"));
  let handler;
  const calls = [];
  new Function('app', 'mainWindow', compile(statement.getText(ast)))({ on: (_, fn) => { handler = fn; } }, {
    isMinimized: () => true, restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus'),
  });
  handler({}, ['tracker.exe', '--supervised']);
  handler({}, ['tracker.exe', '--background']);
  assert.deepEqual(calls, []);
  handler({}, ['tracker.exe']);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
});

function heartbeatHarness(send, packaged = true) {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'startSupervisorHeartbeat');
  let tick;
  let now = 100000;
  const starts = [];
  const start = new Function('sendServiceCommand', 'setInterval', 'process', 'app', 'execFile', 'path', 'Date', 'log',
    'let supervisorHeartbeatInterval = null; let sessionId = null;\n' + compile(node.getText(ast)) + '\nreturn startSupervisorHeartbeat;')(
    send, fn => { tick = fn; return 1; }, { platform: 'win32', pid: 42, env: { SystemRoot: 'C:\\Windows' } }, { isPackaged: packaged },
    (...args) => { starts.push(args); args[3](null); }, path.win32, { now: () => now }, log,
  );
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { start, starts, settle, tick: async () => { tick(); await settle(); }, advance: ms => { now += ms; } };
}

test('stopped service recovery is silent, rate limited, and resets after healthy heartbeat', async () => {
  let healthy = false;
  const h = heartbeatHarness(async () => { if (!healthy) throw new Error('ENOENT'); return { ok: true }; });
  h.start(); await h.settle();
  await h.tick(); assert.equal(h.starts.length, 0);
  await h.tick(); assert.equal(h.starts.length, 1);
  assert.deepEqual(h.starts[0].slice(0, 3), ['C:\\Windows\\System32\\sc.exe', ['start', 'VorionTrackerSupervisor'], { windowsHide: true, timeout: 10000 }]);
  await h.tick(); assert.equal(h.starts.length, 1);
  h.advance(60000); await h.tick(); assert.equal(h.starts.length, 2);
  healthy = true; await h.tick();
  healthy = false; h.advance(60000); await h.tick(); await h.tick(); assert.equal(h.starts.length, 2);
  await h.tick(); assert.equal(h.starts.length, 3);
});

test('slow heartbeat never overlaps another request and development mode never starts a service', async () => {
  let resolve;
  let calls = 0;
  const h = heartbeatHarness(() => { calls++; return new Promise(r => { resolve = r; }); });
  h.start(); await h.tick(); await h.tick(); assert.equal(calls, 1);
  resolve({ ok: true }); await h.settle(); await h.tick(); assert.equal(calls, 2);
  resolve({ ok: true }); await h.settle();
  const dev = heartbeatHarness(async () => { throw new Error('ENOENT'); }, false);
  dev.start(); await dev.settle(); for (let i = 0; i < 5; i++) await dev.tick();
  assert.equal(dev.starts.length, 0);
});

test('startup heartbeat precedes renderer loading and supervised startup stays hidden', () => {
  const boot = source.slice(source.indexOf('app.whenReady().then(async ()=>{'));
  assert.ok(boot.indexOf('startSupervisorHeartbeat()') < boot.indexOf('await createWindow()'));
  assert.match(boot, /if \(!SUPERVISED_MODE && !process\.argv\.includes\('--background'\)\) mainWindow\?\.show\(\)/);
});

test('supervisor recovers IPC and installer grants start-only access while preserving admin stop', () => {
  const supervisor = fs.readFileSync(path.join(__dirname, '../agent/supervisor/Program.cs'), 'utf8');
  assert.match(supervisor, /var pipeTask = RunPipeLoop\(stoppingToken\)/);
  assert.match(supervisor, /Supervisor IPC listener failed; reopening pipe/);
  assert.match(supervisor, /requestTimeout.CancelAfter/);
  assert.match(supervisor, /\(A;;CCLCSWRPLOCRRC;;;IU\)/);
  assert.doesNotMatch(supervisor, /\(A;;[^)]*(?:WP|DC)[^)]*;;;IU\)/);
  assert.match(supervisor, /--stop-elevated[\s\S]*?"start=", "disabled"/);
  assert.match(supervisor, /restart\/5000\/restart\/15000\/restart\/30000/);
  assert.match(supervisor, /DateTime.UtcNow-launchedAt>TimeSpan.FromSeconds\(60\)/);
  assert.match(supervisor, /HasAgentParent\(candidate\)/);
});

test('upgrade protects old-install enrollment before uninstaller and preserves it on subsequent upgrades', () => {
  const installer = fs.readFileSync(path.join(__dirname, '../agent/scripts/installer.nsh'), 'utf8');
  const supervisor = fs.readFileSync(path.join(__dirname, '../agent/supervisor/Program.cs'), 'utf8');
  assert.match(installer, /!macro customCheckAppRunning[\s\S]*--backup-update/);
  assert.match(installer, /\$\{If\} \$\{isUpdated\}[\s\S]*--prepare-update[\s\S]*\$\{Else\}[\s\S]*--uninstall-elevated/);
  assert.match(supervisor, /StopForUpdate\(args\); UpgradeBackup.Save\(\)/);
  assert.match(supervisor, /Install\(string\[\] args\)\{RequireAdministrator\(\);UpgradeBackup.Restore\(\)/);
  assert.match(supervisor, /CopyRecords\(SecureRoot,BackupRoot,true\)/);
  assert.match(supervisor, /CopyRecords\(BackupRoot,SecureRoot,false\)/);
  assert.match(supervisor, /SecretStore.Exists[\s\S]*enrollment.ServerUrl/);
  assert.match(supervisor, /RunSc\("start",AppConstants.ServiceName\);UpgradeBackup.Complete\(\)/);
  assert.match(supervisor, /throw new System.TimeoutException\(/);
});

test('watchdog restarts missing/exited processes or switched sessions, never a live process for a delayed heartbeat', () => {
  const supervisor = fs.readFileSync(path.join(__dirname, '../agent/supervisor/Program.cs'), 'utf8');
  const expression = supervisor.match(/restartReason=(.*);/)[1];
  const decide = new Function('agent', 'sessionChanged', 'return ' + expression);
  assert.equal(decide(null, false), 'agent_missing');
  assert.equal(decide({ HasExited: true }, false), 'process_exited');
  assert.equal(decide({ HasExited: false }, false), '');
  assert.equal(decide({ HasExited: false }, true), 'windows_session_changed');
  assert.match(supervisor, /restart=restartReason.Length>0/);
  assert.doesNotMatch(expression, /lastHeartbeat|launchedAt/);
  assert.match(supervisor, /Environment.TickCount64 - missingSessionSince < 30_000/);
  assert.match(supervisor, /if \(!updateInProgress && launchSession>=0\) LaunchAgent\(launchSession\)/);
  assert.match(supervisor, /Agent restart requested: \{Reason\}/);
});

test('updates cannot silently install on quit and manual launches also coordinate with the supervisor', () => {
  assert.match(source, /autoUpdater.autoInstallOnAppQuit = false/);
  const install = source.slice(source.indexOf('async function installDownloadedUpdate()'), source.indexOf('async function promptForDownloadedUpdate'));
  assert.match(install, /if \(process.platform === 'win32' && app.isPackaged\)/);
  assert.match(install, /command: 'begin-update'/);
  assert.doesNotMatch(install, /if \(SUPERVISED_MODE\)/);
});

test('supervisor debounces session changes, records exit codes, and retains crash backoff', () => {
  const supervisor = fs.readFileSync(path.join(__dirname, '../agent/supervisor/Program.cs'), 'utf8');
  assert.match(supervisor, /pendingSessionId!=activeSessionId/);
  assert.match(supervisor, /Environment.TickCount64-pendingSessionSince<15_000/);
  assert.match(supervisor, /else \{ pendingSessionId=-1; pendingSessionSince=0; \}/);
  assert.match(supervisor, /lifetime>=TimeSpan.FromMinutes\(5\)/);
  assert.match(supervisor, /exit code \{ExitCode\}/);
  assert.match(supervisor, /lock \(gate\) \{\s*if \(agent is \{HasExited:false\} && expectedSessionId==sessionId\) return;\s*var pid = InteractiveProcess.Launch/);
});

test('startup credential outage retries and later recovers the device without re-enrollment', async () => {
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['refreshDeviceEnrollment','scheduleDeviceEnrollmentRetry'].includes(node.name?.text));
  let ready = false; let retry; let starts = 0; const states = [];
  const code = compile(functions.map(node => node.getText(ast)).join('\n'));
  const api = new Function('sendServiceCommand','apiRequest','setTimeout','set','startMonitoring','log','normalizeServerUrl','isLocalServerUrl','HttpError',
    "let deviceToken='',deviceRegistrationId='',deviceEnrollmentRetryTimer=null,monitoringActive=false,isDev=false,SERVER_URL='';\n" + code + '\nreturn {refreshDeviceEnrollment, state:()=>({deviceToken,deviceRegistrationId})};')(
    async () => { if (!ready) throw new Error('ENOENT'); return {ok:true,result:{token:'test-device-credential',serverUrl:'https://example.com'}}; },
    async () => ({device:{id:'same-device'}}), fn => { retry = fn; return 1; }, (_, value) => states.push(value), async () => { starts++; }, log,
    value => value, () => false, class HttpError extends Error {},
  );
  assert.equal(await api.refreshDeviceEnrollment(),false);
  assert.equal(states.at(-1),'validation_pending');
  assert.equal(typeof retry,'function');
  ready = true; retry(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.state().deviceRegistrationId,'same-device');
  assert.equal(starts,1);
  assert.equal(states.at(-1),'enrolled');
});

test('upgrade queries executable paths without reading process modules and handles exit races', () => {
  const supervisor = fs.readFileSync(path.join(__dirname, '../agent/supervisor/Program.cs'), 'utf8');
  assert.doesNotMatch(supervisor, /\.MainModule/);
  assert.match(supervisor, /OpenProcess\(0x1000,false,pid\)/);
  assert.match(supervisor, /QueryFullProcessImageName\(handle,0,path,ref size\)/);
  assert.match(supervisor, /finally \{ Native.CloseHandle\(handle\); \}/);
  const stop = supervisor.slice(supervisor.indexOf('public static void StopForUpdate'),supervisor.indexOf('public static void RequireAdministrator'));
  assert.match(stop, /ProcessIdentity.GetExecutablePath\(process.Id\)/);
  assert.match(stop, /if\(!string.Equals\(executable,installed,StringComparison.OrdinalIgnoreCase\)\) continue/);
  assert.match(stop, /process.Kill\(\)/);
  assert.doesNotMatch(stop, /process.Kill\(true\)/);
  assert.match(stop, /if\(!process.WaitForExit\(10000\)\) throw/);
  assert.match(stop, /when\(process.HasExited\)/);
});
