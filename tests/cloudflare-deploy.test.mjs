import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ACCOUNT_ID, WORKER, ORIGIN, authorizePlan, buildPlan, inspectWorker, readAssets, validatePolicy, verifyLive, verifySource } from '../tools/deploy-cloudflare.mjs';

const sha = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = { repository: 'MertD95/watchparty', event: 'push', ref: 'refs/heads/main', sha, head: sha, remoteMain: sha };
const snapshot = () => ({ metadata: { id: WORKER, has_assets: true, has_modules: false, handlers: [], modified_on: 'first', tag: 'first-version' },
  settings: { bindings: [], compatibility_date: '2026-10-03', compatibility_flags: [], logpush: false },
  subdomain: { enabled: true, previews_enabled: false }, content: { kind: 'no-user-script', status: 404, bytes: 0 } });
const enabled = plan => ({ CLOUDFLARE_DEPLOY_ENABLED: 'true', CLOUDFLARE_BUILDS_DISCONNECTED: 'true',
  CLOUDFLARE_ASSETS_ONLY_CONFIRMED: 'true', CLOUDFLARE_EXPECTED_SETTINGS_SHA256: plan.fingerprint });

test('website source must be current main from the exact repository', () => {
  assert.equal(verifySource(source), sha);
  assert.equal(verifySource({ ...source, event: 'workflow_dispatch' }), sha);
  for (const patch of [{ repository: 'fork/watchparty' }, { event: 'pull_request' }, { ref: 'refs/heads/release/v2.1.1' },
    { head: 'b'.repeat(40) }, { remoteMain: 'b'.repeat(40) }, { sha: 'main' }]) {
    assert.throws(() => verifySource({ ...source, ...patch }));
  }
});

