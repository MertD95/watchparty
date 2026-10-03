import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// Structural accessibility guardrails; responsive geometry and focus are also
// checked in the isolated MCP browser, not inferred from these expressions.
test('help disclosures form one native accordion and remain closed by default', () => {
  const details = [...read('extension/options.html').matchAll(/<details\b([^>]*)>/g)];
  assert.equal(details.length, 3);
  for (const [, attributes] of details) {
    assert.match(attributes, /name="settings-help"/);
    assert.doesNotMatch(attributes, /\bopen\b/);
  }
});

test('popup width can shrink with its viewport instead of clipping controls', () => {
  assert.match(read('extension/popup.html'), /width:\s*min\(360px,\s*100vw\)/);
});

test('companion has a main landmark, large chat targets and reduced-motion support', () => {
  const html = read('extension/sidepanel.html');
  assert.equal([...html.matchAll(/<main\b/g)].length, 1);
  assert.equal([...html.matchAll(/<\/main>/g)].length, 1);
  for (const control of ['chat-input', 'chat-send']) {
    assert.match(html, new RegExp(`\\.${control}\\s*\\{[^}]*min-height:\\s*44px`));
  }
  assert.match(html, /prefers-reduced-motion:\s*reduce/);
});

test('sidebar adapts to dynamic viewports and reduces motion only in its own surfaces', () => {
  const css = read('extension/stremio-overlay.css');
  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /max-height:\s*100dvh/);
  const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reducedMotion, /#wp-overlay \*/);
  assert.match(reducedMotion, /animation:\s*none !important/);
  assert.doesNotMatch(reducedMotion.split('/* --- Unread badge')[0], /(?:^|\n)\s*\*,/);
});

test('onboarding explains that friends need the extension and their own video source', () => {
  const html = read('landing/index.html');
  assert.match(html, /class="how-note"/);
  assert.match(html, /Everyone needs the extension and their own playable source/);
  assert.match(html, /doesn't provide video/);
});
