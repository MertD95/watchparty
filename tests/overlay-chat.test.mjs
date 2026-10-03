import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Event-focused DOM adapter. The installed-extension browser suite owns visual
// assertions; these tests execute the actual chat button and server callbacks.
function overlayRuntime() {
  const ids = new Map();
  const timers = new Map();
  const notices = [];
  let timerId = 0;
  let lastMessageId;
  class Element {
    constructor(tag = 'div') { this.tagName = tag; }
    children = [];
    listeners = new Map();
    style = {};
    dataset = {};
    value = '';
    textContent = '';
    disabled = false;
    isConnected = true;
    className = '';
    classList = {
      contains: (value) => this.className.split(' ').includes(value),
      add: (...values) => { this.className = [...new Set([...this.className.split(' '), ...values])].join(' '); },
      remove: (...values) => { this.className = this.className.split(' ').filter((entry) => !values.includes(entry)).join(' '); },
      toggle: (value, force) => {
        const include = force ?? !this.classList.contains(value);
        this.classList[include ? 'add' : 'remove'](value);
        return include;
      },
    };
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id; }
    set innerHTML(html) {
      this.replaceChildren();
      for (const match of html.matchAll(/<([a-z][a-z0-9-]*)([^>]*)>/gi)) {
        const child = new Element(match[1]);
        const id = match[2].match(/\bid="([^"]+)"/)?.[1];
        if (id) child.id = id;
        child.className = match[2].match(/\bclass="([^"]+)"/)?.[1] || '';
        this.appendChild(child);
      }
    }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    replaceChildren(...next) { for (const child of [...this.children]) child.remove(); this.children = next; }
    get childElementCount() { return this.children.length; }
    get firstElementChild() { return this.children[0]; }
    removeChild(child) { child.remove(); }
    remove() {
      if (ids.get(this.id) === this) ids.delete(this.id);
      for (const child of [...this.children]) child.remove();
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.isConnected = false;
    }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    querySelectorAll(selector) {
      if (selector.startsWith('#')) return ids.has(selector.slice(1)) ? [ids.get(selector.slice(1))] : [];
      return this.children.filter((child) => selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : child.tagName === selector);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    attachShadow() { return new Element('shadow'); }
    focus() {}
  }
  const body = new Element('body');
  const document = {
    body, head: new Element('head'), activeElement: null,
    addEventListener() {}, getElementById: (id) => ids.get(id) || null,
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => Object.assign(new Element('text'), { textContent: text }),
    querySelector: () => null, querySelectorAll: () => [],
  };
  const context = vm.createContext({
    document, crypto: { randomUUID: () => (lastMessageId = webcrypto.randomUUID()) }, URLSearchParams, URL, console,
    window: { innerWidth: 1200, addEventListener() {} },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => 0, clearInterval() {},
    chrome: { runtime: { getURL: (file) => file }, storage: { local: { get: (_keys, callback) => callback({}) }, onChanged: { addListener() {} } } },
    WPUtils: { getUserColor: () => '#6366f1', escapeHtml: (value) => String(value) },
    WPDOM: {
      el: (tag, options = {}) => Object.assign(new Element(tag), { className: options.className || '', textContent: options.text || '', style: options.style || {}, dataset: options.dataset || {} }),
      safeColor: (value) => value, safeUrl: (value) => value || '',
    },
    WPTheme: { startListening() {} },
    WPModals: { showToast: (message) => notices.push(message), showReadyCheck() {} },
    WPRuntimeState: { get: async () => ({}), set: async () => {} },
  });
  for (const file of ['wp-actions.js', 'constants.js', 'wp-protocol.js', 'stremio-overlay-shells.js', 'gif-links.js', 'stremio-overlay.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'extension', file), 'utf8'), context, { filename: file });
  }
  const api = vm.runInContext('WPOverlay', context);
  const room = { id: 'test-room', public: true, users: [{ id: 'user-me', sessionId: 'session-me', name: 'Me' }] };
  // Cache the room before mounting; full room layout is outside this adapter.
  api.updateState({ inRoom: true, isHost: false, userId: 'user-me', sessionId: 'session-me', roomState: room });
  api.create();
  const input = ids.get('wp-chat-input');
  const button = ids.get('wp-chat-send');
  return {
    api, room, input, button, notices, timers, nodes: ids,
    mountLobby() { ids.get('wp-room-controls').innerHTML = vm.runInContext('WPOverlayShells.buildLobbyShell()', context); },
    click: () => button.listeners.get('click')({ isTrusted: true }),
    messages: () => ids.get('wp-chat-messages').children,
    echo: (content, id = 'message-1', clientMessageId = lastMessageId) => api.appendChatMessage({ id, clientMessageId, user: 'user-me', sessionId: 'session-me', content }, room, 'user-me'),
  };
}

