const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../agent/src/main.ts'), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
function loadFunctions(names, bindings) {
  const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(selected.length, names.length);
  const code = ts.transpileModule(selected.map(node => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(bindings), code + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings));
}
const log = { info() {}, warn() {}, error() {} };
const pipeError = () => { throw new Error('connect ENOENT vorion-tracker-service'); };
const upload = { path: 'screenshots/test.webp', url: 'https://storage.example/test.webp' };
const makeShot = () => ({ localId: 'capture-1', sessionId: 'session-1', employeeId: 'employee-1', attempts: 0, imageBuf: Buffer.from('image') });
class HttpError extends Error { constructor(status) { super('HTTP ' + status); this.status = status; } }
function batchHarness(commit) {
  let puts = 0;
  const api = loadFunctions(['uploadScreenshotBatch'], {
    token: 'credential', deviceToken: '', deviceRegistrationId: '',
    canAuthenticateScreenshot: () => true, getAuthenticatedUserIdFromToken: () => 'employee-1',
    requestScreenshotUploadTokens: async () => new Map(),
    uploadScreenshotToR2: async shot => { if (shot.upload) return shot.upload; puts++; return upload; },
    persistPendingScreenshot: pipeError, commitUploadedScreenshots: commit,
    diagnoseR2UploadFailure: async () => {}, HttpError, log,
  });
  return { ...api, puts: () => puts };
}

test('missing supervisor does not block dashboard commit after storage upload', async () => {
  let commits = 0;
  const harness = batchHarness(async records => { commits++; assert.equal(records[0].upload, upload); });
  const shot = makeShot();
  assert.deepEqual(await harness.uploadScreenshotBatch([shot]), []);
  assert.equal(commits, 1);
  assert.equal(harness.puts(), 1);
  assert.equal(shot.upload, upload);
  assert.equal(shot.imageBuf, undefined);
});

test('API failure during supervisor outage retries metadata without uploading image bytes again', async () => {
  let commits = 0;
  const harness = batchHarness(async () => { if (++commits === 1) throw new HttpError(503); });
  const failed = await harness.uploadScreenshotBatch([makeShot()]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].upload, upload);
  assert.deepEqual(await harness.uploadScreenshotBatch(failed), []);
  assert.equal(harness.puts(), 1);
  assert.equal(commits, 2);
});

test('permanent commit rejection remains quarantined when supervisor is unavailable', async () => {
  const harness = batchHarness(async () => { throw new HttpError(403); });
  const failed = await harness.uploadScreenshotBatch([makeShot()]);
  assert.equal(failed[0].permanentFailure, 'commit_rejected_403');
});

test('failed queue deletion does not retry a committed screenshot and is cleaned up on recovery', async () => {
  let available = false;
  const pending = new Set();
  const queue = [];
  const api = loadFunctions(['cleanupCommittedScreenshot', 'hydrateDurableScreenshotQueue'], {
    committedScreenshotCleanup: pending, screenshotInFlightIds: new Set(), screenshotQueue: queue, screenshotQueueHydrating: false,
    deletePendingScreenshot: async () => { if (!available) pipeError(); },
    sendServiceCommand: async () => ({ ok: true, result: { records: available ? [] : [makeShot()] } }),
    deserializePendingScreenshot: shot => shot, log,
  });
  await api.cleanupCommittedScreenshot('capture-1');
  assert.equal(pending.has('capture-1'), true);
  await api.hydrateDurableScreenshotQueue();
  assert.equal(queue.length, 0);
  available = true;
  await api.hydrateDurableScreenshotQueue();
  assert.equal(pending.size, 0);
});

test('retry persistence failure keeps metadata and permanent failure state in memory', async () => {
  for (const permanentFailure of [undefined, 'commit_rejected_403']) {
    const queue = [];
    let first = true;
    let finished;
    const done = new Promise(resolve => { finished = resolve; });
    const api = loadFunctions(['drainScreenshotUploadBacklog'], {
      screenshotUploadInFlight: 0, screenshotInFlightIds: new Set(), MAX_CONCURRENT_SCREENSHOT_UPLOADS: 1,
      dequeueEligibleScreenshots: () => { if (!first) return []; first = false; return [makeShot()]; },
      uploadScreenshotBatch: async () => [{ ...makeShot(), imageBuf: undefined, upload, permanentFailure }],
      persistPendingScreenshot: pipeError, screenshotQueue: queue,
      getScreenshotRetryDelayMs: () => 1000, setImmediate: () => finished(), log,
      cleanupCommittedScreenshot: async () => {}, hydrateDurableScreenshotQueue: async () => {},
    });
    api.drainScreenshotUploadBacklog();
    await done;
    assert.equal(queue.length, permanentFailure ? 0 : 1);
    if (!permanentFailure) { assert.equal(queue[0].upload, upload); assert.equal(queue[0].attempts, 1); }
  }
});

test('legacy clock-skew rejection remains retryable and retains uploaded metadata', async () => {
  const harness = batchHarness(async () => {
    const error = new HttpError(400);
    error.message = 'Screenshot capture time is in the future';
    throw error;
  });
  const failed = await harness.uploadScreenshotBatch([makeShot()]);
  assert.equal(failed[0].permanentFailure, undefined);
  assert.equal(failed[0].upload, upload);
});

test('server accepts clock-skewed screenshots with audited, corrected timestamps', () => {
  const route = fs.readFileSync(path.join(__dirname, '../app/api/agent/screenshots/commit/route.ts'), 'utf8');
  assert.match(route, /resolveIngestTime\(item\?\.capturedAt, receivedAt\)/);
  assert.match(route, /device_captured_at/);
  assert.match(route, /clock_skew_seconds/);
  assert.match(route, /capturedAt:timing\?\.effectiveAt/);
  assert.doesNotMatch(route, /err\('Screenshot capture time is in the future',400\)/);
  assert.doesNotMatch(route, /code: 'capture_clock_skew'/);
});
