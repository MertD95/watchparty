import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the real companion event handlers. Visual/layout verification lives
// in the isolated installed-extension MCP suite, not this minimal DOM adapter.
async function companion({ deferInitialStatus = false, fullDom = false } = {}) {
  const ids = new Map(), timers = new Map(), sent = [];
  let listener, timerId = 0;
  let response = async () => ({ ok: true });
  let initialStatus;
  let activeElement = null;
  class Element {
    children = []; value = ''; textContent = ''; disabled = false;
    style = { setProperty() {} };
    classes = new Set();
    classList = {
      add: name => this.classes.add(name), remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name),
      toggle: (name, force) => { if (force ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name); },
    };
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    get childElementCount() { return this.children.length; }
    get firstChild() { return this.children[0]; }
    setAttribute() {}
    focus() { activeElement = this; }
    contains(child) { return !!child && this.children.includes(child); }
    set innerHTML(value) {
      this.children = [];
      for (const match of value.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const child = new Element(); child.id = match[1]; child.open = /\bopen(?:\s|>)/.test(match[0]);
        ids.set(child.id, child); this.children.push(child);
      }
    }
  }
  for (const id of ['chat-input', 'chat-send', 'chat-messages', 'toast']) ids.set(id, new Element());
  if (fullDom) {
    for (const id of ['status', 'users', 'users-empty', 'chat-container', 'chat-empty', 'sync-indicator', 'people-count', 'people-section', 'chat-section', 'hero-copy', 'room-code', 'sp-open-watchparty-header']) ids.set(id, new Element());
  }
  const room = { id: 'room-a', public: true, users: [{ id: 'me', sessionId: 'session-me', name: 'Me' }] };
  const context = vm.createContext({
    console, crypto: webcrypto, URL, URLSearchParams,
    Node: Element, HTMLInputElement: Element, HTMLTextAreaElement: Element, HTMLButtonElement: Element, HTMLDetailsElement: Element,
    document: { getElementById: id => ids.get(id), createElement: () => new Element(), createTextNode: text => text, body: new Element(), documentElement: new Element(), get activeElement() { return activeElement; } },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    WPRuntimeState: { get: async () => ({}) },
    chrome: {
      runtime: {
        onMessage: { addListener: callback => { listener = callback; } },
        sendMessage: (message, callback) => {
          if (callback) {
            initialStatus = () => callback({ room, userId: 'me', sessionId: 'session-me', wsConnected: true });
            if (!deferInitialStatus) initialStatus();
            return;
          }
          sent.push(message); return response(message);
        },
      },
      storage: { onChanged: { addListener() {} } },
    },
  });
  for (const file of ['wp-actions.js', 'constants.js', 'utils.js', 'sidepanel.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'), context, { filename: file });
  }
  await Promise.resolve(); await Promise.resolve();
  const emit = (action, payload) => listener({ type: 'watchparty-ext', action, payload });
  const chatCommands = () => sent.filter(m => m.action === 'room.chat.send');
  return {
    input: ids.get('chat-input'), button: ids.get('chat-send'), timers, sent, room, ids,
    focused: () => activeElement,
    click: () => ids.get('chat-send').listeners.get('click')({ isTrusted: true }),
    messages: () => ids.get('chat-messages').children,
    toast: () => ids.get('toast').textContent,
    command: () => chatCommands().at(-1), chatCommands,
    response: callback => { response = callback; },
    initialStatus: () => initialStatus(),
    update: payload => emit('status.updated', payload),
    echo: (overrides = {}) => emit('room.chat.appended', {
      id: 'server-message-1', roomId: room.id, user: 'me', sessionId: 'session-me', content: 'hello',
      clientMessageId: chatCommands().at(-1)?.clientMessageId, ...overrides,
    }),
    reject: overrides => emit('room.error', { roomId: room.id, clientMessageId: chatCommands().at(-1)?.clientMessageId, message: 'Cooldown', ...overrides }),
  };
}

test('companion waits for correlated server echo, not bridge acceptance, and deduplicates replays', async () => {
  const ui = await companion(); ui.input.value = 'hello';
  await ui.click();
  assert.equal(ui.input.value, 'hello'); assert.equal(ui.button.disabled, true); assert.equal(ui.messages().length, 0);
  assert.equal(ui.command().roomId, 'room-a'); assert.match(ui.command().clientMessageId, /^[\da-f-]{36}$/i);
  ui.echo(); ui.echo();
  assert.equal(ui.input.value, ''); assert.equal(ui.messages().length, 1);
});

test('own messages from another surface appear but do not acknowledge a different request', async () => {
  const ui = await companion(); ui.input.value = 'hello'; await ui.click();
  ui.echo({ id: 'from-overlay', clientMessageId: undefined });
  assert.equal(ui.messages().length, 1); assert.equal(ui.input.value, 'hello');
  ui.echo(); assert.equal(ui.messages().length, 2); assert.equal(ui.input.value, '');
});