test('chat draft clears only after its own server echo, not after sending on a socket', async () => {
  const ui = overlayRuntime();
  const sent = [];
  ui.api.setActionDispatcher(async (action) => { sent.push(action); return { handled: true }; });
  ui.input.value = 'hello';
  await ui.click();
  assert.equal(ui.input.value, 'hello');
  assert.equal(ui.messages().length, 0, 'no false delivered-message echo');
  assert.equal(ui.button.disabled, true);
  ui.echo('hello');
  assert.equal(ui.input.value, '');
  assert.equal(ui.messages().length, 1);
  assert.equal(sent[0].content, 'hello');
});

test('transport rejection preserves the draft and makes sending retryable', async () => {
  const ui = overlayRuntime();
  ui.api.setActionDispatcher(async () => ({ handled: false, error: 'NOT_CONNECTED' }));
  ui.input.value = 'do not lose this';
  await ui.click();
  assert.equal(ui.input.value, 'do not lose this');
  assert.equal(ui.messages().length, 0);
  assert.equal(ui.button.disabled, false);
  assert.match(ui.notices.at(-1), /not sent/);
});

test('server rejection or acknowledgment timeout cannot leave a false successful chat message', async () => {
  const ui = overlayRuntime();
  ui.api.setActionDispatcher(async () => ({ handled: true }));
  ui.input.value = 'retry me';
  await ui.click();
  ui.api.rejectPendingChat('Message rejected.');
  assert.equal(ui.input.value, 'retry me');
  assert.equal(ui.button.disabled, false);
  await ui.click();
  const timeout = [...ui.timers.values()].find((timer) => timer.ms === 10000);
  timeout.callback();
  assert.equal(ui.input.value, 'retry me');
  assert.equal(ui.messages().length, 0);
  assert.equal(ui.button.disabled, false);
  assert.match(ui.notices.at(-1), /not confirmed/);
});

test('an acknowledgment preserves edits made while the original message was pending', async () => {
  const ui = overlayRuntime();
  ui.api.setActionDispatcher(async () => ({ handled: true }));
  ui.input.value = 'first draft';
  await ui.click();
  ui.input.value = 'next draft';
  ui.echo('first draft');
  assert.equal(ui.input.value, 'next draft');
  assert.equal(ui.messages().length, 1);
});

test('identical own chat from another surface cannot acknowledge or reject this overlay request', async () => {
  const ui = overlayRuntime();
  ui.api.setActionDispatcher(async () => ({ handled: true }));
  ui.input.value = 'same text'; await ui.click();
  ui.echo('same text', 'other-message', 'different-request-id');
  assert.equal(ui.input.value, 'same text'); assert.equal(ui.button.disabled, true);
  ui.api.rejectPendingChat('Unrelated cooldown', 'different-request-id');
  assert.equal(ui.button.disabled, true);
  ui.echo('same text', 'our-message'); assert.equal(ui.input.value, '');
});

test('emoji insertion or other programmatic edits cannot bypass the 300-character chat limit', async () => {
  const ui = overlayRuntime();
  let sends = 0;
  ui.api.setActionDispatcher(async () => { sends += 1; return { handled: true }; });
  ui.input.value = '🎬'.repeat(151);
  await ui.click();
  assert.equal(sends, 0);
  assert.equal(ui.input.value.length, 302);
  assert.match(ui.notices.at(-1), /300 characters/);
});

test('chat is not queued for another room while its dispatcher is unavailable', async () => {
  const ui = overlayRuntime();
  ui.input.value = 'only for this room';
  await ui.click();
  let dispatched = 0;
  ui.api.setActionDispatcher(() => { dispatched += 1; return { handled: true }; });
  assert.equal(dispatched, 0);
  assert.equal(ui.input.value, 'only for this room');
  assert.equal(ui.button.disabled, false);
});