test('production deployment identity and exact Wrangler version cannot be overridden', () => {
  const policy = JSON.parse(readFileSync(new URL('../cloudflare/production.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validatePolicy(policy));
  for (const patch of [{ accountId: 'other' }, { workerName: 'other' }, { origin: 'https://other.example' },
    { assetsDirectory: '.' }, { wranglerVersion: 'latest' }, { main: 'worker.js' }]) {
    assert.throws(() => validatePolicy({ ...policy, ...patch }));
  }
});

test('assets-only plan preserves workers.dev settings and does not manage DNS or routes', () => {
  const plan = buildPlan(snapshot(), '/repo/landing');
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.config.workers_dev, true);
  assert.equal(plan.config.preview_urls, false);
  assert.equal(plan.config.keep_vars, true);
  assert.equal(plan.config.assets.directory, '/repo/landing');
  for (const key of ['main', 'route', 'routes', 'vars', 'kv_namespaces', 'd1_databases', 'services']) assert.equal(key in plan.config, false);
});

test('deployment requires all explicit enablement flags and exact approved configuration', () => {
  const plan = buildPlan(snapshot());
  assert.doesNotThrow(() => authorizePlan(plan, enabled(plan)));
  for (const key of Object.keys(enabled(plan))) {
    assert.throws(() => authorizePlan(plan, { ...enabled(plan), [key]: '' }));
  }
  assert.throws(() => authorizePlan(plan, { ...enabled(plan), CLOUDFLARE_EXPECTED_SETTINGS_SHA256: 'b'.repeat(64) }));
});

test('inspection exposes only known handler names, never arbitrary remote values', () => {
  const changed = snapshot();
  changed.metadata.handlers = ['fetch', 'scheduled', 'private-do-not-log'];
  const plan = buildPlan(changed);
  assert.deepEqual(plan.summary.runtimeHandlers, ['fetch', 'scheduled']);
  assert.equal(plan.summary.unknownHandlerCount, 1);
  assert.equal(plan.summary.handlerShapeRecognized, true);
  assert.equal(JSON.stringify(plan.summary).includes('private-do-not-log'), false);
  assert.ok(plan.blockers.includes('Worker has custom runtime handlers'));
  changed.metadata.handlers = 'private-do-not-log';
  const malformed = buildPlan(changed);
  assert.equal(malformed.summary.handlerShapeRecognized, false);
  assert.equal(malformed.summary.unknownHandlerCount, null);
  assert.deepEqual(malformed.summary.runtimeHandlers, []);
  assert.equal(JSON.stringify(malformed.summary).includes('private-do-not-log'), false);
});

test('observed platform asset fetch handler is allowed only with independently empty user source', () => {
  const observed = snapshot();
  observed.metadata.handlers = ['fetch'];
  observed.content = { kind: 'empty', status: 204, bytes: 0 };
  const plan = buildPlan(observed);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.summary.platformAssetFetch, true);
  assert.equal(plan.summary.hasNamedHandlers, false);
  assert.doesNotThrow(() => authorizePlan(plan, enabled(plan)));
  assert.equal('main' in plan.config, false);
});

test('platform fetch exception never admits custom code, ambiguous content or other handlers', () => {
  for (const change of [s => { s.metadata.handlers = ['fetch', 'scheduled']; },
    s => { s.metadata.handlers = ['fetch', 'fetch']; }, s => { s.metadata.handlers = ['private-value']; },
    s => { s.metadata.handlers = ''; }, s => { s.metadata.has_modules = true; },
    s => { s.metadata.has_assets = false; }, s => { s.metadata.named_handlers = ['private-value']; },
    s => { s.metadata.handlers = []; s.metadata.named_handlers = ['private-value']; },
    s => { s.content.kind = 'custom-or-unknown'; }, s => { s.content.status = 200; },
    s => { s.content = { kind: 'no-user-script', status: 404, bytes: 0 }; },
    s => { s.content.bytes = 1; }, s => { s.settings.bindings = [{ type: 'secret_text', name: 'PRIVATE' }]; }]) {
    const changed = snapshot();
    changed.metadata.handlers = ['fetch'];
    changed.content = { kind: 'empty', status: 204, bytes: 0 };
    change(changed);
    const plan = buildPlan(changed);
    assert.equal(plan.summary.platformAssetFetch, false);
    assert.ok(plan.blockers.length > 0);
    assert.throws(() => authorizePlan(plan, enabled(plan)));
    assert.equal(JSON.stringify(plan.summary).includes('private-value'), false);
  }
});

test('configuration fingerprint stays stable across normal asset deployments', () => {
  const before = snapshot(), after = snapshot();
  after.metadata.modified_on = 'next';
  after.metadata.tag = 'next-version';
  after.metadata.etag = 'new-etag';
  after.metadata.asset_size = 999;
  after.settings.annotations = { 'workers/message': 'next commit', 'workers/tag': 'version-2' };
  after.settings.assets = { config: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' }, jwt: 'new-upload-jwt' };
  after.settings.usage_model = 'standard';
  after.settings.observability = { enabled: false };
  after.settings.tail_consumers = [];
  after.settings.placement = { mode: 'off' };
  const approved = buildPlan(before), next = buildPlan(after, '/different/checkout/landing');
  assert.deepEqual(next.blockers, []);
  assert.equal(next.fingerprint, approved.fingerprint);
  assert.doesNotThrow(() => authorizePlan(next, enabled(approved)));
});

test('real runtime and workers.dev changes invalidate approved fingerprint', () => {
  const before = buildPlan(snapshot());
  for (const mutate of [s => { s.subdomain.enabled = false; }, s => { s.settings.compatibility_date = '2026-10-02'; },
    s => { s.settings.observability = { enabled: true }; }]) {
    const changed = snapshot(); mutate(changed);
    assert.notEqual(buildPlan(changed).fingerprint, before.fingerprint);
    assert.throws(() => authorizePlan(buildPlan(changed), enabled(before)));
  }
});

test('expanded provider observability defaults do not invalidate the next deployment', () => {
  const before = buildPlan(snapshot()), expanded = snapshot();
  expanded.settings.observability = { enabled: false, head_sampling_rate: 1, redact_query_string: false,
    logs: { enabled: false, head_sampling_rate: 1, invocation_logs: true, persist: true },
    traces: { enabled: false, persist: true, head_sampling_rate: 1 } };
  const next = buildPlan(expanded);
  assert.deepEqual(next.blockers, []);
  assert.equal(next.fingerprint, before.fingerprint);
  assert.deepEqual(next.config.observability, expanded.settings.observability);
  assert.deepEqual(before.config.observability, { enabled: false });
  assert.doesNotThrow(() => authorizePlan(next, enabled(before)));
  const compactEnabled = snapshot(), expandedEnabled = snapshot();
  compactEnabled.settings.observability = { enabled: true };
  expandedEnabled.settings.observability = { ...expanded.settings.observability, enabled: true,
    logs: { ...expanded.settings.observability.logs, enabled: true } };
  assert.equal(buildPlan(compactEnabled).fingerprint, buildPlan(expandedEnabled).fingerprint);
});

test('emitted observability preserves parent sampling and omitted nested overrides', () => {
  const original = snapshot();
  original.settings.observability = { enabled: true, head_sampling_rate: 0.1 };
  const plan = buildPlan(original);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.config.observability, { enabled: true, head_sampling_rate: 0.1 });
  assert.equal('logs' in plan.config.observability, false);
  assert.equal('traces' in plan.config.observability, false);
  const nextDeployment = snapshot();
  nextDeployment.settings.observability = structuredClone(plan.config.observability);
  nextDeployment.metadata.tag = 'next-version';
  nextDeployment.metadata.modified_on = 'next-time';
  assert.equal(buildPlan(nextDeployment).fingerprint, plan.fingerprint);
  for (const override of [{ logs: { head_sampling_rate: 1 } }, { logs: { head_sampling_rate: 0.1 } },
    { traces: { head_sampling_rate: 1 } }]) {
    const changed = snapshot();
    changed.settings.observability = { ...original.settings.observability, ...override };
    assert.notEqual(buildPlan(changed).fingerprint, plan.fingerprint);
    assert.throws(() => authorizePlan(buildPlan(changed), enabled(plan)));
  }
});

test('unknown and non-default nested observability settings are never erased', () => {
  const before = buildPlan(snapshot());
  for (const value of [{ logs: { head_sampling_rate: 0.1 } }, { logs: { invocation_logs: false } },
    { traces: { enabled: true } }, { redact_query_string: true }, { issues: { enabled: true } }]) {
    const changed = snapshot(); changed.settings.observability = value;
    const next = buildPlan(changed);
    assert.notEqual(next.fingerprint, before.fingerprint);
    assert.throws(() => authorizePlan(next, enabled(before)));
  }
  for (const value of [{ future_option: true }, { logs: { future_option: true } }, { logs: null },
    { traces: [] }, { head_sampling_rate: '1' }]) {
    const changed = snapshot(); changed.settings.observability = value;
    const next = buildPlan(changed);
    assert.ok(next.blockers.some(reason => reason.includes('observability')));
    assert.notEqual(next.fingerprint, before.fingerprint);
    assert.throws(() => authorizePlan(next, enabled(next)));
  }
});

test('known absent/default settings normalize conservatively without hiding explicit limits', () => {
  const before = buildPlan(snapshot()), explicit = snapshot();
  explicit.settings.tail_consumers = [];
  explicit.settings.placement = { mode: 'off' };
  explicit.settings.limits = null;
  assert.equal(buildPlan(explicit).fingerprint, before.fingerprint);
  const limited = snapshot(); limited.settings.limits = { cpu_ms: 10 };
  assert.notEqual(buildPlan(limited).fingerprint, before.fingerprint);
  assert.deepEqual(buildPlan(limited).config.limits, { cpu_ms: 10 });
  const smart = snapshot(); smart.settings.placement = { mode: 'smart' };
  assert.notEqual(buildPlan(smart).fingerprint, before.fingerprint);
  assert.deepEqual(buildPlan(smart).config.placement, { mode: 'smart' });
});

test('custom scripts, bindings and unsupported settings cannot be silently replaced', () => {
  for (const mutate of [s => { s.metadata.has_modules = true; }, s => { s.metadata.has_assets = false; },
    s => { s.metadata.handlers = ['scheduled']; }, s => { s.content.kind = 'custom-or-unknown'; },
    s => { s.settings.bindings = [{ type: 'secret_text', name: 'PRIVATE', text: 'never-log-this' }]; },
    s => { s.settings.unknown_setting = { value: 'never-log-this' }; },
    s => { s.settings.assets = { config: { not_found_handling: 'single-page-application' } }; },
    s => { s.settings.tags = ['important-tag']; }, s => { delete s.subdomain.previews_enabled; }]) {
    const changed = snapshot(); mutate(changed);
    const plan = buildPlan(changed);
    assert.ok(plan.blockers.length > 0);
    assert.throws(() => authorizePlan(plan, enabled(plan)));
    assert.equal(JSON.stringify({ ...plan.summary, blockers: plan.blockers }).includes('never-log-this'), false);
  }
});

test('an assets config envelope cannot hide unknown outer bindings or routing', () => {
  for (const extra of [{ binding: 'REMOTE' }, { run_worker_first: true }, { future_option: { enabled: true } }]) {
    const changed = snapshot();
    changed.settings.assets = { config: { html_handling: 'auto-trailing-slash' }, ...extra };
    const plan = buildPlan(changed);
    assert.ok(plan.blockers.some(reason => reason.includes('outer asset')));
    assert.throws(() => authorizePlan(plan, enabled(plan)));
  }
  for (const config of [null, false, 'auto', []]) {
    const changed = snapshot(); changed.settings.assets = { config, jwt: 'never-print-me' };
    assert.ok(buildPlan(changed).blockers.some(reason => reason.includes('assets configuration')));
  }
});

function inspectionHarness({ contentStatus = 404, contentBody = JSON.stringify({ success: false, errors: [{ code: 10007 }] }), error } = {}) {
  const calls = [], fixture = snapshot();
  const responses = [{ success: true, result: { id: WORKER, default_environment: { script: fixture.metadata } } },
    { success: true, result: fixture.settings }, { success: true, result: fixture.subdomain }];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer private-test-token');
    if (error) throw new Error(error);
    if (responses.length) return new Response(JSON.stringify(responses.shift()), { status: 200 });
    return new Response(contentBody, { status: contentStatus });
  };
  return { calls, run: () => inspectWorker({ token: 'private-test-token', fetchImpl }) };
}

