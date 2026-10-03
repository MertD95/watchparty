import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runPublisher, compareVersions, validateReleasePackage } from '../tools/publish-chrome-web-store.mjs';
import { readStorePackage } from '../tools/validate-store-package.mjs';
import { verifyReleaseSource } from '../tools/verify-release-source.mjs';

const env = { CHROME_EXTENSION_ID: 'a'.repeat(32), CHROME_PUBLISHER_ID: 'test-publisher',
  CHROME_CLIENT_ID: 'private-client-id', CHROME_CLIENT_SECRET: 'private-client-secret', CHROME_REFRESH_TOKEN: 'private-refresh-token' };
const identity = { itemId: env.CHROME_EXTENSION_ID, name: `publishers/${env.CHROME_PUBLISHER_ID}/items/${env.CHROME_EXTENSION_ID}` };
const revision = (state, version) => ({ state, distributionChannels: [{ crxVersion: version }] });
const status = (extra = {}) => ({ ...identity, publishedItemRevisionStatus: revision('PUBLISHED', '2.0.1'), ...extra });
const uploaded = (extra = {}) => ({ ...identity, crxVersion: '2.0.2', uploadState: 'SUCCEEDED', ...extra });
const pending = status({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '2.0.2') });

// Minimal in-memory ordinary ZIP. No network, credentials, browser or filesystem writes.
function archive(manifest = { manifest_version: 3, name: 'Test', version: '2.0.2' }, extra = []) {
  const files = [['manifest.json', JSON.stringify(manifest)], ...extra];
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const filename = Buffer.from(name), body = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(body.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(local, filename, body);
    central.push(directory, filename);
    offset += local.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function harness(responses, options = {}) {
  const calls = [], logs = [];
  let time = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.redirect, 'error');
    const response = responses.shift();
    assert.notEqual(response, undefined, `Unexpected request: ${url}`);
    if (response instanceof Error) throw response;
    return { ok: !response.httpError, status: response.httpError || response.httpStatus || 200,
      json: async () => response,
      text: async () => response.rawText === undefined ? JSON.stringify(response) : response.rawText };
  };
  return { calls, logs, run: () => runPublisher({ env, submit: true, zipBytes: archive(), fetchImpl,
    sleep: async milliseconds => { time += milliseconds; }, now: () => time, log: text => logs.push(text), ...options }) };
}
const token = () => ({ access_token: 'private-access-token' });

test('store ZIP validation reads the artifact and rejects dev origins, missing files, duplicate and unsafe paths', () => {
  assert.equal(readStorePackage(archive()).manifest.version, '2.0.2');
  assert.throws(() => readStorePackage(archive({ manifest_version: 3, version: '2.0.2', host_permissions: ['http://localhost:8181/*'] })), /Development host/);
  assert.throws(() => readStorePackage(archive({ manifest_version: 3, version: '2.0.2', background: { service_worker: 'missing.js' } })), /resource is missing/);
  assert.throws(() => readStorePackage(archive(undefined, [['manifest.json', '{}']])), /duplicate path/);
  assert.throws(() => readStorePackage(archive(undefined, [['../secret', 'x']])), /Unsafe/);
  assert.throws(() => readStorePackage(archive(undefined, [['types/test.d.ts', 'x']])), /Development-only/);
  assert.throws(() => readStorePackage(Buffer.from('not a zip')), /Invalid store ZIP/);
  assert.equal(compareVersions('2.0.2', '2.0.2.0'), 0);
  assert.equal(compareVersions('2.0.2', '2.0.10'), -1);
});

test('store status mode never uploads or submits and logs no credentials', async () => {
  const h = harness([token(), status()], { submit: false, zipBytes: undefined });
  assert.equal((await h.run()).event, 'status-only-no-changes');
  assert.equal(h.calls.length, 2);
  for (const secret of [env.CHROME_CLIENT_SECRET, env.CHROME_CLIENT_ID, env.CHROME_REFRESH_TOKEN, 'private-access-token']) assert.ok(!h.logs.join('').includes(secret));
});

test('short-lived supplied access token requires no OAuth secrets and never refreshes', async () => {
  const shortEnv = { CHROME_EXTENSION_ID: env.CHROME_EXTENSION_ID, CHROME_PUBLISHER_ID: env.CHROME_PUBLISHER_ID,
    CHROME_ACCESS_TOKEN: 'private-short-lived-token' };
  const h = harness([status()], { env: shortEnv, submit: false, zipBytes: undefined });
  assert.equal((await h.run()).event, 'status-only-no-changes');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].headers.Authorization, 'Bearer private-short-lived-token');
  assert.ok(!h.logs.join('').includes(shortEnv.CHROME_ACCESS_TOKEN));
  const submit = harness([status(), uploaded(), status(), { ...identity, state: 'PENDING_REVIEW' }, pending], {
    env: { ...shortEnv, GITHUB_ACTIONS: 'true', CHROME_PUBLISH_ENABLED: 'true', CHROME_RELEASE_TAG: 'v2.0.2',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'MertD95/watchparty' },
  });
  assert.equal((await submit.run()).submissionState, 'PENDING_REVIEW');
  assert.ok(submit.calls.every(call => !call.url.includes('oauth2.googleapis.com')));
});

