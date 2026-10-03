import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function launcher(options = {}) {
  const nodes = new Map();
  const sent = [];
  const messageListeners = new Set();
  const documentListeners = new Map();
  const copied = [];
  const responses = options.responses || {};
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
    click() {
      if (this.disabled) return;
      const event = { target: this };
      this.listeners.get('click')?.(event);
      documentListeners.get('click')?.(event);
    }
  }
  for (const match of html.matchAll(/<[^>]*\bid="[^"]+"[^>]*>/g)) {
    const node = new Element(match[0]); nodes.set(node.id, node);
  }
  document = {
    body: { dataset: {} }, activeElement: null,
    getElementById: id => nodes.get(id) || null,
    querySelectorAll: () => ['backend-auto', 'backend-local', 'backend-live'].map(id => nodes.get(id)),
    addEventListener: (name, callback) => documentListeners.set(name, callback),
  };
  const context = vm.createContext({
    document, console, URL, URLSearchParams,
    setTimeout: () => 1, clearTimeout() {},
    WPRuntimeState: { get: async () => ({}), set: async () => {} },
    WPRoomKeys: { appendToInviteUrl: options.appendKeys || (async (_id, url) => url) },
    __copyTextDeferred: async loader => {
      try {
        const value = await loader();
        if (options.copyResult === false) return false;
        copied.push(value);
        return true;
      } catch { return false; }
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '2.0.2', host_permissions: options.development ? ['http://localhost:8181/*'] : [], ...(!options.development && { update_url: 'https://clients2.google.com/service/update2/crx' }) }),
        sendMessage(message, callback) {
          sent.push(message);
          if (message.action === 'status.get') initialStatus = callback;
          else if (typeof responses[message.action] === 'function') responses[message.action](message, callback);
          else callback?.(Object.hasOwn(responses, message.action) ? responses[message.action] : { ok: true });
        },
        openOptionsPage: async () => { if (options.optionsError) throw new Error(options.optionsError); },
        onMessage: { addListener: fn => messageListeners.add(fn), removeListener: fn => messageListeners.delete(fn) },
      },
      storage: { onChanged: { addListener() {}, removeListener() {} } },
      tabs: { create: tab => sent.push(tab) },
    },
  });
  for (const file of ['wp-actions.js', 'constants.js', 'utils.js', 'popup.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'), context, { filename: file });
  }
  vm.runInContext('WPUtils.copyTextDeferred = __copyTextDeferred', context);
  return {
    nodes, sent, document, copied, responses,
    status: status => initialStatus({ hasStremioTab: true, wsConnected: true, ...status }),
    update: payload => {
      for (const listener of messageListeners) listener({ type: 'watchparty-ext', action: 'status.updated', payload });
    },
    error: payload => {
      for (const listener of messageListeners) listener({ type: 'watchparty-ext', action: 'room.error', payload });
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

test('installed popup hides redundant server selection while development keeps it available', () => {
  assert.equal(launcher().nodes.get('connection-card').hidden, true);
  assert.equal(launcher({ development: true }).nodes.get('connection-card').hidden, false);
});

test('leave rejection retains the room and reports failure with an explicit originating room ID', async () => {
  const ui = launcher({ responses: { 'room.leave': { ok: false, error: 'Reconnect and try again.' } } });
  ui.status({ room: { id: 'room-a', users: [] } }); await flush();
  ui.nodes.get('btn-leave').click();
  assert.equal(ui.sent.at(-1).roomId, 'room-a');
  assert.equal(ui.nodes.get('view-room').classList.contains('hidden'), false);
  assert.equal(ui.nodes.get('popup-error').textContent, 'Reconnect and try again.');
  assert.equal(ui.nodes.get('btn-leave').disabled, false);
});

test('late leave acknowledgement cannot hide a newer room', async () => {
  let reply;
  const ui = launcher({ responses: { 'room.leave': (_message, callback) => { reply = callback; } } });
  ui.status({ room: { id: 'room-a', users: [] } }); await flush();
  ui.nodes.get('btn-leave').click();
  assert.equal(ui.nodes.get('btn-leave').disabled, true);
  ui.update({ room: { id: 'room-b', users: [] } }); await flush();
  reply({ ok: true });
  assert.equal(ui.nodes.get('view-room').classList.contains('hidden'), false);
  assert.equal(ui.nodes.get('room-id-display').textContent, 'room-b');
});

test('resume and settings failures are visible instead of silently succeeding', async () => {
  const ui = launcher({ responses: { 'room.resume': { ok: false, error: 'Room unavailable.' } }, optionsError: 'Settings unavailable.' });
  ui.status({ room: { id: 'room-a', users: [] } }); await flush();
  ui.nodes.get('btn-resume-room').click();
  assert.equal(ui.sent.at(-1).roomId, 'room-a');
  assert.equal(ui.nodes.get('popup-error').textContent, 'Room unavailable.');
  ui.nodes.get('btn-open-settings').click(); await flush();
  assert.equal(ui.nodes.get('popup-error').textContent, 'Settings unavailable.');
});

test('copying a private invite without its keys fails visibly rather than sharing an unusable link', async () => {
  const ui = launcher(); ui.status({ room: { id: 'private-room', public: false, users: [] } }); await flush();
  ui.nodes.get('btn-share').click(); await flush();
  assert.deepEqual(ui.copied, []);
  assert.match(ui.nodes.get('popup-error').textContent, /missing the private invite keys/);
  assert.equal(ui.nodes.get('btn-share').disabled, false);
});

test('clipboard rejection is visible and copying an ID again never treats feedback text as its room ID', async () => {
  const denied = launcher({ copyResult: false });
  denied.status({ room: { id: 'public-room', public: true, users: [] } }); await flush();
  denied.nodes.get('btn-share').click(); await flush();
  assert.match(denied.nodes.get('popup-error').textContent, /Could not copy/);
  const ui = launcher(); ui.status({ room: { id: 'public-room', public: true, users: [] } }); await flush();
  ui.nodes.get('room-id-display').click(); await flush();
  assert.equal(ui.nodes.get('room-id-display').textContent, 'Link copied!');
  ui.nodes.get('room-id-display').click(); await flush();
  assert.deepEqual(ui.copied, [
    'https://watchparty.mertd.me/r/public-room', 'https://watchparty.mertd.me/r/public-room',
  ]);
});

test('a private invite finishing after a room switch cannot copy stale keys or overwrite the new room label', async () => {
  let resolveKeys;
  const ui = launcher({ appendKeys: () => new Promise(resolve => { resolveKeys = resolve; }) });
  ui.status({ room: { id: 'room-a', public: false, users: [] } }); await flush();
  ui.nodes.get('room-id-display').click();
  ui.update({ room: { id: 'room-b', public: true, users: [] } }); await flush();
  resolveKeys('https://watchparty.mertd.me/r/room-a#accessKey=test&e2eKey=test'); await flush();
  assert.deepEqual(ui.copied, []);
  assert.equal(ui.nodes.get('room-id-display').textContent, 'room-b');
  assert.equal(ui.nodes.get('btn-share').disabled, false);
});

test('invalid join input and missing names receive immediate feedback without dispatch', () => {
  const ui = launcher(); ui.status({ room: null });
  ui.nodes.get('btn-create').click();
  assert.equal(ui.nodes.get('create-error').textContent, 'Enter your name first.');
  ui.nodes.get('username-input').value = 'Tester';
  ui.nodes.get('room-id-input').value = 'not a valid link !!';
  ui.nodes.get('btn-join').click();
  assert.match(ui.nodes.get('join-error').textContent, /valid invite link/);
  assert.equal(ui.sent.some(message => ['room.create', 'room.join'].includes(message.action)), false);
});

test('immediate membership rejection restores both buttons instead of overwriting the error with busy state', () => {
  const ui = launcher({ responses: { 'room.create': { ok: false, error: 'Unable to create.' } } });
  ui.status({ room: null });
  ui.nodes.get('username-input').value = 'Tester';
  ui.nodes.get('btn-create').click();
  assert.equal(ui.nodes.get('create-error').textContent, 'Unable to create.');
  assert.equal(ui.nodes.get('btn-create').disabled, false);
  assert.equal(ui.nodes.get('btn-join').disabled, false);
  assert.equal(ui.nodes.get('btn-create').textContent, 'Create Room');
});

test('pending join ignores another room snapshot and unrelated command errors', async () => {
  const ui = launcher(); ui.status({ room: null }); await flush();
  ui.nodes.get('username-input').value = 'Tester';
  ui.nodes.get('room-id-input').value = 'wanted-room';
  ui.nodes.get('btn-join').click();
  ui.error({ code: 'COOLDOWN', command: 'room.typing.send' });
  ui.update({ room: { id: 'other-room', users: [] } }); await flush();
  assert.equal(ui.nodes.get('btn-join').disabled, true);
  assert.equal(ui.nodes.get('view-room').classList.contains('hidden'), true);
  ui.update({ room: { id: 'wanted-room', users: [] } }); await flush();
  assert.equal(ui.nodes.get('room-id-display').textContent, 'wanted-room');
  assert.equal(ui.nodes.get('btn-join').disabled, false);
});

test('placeholder media does not expose a broken Open title link', async () => {
  const ui = launcher();
  ui.status({ userId: 'guest', room: { id: 'room-a', owner: 'host', users: [], meta: { id: 'pending', type: 'movie', name: 'WatchParty Session' } } });
  await flush();
  assert.equal(ui.nodes.get('content-link').classList.contains('hidden'), true);
  assert.equal(ui.nodes.get('content-link').href, '#');
});
