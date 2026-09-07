const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(name) {
  const source = fs.readFileSync(path.join(__dirname, '../lib', name + '.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = {exports:{}};
  new Function('module','exports','require',compiled)(module,module.exports,(name)=>load(name.replace('./','')));
  return module.exports;
}
const {attendanceBounds} = load('timeline-attendance');
const {getTimelineWindowForDate} = load('shifts');
const range = getTimelineWindowForDate('2026-09-07');
const now = Date.parse('2026-09-07T19:00:00Z');
test('unclosed old session cannot fill a later shift from 4 PM even with a new heartbeat',()=>{
  assert.equal(attendanceBounds({check_in:'2026-09-04T22:20:13Z',last_activity:new Date(now).toISOString()},range,now,120),null);
});
test('11 PM check-in starts at minute 420, preserving the seven absent hours',()=>{
  assert.deepEqual(attendanceBounds({check_in:'2026-09-07T18:00:00Z',last_activity:new Date(now).toISOString()},range,now,120),{start:Date.parse('2026-09-07T18:00:00Z'),end:now});
});
test('closed attendance uses recorded checkout even without screenshots',()=>{
  assert.deepEqual(attendanceBounds({check_in:'2026-09-07T18:00:00Z',check_out:'2026-09-07T18:30:00Z'},range,now,120),{start:Date.parse('2026-09-07T18:00:00Z'),end:Date.parse('2026-09-07T18:30:00Z')});
});
test('stale session ends at its own evidence, not an unrelated heartbeat',()=>{
  assert.equal(attendanceBounds({check_in:'2026-09-07T18:00:00Z',last_activity:'2026-09-07T17:00:00Z'},range,now,120),null);
});
test('CSV uses shared idle-adjusted totals and recorded local check-in rather than live status',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../lib/timeline-export.ts'),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  new Function('module','exports','require',compiled)(module,module.exports,(name)=>{
    if(name==='./reports-handler')return {getDailyReportData:async()=>({rows:[{id:'caleb',name:'Caleb Turner',current_status:'working',segments:[{type:'work',startMinute:420,endMinute:480},{type:'idle',startMinute:450,endMinute:460}],logs:[{type:'attendance'}],audit:[{kind:'attendance',label:'Checked in',at:'2026-09-07T18:00:00Z'}]}]})};
    return load(name.replace('./',''));
  });
  const csv=(await module.exports.makeTimelineExport({sub:'viewer',role:'admin'},'2026-09-07','2026-09-07','csv')).toString();
  assert.match(csv,/"Attendance recorded","50","10","0","83"/);
  assert.match(csv,/07\/09\/2026, 23:00:00/);
  assert.doesNotMatch(csv,/"working"/);
});