test('supplied token failures do not fall back to OAuth refresh credentials or expose the token', async () => {
  for (const invalid of ['', ' ', 'private\nsecret', 'private\rsecret', 'private\tsecret']) {
    const h = harness([], { env: { ...env, CHROME_ACCESS_TOKEN: invalid }, submit: false });
    await assert.rejects(h.run(), /valid OAuth access token/);
    assert.equal(h.calls.length, 0);
  }
  for (const response of [{ httpError: 401, error_description: 'private-short-lived-token' }, new Error('private-short-lived-token')]) {
    const h = harness([response], { env: { ...env, CHROME_ACCESS_TOKEN: 'private-short-lived-token' }, submit: false });
    await assert.rejects(h.run(), error => !error.message.includes('private-short-lived-token'));
    assert.equal(h.calls.length, 1);
    assert.ok(!h.calls[0].url.includes('oauth2.googleapis.com'));
  }
});

test('release package must match its stable tag exactly before authentication', async () => {
  assert.equal(validateReleasePackage(archive(), 'v2.0.2'), '2.0.2');
  for (const tag of [undefined, '', 'main', 'refs/tags/v2.0.2', 'v2.0.2-beta', 'v02.0.2', 'v2.0.3', 'v2.0.2.0', 'v2.0.2\n']) {
    assert.throws(() => validateReleasePackage(archive(), tag));
  }
  const h = harness([], { expectedTag: 'v2.0.3' });
  await assert.rejects(h.run(), /exactly match/);
  assert.equal(h.calls.length, 0);
});

test('CI submission requires explicit enablement and release tag but status works while disabled', async () => {
  for (const flags of [{}, { CHROME_PUBLISH_ENABLED: 'false' }, { CHROME_PUBLISH_ENABLED: 'true' },
    { CHROME_PUBLISH_ENABLED: 'true', CHROME_RELEASE_TAG: 'v2.0.3' }]) {
    const h = harness([], { env: { ...env, GITHUB_ACTIONS: 'true', ...flags } });
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 0);
  }
  const h = harness([token(), status()], { env: { ...env, GITHUB_ACTIONS: 'true', CHROME_PUBLISH_ENABLED: 'false' }, submit: false });
  assert.equal((await h.run()).event, 'status-only-no-changes');
});

test('release workflow keeps short-lived auth scoped, status cheap, and exact-tag packaging separate', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /npm (?:ci|install|test|run verify)|node --test/);
  assert.match(workflow, /!github\.event\.release\.prerelease/);
  assert.match(workflow, /inputs\.mode == 'package' \|\| inputs\.mode == 'upload' \|\| inputs\.mode == 'submit'/);
  assert.match(workflow, /vars\.CHROME_PUBLISH_ENABLED == 'true'/);
  assert.match(workflow, /run: node tools\/verify-release-source\.mjs/);
  assert.match(workflow, /CHROME_RELEASE_CANDIDATE_SHA: \$\{\{ vars\.CHROME_RELEASE_CANDIDATE_SHA \}\}/);
  assert.match(workflow, /CHROME_RELEASE_CANDIDATE_BASE_SHA: \$\{\{ vars\.CHROME_RELEASE_CANDIDATE_BASE_SHA \}\}/);
  assert.match(workflow, /test "\$\{GITHUB_REF\}" = 'refs\/heads\/main'/);
  assert.match(workflow, /path: release-source/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.equal((workflow.match(/id-token: write/g) || []).length, 1);
  assert.match(workflow, /google-github-actions\/auth@[a-f0-9]{40}/);
  assert.match(workflow, /access_token_scopes: https:\/\/www\.googleapis\.com\/auth\/chromewebstore\r?\n/);
  assert.match(workflow, /create_credentials_file: false/);
  assert.match(workflow, /export_environment_variables: false/);
  assert.match(workflow, /if: vars\.CHROME_AUTH_MODE == 'wif'/);
  assert.match(workflow, /if: vars\.CHROME_AUTH_MODE == 'oauth'/);
  assert.ok(workflow.indexOf('Verify artifact checksum') < workflow.indexOf('Obtain short-lived'));
});

test('already published or reviewed identical version is idempotent without upload', async () => {
  for (const existing of [pending, status({ publishedItemRevisionStatus: revision('PUBLISHED', '2.0.2.0') }),
    status({ submittedItemRevisionStatus: revision('STAGED', '2.0.2') })]) {
    const h = harness([token(), existing]);
    assert.match((await h.run()).event, /^already-/);
    assert.equal(h.calls.length, 2);
  }
});

