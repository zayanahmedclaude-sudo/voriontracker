const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('desktop agent synchronizes only through the scoped policy bundle', () => {
  const source = read('agent/src/main.ts');
  const syncPolicies = source.slice(
    source.indexOf('async function syncPolicies()'),
    source.indexOf('function connectPolicyRealtime()'),
  );

  assert.match(syncPolicies, /apiRequest\('GET', '\/api\/agent\/policy-bundle'\)/);
  assert.match(syncPolicies, /bundle\.blockedApps/);
  assert.match(syncPolicies, /bundle\.blockedWebsites/);
  assert.doesNotMatch(syncPolicies, /\/api\/blocked\/apps/);
  assert.doesNotMatch(syncPolicies, /\/api\/blocked\/websites/);
});

test('agent source has no legacy policy delivery paths', () => {
  const source = read('agent/src/main.ts');

  assert.doesNotMatch(source, /\/api\/security\/policies/);
  assert.doesNotMatch(source, /apiRequest\('GET', '\/api\/blocked\/apps'\)/);
  assert.doesNotMatch(source, /apiRequest\('GET', '\/api\/blocked\/websites'\)/);
  assert.doesNotMatch(source, /function enforcePolicies/);
  assert.doesNotMatch(source, /policyInterval/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'app/api/security/policies/route.ts')), false);
});

test('policy inventory routes are authorized dashboard endpoints only', () => {
  const appsRoute = read('app/api/blocked/apps/route.ts');
  const websitesRoute = read('app/api/blocked/websites/route.ts');
  const policiesRoute = read('app/api/policies/route.ts');

  for (const route of [appsRoute, websitesRoute, policiesRoute]) {
    assert.match(route, /canViewSecurity/);
    assert.match(route, /return err\('Forbidden', 403\)/);
  }
  for (const route of [appsRoute, websitesRoute]) {
    assert.match(route, /req\.headers\.get\('x-vorion-agent-id'\)/);
    assert.match(route, /return err\('agent_policy_endpoint_retired', 426\)/);
  }
  assert.doesNotMatch(appsRoute, /listEffectiveBlockedApps/);
  assert.doesNotMatch(websitesRoute, /listEffectiveBlockedWebsites/);
});

test('effective blocked items include only global and matching department or employee scopes', () => {
  const security = read('lib/security.ts');

  assert.match(security, /ba\.scope_type = 'global'/);
  assert.match(security, /ba\.scope_type = 'department' AND ba\.department_id = \$\{input\.departmentId \|\| null\}/);
  assert.match(security, /ba\.scope_type = 'employee' AND ba\.employee_email = \$\{email\} AND ba\.department_id = \$\{input\.departmentId \|\| null\}/);
  assert.match(security, /bw\.scope_type = 'global'/);
  assert.match(security, /bw\.scope_type = 'department' AND bw\.department_id = \$\{input\.departmentId \|\| null\}/);
  assert.match(security, /bw\.scope_type = 'employee' AND bw\.employee_email = \$\{email\} AND bw\.department_id = \$\{input\.departmentId \|\| null\}/);
});
