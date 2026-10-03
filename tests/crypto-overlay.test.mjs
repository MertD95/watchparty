import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(context, file) {
  vm.runInContext(fs.readFileSync(path.join(root, 'extension', file), 'utf8'), context, { filename: file });
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function cryptoRuntime() {
  const blocked = new Map();
  const subtle = new Proxy(webcrypto.subtle, {
    get(target, key) {
      return async (...args) => {
        const blocker = blocked.get(key);
        blocked.delete(key);
        if (blocker) await blocker.promise;
        return Reflect.apply(target[key], target, args);
      };
    },
  });
  const context = vm.createContext({
    crypto: { subtle, getRandomValues: (value) => webcrypto.getRandomValues(value) },
    TextEncoder, TextDecoder, btoa, atob, Uint8Array,
  });
  load(context, 'stremio-crypto.js');
  return {
    context,
    api: vm.runInContext('WPCrypto', context),
    block(method) { const gate = deferred(); blocked.set(method, gate); return gate; },
  };
}

test('encrypted chat never falls back to plaintext when its key is unavailable', async () => {
  const { api } = cryptoRuntime();
  await assert.rejects(api.encrypt('secret'), /key is missing/);
  await api.generateKey();
  api.clear();
  await assert.rejects(api.encrypt('secret'), /key is missing/);
});

test('full-length ASCII and Unicode private messages round-trip through the extension envelope', async () => {
  const host = cryptoRuntime().api;
  const peer = cryptoRuntime().api;
  await host.generateKey();
  await peer.importKey(await host.exportKey());
  for (const content of ['x'.repeat(300), '界'.repeat(300), '🎬'.repeat(150)]) {
    const ciphertext = await host.encrypt(content);
    assert.match(ciphertext, /^e2e:[A-Za-z0-9_-]+$/);
    assert.ok(ciphertext.length > 300, 'wire size exceeds the plaintext character limit');
    assert.equal(await peer.decrypt(ciphertext), content);
  }
});

test('clear invalidates an asynchronous key import without reviving private-room state', async () => {
  const { api, block } = cryptoRuntime();
  const gate = block('importKey');
  let notifications = 0;
  api.onKeyLoaded(() => { notifications += 1; });
  const importing = api.importKey('A'.repeat(43));
  api.clear();
  gate.resolve();
  await assert.rejects(importing, /context changed/);
  assert.equal(api.isEnabled(), false);
  assert.equal(notifications, 0);
});

test('the latest key import wins even when an older room finishes importing last', async () => {
  const { api, block } = cryptoRuntime();
  const gate = block('importKey');
  const oldImport = api.importKey('A'.repeat(43));
  const newestKey = Buffer.alloc(32, 7).toString('base64url');
  await api.importKey(newestKey);
  const generation = api.getGeneration();
  gate.resolve();
  await assert.rejects(oldImport, /context changed/);
  assert.equal(api.getGeneration(), generation);
  const peer = cryptoRuntime().api;
  await peer.importKey(newestKey);
  assert.equal(await peer.decrypt(await api.encrypt('new room')), 'new room');
});

test('generation and export operations cannot leak a key from an abandoned room', async () => {
  const { api, block } = cryptoRuntime();
  const generating = block('generateKey');
  const generated = api.generateKey();
  api.clear();
  generating.resolve();
  await assert.rejects(generated, /context changed/);
  assert.equal(api.isEnabled(), false);
  await api.generateKey();
  const exporting = block('exportKey');
  const exported = api.exportKey();
  api.clear();
  exporting.resolve();
  await assert.rejects(exported, /context changed/);
});

test('in-flight encryption and decryption are invalidated by a room-key change', async () => {
  const { api, block } = cryptoRuntime();
  await api.generateKey();
  const ciphertext = await api.encrypt('previous room');
  const encryption = block('encrypt');
  const decryption = block('decrypt');
  const pendingEncrypt = api.encrypt('must not send');
  const pendingDecrypt = api.decrypt(ciphertext);
  api.clear();
  encryption.resolve();
  decryption.resolve();
  await assert.rejects(pendingEncrypt, /context changed/);
  assert.equal(await pendingDecrypt, '[encrypted message]');
});

test('invalid imported keys fail closed instead of retaining another room key', async () => {
  const { api } = cryptoRuntime();
  await api.generateKey();
  await assert.rejects(api.importKey('short-invalid-key'), /Invalid room encryption key/);
  assert.equal(api.isEnabled(), false);
  await assert.rejects(api.encrypt('private message'), /key is missing/);
});

test('preparing another invitation never changes the active room encryption key', async () => {
  const { api } = cryptoRuntime();
  await api.generateKey();
  const activeKey = await api.exportKey();
  const generation = api.getGeneration();
  const invitationKey = await api.generateKeyString();
  assert.notEqual(invitationKey, activeKey);
  assert.equal(api.getGeneration(), generation);
  assert.equal(await api.exportKey(), activeKey);
  const peer = cryptoRuntime().api;
  await peer.importKey(activeKey);
  assert.equal(await peer.decrypt(await api.encrypt('still the active room')), 'still the active room');
});

test('decryption distinguishes actual placeholder text from a missing or incorrect key', async () => {
  const { api } = cryptoRuntime();
  await api.generateKey();
  const message = await api.encrypt('[encrypted message]');
  const decrypted = await api.decryptResult(message);
  assert.equal(decrypted.ok, true);
  assert.equal(decrypted.content, '[encrypted message]');
  api.clear();
  const missingKey = await api.decryptResult(message);
  assert.equal(missingKey.ok, false);
  assert.equal(missingKey.content, null);
});

test('a delayed room-key storage read cannot replace a newer room encryption key', async () => {
  const { api, context } = cryptoRuntime();
  const read = deferred();
  context.chrome = { storage: { session: { get: () => read.promise } } };
  context.WPConstants = { STORAGE: { roomE2eKey: (id) => `wpRoomE2eKey:${id}` } };
  load(context, 'room-keys.js');
  const keys = vm.runInContext('WPRoomKeys', context);
  const keyA = Buffer.alloc(32, 1).toString('base64url');
  const keyB = Buffer.alloc(32, 2).toString('base64url');
  const restoringA = keys.loadIntoCrypto('room-a');
  api.clear();
  await api.importKey(keyB);
  const privateB = await api.encrypt('still room B');
  read.resolve({ 'wpRoomE2eKey:room-a': keyA });
  assert.equal(await restoringA, null);
  assert.equal(await api.decrypt(privateB), 'still room B');
  const peerB = cryptoRuntime().api;
  await peerB.importKey(keyB);
  assert.equal(await peerB.decrypt(await api.encrypt('new B traffic')), 'new B traffic');
});

test('room-key loading revalidates membership after storage before starting import', async () => {
  const { api, context } = cryptoRuntime();
  const read = deferred();
  context.chrome = { storage: { session: { get: () => read.promise } } };
  context.WPConstants = { STORAGE: { roomE2eKey: (id) => `wpRoomE2eKey:${id}` } };
  load(context, 'room-keys.js');
  const keys = vm.runInContext('WPRoomKeys', context);
  let current = true;
  const loading = keys.loadIntoCrypto('room-a', { isCurrent: () => current });
  current = false;
  read.resolve({ 'wpRoomE2eKey:room-a': Buffer.alloc(32, 1).toString('base64url') });
  assert.equal(await loading, null);
  assert.equal(api.isEnabled(), false);
  assert.equal(api.getGeneration(), 0);
});

// Minimal DOM adapter: exercises the production modal callbacks, not a copy of
// their logic. Browser integration remains responsible for layout/popover APIs.
function modalRuntime() {
  const nodes = new Map();
  const timers = new Map();
  let timerId = 0;
  let scheduledIntervals = 0;
  const video = { paused: true, plays: 0, pauses: 0,
    play() { this.plays += 1; return Promise.resolve(); },
    pause() { this.pauses += 1; },
  };
  class Element {
    children = [];
    listeners = new Map();
    textContent = '';
    disabled = false;
    classList = { add() {}, remove() {} };
    set id(value) { this._id = value; nodes.set(value, this); }
    get id() { return this._id; }
    set innerHTML(html) {
      this.html = html;
      for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
        const child = new Element(); child.id = id; this.children.push(child);
      }
      const count = html.match(/id="wp-ready-count">([^<]+)/)?.[1];
      if (count) nodes.get('wp-ready-count').textContent = count;
    }
    appendChild(child) { this.children.push(child); }
    setAttribute() {}
    showPopover() {}
    hidePopover() {}
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    remove() {
      if (nodes.get(this.id) === this) nodes.delete(this.id);
      for (const child of this.children) child.remove();
    }
  }
  const overlay = new Element(); overlay.id = 'wp-overlay';
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id), createElement: () => new Element(), querySelector: () => video },
    setInterval() { scheduledIntervals += 1; return scheduledIntervals; }, clearInterval() {},
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, requestAnimationFrame() {},
    WPConstants: { ACTION: { ROOM_READY_CHECK_UPDATE: 'room.readyCheck.update' } },
  });
  load(context, 'stremio-overlay-modals.js');
  return { api: vm.runInContext('WPModals', context), nodes, video, timers, intervals: () => scheduledIntervals };
}