test('store preflight blocks other submissions, rollback, unknown versions, policy problems and concurrent uploads', async () => {
  for (const existing of [status({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '2.0.3') }),
    status({ publishedItemRevisionStatus: revision('PUBLISHED', '3.0') }), status({ warned: true }), status({ takenDown: true }),
    status({ lastAsyncUploadState: 'IN_PROGRESS' }), status({ lastAsyncUploadState: 'UPLOAD_IN_PROGRESS' }),
    status({ submittedItemRevisionStatus: { state: 'FUTURE_STATE' } }), status({ publishedItemRevisionStatus: { state: 'PUBLISHED' } })]) {
    const h = harness([token(), existing]);
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 2);
  }
});

test('store submission uses API v2, exact ZIP and mandatory review with warning blocking', async () => {
  const h = harness([token(), status(), uploaded(), status(), { ...identity, state: 'PENDING_REVIEW' }, pending]);
  const result = await h.run();
  assert.equal(result.submissionState, 'PENDING_REVIEW');
  assert.match(h.calls[2].url, /^https:\/\/chromewebstore\.googleapis\.com\/upload\/v2\/publishers\//);
  assert.deepEqual(h.calls[2].body, archive());
  assert.equal(h.calls[2].headers['Content-Type'], 'application/zip');
  assert.deepEqual(JSON.parse(h.calls[4].body), { publishType: 'STAGED_PUBLISH', skipReview: false, blockOnWarnings: true });
  assert.ok(h.logs.some(line => JSON.parse(line).event === 'submission-accepted' && JSON.parse(line).approved === false));
});

test('async upload polls both documented progress names and never publishes before success', async () => {
  const h = harness([token(), status(), uploaded({ uploadState: 'IN_PROGRESS', crxVersion: undefined }),
    status({ lastAsyncUploadState: 'UPLOAD_IN_PROGRESS' }), status({ lastAsyncUploadState: 'SUCCEEDED' }),
    status(), { ...identity, state: 'PENDING_REVIEW' }, pending]);
  assert.equal((await h.run()).submissionState, 'PENDING_REVIEW');
  assert.equal(h.calls.filter(call => call.url.endsWith(':publish')).length, 1);
});

test('failed, unknown or bounded-out uploads never submit', async () => {
  for (const uploadState of ['FAILED', 'UNKNOWN', 'IN_PROGRESS']) {
    const responses = [token(), status(), uploaded({ uploadState })];
    if (uploadState === 'IN_PROGRESS') responses.push(status({ lastAsyncUploadState: 'IN_PROGRESS' }));
    const h = harness(responses, { maxPolls: 1 });
    await assert.rejects(h.run(), /submission was not requested/);
    assert.ok(h.calls.every(call => !call.url.endsWith(':publish')));
  }
});

test('store failure does not expose OAuth responses and mutations are not retried', async () => {
  const auth = harness([{ httpError: 401, error_description: env.CHROME_CLIENT_SECRET }]);
  await assert.rejects(auth.run(), error => !error.message.includes(env.CHROME_CLIENT_SECRET) && /HTTP 401/.test(error.message));
  const network = harness([token(), status(), new Error(env.CHROME_REFRESH_TOKEN)]);
  await assert.rejects(network.run(), error => !error.message.includes(env.CHROME_REFRESH_TOKEN) && /no automatic retry/.test(error.message));
  assert.equal(network.calls.length, 3);
});

test('upload version mismatch or another active submission appearing after upload prevents publish', async () => {
  for (const responses of [[token(), status(), uploaded({ crxVersion: '2.0.3' })],
    [token(), status(), uploaded({ crxVersion: undefined })], [token(), status(), uploaded({ crxVersion: '' })],
    [token(), status(), uploaded(), status({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '2.0.3') })]]) {
    const h = harness(responses);
    await assert.rejects(h.run(), /submission was not requested/);
    assert.ok(h.calls.every(call => !call.url.endsWith(':publish')));
  }
});

test('a failed read-only final status cannot erase the confirmed submission result', async () => {
  const h = harness([token(), status(), uploaded(), status(), { ...identity, state: 'PENDING_REVIEW' }, new Error('offline')]);
  const result = await h.run();
  assert.equal(result.event, 'submission-accepted-status-unavailable');
  assert.equal(result.state, 'PENDING_REVIEW');
  assert.equal(h.calls.filter(call => call.url.endsWith(':publish')).length, 1);
});

const pendingThree = () => status({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '2.0.3') });
const cancelHarness = (responses, options = {}) => harness(responses, {
  submit: false, cancelReview: true, expectedPendingVersion: '2.0.3', zipBytes: undefined, ...options,
});

test('explicit cancellation requires an exact version and never combines with package submission', async () => {
  for (const expectedPendingVersion of [undefined, '', 'v2.0.3', '02.0.3', '2.0.3\n', '65536', '1.2.3.4.5', '2.0.3;echo unsafe']) {
    const h = cancelHarness([], { expectedPendingVersion });
    await assert.rejects(h.run(), /exact expected pending version/);
    assert.equal(h.calls.length, 0);
  }
  for (const options of [{ submit: true }, { zipBytes: archive() }]) {
    const h = cancelHarness([], options);
    await assert.rejects(h.run(), /separate operations|must not receive/);
    assert.equal(h.calls.length, 0);
  }
});