test('switching rooms cancels a pending draft and late send results cannot affect the new room', async () => {
  const ui = overlayRuntime();
  let resolveSend;
  ui.api.setActionDispatcher(() => new Promise((resolve) => { resolveSend = resolve; }));
  ui.input.value = 'private draft from previous room';
  const sending = ui.click();
  // Omit unrelated layout cards from the event-only DOM adapter.
  for (const id of ['wp-status', 'wp-content-link', 'wp-room-controls', 'wp-local-settings', 'wp-users']) ui.nodes.delete(id);
  ui.api.updateState({ inRoom: true, isHost: false, userId: 'user-me', sessionId: 'session-me', roomState: { ...ui.room, id: 'another-room' } });
  assert.equal(ui.input.value, '', 'a private draft must not accidentally carry into a different room');
  assert.equal(ui.button.disabled, false);
  ui.input.value = 'new room draft';
  resolveSend({ handled: true });
  await sending;
  assert.equal(ui.input.value, 'new room draft');
  assert.equal(ui.messages().length, 0);
});

test('a rejected private join replaces pending lobby feedback and preserves the invite for retry', async () => {
  const ui = overlayRuntime();
  ui.mountLobby();
  ui.api.setActionDispatcher(async () => ({ handled: true }));
  const input = ui.nodes.get('wp-lobby-join-input');
  input.value = 'private-room-id';
  const panelClick = ui.nodes.get('wp-panel-room').listeners.get('click');
  panelClick({ isTrusted: true, target: { closest: (selector) => selector === '#wp-lobby-join-btn' ? ui.nodes.get('wp-lobby-join-btn') : null } });
  await Promise.resolve();
  const feedback = ui.nodes.get('wp-lobby-join-feedback');
  assert.equal(feedback.textContent, 'Joining room...');
  assert.equal(feedback.dataset.pending, 'true');
  ui.api.showRoomError({ code: 'INVALID_ROOM_KEY', message: 'Invalid room key.' });
  assert.match(feedback.textContent, /fresh full invite link/);
  assert.equal(feedback.dataset.pending, '');
  assert.equal(feedback.classList.contains('wp-warning'), true);
  assert.equal(input.value, 'private-room-id');
  ui.api.showRoomError({ code: 'COOLDOWN', message: 'Unrelated error' });
  assert.match(feedback.textContent, /fresh full invite link/, 'unrelated later errors do not overwrite resolved lobby feedback');
});

test('failed creation receives persistent lobby feedback instead of remaining in progress', async () => {
  const ui = overlayRuntime();
  ui.mountLobby();
  ui.api.setActionDispatcher(async () => ({ handled: true }));
  const panelClick = ui.nodes.get('wp-panel-room').listeners.get('click');
  panelClick({ isTrusted: true, target: { closest: (selector) => selector === '#wp-lobby-create-btn' ? ui.nodes.get('wp-lobby-create-btn') : null } });
  await Promise.resolve();
  const feedback = ui.nodes.get('wp-lobby-create-feedback');
  assert.equal(feedback.textContent, 'Creating room...');
  ui.api.showRoomError({ code: 'VALIDATION_FAILED', message: 'Choose a different room name.' });
  assert.equal(feedback.textContent, 'Choose a different room name.');
  assert.equal(feedback.dataset.pending, '');
});

test('direct GIF picker validates locally without searches or automatic image requests', async () => {
  const ui = overlayRuntime();
  const input = ui.nodes.get('wp-gif-search');
  const send = ui.nodes.get('wp-gif-send');
  let actions = 0;
  ui.api.setActionDispatcher(async () => { actions += 1; return { handled: true }; });
  ui.nodes.get('wp-gif-btn').listeners.get('click')({ isTrusted: true, stopPropagation() {} });
  assert.equal(send.disabled, true);
  input.value = 'https://example.com/a-page';
  input.listeners.get('input')();
  assert.equal(send.disabled, true);
  assert.equal(input['aria-invalid'], 'true');
  assert.match(ui.nodes.get('wp-gif-status').textContent, /\.gif/);
  await send.listeners.get('click')({ isTrusted: true });
  assert.equal(actions, 0);
  input.value = 'https://example.com/image.gif';
  input.listeners.get('input')();
  assert.equal(send.disabled, false);
  assert.equal(input['aria-invalid'], 'false');
  assert.equal(ui.nodes.get('wp-gif-status').textContent, '');
  assert.equal(ui.nodes.get('wp-gif-picker').children.some((node) => node.tagName === 'img'), false);
  await send.listeners.get('click')({ isTrusted: false });
  assert.equal(actions, 0, 'untrusted script cannot share an image');
});

