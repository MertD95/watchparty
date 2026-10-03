import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rules = JSON.parse(fs.readFileSync(new URL('../extension/rules.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const supportedDomains = ['web.stremio.com', 'web.strem.io', 'app.strem.io'];

// A deliberately small evaluator for the exact condition fields in this file.
// Native Chromium testMatchOutcome verifies the packaged browser semantics too.
function matches(rule, { url, initiator, method = 'get', type = 'xmlhttprequest' }) {
  const condition = rule.condition;
  assert.deepEqual(Object.keys(condition).sort(), ['initiatorDomains', 'requestMethods', 'resourceTypes', 'urlFilter']);
  assert.ok(condition.urlFilter.startsWith('|http://'));
  const domain = initiator ? new URL(initiator).hostname : '';
  return url.startsWith(condition.urlFilter.slice(1))
    && condition.initiatorDomains.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`))
    && condition.requestMethods.includes(method)
    && condition.resourceTypes.includes(type);
}

test('network rules use host-scoped header access and retain the Stremio local service', () => {
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
  assert.ok(!manifest.permissions.includes('declarativeNetRequest'));
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.map(rule => rule.id), [1, 2]);
  assert.ok(manifest.host_permissions.includes('http://localhost:11470/*'));
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1:11470/*'));
  for (const rule of rules) {
    assert.equal(rule.action.type, 'modifyHeaders');
    assert.deepEqual(rule.condition.initiatorDomains, supportedDomains);
    assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest', 'other', 'media']);
  }
});

test('header modification has explicit access to its exact supported page initiators', () => {
  // Content-script matches appear in chrome.permissions but do not grant the
  // explicit initiator host access required to modify these response headers.
  for (const domain of supportedDomains) {
    assert.ok(manifest.host_permissions.includes(`https://${domain}/*`), domain);
  }
  const remoteHostPermissions = manifest.host_permissions.filter(origin => origin.startsWith('https://'));
  assert.deepEqual(remoteHostPermissions.slice().sort(), supportedDomains.map(domain => `https://${domain}/*`).sort());
});

test('supported Stremio pages can reach only the exact HTTP local playback service', () => {
  for (const domain of supportedDomains) {
    for (const hostname of ['localhost', '127.0.0.1']) {
      for (const method of ['get', 'post', 'options', 'head']) {
        for (const type of ['xmlhttprequest', 'media', 'other']) {
          assert.equal(rules.filter(rule => matches(rule, {
            url: `http://${hostname}:11470/settings`, initiator: `https://${domain}/`, method, type,
          })).length, 1);
        }
      }
    }
  }
});

test('network rules never alter other loopback ports, remote hosts, schemes or deceptive URLs', () => {
  for (const url of [
    'http://localhost:8181/manual/reset', 'http://127.0.0.1:8181/manual/reset',
    'http://localhost:8090/', 'http://localhost:8080/', 'http://localhost:5111/reload',
    'http://localhost/', 'http://localhost:114700/', 'http://localhost:1147/',
    'https://localhost:11470/', 'http://localhost.evil.example:11470/',
    'http://a.localhost:11470/', 'http://127.0.0.2:11470/',
    'https://example.com/?target=http://localhost:11470/',
    'http://localhost:11470@evil.example/', 'http://192.168.1.1:11470/',
  ]) {
    assert.equal(rules.some(rule => matches(rule, { url, initiator: 'https://web.stremio.com/' })), false, url);
  }
});

test('network rules do not weaken CORS for arbitrary websites or extension-worker requests', () => {
  for (const initiator of [undefined, 'https://example.com/', 'https://watchparty.mertd.me/',
    'http://localhost:8090/', 'https://web.stremio.com.evil.example/',
    'chrome-extension://kfkdlmmjcnndgjkbbckhcafglbmndobk/']) {
    assert.equal(rules.some(rule => matches(rule, { url: 'http://localhost:11470/settings', initiator })), false);
  }
});

test('network rules leave documents, scripts, sockets and unrelated HTTP methods alone', () => {
  for (const type of ['main_frame', 'sub_frame', 'script', 'websocket', 'image']) {
    assert.equal(rules.some(rule => matches(rule, { url: 'http://localhost:11470/', initiator: 'https://web.stremio.com/', type })), false);
  }
  for (const method of ['delete', 'put', 'patch']) {
    assert.equal(rules.some(rule => matches(rule, { url: 'http://localhost:11470/', initiator: 'https://web.stremio.com/', method })), false);
  }
});
