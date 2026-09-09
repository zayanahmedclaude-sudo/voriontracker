const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(legacyMidnight = false) {
  const source = fs.readFileSync(path.join(__dirname, '../lib/shifts.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  const runtime = legacyMidnight ? { DateTimeFormat: function(locale, options) {
    const { hour12, ...rest } = options;
    return new Intl.DateTimeFormat(locale, { ...rest, hourCycle: options.hourCycle || 'h24' });
  } } : Intl;
  new Function('module', 'exports', 'Intl', code)(module, module.exports, runtime);
  return module.exports;
}
for (const legacy of [false, true]) {
  test(`overnight report keeps September 9 through midnight PKT (h24 runtime: ${legacy})`, () => {
    const shifts = load(legacy);
    for (const at of ['2026-09-09T23:59:59+05:00','2026-09-10T00:00:00+05:00','2026-09-10T00:30:00+05:00','2026-09-10T01:00:00+05:00','2026-09-10T06:59:59+05:00']) {
      assert.equal(shifts.getWindowDateInTimeZone(new Date(at), 16), '2026-09-09', at);
      assert.equal(shifts.getAutoCheckoutCutoffForTimestamp(at).toISOString(), '2026-09-10T03:00:00.000Z', at);
    }
    assert.equal(shifts.getWindowDateInTimeZone(new Date('2026-09-10T16:00:00+05:00'),16), '2026-09-10');
    assert.equal(shifts.zonedDateTimeToUtc('2026-09-10','00:00:00','Asia/Karachi').toISOString(), '2026-09-09T19:00:00.000Z');
  });
  test(`midnight handles month/year rollover (h24 runtime: ${legacy})`, () => {
    const shifts = load(legacy);
    assert.equal(shifts.getWindowDateInTimeZone(new Date('2027-01-01T00:00:00+05:00'),16),'2026-12-31');
    assert.equal(shifts.getWindowDateInTimeZone(new Date('2026-10-01T00:00:00+05:00'),16),'2026-09-30');
  });
}