test('cancel-review calls the official empty-body endpoint once and confirms removal without uploading', async () => {
  for (const acknowledgement of [{ rawText: '', httpStatus: 204 }, { rawText: '', httpStatus: 200 }, { rawText: '{ }' }]) {
    const h = cancelHarness([token(), pendingThree(), pendingThree(), acknowledgement, status()]);
    const result = await h.run();
    assert.equal(result.event, 'cancellation-confirmed');
    assert.equal(result.requestedVersion, '2.0.3');
    assert.equal(result.submittedState, null);
    const mutation = h.calls.filter(call => call.url.endsWith(':cancelSubmission'));
    assert.equal(mutation.length, 1);
    assert.equal(mutation[0].url, `https://chromewebstore.googleapis.com/v2/${identity.name}:cancelSubmission`);
    assert.equal(mutation[0].method, 'POST');
    assert.equal(mutation[0].body, undefined);
    assert.equal(h.calls.some(call => call.url.endsWith(':upload') || call.url.endsWith(':publish')), false);
    for (const secret of [env.CHROME_CLIENT_SECRET, env.CHROME_CLIENT_ID, env.CHROME_REFRESH_TOKEN, 'private-access-token']) {
      assert.equal(h.logs.join('').includes(secret), false);
    }
  }
});

test('cancellation refuses missing, mismatched, ambiguous, approved and policy-blocked reviews without mutation', async () => {
  const ambiguous = revision('PENDING_REVIEW', '2.0.3');
  ambiguous.distributionChannels.push({ crxVersion: '2.0.4' });
  const unknownChannel = revision('PENDING_REVIEW', '2.0.3');
  unknownChannel.distributionChannels.push({});
  for (const initial of [status(), pending,
    status({ submittedItemRevisionStatus: revision('STAGED', '2.0.3') }),
    status({ submittedItemRevisionStatus: revision('PUBLISHED', '2.0.3') }),
    status({ submittedItemRevisionStatus: revision('CANCELLED', '2.0.3') }),
    status({ submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } }),
    status({ submittedItemRevisionStatus: ambiguous }), status({ submittedItemRevisionStatus: unknownChannel }),
    { ...pendingThree(), warned: true }, { ...pendingThree(), takenDown: true },
    { ...pendingThree(), lastAsyncUploadState: 'IN_PROGRESS' },
    { ...pendingThree(), publishedItemRevisionStatus: revision('PUBLISHED', '2.0.3') },
  ]) {
    const h = cancelHarness([token(), initial]);
    await assert.rejects(h.run(), /no cancellation was performed/);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls.some(call => call.url.endsWith(':cancelSubmission')), false);
  }
});

test('the cancellation preflight rechecks the exact pending version immediately before mutation', async () => {
  for (const changed of [pending, status(), status({ submittedItemRevisionStatus: revision('STAGED', '2.0.3') })]) {
    const h = cancelHarness([token(), pendingThree(), changed]);
    await assert.rejects(h.run(), /no cancellation was performed/);
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls.some(call => call.url.endsWith(':cancelSubmission')), false);
  }
});

test('cancellation polls only read-only status and bounds unchanged review confirmation', async () => {
  const cancelled = status({ submittedItemRevisionStatus: revision('CANCELLED', '2.0.3') });
  const h = cancelHarness([token(), pendingThree(), pendingThree(), {}, pendingThree(), cancelled], { maxPolls: 1 });
  assert.equal((await h.run()).event, 'cancellation-confirmed');
  assert.equal(h.calls.filter(call => call.url.endsWith(':cancelSubmission')).length, 1);
  const stillPending = cancelHarness([token(), pendingThree(), pendingThree(), {}, pendingThree(), pendingThree()], { maxPolls: 1 });
  await assert.rejects(stillPending.run(), /still pending/);
  assert.equal(stillPending.calls.filter(call => call.url.endsWith(':cancelSubmission')).length, 1);
});

test('failed or ambiguous cancellation is never retried and never exposes provider data', async () => {
  for (const failure of [new Error('private-provider-data'), { httpError: 409, details: 'private-provider-data' },
    { rawText: 'private-provider-data' }, { rawText: '{"error":"private-provider-data"}' }]) {
    const h = cancelHarness([token(), pendingThree(), pendingThree(), failure]);
    await assert.rejects(h.run(), error => !error.message.includes('private-provider-data'));
    assert.equal(h.calls.filter(call => call.url.endsWith(':cancelSubmission')).length, 1);
    assert.equal(h.logs.join('').includes('private-provider-data'), false);
  }
  for (const followup of [new Error('private-provider-data'),
    { ...pendingThree(), publishedItemRevisionStatus: revision('PUBLISHED', '2.0.3') },
    status({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '2.0.4') })]) {
    const h = cancelHarness([token(), pendingThree(), pendingThree(), {}, followup]);
    await assert.rejects(h.run(), /status confirmation failed|state changed/);
    assert.equal(h.calls.filter(call => call.url.endsWith(':cancelSubmission')).length, 1);
    assert.ok(h.logs.some(line => JSON.parse(line).event === 'cancellation-accepted'));
  }
});

