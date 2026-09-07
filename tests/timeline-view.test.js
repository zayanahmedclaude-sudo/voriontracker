const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../lib/timeline-view.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', compiled)(loaded, loaded.exports);
const { activityMinutes, hourlyHeatmap, csvCell } = loaded.exports;
test('timeline resolves overlapping work, idle and breaks without counting twice', () => {
  const segments = [{type:'work',startMinute:0,endMinute:60},{type:'idle',startMinute:20,endMinute:40},{type:'break',startMinute:30,endMinute:45}];
  assert.deepEqual(activityMinutes(segments,0,60), {work:35,idle:10,break:15,offline:0});
  assert.deepEqual(activityMinutes(segments,60,120), {work:0,idle:0,break:0,offline:60});
});
test('heatmap covers fifteen hours and distinguishes missing activity', () => {
  const heat = hourlyHeatmap([{type:'idle',startMinute:0,endMinute:50},{type:'break',startMinute:60,endMinute:120}]);
  assert.equal(heat.length,15);
  assert.deepEqual(heat.slice(0,3),['idle','break','offline']);
});
test('timeline CSV neutralizes formula cells and escapes quotes', () => {
  assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(csvCell('A "B"'), '"A ""B"""');
});
