const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('canonical screenshot protocol is enforced on screenshot routes', () => {
  const protocol = read('lib/screenshot-protocol.ts');
  const authRoute = read('app/api/r2/screenshot-upload-urls/route.ts');
  const commitRoute = read('app/api/agent/screenshots/commit/route.ts');

  assert.match(protocol, /SCREENSHOT_PROTOCOL_VERSION\s*=\s*2/);
  assert.match(protocol, /SCREENSHOT_PROTOCOL_HEADER\s*=\s*'x-vorion-agent-protocol'/);
  assert.match(protocol, /status:\s*426/);
  assert.match(protocol, /agent_upgrade_required/);
  assert.match(authRoute, /requireAgentProtocol\(request\)/);
  assert.match(commitRoute, /requireAgentProtocol\(req\)/);
});

test('legacy screenshot keys are not accepted by regular key helpers', () => {
  const storage = read('lib/screenshot-storage.ts');
  const keys = read('lib/screenshot-keys.ts');

  assert.match(keys, /parseCanonicalScreenshotKey/);
  assert.match(keys, /segments\.length !== 8/);
  assert.match(keys, /root !== 'screenshots'/);
  assert.match(keys, /category !== 'regular' && category !== 'thumbnails'/);
  assert.doesNotMatch(storage, /isLegacyRegularScreenshotKey\(key, employeeId\)/);
  assert.doesNotMatch(storage, /isLegacyRegularThumbnailKey\(key, employeeId\)/);
});

test('retention uses database leases instead of advisory locks', () => {
  const retention = read('lib/screenshot-retention.ts');
  const migration = read('migrations/20260811_scheduled_job_leases.sql');

  assert.match(retention, /scheduled_job_leases/);
  assert.match(retention, /randomUUID/);
  assert.match(retention, /locked_until < NOW\(\)/);
  assert.doesNotMatch(retention, /pg_try_advisory_lock|pg_advisory_unlock/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS scheduled_job_leases/);
});