test('CI cancellation requires explicitly enabled trusted manual main and supports protected WIF auth', async () => {
  const trusted = { ...env, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'MertD95/watchparty', CHROME_PUBLISH_ENABLED: 'true' };
  for (const changes of [{ GITHUB_EVENT_NAME: 'release' }, { GITHUB_REF: 'refs/tags/v2.0.4' },
    { GITHUB_REPOSITORY: 'someone/watchparty' }, { CHROME_PUBLISH_ENABLED: 'false' }]) {
    const h = cancelHarness([], { env: { ...trusted, ...changes } });
    await assert.rejects(h.run(), /enabled manual dispatch/);
    assert.equal(h.calls.length, 0);
  }
  const h = cancelHarness([pendingThree(), pendingThree(), {}, status()], {
    env: { ...trusted, CHROME_ACCESS_TOKEN: 'private-short-lived-token', CHROME_CLIENT_ID: undefined,
      CHROME_CLIENT_SECRET: undefined, CHROME_REFRESH_TOKEN: undefined },
  });
  assert.equal((await h.run()).event, 'cancellation-confirmed');
  assert.equal(h.calls.some(call => call.url.includes('oauth2.googleapis.com')), false);
  assert.equal(h.logs.join('').includes('private-short-lived-token'), false);
});

test('status and ordinary release submission never cancel even when an expected pending version is configured', async () => {
  const h = harness([token(), pendingThree()], { env: { ...env, CHROME_EXPECTED_PENDING_VERSION: '2.0.3' } });
  await assert.rejects(h.run(), /no upload or cancellation was performed/);
  assert.equal(h.calls.some(call => call.url.endsWith(':cancelSubmission')), false);
  const readOnly = harness([token(), pendingThree()], { submit: false, expectedPendingVersion: '2.0.3' });
  assert.equal((await readOnly.run()).event, 'status-only-no-changes');
  assert.equal(readOnly.calls.length, 2);
});

test('workflow cancellation is manual-only, skips packaging and uses protected explicit expected-version input', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /options: \[status, package, upload, submit, cancel-review, publish-staged\]/);
  assert.match(workflow, /expected_version:/);
  assert.match(workflow, /CHROME_EXPECTED_PENDING_VERSION: \$\{\{ inputs\.expected_version \}\}/);
  const packageJob = workflow.slice(workflow.indexOf('  package:'), workflow.indexOf('  chrome-store:'));
  assert.doesNotMatch(packageJob, /cancel-review/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && \(inputs\.mode == 'status' \|\| inputs\.mode == 'cancel-review' \|\| inputs\.mode == 'publish-staged'\)/);
  assert.match(workflow, /if \[ "\$\{STORE_MODE\}" = 'cancel-review' \]; then\r?\n\s+test "\$\{GITHUB_EVENT_NAME\}" = 'workflow_dispatch'/);
  assert.equal((workflow.match(/--cancel-review "\$\{CHROME_EXPECTED_PENDING_VERSION\}"/g) || []).length, 2);
  assert.doesNotMatch(workflow, /npm (?:ci|install|test|run verify)|node --test/);
});

test('release source guard allows main history and one exact candidate with trusted release or main-dispatch tools', () => {
  const releaseSha = 'a'.repeat(40), candidate = { repository: 'MertD95/watchparty', event: 'release',
    ref: 'refs/tags/v2.1.0', workflowSha: releaseSha, releaseTag: 'v2.1.0', releaseSha,
    releaseOnMain: false, mainOnRelease: true, candidateSha: releaseSha };
  assert.deepEqual(verifyReleaseSource(candidate), { releaseTag: 'v2.1.0', releaseSha });
  assert.doesNotThrow(() => verifyReleaseSource({ ...candidate, releaseOnMain: true, candidateSha: undefined, mainOnRelease: false }));
  assert.doesNotThrow(() => verifyReleaseSource({ ...candidate, event: 'workflow_dispatch', ref: 'refs/heads/main',
    workflowSha: 'b'.repeat(40), releaseOnMain: true, candidateSha: undefined }));
  assert.doesNotThrow(() => verifyReleaseSource({ ...candidate, event: 'workflow_dispatch', ref: 'refs/heads/main',
    workflowSha: 'b'.repeat(40) }));
  for (const override of [
    { repository: 'someone/watchparty' }, { event: 'push' }, { ref: 'refs/heads/release/v2.1.0' },
    { workflowSha: 'b'.repeat(40) }, { releaseSha: 'not-a-sha' }, { releaseTag: 'v2.1.0-beta' },
    { releaseTag: 'v02.1.0' }, { releaseTag: 'v2.1.0\n' }, { releaseTag: 'v2.1.0;echo unsafe' },
    { candidateSha: undefined }, { candidateSha: 'b'.repeat(40) }, { candidateSha: releaseSha + '\n' },
    { candidateSha: releaseSha.toUpperCase() }, { mainOnRelease: false }, { mainOnRelease: 'true' },
    { event: 'workflow_dispatch', ref: 'refs/heads/main', candidateSha: undefined },
    { event: 'workflow_dispatch', ref: 'refs/heads/main', candidateSha: 'b'.repeat(40) },
    { event: 'workflow_dispatch', ref: 'refs/heads/main', mainOnRelease: false },
    { event: 'workflow_dispatch', ref: 'refs/heads/release/v2.1.0', releaseOnMain: true },
  ]) assert.throws(() => verifyReleaseSource({ ...candidate, ...override }));
});

