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