test('inspection uses only read-only calls scoped to this Worker, never account enumeration', async () => {
  const h = inspectionHarness(), result = await h.run();
  assert.equal(buildPlan(result).blockers.length, 0);
  assert.equal(h.calls.length, 4);
  for (const { url } of h.calls) {
    assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/`));
    assert.ok(url.includes('/watchparty'));
  }
});

test('custom script contents and unknown content errors fail closed', async () => {
  for (const options of [{ contentStatus: 200, contentBody: 'export default { fetch() {} }' },
    { contentStatus: 404, contentBody: 'not found' }, { contentStatus: 403, contentBody: 'private error' }]) {
    const result = await inspectionHarness(options).run();
    assert.ok(buildPlan(result).blockers.some(reason => reason.includes('source')));
    assert.equal(JSON.stringify(result).includes(options.contentBody), false);
  }
});

test('inspection never leaks credentials through fetch errors and rejects missing secrets early', async () => {
  await assert.rejects(inspectionHarness({ error: 'private-test-token was rejected' }).run(), error => !error.message.includes('private-test-token'));
  await assert.rejects(inspectWorker({ token: '', fetchImpl: () => { throw new Error('must not call'); } }), /CLOUDFLARE_API_TOKEN/);
});

test('upload scope is the existing small static landing folder only', () => {
  const assets = readAssets();
  assert.ok(assets.some(file => file.name === 'landing.js'));
  assert.ok(assets.some(file => file.name === '_redirects'));
  assert.ok(assets.every(file => !file.name.includes('/') && !file.name.includes('extension')));
  assert.ok(assets.every(file => file.hash === hash(file.bytes)));
});

test('post-deploy verification checks exact public bytes, invite rewrites, and 404 behavior', async () => {
  const files = ['index.html', 'privacy.html', 'landing.js', '_redirects'].map(name => ({ name, bytes: Buffer.from(name), hash: hash(name) }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.ok(url.startsWith(ORIGIN));
    assert.equal(options.redirect, 'error');
    calls.push(url);
    const name = url.endsWith('/__watchparty_deployment_missing__') ? null : url.endsWith('/privacy') ? 'privacy.html'
      : url.endsWith('/landing.js') ? 'landing.js' : 'index.html';
    return new Response(name || '', { status: name ? 200 : 404 });
  };
  assert.deepEqual(await verifyLive({ files, fetchImpl }), { matchedPaths: 4, missingPath: 404 });
  assert.ok(calls.includes(`${ORIGIN}/r/deployment-check`));
  await assert.rejects(verifyLive({ files, fetchImpl: async () => new Response('stale') }), /does not match/);
});

test('workflow deploys only trusted main, pins tooling, and runs no product tests', () => {
  const workflow = readFileSync(new URL('../.github/workflows/cloudflare.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /environment: cloudflare-production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /default: inspect/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /wrangler@4\.147\.0/);
  assert.match(workflow, /Cache pinned deployment CLI without credentials/);
  assert.match(workflow, /node tools\/deploy-cloudflare\.mjs source\s+npx --offline --yes --package=wrangler@4\.147\.0 wrangler deploy/);
  assert.doesNotMatch(workflow, /npm (?:ci|test)|node --test|pull_request_target|secrets: inherit/);
  for (const [, ref] of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(ref, /@[a-f0-9]{40}$/);
});