test('held candidate baseline permits only trusted-main dispatch of the exact pinned source after main advances', () => {
  const releaseSha = 'a'.repeat(40), baseline = 'c'.repeat(40);
  const held = { repository: 'MertD95/watchparty', event: 'workflow_dispatch', ref: 'refs/heads/main',
    workflowSha: 'b'.repeat(40), releaseTag: 'v2.1.1', releaseSha, candidateSha: releaseSha,
    candidateBaseSha: baseline, releaseOnMain: false, mainOnRelease: false,
    baseOnRelease: true, baseOnMain: true };
  assert.deepEqual(verifyReleaseSource(held), { releaseTag: 'v2.1.1', releaseSha });
  for (const override of [
    { candidateSha: undefined }, { candidateSha: 'd'.repeat(40) }, { candidateSha: releaseSha + '\n' },
    { candidateBaseSha: undefined }, { candidateBaseSha: '' }, { candidateBaseSha: 'main' },
    { candidateBaseSha: baseline.toUpperCase() }, { candidateBaseSha: baseline + '\n' },
    { baseOnRelease: false }, { baseOnMain: false }, { baseOnRelease: 'true' }, { baseOnMain: 'true' },
    { ref: 'refs/heads/release/v2.1.1' }, { ref: 'refs/tags/v2.1.1' },
    { repository: 'someone/watchparty' }, { event: 'push' },
    // A matching tag's own workflow cannot use the manual-main baseline exception.
    { event: 'release', ref: 'refs/tags/v2.1.1', workflowSha: releaseSha },
  ]) assert.throws(() => verifyReleaseSource({ ...held, ...override }));
  // Release events retain their original exact tag identity AND current-main ancestry.
  assert.doesNotThrow(() => verifyReleaseSource({ ...held, event: 'release', ref: 'refs/tags/v2.1.1',
    workflowSha: releaseSha, mainOnRelease: true }));
  assert.throws(() => verifyReleaseSource({ ...held, event: 'release', ref: 'refs/tags/v2.1.1',
    workflowSha: 'd'.repeat(40), mainOnRelease: true }));
});

test('upload-only prepares the exact package and stops before review or publication', async () => {
  for (const uploadState of ['SUCCEEDED', 'IN_PROGRESS']) {
    const responses = [token(), status(), uploaded({ uploadState, ...(uploadState === 'IN_PROGRESS' ? { crxVersion: undefined } : {}) })];
    if (uploadState === 'IN_PROGRESS') responses.push(status({ lastAsyncUploadState: 'SUCCEEDED' }));
    responses.push(status());
    const h = harness(responses, { submit: false, uploadOnly: true });
    const result = await h.run();
    assert.equal(result.event, 'upload-only-complete');
    assert.equal(result.requestedVersion, '2.0.2');
    assert.equal(result.reviewSubmitted, false);
    assert.equal(h.calls.filter(call => call.url.endsWith(':upload')).length, 1);
    assert.equal(h.calls.some(call => call.url.endsWith(':publish') || call.url.endsWith(':cancelSubmission')), false);
  }
});

test('upload-only enforces package/version guards and never overlaps other operations', async () => {
  for (const options of [{ submit: true }, { cancelReview: true }, { publishStaged: true }, { expectedTag: 'v2.0.3' },
    { env: { ...env, GITHUB_ACTIONS: 'true', CHROME_PUBLISH_ENABLED: 'false' } },
    { env: { ...env, GITHUB_ACTIONS: 'true', CHROME_PUBLISH_ENABLED: 'true' } }]) {
    const h = harness([], { submit: false, uploadOnly: true, ...options });
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 0);
  }
  for (const initial of [{ ...status(), warned: true }, { ...status(), takenDown: true },
    status({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '2.0.3') }),
    status({ lastAsyncUploadState: 'IN_PROGRESS' })]) {
    const h = harness([token(), initial], { submit: false, uploadOnly: true });
    await assert.rejects(h.run());
    assert.equal(h.calls.some(call => call.url.endsWith(':upload') || call.url.endsWith(':publish')), false);
  }
  const failed = harness([token(), status(), new Error('private-provider-data')], { submit: false, uploadOnly: true });
  await assert.rejects(failed.run(), error => !error.message.includes('private-provider-data'));
  assert.equal(failed.calls.filter(call => call.url.endsWith(':upload')).length, 1);
});

