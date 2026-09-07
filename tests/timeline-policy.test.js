const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
function load(file){const module={exports:{}};const source=fs.readFileSync(path.join(__dirname,'../lib',file+'.ts'),'utf8');const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;new Function('require','module','exports',code)(name=>name.startsWith('./')?load(name.slice(2)):require(name),module,module.exports);return module.exports;}
const {validatePreferences,defaultPreferences,validateSchedule,earlyAttempt,scheduledWindow,geofenceDistance,nextExportAt}=load('timeline-policy');
const schedule=Array.from({length:7},(_,day)=>({day,start:'16:00',end:'07:00',off:day===0}));
test('assigned overnight shift blocks until exact end, including last fifteen minutes',()=>{
  const checkIn='2026-09-07T11:00:00Z';
  assert.equal(earlyAttempt(schedule,checkIn,new Date('2026-09-08T01:59:59Z')).flagged,true);
  assert.equal(earlyAttempt(schedule,checkIn,new Date('2026-09-08T01:45:00Z')).remainingMinutes,15);
  assert.equal(earlyAttempt(schedule,checkIn,new Date('2026-09-08T02:00:00Z')).flagged,false);
  assert.equal(earlyAttempt([],checkIn,new Date('2026-09-08T01:00:00Z')).flagged,false);
});
test('schedule distinguishes overnight, same-day, off days and malformed weeks',()=>{
  assert.equal(scheduledWindow(schedule,'2026-09-06'),null);
  assert.equal(scheduledWindow(schedule,'2026-09-07').end.toISOString(),'2026-09-08T02:00:00.000Z');
  const daytime=schedule.map(d=>({...d,start:'09:00',end:'17:00'}));
  assert.equal(scheduledWindow(daytime,'2026-09-07').end.toISOString(),'2026-09-07T12:00:00.000Z');
  assert.equal(earlyAttempt(daytime,'2026-09-07T04:00:00Z',new Date('2026-09-07T11:59:00Z')).remainingMinutes,1);
  assert.throws(()=>validateSchedule(schedule.map(d=>({...d,day:1}))));
  assert.throws(()=>validateSchedule(schedule.map(d=>({...d,start:'25:00'}))));
});
test('settings validate thresholds, channels and saved view shape',()=>{
  assert.deepEqual(validatePreferences(defaultPreferences),defaultPreferences);
  for(const threshold of [0,241,NaN,1.5,'15'])assert.throws(()=>validatePreferences({...defaultPreferences,threshold}));
  assert.throws(()=>validatePreferences({...defaultPreferences,channel:'sms'}));
  assert.throws(()=>validatePreferences({...defaultPreferences,views:[null]}));
  const p=validatePreferences({...defaultPreferences,views:[{name:' Team ',query:'Sam',status:'idle',team:true,sort:'most_idle'}]});
  assert.equal(p.views[0].team,true);assert.equal(p.views[0].name,'Team');
});
test('monthly export clamps month end and daily/weekly advances correctly',()=>{
  assert.equal(nextExportAt('monthly',new Date('2026-01-31T08:00:00Z')).toISOString(),'2026-02-28T08:00:00.000Z');
  assert.equal(nextExportAt('weekly',new Date('2026-09-07T08:00:00Z')).toISOString(),'2026-09-14T08:00:00.000Z');
});
test('geofence distance uses meters',()=>{
  assert.equal(geofenceDistance(24,67,24,67),0);
  assert.ok(Math.abs(geofenceDistance(0,0,0,1)-111195)<10);
});
