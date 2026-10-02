import test from 'node:test';
import assert from 'node:assert/strict';
import { runPublisher, compareVersions } from '../tools/publish-chrome-web-store.mjs';
import { readStorePackage } from '../tools/validate-store-package.mjs';

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
    return { ok: !response.httpError, status: response.httpError || 200, json: async () => response };
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
  assert.deepEqual(JSON.parse(h.calls[4].body), { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true });
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