test('explicit review submission reuploads its validated package and cannot run automatically on release', async () => {
  const trusted = { ...env, GITHUB_ACTIONS: 'true', CHROME_PUBLISH_ENABLED: 'true', CHROME_RELEASE_TAG: 'v2.0.2',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'MertD95/watchparty' };
  for (const changes of [{ GITHUB_EVENT_NAME: 'release', GITHUB_REF: 'refs/tags/v2.0.2' },
    { GITHUB_REF: 'refs/heads/release/v2.0.2' }, { GITHUB_REPOSITORY: 'someone/watchparty' }]) {
    const h = harness([], { env: { ...trusted, ...changes } });
    await assert.rejects(h.run(), /explicit manual dispatch from trusted main/);
    assert.equal(h.calls.length, 0);
  }
  const h = harness([token(), status({ lastAsyncUploadState: 'SUCCEEDED' }), uploaded(), status(),
    { ...identity, state: 'PENDING_REVIEW' }, pending], { env: trusted });
  assert.equal((await h.run()).submissionState, 'PENDING_REVIEW');
  assert.equal(h.calls.filter(call => call.url.endsWith(':upload')).length, 1);
  assert.deepEqual(h.calls.find(call => call.url.endsWith(':upload')).body, archive());
  assert.equal(JSON.parse(h.calls.find(call => call.url.endsWith(':publish')).body).publishType, 'STAGED_PUBLISH');
  const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /STORE_MODE: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.mode \|\| 'upload' \}\}/);
  assert.match(workflow, /if \[ "\$\{STORE_MODE\}" = 'submit' \]; then\r?\n\s+test "\$\{GITHUB_EVENT_NAME\}" = 'workflow_dispatch'/);
  assert.equal((workflow.match(/--upload "\$\{PACKAGE_NAME\}"/g) || []).length, 2);
  assert.equal((workflow.match(/if: env\.STORE_MODE == 'submit' \|\| env\.STORE_MODE == 'upload'/g) || []).length, 2);
});

const stagedTwo = () => status({ submittedItemRevisionStatus: revision('STAGED', '2.0.2') });
const publishedTwo = () => status({ publishedItemRevisionStatus: revision('PUBLISHED', '2.0.2') });
const activateHarness = (responses, options = {}) => harness(responses, {
  submit: false, publishStaged: true, expectedStagedVersion: '2.0.2', zipBytes: undefined, ...options,
});

test('staged activation is exact-version, exclusive and package-free before authentication', async () => {
  for (const expectedStagedVersion of [undefined, '', 'v2.0.2', '02.0.2', '2.0.2\n', '65536', '1.2.3.4.5']) {
    const h = activateHarness([], { expectedStagedVersion });
    await assert.rejects(h.run(), /exact expected staged version/);
    assert.equal(h.calls.length, 0);
  }
  for (const options of [{ submit: true }, { cancelReview: true }, { zipBytes: archive() }]) {
    const h = activateHarness([], options);
    await assert.rejects(h.run(), /separate operations|must not receive/);
    assert.equal(h.calls.length, 0);
  }
});

test('staged activation rechecks approved exact version then publishes once and confirms without upload', async () => {
  const h = activateHarness([token(), stagedTwo(), stagedTwo(), { ...identity, state: 'PUBLISHED' }, publishedTwo()]);
  assert.equal((await h.run()).event, 'staged-publication-confirmed');
  const mutations = h.calls.filter(call => call.method === 'POST' && !call.url.includes('oauth2.googleapis.com'));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url, `https://chromewebstore.googleapis.com/v2/${identity.name}:publish`);
  assert.deepEqual(JSON.parse(mutations[0].body), { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true });
  assert.equal(h.calls.filter(call => call.url.endsWith(':fetchStatus')).length, 3);
  assert.ok(h.logs.some(line => JSON.parse(line).event === 'staged-publication-accepted'));
  for (const secret of [env.CHROME_CLIENT_ID, env.CHROME_CLIENT_SECRET, env.CHROME_REFRESH_TOKEN, 'private-access-token']) {
    assert.equal(h.logs.join('').includes(secret), false);
  }
});

test('staged activation refuses unapproved, missing, mismatched, ambiguous, unknown or policy-blocked state', async () => {
  const ambiguous = revision('STAGED', '2.0.2');
  ambiguous.distributionChannels.push({ crxVersion: '2.0.3' });
  const missingVersion = revision('STAGED', '2.0.2');
  missingVersion.distributionChannels.push({});
  for (const initial of [status(), pending,
    status({ submittedItemRevisionStatus: revision('REJECTED', '2.0.2') }),
    status({ submittedItemRevisionStatus: revision('STAGED', '2.0.3') }),
    status({ submittedItemRevisionStatus: revision('STAGED', '2.0.2.0') }),
    status({ submittedItemRevisionStatus: ambiguous }), status({ submittedItemRevisionStatus: missingVersion }),
    { ...stagedTwo(), warned: true }, { ...stagedTwo(), takenDown: true },
    { ...stagedTwo(), lastAsyncUploadState: 'UPLOAD_IN_PROGRESS' },
    { ...stagedTwo(), publishedItemRevisionStatus: revision('PUBLISHED', '2.0.3') },
    { ...stagedTwo(), publishedItemRevisionStatus: revision('FUTURE_STATE', '2.0.1') },
    { ...stagedTwo(), publishedItemRevisionStatus: { state: 'PUBLISHED' } },
    { ...stagedTwo(), publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '2.0.1' }, {}] } },
  ]) {
    const h = activateHarness([token(), initial]);
    await assert.rejects(h.run(), /no staged publication was performed/);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls.some(call => call.url.endsWith(':publish')), false);
  }
});

