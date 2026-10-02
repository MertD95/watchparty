import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function launcher() {
  const nodes = new Map();
  const sent = [];
  const messageListeners = new Set();
  let initialStatus;
  let document;
  class Element {
    constructor(attributes = '') {
      this.attributes = new Map([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
      this.id = this.attributes.get('id');
      this.classes = new Set((this.attributes.get('class') || '').split(/\s+/).filter(Boolean));
      this.classList = {
        add: name => this.classes.add(name), remove: name => this.classes.delete(name),
        contains: name => this.classes.has(name),
        toggle: (name, force) => {
          if (force ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name);
        },
      };
      this.dataset = { mode: this.attributes.get('data-mode') };
      this.listeners = new Map();
      this.textContent = ''; this.value = ''; this.checked = /\bchecked\b/.test(attributes);
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    focus() { document.activeElement = this; }
    click() { this.listeners.get('click')?.({ target: this }); }
  }
  for (const match of html.matchAll(/<[^>]*\bid="[^"]+"[^>]*>/g)) {
    const node = new Element(match[0]); nodes.set(node.id, node);
  }
  document = {
    body: { dataset: {} }, activeElement: null,
    getElementById: id => nodes.get(id) || null,
    querySelectorAll: () => ['backend-auto', 'backend-local', 'backend-live'].map(id => nodes.get(id)),
    addEventListener() {},
  };
  const context = vm.createContext({
    document, console, URL, URLSearchParams,
    setTimeout: () => 1, clearTimeout() {},
    WPRuntimeState: { get: async () => ({}), set: async () => {} },
    WPRoomKeys: { appendToInviteUrl: async (_id, url) => url },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '2.0.2', update_url: 'https://clients2.google.com/service/update2/crx' }),
        sendMessage(message, callback) {
          sent.push(message);
          if (message.action === 'status.get') initialStatus = callback;
          else callback?.({ ok: true });
        },
        onMessage: { addListener: fn => messageListeners.add(fn), removeListener: fn => messageListeners.delete(fn) },
      },
      storage: { onChanged: { addListener() {}, removeListener() {} } },
      tabs: { create: tab => sent.push(tab) },
    },
  });
  for (const file of ['wp-actions.js', 'constants.js', 'utils.js', 'popup.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'), context, { filename: file });
  }
  return {
    nodes, sent, document,
    status: status => initialStatus({ hasStremioTab: true, wsConnected: true, ...status }),
    update: payload => {
      for (const listener of messageListeners) listener({ type: 'watchparty-ext', action: 'status.updated', payload });
    },
  };
}

test('launcher has one primary action and advanced/setup disclosures are closed by default', () => {
  assert.equal([...html.matchAll(/class="[^"]*\bbtn-primary\b[^\"]*"/g)].length, 1);
  for (const id of ['setup-card', 'connection-card']) {
    const tag = html.match(new RegExp(`<details[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag); assert.doesNotMatch(tag, /\bopen(?:\s|=|>)/);
  }
  assert.match(html, /<button[^>]*id="room-id-display"/);
});

test('empty launcher routes its primary button to Stremio and hides room-only actions', async () => {
  const ui = launcher(); ui.status({ room: null }); await flush();
  assert.equal(ui.nodes.get('btn-resume-room').textContent, 'Open Stremio');
  assert.equal(ui.nodes.get('room-actions').classList.contains('hidden'), true);
  assert.equal(ui.nodes.get('setup-card').classList.contains('hidden'), false);
  assert.equal(ui.nodes.get('stremio-status').textContent, 'Stremio open');
  assert.equal(ui.nodes.get('backend-local').hidden, true, 'installed users cannot select a local server');
  ui.nodes.get('btn-resume-room').click();
  assert.equal(ui.sent.at(-1).action, 'app.stremio.open');
});

test('active room has a return action and truthful guest label, without setup clutter', async () => {
  const ui = launcher();
  ui.status({ room: { id: 'movie-night', owner: 'host', meta: { name: 'A film' }, public: false, users: [] }, userId: 'guest' });
  await flush();
  assert.equal(ui.nodes.get('btn-resume-room').textContent, 'Return to room in Stremio');
  assert.equal(ui.nodes.get('room-role-badge').textContent, 'Guest');
  assert.equal(ui.nodes.get('room-privacy-badge').textContent, 'Invite only');
  assert.equal(ui.nodes.get('room-actions').classList.contains('hidden'), false);
  assert.equal(ui.nodes.get('setup-card').classList.contains('hidden'), true);
  ui.nodes.get('btn-resume-room').click(); assert.equal(ui.sent.at(-1).action, 'room.resume');
  ui.update({ wsConnected: false });
  assert.equal(ui.nodes.get('ws-status').textContent, 'Reconnecting…');
});

test('a delayed identity lookup cannot resurrect a room after leaving it', async () => {
  const ui = launcher(); ui.status({ room: null }); await flush();
  ui.update({ room: { id: 'old-room', users: [] } });
  ui.nodes.get('btn-leave').click();
  await flush();
  assert.equal(ui.nodes.get('view-room').classList.contains('hidden'), true);
  assert.equal(ui.nodes.get('room-actions').classList.contains('hidden'), true);
  assert.equal(ui.nodes.get('btn-resume-room').textContent, 'Open Stremio');
});

test('popup room tabs support arrow keys and keep a single tab stop', () => {
  const ui = launcher();
  const create = ui.nodes.get('lobby-tab-create');
  const join = ui.nodes.get('lobby-tab-join');
  let prevented = false;
  create.listeners.get('keydown')({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(ui.document.activeElement, join);
  assert.equal(create.tabIndex, -1); assert.equal(join.tabIndex, 0);
  assert.equal(join.getAttribute('aria-selected'), 'true');
  assert.equal(ui.nodes.get('create-panel').classList.contains('hidden'), true);
  join.listeners.get('keydown')({ key: 'Home', preventDefault() {} });
  assert.equal(ui.document.activeElement, create); assert.equal(create.tabIndex, 0);
});
