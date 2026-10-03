import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createLandingServer } from '../tools/serve-landing.mjs';

const server = createLandingServer();
let port;
before(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
function request(url, { method = 'GET', serverPort = port, host = `localhost:${serverPort}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: serverPort, path: url, method, headers: { Host: host } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
test('landing serves home, privacy and room redirects with uncached safe response headers', async () => {
  for (const url of ['/', '/index.html', '/privacy.html', '/r/audit-room', '/r/audit-room/?source=test']) {
    const res = await request(url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.match(res.body.toString(), /WatchParty/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  }
});
test('landing serves scripts, styles and local extension assets with proper MIME types', async () => {
  for (const [url, mime] of [['/landing.js', 'application/javascript'], ['/styles.css', 'text/css'], ['/__extension/manifest.json', 'application/json']]) {
    const res = await request(url);
    assert.equal(res.status, 200, url);
    assert.ok(res.headers['content-type'].startsWith(mime), url);
  }
});
test('landing HEAD returns exact GET content length without a body', async () => {
  for (const url of ['/', '/landing.js', '/r/audit-room']) {
    const get = await request(url);
    const head = await request(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers['content-length']), get.body.length);
  }
});
test('landing rejects state-changing methods', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const res = await request('/', { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'GET, HEAD');
  }
});
test('landing blocks untrusted Host and DNS rebinding names', async () => {
  for (const host of ['attacker.example', 'localhost.attacker.example', 'localhost@attacker.example', '0.0.0.0', 'localhost.']) {
    assert.equal((await request('/', { host })).status, 403, host);
  }
  assert.equal((await request('/', { host: `127.0.0.1:${port}` })).status, 200);
});
test('landing rejects raw, encoded, Windows and sibling-prefix traversal', async () => {
  for (const url of ['/../package.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/__extension/../package.json', '/__manual-fixtures/../../package.json', '/__extension/../extension-secret/test.json', '/..%5cpackage.json', '/landing.js%00.json', '//C:/Windows/win.ini']) {
    assert.equal((await request(url)).status, 403, url);
  }
});
test('landing reports malformed URLs and missing resources instead of successful HTML', async () => {
  for (const url of ['/%zz.js', '/%E0%A4%A.html']) assert.equal((await request(url)).status, 400, url);
  for (const url of ['/missing.js', '/missing.css', '/not-a-route', '/r/', '/r/room/extra', '/secret.env', '/__extension/missing.js']) assert.equal((await request(url)).status, 404, url);
});

test('landing serves manual fixtures and room links without letting query parameters select files', async () => {
  for (const [url, mime] of [
    ['/__manual-fixtures/media-sync.html', 'text/html'],
    ['/__manual-fixtures/direct-play-fixtures.html', 'text/html'],
    ['/__manual-fixtures/direct-play-cases.js', 'application/javascript'],
    ['/__extension/popup.html', 'text/html'],
    ['/__extension/icons/icon128.png', 'image/png'],
    ['/favicon.svg', 'image/svg+xml'],
    ['/r/12345678-1234-4123-8123-123456789abc?key=synthetic-key&next=../../package.json', 'text/html'],
    ['/landing.js?file=../../package.json', 'application/javascript'],
  ]) {
    const response = await request(url);
    assert.equal(response.status, 200, url);
    assert.ok(response.headers['content-type'].startsWith(mime), url);
  }
});

test('landing HEAD preserves error status and safe headers without returning error bodies', async () => {
  for (const [url, status, options] of [
    ['/missing.js', 404], ['/%zz.js', 400], ['/../package.json', 403],
    ['/', 403, { host: 'attacker.invalid' }], ['/__extension/', 403],
  ]) {
    const response = await request(url, { method: 'HEAD', ...options });
    assert.equal(response.status, status, url);
    assert.equal(response.body.length, 0, url);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
});

async function isolatedAssets(t, { linkedRoots = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'watchparty-landing-test-'));
  let fixtureServer;
  t.after(async () => {
    if (fixtureServer) {
      fixtureServer.closeAllConnections();
      await new Promise(resolve => fixtureServer.close(resolve));
    }
    // Delete only this test-owned temporary directory, never an injected root.
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('watchparty-landing-test-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const roots = { landingRoot: path.join(temporary, 'landing'), fixturesRoot: path.join(temporary, 'fixtures'), extensionRoot: path.join(temporary, 'extension') };
  const outside = path.join(temporary, 'landing-private');
  for (const directory of [...Object.values(roots), outside]) await fs.mkdir(directory);
  for (const directory of Object.values(roots)) {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Synthetic asset</title>');
    await fs.writeFile(path.join(directory, 'fixture.json'), '{"synthetic":true}');
    await fs.mkdir(path.join(directory, 'folder.js'));
  }
  await fs.writeFile(path.join(outside, 'synthetic.json'), '{"marker":"synthetic-outside-root-content"}');
  const symlinkDirectory = (target, alias) => fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const configured = { ...roots };
  if (linkedRoots) {
    for (const [name, directory] of Object.entries(roots)) {
      configured[name] = directory + '-alias';
      await symlinkDirectory(directory, configured[name]);
    }
  }
  fixtureServer = createLandingServer(configured);
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  return { roots, outside, symlinkDirectory,
    request: (url, options = {}) => request(url, { serverPort: fixtureServer.address().port, ...options }) };
}

test('landing denies real outside-root directory symlinks in each asset mount, including sibling-prefix targets', async t => {
  const assets = await isolatedAssets(t);
  for (const [name, prefix] of [['landingRoot', ''], ['fixturesRoot', '/__manual-fixtures'], ['extensionRoot', '/__extension']]) {
    await assets.symlinkDirectory(assets.outside, path.join(assets.roots[name], 'escape'));
    for (const method of ['GET', 'HEAD']) {
      const response = await assets.request(prefix + '/escape/synthetic.json', { method });
      assert.equal(response.status, 403, name + ' ' + method);
      assert.equal(response.body.toString().includes('synthetic-outside-root-content'), false);
    }
  }
});

test('landing supports canonicalized junction asset roots while still preventing symlink escape', async t => {
  const assets = await isolatedAssets(t, { linkedRoots: true });
  for (const [name, prefix] of [['landingRoot', ''], ['fixturesRoot', '/__manual-fixtures'], ['extensionRoot', '/__extension']]) {
    const get = await assets.request(prefix + '/fixture.json');
    assert.equal(get.status, 200, name);
    assert.deepEqual(JSON.parse(get.body.toString()), { synthetic: true });
    const head = await assets.request(prefix + '/fixture.json', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers['content-length']), get.body.length);
    await assets.symlinkDirectory(assets.outside, path.join(assets.roots[name], 'escape'));
    assert.equal((await assets.request(prefix + '/escape/synthetic.json')).status, 403);
  }
  assert.equal((await assets.request('/')).status, 200);
  assert.equal((await assets.request('/r/fixture-room')).status, 200);
});

test('landing does not serve directories as MIME-looking files and permits links contained in the asset root', async t => {
  const assets = await isolatedAssets(t);
  await fs.mkdir(path.join(assets.roots.landingRoot, 'inner'));
  await fs.writeFile(path.join(assets.roots.landingRoot, 'inner', 'safe.json'), '{"contained":true}');
  await assets.symlinkDirectory(path.join(assets.roots.landingRoot, 'inner'), path.join(assets.roots.landingRoot, 'alias'));
  assert.equal((await assets.request('/alias/safe.json')).status, 200);
  for (const url of ['/inner/', '/folder.js', '/__manual-fixtures/folder.js', '/__extension/folder.js', '/%252e%252e/package.json']) {
    const response = await assets.request(url);
    assert.equal(response.status, 404, url);
    assert.equal(response.body.toString().includes('Synthetic asset'), false);
  }
});
