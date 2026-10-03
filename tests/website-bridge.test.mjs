import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadBridge({ origin = 'https://watchparty.mertd.me', respond = async () => ({ ok: true }) } = {}) {
  const attrs = new Map(), calls = [], posts = [], timers = new Map(), documentEvents = [];
  const listeners = {}, documentListeners = {};
  let timerId = 0;
  const window = {
    addEventListener(name, fn) { listeners[name] = fn; },
    postMessage(message, target) { posts.push({ message, target }); },
  };
  const document = {
    readyState: 'loading',
    documentElement: { setAttribute(k, v) { attrs.set(k, v); }, removeAttribute(k) { attrs.delete(k); } },
    addEventListener(name, fn) { documentListeners[name] = fn; },
    dispatchEvent(event) { documentEvents.push(event); },
  };
  const chrome = { runtime: {
    id: 'test-extension', getManifest: () => ({ version: '2.0.4' }),
    sendMessage(message) { calls.push(message); return respond(message); },
    onMessage: { addListener(fn) { listeners.runtime = fn; } },
  } };
  const context = vm.createContext({ window, document, chrome, location: { origin }, URL,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); },
  });
  for (const file of ['wp-actions.js', 'constants.js', 'content.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'extension', file), 'utf8'), context, { filename: file });
  }
  return { attrs, calls, posts, timers, chrome, listeners, documentEvents,
    constants: vm.runInContext('WPConstants', context),
    ready: () => documentListeners.DOMContentLoaded(),
    dispatch: (data, options = {}) => listeners.message({ data, source: window, origin, ...options }),
    results: () => posts.filter(({ message }) => message.type === 'watchparty-ext-action-result').map(({ message }) => message),
  };
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('bridge advertises acknowledgment support before page readiness and announces a cached profile', async () => {
  const env = loadBridge({ respond: async () => ({ username: 'Alice', currentRoomId: 'room-one' }) });
  assert.equal(env.attrs.get('data-watchparty-action-results'), '1');
  assert.equal(env.attrs.get('data-watchparty-ext'), '1');
  assert.equal(env.calls.length, 0);
  env.ready();
  await flush();
  assert.equal(env.documentEvents[0].detail.actionResults, true);
  assert.equal(env.posts.find(p => p.message.type === 'watchparty-ext-profile').message.data.username, 'Alice');
  assert.equal(env.timers.size, 0);
});

for (const [type, payload, constant] of [
  ['watchparty-join-room', { roomId: 'room-one', username: 'Alice' }, 'ROOM_JOIN'],
  ['watchparty-resume-room', { roomId: 'room-one' }, 'ROOM_RESUME'],
  ['watchparty-open-options', {}, 'APP_OPTIONS_OPEN'],
  ['watchparty-open-stremio', { url: 'https://web.stremio.com/#/board' }, 'APP_STREMIO_OPEN'],
]) {
  test(`${type} returns a correlated safe acknowledgment and preserves its target`, async () => {
    const env = loadBridge({ respond: async () => ({ ok: true, staged: true, needsStremio: true, accessKey: 'must-not-leak', sessionToken: 'secret' }) });
    await env.dispatch({ type, requestId: 'request-one', ...payload });
    assert.equal(env.calls.length, 1);
    assert.equal(env.calls[0].action, env.constants.ACTION[constant]);
    if (payload.roomId) assert.equal(env.calls[0].roomId, payload.roomId);
    assert.deepEqual(JSON.parse(JSON.stringify(env.results()[0])), {
      type: 'watchparty-ext-action-result', requestId: 'request-one', action: type,
      ok: true, handled: true, staged: true, needsStremio: true,
    });
    assert.equal(env.posts[0].target, 'https://watchparty.mertd.me');
  });
}

test('private invites and direct-join preferences survive forwarding without leaking back', async () => {
  const env = loadBridge();
  await env.dispatch({ type: 'watchparty-join-room', requestId: 'private', roomId: 'private-room',
    username: ' Alice ', accessKey: 'A'.repeat(32), e2eKey: 'B'.repeat(43), preferDirectJoin: true });
  assert.equal(env.calls[0].username, 'Alice');
  assert.equal(env.calls[0].accessKey, 'A'.repeat(32));
  assert.equal(env.calls[0].e2eKey, 'B'.repeat(43));
  assert.equal(env.calls[0].preferDirectJoin, true);
  assert.equal(env.calls[0].backendMode, 'live');
  assert.equal(JSON.stringify(env.results()).includes('A'.repeat(32)), false);
});

test('localhost joins explicitly select local and non-boolean direct requests remain false', async () => {
  const env = loadBridge({ origin: 'http://localhost:8090' });
  await env.dispatch({ type: 'watchparty-join-room', requestId: 'local', roomId: 'local-room', preferDirectJoin: 'true' });
  assert.equal(env.calls[0].backendMode, 'local');
  assert.equal(env.calls[0].preferDirectJoin, false);
});

test('uncorrelated website mutations and the removed website-create route never dispatch', async () => {
  const env = loadBridge();
  await env.dispatch({ type: 'watchparty-join-room', roomId: 'invite-room' });
  await env.dispatch({ type: 'watchparty-create-room', requestId: 'obsolete', username: 'Alice' });
  assert.equal(env.calls.length, 0);
  assert.equal(env.results().length, 0);
});

test('foreign frames, foreign allowed origins, unknown messages, and malformed correlation IDs cannot dispatch', async () => {
  const env = loadBridge();
  const action = { type: 'watchparty-open-options', requestId: 'valid' };
  await env.dispatch(action, { source: {} });
  await env.dispatch(action, { origin: 'http://localhost:8090' });
  await env.dispatch(action, { origin: 'https://example.org' });
  await env.dispatch({ ...action, type: 'unknown' });
  await env.dispatch({ ...action, requestId: {} });
  assert.equal(env.calls.length, 0);
});

for (const data of [
  { type: 'watchparty-join-room', roomId: '' },
  { type: 'watchparty-join-room', roomId: '../wrong' },
  { type: 'watchparty-join-room', roomId: 'valid', accessKey: 'bad-key' },
  { type: 'watchparty-join-room', roomId: 'valid', e2eKey: 123 },
  { type: 'watchparty-join-room', roomId: 'valid', e2eKey: 'a'.repeat(16) },
  { type: 'watchparty-join-room', roomId: 'valid', e2eKey: 'a'.repeat(44) },
  { type: 'watchparty-join-room', roomId: 'valid', username: 'a'.repeat(26) },
  { type: 'watchparty-open-stremio', url: 'javascript:alert(1)' },
  { type: 'watchparty-open-stremio', url: 'https://web.stremio.com.evil.test/' },
  { type: 'watchparty-open-stremio', url: 'https://user:password@web.stremio.com/' },
  { type: 'watchparty-resume-room', roomId: null },
]) {
  test(`invalid website payload is rejected before dispatch: ${JSON.stringify(data)}`, async () => {
    const env = loadBridge();
    await env.dispatch({ ...data, requestId: 'invalid' });
    assert.equal(env.calls.length, 0);
    assert.equal(env.results()[0].ok, false);
    assert.equal(typeof env.results()[0].error, 'string');
  });
}

for (const [label, respond] of [
  ['controller refusal', async () => ({ ok: false, error: 'The room changed.' })],
  ['unhandled response', async () => ({ ok: true, handled: false })],
  ['missing acknowledgment', async () => undefined],
  ['runtime rejection', async () => { throw new Error('Could not open options'); }],
  ['synchronous runtime exception', () => { throw new Error('Could not open options'); }],
]) {
  test(`website actions never claim success for ${label}`, async () => {
    const env = loadBridge({ respond });
    await env.dispatch({ type: 'watchparty-open-options', requestId: 'rejected' });
    assert.equal(env.results()[0].ok, false);
    assert.equal(typeof env.results()[0].error, 'string');
    assert.equal(env.attrs.get('data-watchparty-ext'), '1');
    assert.equal(env.timers.size, 0);
  });
}

test('a hanging action times out visibly and a late reply does not become success or resend', async () => {
  let finish;
  const env = loadBridge({ respond: () => new Promise(resolve => { finish = resolve; }) });
  const data = { type: 'watchparty-join-room', requestId: 'slow', roomId: 'room-one' };
  const pending = env.dispatch(data);
  await flush();
  assert.equal([...env.timers.values()][0].ms, 8000);
  [...env.timers.values()][0].fn();
  await pending;
  assert.match(env.results()[0].error, /Check Stremio before retrying/);
  finish({ ok: true });
  await flush();
  await env.dispatch(data);
  assert.equal(env.calls.length, 1);
  assert.equal(env.results().every(result => result.ok === false), true);
});

test('duplicate pending and completed request IDs do not repeat a join, and collision does not change its action', async () => {
  let finish;
  const env = loadBridge({ respond: () => new Promise(resolve => { finish = resolve; }) });
  const data = { type: 'watchparty-join-room', requestId: 'same', username: 'Alice', roomId: 'join-target' };
  const first = env.dispatch(data), second = env.dispatch(data);
  await flush();
  await env.dispatch({ type: 'watchparty-open-options', requestId: 'same' });
  assert.match(env.results()[0].error, /already used/);
  finish({ ok: true });
  await Promise.all([first, second]);
  await env.dispatch(data);
  assert.equal(env.calls.length, 1);
});

test('invalidated extension context removes presence and reports refresh guidance exactly once', async () => {
  const env = loadBridge({ respond: () => { throw new Error('Extension context invalidated.'); } });
  await env.dispatch({ type: 'watchparty-open-options', requestId: 'expired' });
  await env.dispatch({ type: 'watchparty-open-options', requestId: 'expired-two' });
  assert.equal(env.attrs.has('data-watchparty-ext'), false);
  assert.equal(env.attrs.has('data-watchparty-action-results'), false);
  assert.equal(env.posts.filter(p => p.message.type === 'watchparty-ext-unavailable').length, 1);
  assert.equal(env.results().every(result => /Refresh/.test(result.error)), true);
  assert.equal(env.calls.length, 1);
});

test('status failure is not misrepresented as Stremio being offline, and successful status remains correlated', async () => {
  for (const fail of [false, true]) {
    const env = loadBridge({ respond: async () => { if (fail) throw new Error('Worker unavailable'); return { stremioRunning: true }; } });
    await env.dispatch({ type: 'watchparty-ext-request', action: env.constants.ACTION.STATUS_GET, requestId: 'status' });
    const response = env.posts[0].message;
    assert.equal(response.type, 'watchparty-ext-response');
    assert.equal(response.requestId, 'status');
    assert.equal(response.data.stremioRunning, fail ? undefined : true);
    if (fail) assert.equal(response.data.ok, false);
  }
});

test('profile changes refresh real status and pushed room errors retain correlation fields', async () => {
  const env = loadBridge({ respond: async () => ({ username: 'Updated name', currentRoomId: 'room-new' }) });
  env.listeners.runtime({ type: 'watchparty-ext', action: env.constants.ACTION.PROFILE_UPDATED }, {}, () => {});
  await flush();
  assert.equal(env.posts[0].message.data.username, 'Updated name');
  const payload = { lastRoomError: { code: 'ROOM_NOT_FOUND', command: 'room.join', roomId: 'missing-room' } };
  env.listeners.runtime({ type: 'watchparty-ext', action: env.constants.ACTION.STATUS_UPDATED, payload }, {}, () => {});
  assert.equal(env.posts[1].message.type, 'watchparty-ext-status');
  assert.deepEqual(env.posts[1].message.data, payload);
  let probe;
  env.listeners.runtime({ type: 'watchparty-ext', action: env.constants.ACTION.PROBE_SURFACE }, {}, result => { probe = result; });
  assert.equal(probe.surface, 'watchparty');
});