test('ready confirmation waits for server counts and never schedules its own playback', async () => {
  const { api, nodes, video, intervals } = modalRuntime();
  api.showReadyCheck('started', [], 1, 'session-me', async () => ({ handled: true }));
  const button = nodes.get('wp-ready-confirm');
  await button.listeners.get('click')({ isTrusted: true });
  assert.equal(button.disabled, true);
  assert.equal(nodes.get('wp-ready-count').textContent, '0 / 1');
  assert.ok(nodes.has('wp-ready-modal'));
  assert.equal(intervals(), 0);
  api.showReadyCheck('updated', ['session-me'], 1, 'session-me');
  assert.equal(nodes.get('wp-ready-count').textContent, '1 / 1');
  api.showCountdown(3);
  api.showCountdown(0);
  assert.equal(video.plays, 0, 'only authoritative playback state may start video');
  assert.equal(video.pauses, 0, 'only authoritative playback state may pause video');
});

test('failed ready confirmations remain retryable without incrementing the room count', async () => {
  const { api, nodes } = modalRuntime();
  api.showReadyCheck('started', [], 2, 'session-me', async () => ({ handled: false }));
  const button = nodes.get('wp-ready-confirm');
  await button.listeners.get('click')({ isTrusted: true });
  assert.equal(button.disabled, false);
  assert.equal(nodes.get('wp-ready-count').textContent, '0 / 2');
});