test('GIF sharing targets the visible room and keeps the link until its own server echo', async () => {
  const ui = overlayRuntime();
  const input = ui.nodes.get('wp-gif-search');
  const send = ui.nodes.get('wp-gif-send');
  const actions = [];
  ui.api.setActionDispatcher(async (action) => { actions.push(action); return { handled: true }; });
  input.value = 'https://example.com/image.gif';
  input.listeners.get('input')();
  await send.listeners.get('click')({ isTrusted: true });
  assert.equal(actions[0].content, '[gif:https://example.com/image.gif]');
  assert.equal(actions[0].roomId, ui.room.id);
  assert.equal(input.value, 'https://example.com/image.gif');
  assert.equal(send.disabled, true);
  assert.equal(ui.messages().length, 0, 'transport acceptance is not delivery');
  ui.echo(actions[0].content, 'other-gif', 'other-request');
  assert.equal(input.value, 'https://example.com/image.gif');
  ui.echo(actions[0].content, 'our-gif', actions[0].clientMessageId);
  assert.equal(input.value, '');
  const content = ui.messages()[1].children[0].children[0];
  const image = content.children.find((node) => node.tagName === 'img');
  assert.equal(image.src, 'https://example.com/image.gif');
  assert.equal(image.referrerPolicy, 'no-referrer');
  image.listeners.get('error')();
  assert.equal(image.hidden, true);
  assert.match(content.children.at(-1).textContent, /GIF could not load/);
});

test('GIF rejection and timeout preserve the link and allow a retry without duplicate sends', async () => {
  const ui = overlayRuntime();
  const input = ui.nodes.get('wp-gif-search');
  const send = ui.nodes.get('wp-gif-send');
  input.value = 'https://example.com/image.gif';
  input.listeners.get('input')();
  ui.api.setActionDispatcher(async () => ({ handled: false }));
  await send.listeners.get('click')({ isTrusted: true });
  assert.equal(input.value, 'https://example.com/image.gif');
  assert.equal(send.disabled, false);
  let sends = 0;
  ui.api.setActionDispatcher(async () => { sends += 1; return { handled: true }; });
  await send.listeners.get('click')({ isTrusted: true });
  await send.listeners.get('click')({ isTrusted: true });
  assert.equal(sends, 1);
  [...ui.timers.values()].find((timer) => timer.ms === 10000).callback();
  assert.equal(input.value, 'https://example.com/image.gif');
  assert.equal(send.disabled, false);
  assert.match(ui.notices.at(-1), /not confirmed/);
});

test('GIF edits survive acknowledgment and a room change clears the private image draft', async () => {
  const ui = overlayRuntime();
  const input = ui.nodes.get('wp-gif-search');
  const send = ui.nodes.get('wp-gif-send');
  let resolveSend;
  ui.api.setActionDispatcher((action) => action.action === 'room.chat.send'
    ? new Promise((resolve) => { resolveSend = resolve; }) : { handled: true });
  input.value = 'https://example.com/first.gif';
  input.listeners.get('input')();
  const sending = send.listeners.get('click')({ isTrusted: true });
  input.value = 'https://example.com/second.gif';
  ui.echo('[gif:https://example.com/first.gif]');
  assert.equal(input.value, 'https://example.com/second.gif');
  for (const id of ['wp-status', 'wp-content-link', 'wp-room-controls', 'wp-local-settings', 'wp-users']) ui.nodes.delete(id);
  ui.api.updateState({ inRoom: true, isHost: false, userId: 'user-me', sessionId: 'session-me', roomState: { ...ui.room, id: 'another-room' } });
  assert.equal(input.value, '');
  assert.equal(send.disabled, true);
  ui.nodes.get('wp-gif-picker').classList.remove('wp-hidden-el');
  input.value = 'https://example.com/new-room.gif';
  input.listeners.get('input')();
  resolveSend({ handled: true });
  await sending;
  assert.equal(input.value, 'https://example.com/new-room.gif');
  assert.equal(ui.nodes.get('wp-gif-picker').classList.contains('wp-hidden-el'), false);
});