test('already published exact staged target is idempotent at initial or immediate preflight status', async () => {
  for (const responses of [[token(), publishedTwo()], [token(), stagedTwo(), publishedTwo()]]) {
    const h = activateHarness(responses);
    assert.equal((await h.run()).event, 'already-published-no-changes');
    assert.equal(h.calls.some(call => call.url.endsWith(':publish')), false);
  }
  for (const changed of [pending, status({ submittedItemRevisionStatus: revision('STAGED', '2.0.3') }), { ...stagedTwo(), warned: true }]) {
    const h = activateHarness([token(), stagedTwo(), changed]);
    await assert.rejects(h.run(), /no staged publication was performed/);
    assert.equal(h.calls.some(call => call.url.endsWith(':publish')), false);
  }
});

test('staged activation polls only status after acceptance and never retries ambiguous publication', async () => {
  const h = activateHarness([token(), stagedTwo(), stagedTwo(), { ...identity, state: 'PUBLISHED' }, stagedTwo(), publishedTwo()], { maxPolls: 1 });
  assert.equal((await h.run()).event, 'staged-publication-confirmed');
  assert.equal(h.calls.filter(call => call.url.endsWith(':publish')).length, 1);
  for (const failure of [new Error('private-provider-data'), { httpError: 409, details: 'private-provider-data' },
    { ...identity, state: 'PENDING_REVIEW' }, { ...identity, itemId: 'wrong-item', state: 'PUBLISHED' }]) {
    const failed = activateHarness([token(), stagedTwo(), stagedTwo(), failure]);
    await assert.rejects(failed.run(), error => !error.message.includes('private-provider-data'));
    assert.equal(failed.calls.filter(call => call.url.endsWith(':publish')).length, 1);
  }
  for (const followup of [new Error('private-provider-data'), stagedTwo(), { ...publishedTwo(), warned: true },
    status({ publishedItemRevisionStatus: revision('PUBLISHED', '2.0.3') })]) {
    const failed = activateHarness([token(), stagedTwo(), stagedTwo(), { ...identity, state: 'PUBLISHED' }, followup], { maxPolls: 0 });
    await assert.rejects(failed.run());
    assert.equal(failed.calls.filter(call => call.url.endsWith(':publish')).length, 1);
    assert.ok(failed.logs.some(line => JSON.parse(line).event === 'staged-publication-accepted'));
  }
});

test('CI staged publication requires enabled trusted manual main and never automatically activates a submission', async () => {
  const trusted = { ...env, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'MertD95/watchparty', CHROME_PUBLISH_ENABLED: 'true' };
  for (const changes of [{ GITHUB_EVENT_NAME: 'release' }, { GITHUB_REF: 'refs/tags/v2.0.2' },
    { GITHUB_REPOSITORY: 'someone/watchparty' }, { CHROME_PUBLISH_ENABLED: 'false' }]) {
    const h = activateHarness([], { env: { ...trusted, ...changes } });
    await assert.rejects(h.run(), /enabled manual dispatch/);
    assert.equal(h.calls.length, 0);
  }
  const h = activateHarness([stagedTwo(), stagedTwo(), { ...identity, state: 'PUBLISHED' }, publishedTwo()], {
    env: { ...trusted, CHROME_ACCESS_TOKEN: 'private-short-lived-token' },
  });
  assert.equal((await h.run()).event, 'staged-publication-confirmed');
  assert.equal(h.calls.some(call => call.url.includes('oauth2.googleapis.com')), false);
  for (const submit of [true, false]) {
    const passive = harness([token(), stagedTwo()], { submit, expectedStagedVersion: '2.0.2' });
    assert.match((await passive.run()).event, /already-submitted-no-changes|status-only-no-changes/);
    assert.equal(passive.calls.some(call => call.url.endsWith(':publish')), false);
  }
  const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const packageJob = workflow.slice(workflow.indexOf('  package:'), workflow.indexOf('  chrome-store:'));
  assert.doesNotMatch(packageJob, /publish-staged/);
  assert.match(workflow, /CHROME_EXPECTED_STAGED_VERSION: \$\{\{ inputs\.expected_version \}\}/);
  assert.match(workflow, /if \[ "\$\{STORE_MODE\}" = 'publish-staged' \]; then\r?\n\s+test "\$\{GITHUB_EVENT_NAME\}" = 'workflow_dispatch'/);
  assert.equal((workflow.match(/--publish-staged "\$\{CHROME_EXPECTED_STAGED_VERSION\}"/g) || []).length, 2);
});