test('late ready confirmation cannot mutate a replacement modal and cancellation clears countdown', async () => {
  const { api, nodes } = modalRuntime();
  const response = deferred();
  api.showReadyCheck('started', [], 2, 'session-me', () => response.promise);
  const previous = nodes.get('wp-ready-confirm');
  const click = previous.listeners.get('click')({ isTrusted: true });
  api.showReadyCheck('cancelled', [], 0, 'session-me');
  api.showReadyCheck('started', [], 3, 'session-me', () => ({ handled: true }));
  const current = nodes.get('wp-ready-confirm');
  response.resolve({ handled: true });
  await click;
  assert.equal(current.disabled, false);
  assert.equal(nodes.get('wp-ready-count').textContent, '0 / 3');
  api.showCountdown(2);
  assert.ok(nodes.has('wp-countdown'));
  api.showReadyCheck('cancelled', [], 0, 'session-me');
  assert.equal(nodes.has('wp-countdown'), false);
});

test('canonical ready confirmation wins over a late rejected transport result', async () => {
  const { api, nodes, timers } = modalRuntime(); const reply = deferred();
  api.showReadyCheck('started', [], 2, 'me', () => reply.promise);
  const button = nodes.get('wp-ready-confirm');
  const sending = button.listeners.get('click')({ isTrusted: true });
  api.showReadyCheck('updated', ['me'], 2, 'me');
  reply.resolve({ handled: false, error: 'late bridge failure' }); await sending;
  assert.equal(button.disabled, true); assert.equal(button.textContent, 'Waiting...');
  assert.equal(nodes.get('wp-ready-count').textContent, '1 / 2');
  assert.equal(timers.size, 0);
});

test('missing bridge response and missing server echo both make ready confirmation retryable', async () => {
  for (const mode of ['bridge', 'echo']) {
    const { api, nodes, timers } = modalRuntime();
    api.showReadyCheck('started', [], 2, 'me', () => mode === 'bridge' ? new Promise(() => {}) : { handled: true });
    const button = nodes.get('wp-ready-confirm');
    const sending = button.listeners.get('click')({ isTrusted: true });
    if (mode === 'echo') await sending;
    [...timers.values()].find(timer => timer.ms === 8000).callback();
    await sending;
    assert.equal(button.disabled, false);
    assert.equal(nodes.get('wp-ready-count').textContent, '0 / 2');
    assert.match(nodes.get('wp-ready-status').textContent, /No response|not received/);
  }
});

test('host cancellation waits for the server and failures stay visible and retryable', async () => {
  const { api, nodes } = modalRuntime(); const reply = deferred(); const commands = [];
  api.showReadyCheck('started', ['me'], 2, 'me', (_action, detail) => { commands.push(detail); return reply.promise; }, { isHost: true });
  const button = nodes.get('wp-ready-stop');
  const cancelling = button.listeners.get('click')({ isTrusted: true });
  assert.equal(button.disabled, true); assert.ok(nodes.has('wp-ready-modal'));
  reply.resolve({ handled: false, error: 'No longer host' }); await cancelling;
  assert.equal(commands[0].readyAction, 'cancel');
  assert.equal(button.disabled, false); assert.equal(nodes.get('wp-ready-status').textContent, 'No longer host');
  api.showReadyCheck('cancelled', [], 0, 'me');
  assert.equal(nodes.has('wp-ready-modal'), false);
});
