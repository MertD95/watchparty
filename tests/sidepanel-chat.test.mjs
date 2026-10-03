import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the real companion event handlers. Visual/layout verification lives
// in the isolated installed-extension MCP suite, not this minimal DOM adapter.
async function companion({ deferInitialStatus = false, fullDom = false, hasVideo = false, host = true } = {}) {
  const ids = new Map(), timers = new Map(), sent = [];
  let listener, timerId = 0;
  let response = async () => ({ ok: true });
  let initialStatus;
  let activeElement = null;
  let stateRead = async () => ({});
  let appendKeys = async (_roomId, url) => url;
  let openSettings = async () => {};
  let openTab = async () => {};
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
    attributes = new Map();
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name); }
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
    for (const id of ['status', 'users', 'users-empty', 'chat-container', 'chat-empty', 'sync-indicator', 'people-count', 'people-section', 'chat-section', 'hero-copy', 'room-code', 'sp-open-watchparty-header', 'sp-open-settings-header']) ids.set(id, new Element());
  }
  const room = { id: 'room-a', public: true, owner: host ? 'me' : 'host', ownerSessionId: host ? 'session-me' : 'session-host', users: [{ id: 'me', sessionId: 'session-me', name: 'Me' }] };
  const context = vm.createContext({
    console, crypto: webcrypto, URL, URLSearchParams,
    Node: Element, HTMLInputElement: Element, HTMLTextAreaElement: Element, HTMLButtonElement: Element, HTMLDetailsElement: Element,
    document: { getElementById: id => ids.get(id), createElement: () => new Element(), createTextNode: text => text, body: new Element(), documentElement: new Element(), get activeElement() { return activeElement; } },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    WPRuntimeState: { get: keys => stateRead(keys) },
    WPRoomKeys: { appendToInviteUrl: (...args) => appendKeys(...args) },
    chrome: {
      runtime: {
        onMessage: { addListener: callback => { listener = callback; } },
        openOptionsPage: () => openSettings(),
        sendMessage: (message, callback) => {
          if (callback) {
            initialStatus = () => callback({ room, userId: 'me', sessionId: 'session-me', wsConnected: true, adapterState: { hasVideo } });
            if (!deferInitialStatus) initialStatus();
            return;
          }
          sent.push(message); return response(message);
        },
      },
      storage: { onChanged: { addListener() {} } },
      tabs: { create: options => openTab(options) },
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
    clickControl: (id, event = { isTrusted: true }) => ids.get(id)?.listeners.get('click')?.(event),
    messages: () => ids.get('chat-messages').children,
    toast: () => ids.get('toast').textContent,
    command: () => chatCommands().at(-1), chatCommands,
    response: callback => { response = callback; },
    stateRead: callback => { stateRead = callback; },
    appendKeys: callback => { appendKeys = callback; },
    openSettings: callback => { openSettings = callback; },
    openTab: callback => { openTab = callback; },
    initialStatus: () => initialStatus(),
    update: payload => emit('status.updated', payload),
    echo: (overrides = {}) => emit('room.chat.appended', {
      id: 'server-message-1', roomId: room.id, user: 'me', sessionId: 'session-me', content: 'hello',
      clientMessageId: chatCommands().at(-1)?.clientMessageId, ...overrides,
    }),
    reject: overrides => emit('room.error', { roomId: room.id, clientMessageId: chatCommands().at(-1)?.clientMessageId, message: 'Cooldown', ...overrides }),
    bookmark: overrides => emit('room.bookmark.appended', { roomId: room.id, user: 'me', time: 62, ...overrides }),
  };
}

const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

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

test('frequent playback updates keep action elements mounted and retain their click handlers', async () => {
  const ui = await companion({ fullDom: true, hasVideo: true });
  const leave = ui.ids.get('sp-leave');
  const bookmark = ui.ids.get('sp-bookmark');
  ui.ids.get('sp-room-tools').open = true;
  for (let time = 0; time < 100; time += 1) {
    ui.update({ room: { ...ui.room, player: { time, paused: false } }, wsConnected: true });
    assert.equal(ui.ids.get('sp-leave'), leave);
    assert.equal(ui.ids.get('sp-bookmark'), bookmark);
  }
  await ui.clickControl('sp-leave');
  assert.equal(ui.sent.at(-1).action, 'room.leave');
  assert.equal(ui.sent.at(-1).roomId, 'room-a');
  ui.update({ room: { ...ui.room, id: 'room-b' } });
  assert.notEqual(ui.ids.get('sp-leave'), leave, 'new room replaces scoped controls');
});

test('room controls disable video actions without a local player and while disconnected, but retain leave', async () => {
  const ui = await companion({ fullDom: true });
  for (const id of ['sp-bookmark', 'sp-ready-check']) {
    assert.equal(ui.ids.get(id).disabled, true);
    assert.match(ui.ids.get(id).title, /video/);
    await ui.clickControl(id);
  }
  assert.equal(ui.sent.length, 0);
  ui.update({ adapterState: { hasVideo: true } });
  assert.equal(ui.ids.get('sp-bookmark').disabled, false);
  assert.equal(ui.ids.get('sp-ready-check').disabled, false);
  ui.update({ wsConnected: false });
  assert.equal(ui.ids.get('sp-bookmark').disabled, true);
  assert.equal(ui.ids.get('sp-ready-check').disabled, true);
  assert.equal(ui.ids.get('sp-leave').disabled, false);
  await ui.clickControl('sp-leave');
  assert.equal(ui.sent.at(-1).action, 'room.leave');
  assert.equal(ui.sent.at(-1).roomId, 'room-a');
  const guest = await companion({ fullDom: true, hasVideo: true, host: false });
  assert.equal(guest.ids.has('sp-ready-check'), false);
});

test('bookmark and ready controls await acceptance, prevent duplicate pending sends and only claim requests', async () => {
  for (const [id, action, label] of [
    ['sp-bookmark', 'room.bookmark.add', 'Bookmark requested'],
    ['sp-ready-check', 'room.readyCheck.update', 'Ready check requested'],
  ]) {
    const ui = await companion({ fullDom: true, hasVideo: true }); let finish;
    ui.response(() => new Promise(resolve => { finish = resolve; }));
    const work = ui.clickControl(id);
    assert.equal(ui.ids.get(id).disabled, true);
    assert.equal(ui.ids.get(id).getAttribute('aria-busy'), 'true');
    assert.equal(ui.toast(), '');
    await ui.clickControl(id);
    assert.equal(ui.sent.length, 1);
    assert.equal(ui.sent[0].action, action); assert.equal(ui.sent[0].roomId, 'room-a');
    ui.update({ adapterState: { hasVideo: true } });
    assert.equal(ui.ids.get(id).disabled, true, 'state refresh retains pending guard');
    finish({ ok: true, handled: true }); await work;
    assert.equal(ui.toast(), label); assert.equal(ui.ids.get(id).disabled, false);
  }
});

test('room controls report bridge rejection, unhandled responses and exceptions without success feedback', async () => {
  for (const reply of [undefined, { ok: true, handled: false }, { ok: false, error: 'Open a video first' }, 'throw']) {
    const ui = await companion({ fullDom: true, hasVideo: true });
    ui.response(async () => { if (reply === 'throw') throw new Error('closed'); return reply; });
    await ui.clickControl('sp-bookmark');
    assert.match(ui.toast(), /not accepted|Open a video|Could not reach/);
    assert.doesNotMatch(ui.toast(), /requested|sent|started/);
    assert.equal(ui.ids.get('sp-bookmark').disabled, false);
  }
});

test('unanswered room action times out and late replies from a previous membership stay silent', async () => {
  const timeout = await companion({ fullDom: true, hasVideo: true });
  timeout.response(() => new Promise(() => {}));
  const pending = timeout.clickControl('sp-bookmark');
  [...timeout.timers.values()].find(timer => timer.ms === 8000).callback();
  await pending;
  assert.match(timeout.toast(), /No response/);
  assert.equal(timeout.ids.get('sp-bookmark').disabled, false);

  const ui = await companion({ fullDom: true, hasVideo: true }); let finish;
  ui.response(() => new Promise(resolve => { finish = resolve; }));
  const work = ui.clickControl('sp-bookmark');
  ui.update({ room: { ...ui.room, id: 'room-b' }, adapterState: { hasVideo: true } });
  ui.update({ room: ui.room, adapterState: { hasVideo: true } });
  finish({ ok: false, error: 'Old room rejection' }); await work;
  assert.equal(ui.toast(), '');
  assert.equal(ui.ids.get('sp-bookmark').disabled, false);
});

test('bookmark seek is disabled without video, carries its room and surfaces a failed seek', async () => {
  const ui = await companion({ fullDom: true }); ui.bookmark();
  const timeButton = ui.messages()[0].children.find(child => typeof child !== 'string' && child.className === 'bookmark-time');
  assert.equal(timeButton.disabled, true);
  timeButton.listeners.get('click')({ isTrusted: true }); await flush();
  assert.equal(ui.sent.length, 0);
  ui.update({ adapterState: { hasVideo: true } });
  assert.equal(timeButton.disabled, false);
  ui.response(async () => ({ ok: false, error: 'Video is not seekable yet' }));
  timeButton.listeners.get('click')({ isTrusted: true }); await flush();
  assert.equal(ui.sent.at(-1).action, 'room.bookmark.seek');
  assert.equal(ui.sent.at(-1).roomId, 'room-a'); assert.equal(ui.sent.at(-1).time, 62);
  assert.equal(ui.toast(), 'Video is not seekable yet');
  assert.equal(timeButton.disabled, false);
});

test('synthetic room action events never reach the bridge', async () => {
  const ui = await companion({ fullDom: true, hasVideo: true });
  for (const id of ['sp-ready-check', 'sp-bookmark', 'sp-leave']) await ui.clickControl(id, { isTrusted: false });
  assert.equal(ui.sent.length, 0);
});

test('copy invite completes or reports storage/key failures instead of hanging', async () => {
  const ok = await companion({ fullDom: true });
  ok.appendKeys(async (_id, url) => `${url}#accessKey=test-secret`);
  await ok.clickControl('sp-copy-invite');
  assert.equal(ok.toast(), 'Invite copied');
  assert.match(ok.sent.find(message => message.action === 'clipboard.copy').text, /#accessKey=test-secret$/);
  for (const mode of ['storage', 'key']) {
    const ui = await companion({ fullDom: true });
    if (mode === 'storage') ui.stateRead(async () => { throw new Error('storage failed'); });
    else ui.appendKeys(async () => { throw new Error('key failed'); });
    await ui.clickControl('sp-copy-invite');
    assert.equal(ui.toast(), 'Copy failed');
    assert.equal(ui.sent.filter(message => message.action === 'clipboard.copy').length, 0);
  }
});

test('launch and settings controls expose failures while Stremio can fall back to a new tab', async () => {
  const ui = await companion({ fullDom: true }); let opened;
  ui.response(async () => ({ ok: false }));
  ui.openTab(async options => { opened = options.url; });
  await ui.clickControl('sp-open-watchparty-header');
  assert.equal(opened, 'https://web.stremio.com');
  ui.openTab(async () => { throw new Error('no tab'); });
  await ui.clickControl('sp-open-watchparty-header');
  assert.match(ui.toast(), /Could not open Stremio/);
  ui.openSettings(async () => { throw new Error('no settings'); });
  ui.clickControl('sp-open-settings-header'); await flush();
  assert.match(ui.toast(), /Could not open settings/);
  assert.equal([...ui.timers.values()].filter(timer => timer.ms === 4000).length, 1, 'old toast timers cannot hide new feedback');
});

test('server room-control rejection replaces acceptance feedback without leaking old-room errors', async () => {
  const ui = await companion({ fullDom: true, hasVideo: true });
  await ui.clickControl('sp-ready-check');
  assert.equal(ui.toast(), 'Ready check requested');
  ui.reject({ command: 'room.readyCheck.update', message: 'Only the host can start a ready check' });
  assert.equal(ui.toast(), 'Only the host can start a ready check');
  ui.reject({ roomId: 'old-room', command: 'room.bookmark.add', message: 'Old room error' });
  assert.equal(ui.toast(), 'Only the host can start a ready check');
});

test('copying cannot export an invite after leaving and rejoining during a pending key lookup', async () => {
  const ui = await companion({ fullDom: true }); let finish;
  ui.appendKeys(() => new Promise(resolve => { finish = resolve; }));
  const copy = ui.clickControl('sp-copy-invite'); await flush();
  ui.update({ room: null }); ui.update({ room: ui.room });
  finish('https://watchparty.mertd.me/r/room-a#accessKey=old');
  await flush();
  // The shared clipboard helper retries its loader; reject the same stale
  // generation on that attempt too, rather than exporting the previous key.
  finish('https://watchparty.mertd.me/r/room-a#accessKey=old');
  await copy;
  assert.equal(ui.toast(), 'Copy failed');
  assert.equal(ui.sent.filter(message => message.action === 'clipboard.copy').length, 0);
});
