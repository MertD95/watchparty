import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from '../tools/serve-ui-preview.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = createPreviewServer();
let port;

before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

// Use raw request paths so URL normalization cannot hide traversal attempts.
function request(requestPath, { method = 'GET', host = `localhost:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method, headers: { Host: host } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('UI preview serves a local-only hub with restrictive response headers', async () => {
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/html/);
  assert.match(response.body.toString(), /WatchParty/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.match(response.headers['content-security-policy'], /object-src 'none'/);
});

test('UI preview injects its bridge before native scripts without changing release HTML', async () => {
  for (const filename of ['options.html', 'popup.html', 'sidepanel.html']) {
    const file = path.join(root, 'extension', filename);
    const original = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(original, /\/preview\/bridge\.js/);
    const response = await request(`/extension/${filename}?sample=active`);
    assert.equal(response.status, 200, filename);
    const html = response.body.toString();
    assert.equal(html, original.replace('<head>', '<head>\n  <script src="/preview/bridge.js"></script>'));
    assert.equal([...html.matchAll(/\/preview\/bridge\.js/g)].length, 1);
    assert.equal(html.indexOf('<script'), html.indexOf('<script src="/preview/bridge.js">'));
    assert.equal(await fs.readFile(file, 'utf8'), original);
  }
});

test('UI preview serves native scripts byte-for-byte and preview-only assets separately', async () => {
  for (const [url, file] of [
    ['/extension/options.js', 'extension/options.js'],
    ['/extension/manifest.json', 'extension/manifest.json'],
    ['/preview/preview.css', 'tools/ui-preview/preview.css'],
    ['/preview/preview.js', 'tools/ui-preview/preview.js'],
  ]) {
    const response = await request(url);
    assert.equal(response.status, 200, url);
    assert.deepEqual(response.body, await fs.readFile(path.join(root, file)), url);
  }
});

test('UI preview keeps native page aliases functional after safe path normalization', async () => {
  for (const url of [
    '/extension/./options.html',
    '/extension/unused/../options.html',
    '/extension/%2e/popup.html',
    '/extension/unused/%2e%2e/sidepanel.html',
  ]) {
    const response = await request(url);
    assert.equal(response.status, 200, url);
    assert.equal([...response.body.toString().matchAll(/\/preview\/bridge\.js/g)].length, 1, url);
  }
});

test('UI preview HEAD reports the transformed content length without returning a body', async () => {
  const get = await request('/extension/options.html');
  const head = await request('/extension/options.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), get.body.length);
  assert.equal(head.headers['content-type'], get.headers['content-type']);
});

test('UI preview rejects untrusted Host names and accepts only literal local names', async () => {
  for (const host of ['attacker.example', 'localhost.attacker.example', '127.0.0.1.attacker.example', '0.0.0.0', 'localhost@attacker.example', 'localhost.']) {
    assert.equal((await request('/', { host })).status, 403, host);
  }
  for (const host of ['localhost', 'LOCALHOST', `127.0.0.1:${port}`]) {
    assert.equal((await request('/', { host })).status, 200, host);
  }
});

test('UI preview rejects every state-changing request method', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal((await request('/extension/options.html', { method })).status, 405, method);
  }
});

test('UI preview confines raw and encoded traversal to the two public asset roots', async () => {
  for (const url of [
    '/extension/../package.json',
    '/extension/%2e%2e/package.json',
    '/extension/%2e%2e%2fpackage.json',
    '/preview/../../package.json',
    '/preview/%2e%2e/%2e%2e/package.json',
    '/extension/../tools/ui-preview/index.html',
    '/extension/%5c..%5cpackage.json',
    '/extension/options.html%00.js',
    '/extension//etc/passwd.json',
    '/extension/C:/Windows/win.ini',
  ]) {
    assert.equal((await request(url)).status, 403, url);
  }
});

test('UI preview rejects malformed escapes, unsupported file types, and unknown routes', async () => {
  assert.equal((await request('/extension/%zz.js')).status, 400);
  assert.equal((await request('/extension/%E0%A4%A.html')).status, 400);
  assert.equal((await request('/extension/secrets.env')).status, 403);
  assert.equal((await request('/package.json')).status, 404);
  assert.equal((await request('/extension/missing.js')).status, 404);
  const head = await request('/extension/../package.json', { method: 'HEAD' });
  assert.equal(head.status, 403);
  assert.equal(head.body.length, 0);
});
