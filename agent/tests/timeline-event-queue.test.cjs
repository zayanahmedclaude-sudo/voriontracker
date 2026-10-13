const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../src/timeline-event-queue.ts');
const source = require('node:fs').readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', compiled)(loaded, loaded.exports, require, path.dirname(sourcePath));
const { TimelineEventQueue } = loaded.exports;

test('timeline event queue keeps failed events and removes delivered events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-events-'));
  const queue = new TimelineEventQueue(dir);
  await queue.enqueue('employee-1', 'app_open', 'Code', 0, 80, '2026-09-07T16:00:00.000Z');
  await assert.rejects(queue.flush('employee-1', async () => { throw new Error('offline'); }));
  assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.json')).length, 1);
  const sent = [];
  await queue.flush('employee-1', async event => sent.push(event));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].app, 'Code');
  assert.deepEqual(await fs.readdir(dir), []);
});

test('timeline event queue ignores another employee during flush', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-events-'));
  const queue = new TimelineEventQueue(dir);
  await queue.enqueue('employee-1', 'app_open', 'Code', 0, 80);
  await queue.enqueue('employee-2', 'app_open', 'Browser', 0, 60);
  const sent = [];
  await queue.flush('employee-1', async event => sent.push(event));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].employee, 'employee-1');
  const remaining = await fs.readdir(dir);
  assert.equal(remaining.length, 1);
});

test('timeline event queue sets aside events the server refuses instead of retrying them forever', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-events-'));
  const queue = new TimelineEventQueue(dir);
  await queue.enqueue('employee-1', 'app_open', 'Old', 0, 80, '2026-09-01T00:00:00.000Z');
  await queue.enqueue('employee-1', 'app_open', 'New', 0, 80, '2026-10-01T00:00:00.000Z');
  const sent = [];
  const handled = await queue.flush('employee-1', async event => {
    if (event.app === 'Old') { const error = new Error('Conflict'); error.status = 409; throw error; }
    sent.push(event.app);
  });
  assert.equal(handled, 2);
  assert.deepEqual(sent, ['New']);
  const remaining = await fs.readdir(dir);
  assert.equal(remaining.filter(name => name.endsWith('.json')).length, 0);
  assert.equal(remaining.filter(name => name.endsWith('.rejected')).length, 1);
});

test('timeline event queue writes do not wait for a slow flush, and flushes coalesce', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-events-'));
  const queue = new TimelineEventQueue(dir);
  await queue.enqueue('employee-1', 'app_open', 'Code', 0, 80);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const slowSend = async () => { calls += 1; await gate; };
  const first = queue.flush('employee-1', slowSend);
  const second = queue.flush('employee-1', slowSend);
  assert.equal(first, second);
  const started = Date.now();
  await queue.enqueue('employee-1', 'app_close', 'Code', 1, 80);
  assert.ok(Date.now() - started < 1000, 'enqueue returned while a flush was still running');
  release();
  await first;
  assert.equal(calls, 1);
});

test('timeline event queue migrates files written by older agents', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-events-'));
  const key = '0f8fad5b-d9cb-469f-a165-70867728950e';
  await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify({ key, employee: 'employee-1', type: 'app_open', app: 'Legacy', durationMinutes: 0, activityPct: 50, at: '2026-09-14T15:13:59.632Z' }));
  const orphan = '1e8fad5b-d9cb-469f-a165-70867728950f';
  await fs.writeFile(path.join(dir, `${orphan}.json`), JSON.stringify({ key: orphan, employee: '', type: 'app_open', app: 'Nobody', durationMinutes: 0, activityPct: 0, at: '2026-09-14T15:13:59.632Z' }));
  const queue = new TimelineEventQueue(dir);
  const sent = [];
  await queue.flush('employee-1', async event => sent.push(event.app));
  assert.deepEqual(sent, ['Legacy']);
  assert.deepEqual(await fs.readdir(dir), [`${orphan}.json.rejected`]);
});
