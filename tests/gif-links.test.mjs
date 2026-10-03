import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ URL, fetch() { throw new Error('GIF validation must never make requests'); } });
const source = fs.readFileSync(new URL('../extension/gif-links.js', import.meta.url), 'utf8');
vm.runInContext(source, context);
const parse = vm.runInContext('WPGifLinks.parse', context);

test('GIF links accept direct HTTPS image links and normalize them without a network request', () => {
  assert.equal(parse(' HTTPS://Example.COM/image.GIF?v=1 ').url, 'https://example.com/image.GIF?v=1');
  assert.equal(parse('').url, '');
  assert.equal(parse('').error, '');
  assert.equal(parse(null).error, '');
});

test('GIF links reject unsafe schemes, credentials, webpages, malformed URLs and chat delimiters', () => {
  for (const value of ['http://example.com/image.gif', 'javascript:alert(1)', 'data:image/gif;base64,AAAA',
    'https:example.com/image.gif', 'https://user:secret@example.com/image.gif', 'https://example.com/watch',
    'https://example.com/image.png', 'https://example.com/image.gif]hello', 'https://example.com/a b.gif',
    'https://example.com/a\\image.gif', 'https://', 'https://example.com/a.gif?value=[hello]']) {
    assert.equal(parse(value).url, '', value);
    assert.ok(parse(value).error, value);
  }
});

test('GIF link length includes URL normalization and the chat envelope', () => {
  const allowed = `https://example.com/${'a'.repeat(270)}.gif`;
  assert.equal(allowed.length, 294);
  assert.equal(`[gif:${parse(allowed).url}]`.length, 300);
  assert.equal(parse(`${allowed}?`).url, '');
  assert.match(parse(`${allowed}?`).error, /too long/);
  assert.equal(parse(`https://example.com/${'é'.repeat(50)}.gif`).url, '');
});

test('production and preview load the local GIF validator instead of retired search credentials', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf('gif-links.js') >= 0);
  assert.ok(scripts.indexOf('gif-links.js') < scripts.indexOf('stremio-overlay.js'));
  assert.equal(scripts.includes('gif-provider.js'), false);
  assert.equal(fs.existsSync(new URL('../extension/gif-provider.js', import.meta.url)), false);
  assert.doesNotMatch(source, /apiKey|fetch\(/);
  const preview = fs.readFileSync(new URL('../tools/ui-preview/overlay.html', import.meta.url), 'utf8');
  assert.match(preview, /src="\/extension\/gif-links\.js"/);
});