test('server rejection preserves draft, shows feedback, and permits retry', async () => {
  const ui = await companion(); ui.input.value = 'hello'; await ui.click();
  ui.reject({ clientMessageId: 'unrelated' }); assert.equal(ui.button.disabled, true);
  ui.reject({});
  assert.equal(ui.input.value, 'hello'); assert.equal(ui.messages().length, 0);
  assert.equal(ui.button.disabled, false); assert.equal(ui.toast(), 'Cooldown');
  await ui.click(); assert.equal(ui.chatCommands().length, 2);
});

test('bridge failures and delivery timeout do not lose the draft or fake delivery', async () => {
  for (const mode of ['reject', 'disconnect', 'timeout']) {
    const ui = await companion(); ui.input.value = 'hello';
    if (mode === 'reject') ui.response(async () => ({ ok: false, error: 'Not in room' }));
    if (mode === 'disconnect') ui.response(async () => { throw new Error('port closed'); });
    await ui.click();
    if (mode === 'timeout') [...ui.timers.values()].find(t => t.ms === 10000).callback();
    assert.equal(ui.input.value, 'hello'); assert.equal(ui.messages().length, 0); assert.equal(ui.button.disabled, false);
  }
});

test('room switches clear old drafts and ignore late chat, errors, and send completions', async () => {
  const ui = await companion(); let resolveSend;
  ui.response(() => new Promise(resolve => { resolveSend = resolve; }));
  ui.input.value = 'private room A draft'; const send = ui.click();
  ui.update({ room: { ...ui.room, id: 'room-b' }, wsConnected: true });
  assert.equal(ui.input.value, ''); ui.input.value = 'room B draft';
  ui.echo(); ui.reject({}); resolveSend({ ok: false, error: 'late error' }); await send;
  assert.equal(ui.input.value, 'room B draft'); assert.equal(ui.messages().length, 0); assert.equal(ui.button.disabled, false);
});

test('acknowledgment preserves draft edits and disconnect cancels pending send', async () => {
  const ui = await companion(); ui.input.value = 'hello'; await ui.click();
  ui.input.value = 'next message'; ui.echo(); assert.equal(ui.input.value, 'next message');
  const disconnected = await companion(); disconnected.input.value = 'hello'; await disconnected.click();
  disconnected.update({ wsConnected: false });
  assert.equal(disconnected.input.value, 'hello'); assert.equal(disconnected.button.disabled, true);
  disconnected.update({ wsConnected: true }); assert.equal(disconnected.button.disabled, false);
});

test('pending, overlong and disconnected companion sends never reach transport', async () => {
  const ui = await companion(); ui.input.value = '🎬'.repeat(151); await ui.click();
  assert.equal(ui.chatCommands().length, 0);
  ui.input.value = 'hello'; await ui.click(); await ui.click(); assert.equal(ui.chatCommands().length, 1);
  ui.update({ wsConnected: false }); await ui.click(); assert.equal(ui.chatCommands().length, 1);
});

test('late initial coordinator snapshot cannot overwrite a newer room broadcast or erase its draft', async () => {
  const ui = await companion({ deferInitialStatus: true });
  ui.update({ room: { ...ui.room, id: 'room-b' }, userId: 'me', sessionId: 'session-me', wsConnected: true });
  ui.input.value = 'room B draft';
  ui.initialStatus();
  assert.equal(ui.input.value, 'room B draft');
  await ui.click(); assert.equal(ui.command().roomId, 'room-b');
});

test('companion only shows People and Chat in an active room', async () => {
  const ui = await companion({ fullDom: true });
  for (const id of ['people-section', 'chat-section']) assert.equal(ui.ids.get(id).classList.contains('hidden'), false);
  assert.equal(ui.ids.get('sp-open-watchparty-header').textContent, 'Return to Stremio');
  ui.update({ room: null });
  for (const id of ['people-section', 'chat-section']) assert.equal(ui.ids.get(id).classList.contains('hidden'), true);
  assert.equal(ui.ids.get('sp-open-watchparty-header').textContent, 'Open Stremio');
  assert.equal(ui.ids.has('sp-open-watchparty-empty'), false, 'the empty state does not duplicate the launcher');
});

test('companion room refresh preserves disclosure and keyboard action focus', async () => {
  const ui = await companion({ fullDom: true });
  ui.ids.get('sp-room-tools').open = true;
  ui.ids.get('sp-bookmark').focus();
  ui.update({ wsConnected: true });
  assert.equal(ui.ids.get('sp-room-tools').open, true);
  assert.equal(ui.focused(), ui.ids.get('sp-bookmark'));
});
