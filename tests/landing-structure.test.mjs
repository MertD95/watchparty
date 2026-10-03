import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const landingRoot = path.join(root, 'landing');
const html = fs.readFileSync(path.join(landingRoot, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(landingRoot, 'landing.js'), 'utf8');

// These are deliberately structural checks, not a substitute for native-browser
// layout, focus, dialog, or extension-handoff tests. Avoid pinning UI copy here.
function openingTags(source) {
  return [...source.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)].map(match => {
    const attributes = new Map();
    for (const attribute of match[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    return { tag: match[1].toLowerCase(), attributes };
  });
}

const tags = openingTags(html);
const elementsById = new Map(tags.filter(tag => tag.attributes.has('id')).map(tag => [tag.attributes.get('id'), tag]));

test('landing assets are external root-relative files that also work under room invite routes', () => {
  const scripts = tags.filter(tag => tag.tag === 'script');
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].attributes.get('src'), '/landing.js');
  const styles = tags.filter(tag => tag.tag === 'link' && tag.attributes.get('rel') === 'stylesheet');
  assert.equal(styles.length, 1);
  assert.equal(styles[0].attributes.get('href'), '/styles.css');
  for (const asset of ['/landing.js', '/styles.css', '/favicon.svg']) {
    assert.ok(fs.statSync(path.join(landingRoot, asset.slice(1))).isFile(), asset);
    assert.equal(new URL(asset, 'https://watchparty.mertd.me/r/invite-room').pathname, asset);
  }
  assert.doesNotMatch(html, /<style\b|<script\b(?![^>]*\bsrc=)/i);
  assert.doesNotThrow(() => new Script(script, { filename: 'landing.js' }));
  assert.match(fs.readFileSync(path.join(landingRoot, '_redirects'), 'utf8'), /\/r\/:id\s+\/\s+200/);
});

test('landing has unique IDs and every static script control exists', () => {
  const ids = tags.filter(tag => tag.attributes.has('id')).map(tag => tag.attributes.get('id'));
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML id');
  const referencedIds = new Set([...script.matchAll(/document\.getElementById\(['"]([^'"]+)['"]\)/g)].map(match => match[1]));
  for (const id of referencedIds) assert.ok(elementsById.has(id), `missing landing control #${id}`);
});

test('form controls have explicit accessible labels and valid descriptive references', () => {
  const labelledControls = new Set(tags.filter(tag => tag.tag === 'label').map(tag => tag.attributes.get('for')));
  for (const element of tags) {
    const attributes = element.attributes;
    for (const referenceName of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      for (const id of (attributes.get(referenceName) || '').split(/\s+/).filter(Boolean)) {
        assert.ok(elementsById.has(id), `${referenceName} refers to missing #${id}`);
      }
    }
    if (!['input', 'textarea', 'select'].includes(element.tag) || attributes.get('type') === 'hidden') continue;
    assert.ok(
      labelledControls.has(attributes.get('id')) || attributes.get('aria-label') || attributes.get('aria-labelledby'),
      `${element.tag} #${attributes.get('id')} needs an accessible label, not only a placeholder`,
    );
  }
});

test('invite dialog is named and validation and connection updates are announced', () => {
  const dialog = elementsById.get('uuid-modal').attributes;
  assert.equal(dialog.get('role'), 'dialog');
  assert.equal(dialog.get('aria-modal'), 'true');
  assert.equal(dialog.get('aria-labelledby'), 'uuid-title');
  assert.equal(dialog.get('aria-describedby'), 'uuid-description');
  assert.equal(elementsById.get('uuid-error').attributes.get('role'), 'alert');
  for (const id of ['rooms-status', 'redirect-status']) {
    assert.equal(elementsById.get(id).attributes.get('role'), 'status', id);
  }
});

test('navigation targets are real, external tabs are isolated, and privacy remains reachable', () => {
  const anchors = tags.filter(tag => tag.tag === 'a');
  for (const { attributes } of anchors) {
    const href = attributes.get('href');
    assert.ok(href && href !== '#', 'links must not silently point nowhere');
    assert.doesNotMatch(href, /^(?:javascript|data):/i);
    if (href.startsWith('#')) assert.ok(elementsById.has(href.slice(1)), `missing anchor ${href}`);
    if (attributes.get('target') === '_blank') {
      assert.ok((attributes.get('rel') || '').split(/\s+/).includes('noopener'), href);
    }
  }
  assert.ok(anchors.some(tag => tag.attributes.get('href') === '/privacy.html'));
  assert.ok(fs.statSync(path.join(landingRoot, 'privacy.html')).isFile());
  assert.match(elementsById.get('install-link').attributes.get('href'), /^https:\/\/chromewebstore\.google\.com\/detail\//);
});

test('landing keeps advanced help optional and does not import the sample-data playground', () => {
  const help = elementsById.get('site-tools');
  assert.equal(help.tag, 'details');
  assert.equal(help.attributes.has('open'), false);
  assert.doesNotMatch(html, /\/preview\/|preview\/bridge\.js|data-watchparty-ext\s*=/i);
  assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1"/);
  for (const { attributes } of tags) {
    for (const attribute of attributes.keys()) assert.doesNotMatch(attribute, /^on[a-z]+$/i, 'no inline event handlers');
  }
});

test('each route has a skip link within its visible surface and a focusable target', () => {
  assert.match(html, /<div id="page-landing">\s*<a class="skip-link" href="#main-content"/);
  assert.match(html, /<main id="page-redirect"[^>]*>\s*<a class="skip-link" href="#redirect-title"/);
  for (const id of ['main-content', 'redirect-title']) {
    assert.equal(elementsById.get(id).attributes.get('tabindex'), '-1');
  }
});

test('action feedback is announced separately from room-list health and stale profile hints', () => {
  for (const id of ['website-action-status', 'rooms-action-status', 'rooms-status']) {
    const attributes = elementsById.get(id).attributes;
    assert.equal(attributes.get('role'), 'status', id);
    assert.equal(attributes.get('aria-live'), 'polite', id);
  }
});

test('privacy has a local return link, keyboard focus styling and current GIF data-sharing disclosure', () => {
  const privacy = fs.readFileSync(path.join(landingRoot, 'privacy.html'), 'utf8');
  const links = openingTags(privacy).filter(tag => tag.tag === 'a');
  assert.ok(links.some(link => link.attributes.get('href') === '/'));
  assert.match(privacy, /a:focus-visible/);
  assert.match(privacy, /Last updated: 2026-10-03/);
  assert.match(privacy, /Shared GIF images load from the image host/);
  assert.doesNotMatch(privacy, /GIF search requests are sent/);
  for (const link of links) assert.doesNotMatch(link.attributes.get('href'), /^(?:javascript|data):/i);
});
