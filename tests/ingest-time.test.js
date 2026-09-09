const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../lib/ingest-time.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', output)(loaded, loaded.exports);
const { resolveIngestTime } = loaded.exports;
const received = new Date('2026-09-10T00:00:00.000Z');

test('equivalent international timezone timestamps resolve to the same UTC instant', () => {
  for (const value of [
    '2026-09-10T05:00:00+05:00',
    '2026-09-09T20:00:00-04:00',
    '2026-09-10T09:00:00+09:00',
    '2026-09-10T00:00:00Z',
  ]) {
    const timing = resolveIngestTime(value, received);
    assert.equal(timing.deviceAt, '2026-09-10T00:00:00.000Z');
    assert.equal(timing.effectiveAt, '2026-09-10T00:00:00.000Z');
    assert.equal(timing.clockSkewSeconds, 0);
    assert.equal(timing.corrected, false);
  }
});

test('future clock drift uses server receipt time and retains device evidence', () => {
  const timing = resolveIngestTime('2026-09-10T05:30:00+05:00', received);
  assert.equal(timing.deviceAt, '2026-09-10T00:30:00.000Z');
  assert.equal(timing.effectiveAt, '2026-09-10T00:00:00.000Z');
  assert.equal(timing.clockSkewSeconds, 1800);
  assert.equal(timing.corrected, true);
});

test('small drift remains attributable to actual device capture time', () => {
  const timing = resolveIngestTime('2026-09-10T00:04:59Z', received);
  assert.equal(timing.effectiveAt, '2026-09-10T00:04:59.000Z');
  assert.equal(timing.corrected, false);
});

test('invalid and implausibly old timestamps are rejected', () => {
  assert.equal(resolveIngestTime('not-a-date', received), null);
  assert.equal(resolveIngestTime('2026-01-01T00:00:00Z', received), null);
});

test('screenshots page derives filter dates in the explicit business timezone', () => {
  const page = fs.readFileSync(path.join(__dirname, '../app/(dashboard)/screenshots/page.tsx'), 'utf8');
  assert.match(page, /function getDateInputValue\(date = new Date\(\), timeZone = BUSINESS_TIME_ZONE\)/);
  assert.match(page, /new Intl\.DateTimeFormat\('en-CA', \{\s*timeZone,/);
});
