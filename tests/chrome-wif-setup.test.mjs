import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Execute the actual Bash/Python bootstrap against a fake gcloud. No Google
// account, network, keys, or project changes are involved in these local tests.
const script = fileURLToPath(new URL('../tools/setup-chrome-wif.sh', import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const bashAvailable = spawnSync(bash, ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
let python;
for (const candidate of ['python3', 'python']) {
  const result = spawnSync(candidate, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) { python = result.stdout.trim(); break; }
}
const skip = !bashAvailable || !python ? 'Bash and Python 3 are required for the mocked Cloud Shell bootstrap tests.' : false;
const project = 'watchparty-test';
const projectNumber = '123456789';
const repositoryId = '1204885893';
const ownerId = '78028167';
const accountEmail = `watchparty-cws-publisher@${project}.iam.gserviceaccount.com`;
const poolName = `projects/${projectNumber}/locations/global/workloadIdentityPools/watchparty-github`;
const providerName = `${poolName}/providers/github`;
const member = `principalSet://iam.googleapis.com/${poolName}/attribute.repository_id/${repositoryId}`;
const expectedCondition = `assertion.repository_id == '${repositoryId}' && assertion.repository_owner_id == '${ownerId}' && assertion.sub == 'repo:MertD95/watchparty:environment:chrome-web-store' && assertion.workflow_ref == 'MertD95/watchparty/.github/workflows/release.yml@' + assertion.ref && ((assertion.event_name == 'release' && assertion.ref.startsWith('refs/tags/v')) || (assertion.event_name == 'workflow_dispatch' && assertion.ref == 'refs/heads/main'))`;
const defaults = () => ({ project: { projectId: project, projectNumber, lifecycleState: 'ACTIVE' }, accounts: [], pools: [], providers: [], keys: [], accountPolicy: {}, projectPolicy: {} });
const configured = () => ({ ...defaults(), accounts: [{ email: accountEmail, disabled: false }],
  pools: [{ name: poolName, state: 'ACTIVE', disabled: false }],
  providers: [{ name: providerName, state: 'ACTIVE', disabled: false,
    attributeMapping: { 'google.subject': 'assertion.sub', 'attribute.repository_id': 'assertion.repository_id' },
    attributeCondition: expectedCondition, oidc: { issuerUri: 'https://token.actions.githubusercontent.com' } }],
  accountPolicy: { bindings: [{ role: 'roles/iam.workloadIdentityUser', members: [member] }] } });
const shellQuote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;

const fakeGcloud = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const statePath = process.env.WP_WIF_MOCK_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(process.env.WP_WIF_MOCK_CALLS, JSON.stringify(args) + '\\n');
const is = (...prefix) => prefix.every((value, i) => args[i] === value);
const option = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
let result = {};
if (state.failList && is('iam', 'service-accounts', 'list')) process.exit(7);
if (is('projects', 'describe')) result = state.project;
else if (is('projects', 'get-iam-policy')) result = state.projectPolicy;
else if (is('services', 'enable')) {}
else if (is('iam', 'service-accounts', 'list')) result = state.accounts;
else if (is('iam', 'service-accounts', 'keys', 'list')) result = state.keys;
else if (is('iam', 'service-accounts', 'get-iam-policy')) result = state.accountPolicy;
else if (is('iam', 'service-accounts', 'create')) state.accounts = [{ email: 'watchparty-cws-publisher@' + option('--project') + '.iam.gserviceaccount.com' }];
else if (is('iam', 'workload-identity-pools', 'list')) result = state.pools;
else if (is('iam', 'workload-identity-pools', 'create')) state.pools = [{ name: 'projects/' + state.project.projectNumber + '/locations/global/workloadIdentityPools/' + args[3], state: 'ACTIVE' }];
else if (is('iam', 'workload-identity-pools', 'providers', 'list')) result = state.providers;
else if (is('iam', 'workload-identity-pools', 'providers', 'create-oidc')) state.providers = [{ name: state.pools[0].name + '/providers/' + args[4], state: 'ACTIVE', attributeCondition: option('--attribute-condition'), attributeMapping: Object.fromEntries(option('--attribute-mapping').split(',').map(pair => pair.split('='))), oidc: { issuerUri: option('--issuer-uri') } }];
else if (is('iam', 'service-accounts', 'add-iam-policy-binding')) state.accountPolicy = { bindings: [{ role: option('--role'), members: [option('--member')] }] };
else { process.stderr.write('Unexpected mock command'); process.exit(8); }
fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify(result));
`;

function harness(t, initial = defaults()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watchparty-wif-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  const statePath = path.join(directory, 'state.json');
  const callsPath = path.join(directory, 'calls.jsonl');
  const mockPath = path.join(directory, 'gcloud.mjs');
  fs.writeFileSync(statePath, JSON.stringify(initial));
  fs.writeFileSync(callsPath, '');
  fs.writeFileSync(mockPath, fakeGcloud);
  fs.writeFileSync(path.join(bin, 'gcloud'), `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} ${shellQuote(mockPath)} "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'python3'), `#!/usr/bin/env bash\nexec ${shellQuote(python)} "$@"\n`, { mode: 0o700 });
  const environment = { ...process.env, WP_WIF_MOCK_STATE: statePath, WP_WIF_MOCK_CALLS: callsPath };
  // Windows preserves the caller's Path casing; avoid two case-insensitive keys.
  const pathKey = Object.keys(environment).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  environment[pathKey] = bin + path.delimiter + environment[pathKey];
  return {
    run(args = ['--project', project, '--repository-id', repositoryId, '--owner-id', ownerId]) {
      return spawnSync(bash, [script, ...args], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    },
    calls: () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
  };
}
const trustMutations = calls => calls.filter(args => args.some(arg => ['create', 'create-oidc', 'add-iam-policy-binding', 'update', 'undelete'].includes(arg)));

test('WIF bootstrap validates inputs before any Google call', { skip }, t => {
  const h = harness(t);
  for (const args of [[], ['--project', 'bad;command'], ['--project'],
    ['--project', project, '--repository-id', '1;bad', '--owner-id', ownerId],
    ['--project', project, '--project', project, '--repository-id', repositoryId, '--owner-id', ownerId]]) {
    assert.notEqual(h.run(args).status, 0);
  }
  assert.equal(h.run(['--help']).status, 0);
  assert.equal(h.calls().length, 0);
});

test('WIF bootstrap creates exactly scoped resources and reruns idempotently', { skip }, t => {
  const h = harness(t);
  const first = h.run();
  assert.equal(first.status, 0, first.stderr || first.error?.message);
  assert.match(first.stdout, /GOOGLE_PROJECT_NUMBER=123456789/);
  assert.ok(first.stdout.includes(accountEmail));
  assert.ok(first.stdout.includes(providerName));
  assert.equal(trustMutations(h.calls()).length, 4);
  const state = h.state();
  assert.equal(state.providers[0].attributeCondition, expectedCondition);
  assert.deepEqual(state.accountPolicy.bindings, configured().accountPolicy.bindings);
  assert.deepEqual(state.keys, []);
  assert.deepEqual(state.projectPolicy, {});
  const enabled = h.calls().find(args => args[0] === 'services');
  assert.ok(enabled.includes('chromewebstore.googleapis.com'));
  assert.ok(enabled.includes('cloudresourcemanager.googleapis.com'));
  const second = h.run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(trustMutations(h.calls()).length, 4, 'reuse must not alter existing IAM trust');
});

test('WIF bootstrap refuses broader providers, extra providers, or disabled/deleted resources', { skip }, t => {
  const variants = [
    state => { state.providers[0].attributeCondition = 'true'; },
    state => { state.providers.push({ ...state.providers[0], name: poolName + '/providers/other' }); },
    state => { state.providers[0].oidc.allowedAudiences = ['another-audience']; },
    state => { state.providers[0].attributeMapping['attribute.other'] = 'assertion.actor'; },
    state => { state.pools[0].disabled = true; },
    state => { state.providers[0].state = 'DELETED'; },
    state => { state.accounts[0].disabled = true; },
  ];
  for (const alter of variants) {
    const state = configured(); alter(state);
    const h = harness(t, state);
    const result = h.run();
    assert.notEqual(result.status, 0);
    assert.equal(trustMutations(h.calls()).length, 0, result.stderr);
  }
});

test('WIF bootstrap refuses unexpected keys, IAM trust, or project roles', { skip }, t => {
  const variants = [
    state => { state.keys.push({ name: 'existing-key' }); },
    state => { state.accountPolicy.bindings[0].members.push('allUsers'); },
    state => { state.accountPolicy.bindings[0].condition = { expression: 'true' }; },
    state => { state.projectPolicy.bindings = [{ role: 'roles/editor', members: ['serviceAccount:' + accountEmail] }]; },
  ];
  for (const alter of variants) {
    const state = configured(); alter(state);
    const h = harness(t, state);
    const result = h.run();
    assert.notEqual(result.status, 0);
    assert.equal(trustMutations(h.calls()).length, 0, result.stderr);
  }
});

test('WIF bootstrap does not confuse list permission failures with absent resources', { skip }, t => {
  const h = harness(t, { ...defaults(), failList: true });
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.equal(trustMutations(h.calls()).length, 0);
});
