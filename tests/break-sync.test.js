const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('agent changes break state only after the server confirms it', () => {
  const agent = read('agent', 'src', 'main.ts');
  const change = agent.slice(agent.indexOf('async function changeBreakState'), agent.indexOf('async function syncSessionStatusFromServer'));
  assert.ok(change.indexOf("await sessionAction(action") < change.indexOf('status = target;'), 'status is set after the request succeeds');
  assert.match(change, /await syncSessionStatusFromServer\(\);\s*if \(status === target\) return \{ ok: true \};/);
  assert.doesNotMatch(agent, /status = 'break';\s*await sessionAction\('start_break'/);
});

test('server break actions are safe to retry', () => {
  const sessions = read('app', 'api', 'sessions', 'route.ts');
  assert.match(sessions, /alreadyOnBreak: true/);
  assert.match(sessions, /if \(!breakRecord\) return ok\(\{ alreadyEnded: true \}\)/);
});

test('a syncing backlog does not raise a screenshots-stopped alert', () => {
  const health = read('lib', 'capture-health.ts');
  assert.match(health, /backlog > 0 && Number\.isFinite\(reconnectedAgoMs\) && reconnectedAgoMs < SYNC_GRACE_MS\) return;/);
  assert.match(health, /backlog > 0 && Number\.isFinite\(lastCommitAgoMs\) && lastCommitAgoMs < UPLOAD_PROGRESS_WINDOW_MS\) return;/);
});
