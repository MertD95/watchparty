import assert from 'node:assert/strict';
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

test('simultaneous first tabs receive one persisted identity and private token', async () => {
  const context = vm.createContext({});
  load(context, 'session-identity.js');
  const persist = deferred();
  let values = {};
  let writes = 0;
  let ids = 0;
  const identity = vm.runInContext('WPSessionIdentity', context).create({
    storage: {
      async get() { return values; },
      async set(next) { writes += 1; await persist.promise; values = next; },
    },
    randomUUID: () => `uuid-${++ids}`,
    sessionIdKey: 'id', sessionTokenKey: 'token',
  });
  let settled = false;
  const requests = Array.from({ length: 25 }, () => identity.ensure());
  requests[0].then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'credentials must not escape before persistence');
  persist.resolve();
  const results = await Promise.all(requests);
  assert.equal(new Set(results.map((entry) => `${entry.sessionId}:${entry.sessionToken}`)).size, 1);
  assert.equal(writes, 1);
  assert.equal(ids, 2);
  assert.equal((await identity.ensure()).sessionId, values.id);
});

test('failed identity persistence fails closed and allows retry without caching the failure', async () => {
  const context = vm.createContext({});
  load(context, 'session-identity.js');
  let fail = true;
  const identity = vm.runInContext('WPSessionIdentity', context).create({
    storage: { async get() { return { id: 'existing-user' }; }, async set() { if (fail) throw new Error('disk unavailable'); } },
    randomUUID: () => 'new-token', sessionIdKey: 'id', sessionTokenKey: 'token',
  });
  await assert.rejects(identity.ensure(), /disk unavailable/);
  fail = false;
  assert.equal((await identity.ensure()).sessionId, 'existing-user');
});

test('lease responses cannot overrule newer claims, storage elections, or release', () => {
  const context = vm.createContext({});
  load(context, 'stremio-controller-kernel.js');
  const guard = vm.runInContext('WPControllerKernel', context).createLeaseResponseGuard();
  const oldClaim = guard.begin();
  const newClaim = guard.begin();
  assert.equal(guard.isCurrent(oldClaim), false);
  assert.equal(guard.isCurrent(newClaim), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(newClaim), false);
  const afterElection = guard.begin();
  guard.invalidate();
  assert.equal(guard.isCurrent(afterElection), false);
});

function loadSocketRuntime({ packaged = false } = {}) {
  const probe = deferred();
  const sockets = [];
  const timers = new Map();
  let timerId = 0;
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    messages = [];
    constructor(url) { this.url = url; sockets.push(this); }
    send(message) { this.messages.push(JSON.parse(message)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
  }
  const context = vm.createContext({
    console, WebSocket: FakeSocket,
    chrome: { runtime: { getManifest: () => ({ host_permissions: packaged ? ['http://localhost:11470/*'] : ['http://localhost:8181/*'] }), sendMessage: () => probe.promise } },
    WPRuntimeClock: {
      now: () => 1000, random: () => 0,
      setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
      clearTimeout: (id) => timers.delete(id),
      setInterval: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
      clearInterval: (id) => timers.delete(id),
    },
    WPSync: { setClockOffset() {} },
  });
  for (const file of ['wp-actions.js', 'constants.js', 'wp-protocol.js', 'stremio-ws.js']) load(context, file);
  return { api: vm.runInContext('WPWS', context), context, probe, sockets, timers };
}

test('concurrent connect calls during the localhost probe create exactly one socket', async () => {
  const { api, probe, sockets } = loadSocketRuntime();
  const requests = Array.from({ length: 15 }, () => api.connect());
  probe.resolve({ ok: true });
  await Promise.all(requests);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'ws://localhost:8181');
});

test('unpacked production packages connect directly to production without a development probe', { timeout: 1000 }, async () => {
  const { api, sockets } = loadSocketRuntime({ packaged: true });
  await api.connect();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'wss://ws.mertd.me');
});

test('controller release while a backend probe is pending cannot resurrect its socket', async () => {
  const { api, probe, sockets, timers } = loadSocketRuntime();
  const pending = api.connect();
  api.disconnect();
  probe.resolve({ ok: true });
  await pending;
  assert.equal(sockets.length, 0);
  assert.equal(timers.size, 0);
});

test('callbacks already queued by an obsolete socket cannot clear its replacement', async () => {
  const { api, sockets, timers } = loadSocketRuntime();
  api.setBackendMode('local');
  await api.connect();
  const old = sockets[0];
  old.open();
  const lateClose = old.onclose;
  const lateMessage = old.onmessage;
  const lateOpen = old.onopen;
  let received = 0;
  api.onMessage(() => { received += 1; });
  api.disconnect();
  await api.connect();
  sockets[1].open();
  api.markApplicationReady();
  lateClose();
  lateOpen();
  lateMessage({ data: JSON.stringify({ type: 'obsolete-message', seq: 999 }) });
  assert.equal(api.isConnected(), true);
  assert.equal(api.isApplicationReady(), true);
  assert.equal(received, 0);
  assert.equal(api.getLastSeq(), 0);
  assert.equal(timers.size, 1, 'only the current socket keepalive is scheduled');
});

test('a backend mode change cannot be overwritten by an older automatic probe', async () => {
  const { api, probe, sockets } = loadSocketRuntime();
  const oldConnection = api.connect();
  api.setBackendMode('live');
  api.disconnect();
  await api.connect();
  probe.resolve({ ok: true });
  await oldConnection;
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'wss://ws.mertd.me');
  assert.equal(api.getActiveBackend(), 'live');
});

test('unexpected socket closure cancels all old clock and heartbeat timers', async () => {
  const { api, sockets, timers } = loadSocketRuntime();
  api.setBackendMode('local');
  await api.connect();
  sockets[0].open();
  api.startClockSync();
  assert.ok(timers.size > 1);
  sockets[0].close();
  assert.equal(timers.size, 1, 'only the reconnect timer remains');
  api.disconnect();
  assert.equal(timers.size, 0);
});

test('publisher fence is durable across browser-session storage resets', () => {
  const { context } = loadSocketRuntime();
  load(context, 'runtime-state.js');
  assert.equal(vm.runInContext('WPRuntimeState.isSessionKey(WPConstants.STORAGE.CONTROLLER_FENCE)', context), false);
  assert.equal(vm.runInContext('WPConstants.STORAGE_CONTRACT.DURABLE.includes(WPConstants.STORAGE.CONTROLLER_FENCE)', context), true);
});

test('shared session credentials are restricted to the Stremio content script route', () => {
  const { context } = loadSocketRuntime();
  for (const source of ['watchparty-bridge', 'popup', 'sidepanel', 'options']) {
    context.source = source;
    assert.equal(vm.runInContext('WPActionContract.isAllowedSource(WPAction.SESSION_IDENTITY_GET, source)', context), false);
  }
  assert.equal(vm.runInContext("WPActionContract.isAllowedSource(WPAction.SESSION_IDENTITY_GET, 'stremio-content')", context), true);
});

test('offline bootstrap commands are reconstructed, never replayed after a new handshake', async () => {
  const { api, sockets } = loadSocketRuntime();
  api.setBackendMode('local');
  await api.connect();
  assert.equal(api.send({ type: 'room.join', payload: { id: 'old-room' } }), false);
  sockets[0].open();
  api.send({ type: 'room.join', payload: { id: 'new-room' } });
  api.markApplicationReady();
  assert.deepEqual(sockets[0].messages.map((message) => message.payload.id), ['new-room']);
});

test('queued room actions cannot leak from a disconnected old room into a new room', async () => {
  const { api, sockets } = loadSocketRuntime();
  api.setBackendMode('local');
  await api.connect();
  sockets[0].open();
  api.setRoomScope('room-a');
  assert.equal(api.send({ type: 'room.chat.send', payload: { content: 'room-a only' } }), true);
  api.setRoomScope('room-b');
  api.markApplicationReady();
  assert.equal(sockets[0].messages.length, 0);
});

test('delayed actions from a released controller are dropped, not retained for its future election', async () => {
  const { api, sockets } = loadSocketRuntime();
  api.setBackendMode('local');
  await api.connect();
  sockets[0].open();
  const connectedGeneration = api.getConnectionGeneration();
  sockets[0].close();
  assert.notEqual(api.getConnectionGeneration(), connectedGeneration);
  api.disconnect();
  assert.equal(api.send({ type: 'room.chat.send', payload: { content: 'stale' } }), false);
  await api.connect();
  sockets[1].open();
  api.markApplicationReady();
  assert.equal(sockets[1].messages.length, 0);
});

test('only the currently leased content instance can overwrite the shared worker projection', () => {
  const { context } = loadSocketRuntime();
  context.structuredClone = structuredClone;
  load(context, 'background-coordinator-kernel.js');
  const kernel = vm.runInContext('WPCoordinatorKernel', context);
  const lease = { tabId: 12, leaseId: 'new-content-instance' };
  assert.equal(kernel.isCurrentControllerPublication(lease, { controllerLeaseId: 'new-content-instance' }, 12), true);
  assert.equal(kernel.isCurrentControllerPublication(lease, { controllerLeaseId: 'new-content-instance' }, 11), false);
  assert.equal(kernel.isCurrentControllerPublication(lease, { controllerLeaseId: 'old-content-instance' }, 12), false);
  assert.equal(kernel.isCurrentControllerPublication(lease, {}, 12), false);
  assert.equal(kernel.isCurrentControllerPublication(null, { controllerLeaseId: 'new-content-instance' }, 12), false);
});

test('a restarted worker preserves its persisted room when its first event is a lease renewal', () => {
  const { context } = loadSocketRuntime();
  context.structuredClone = structuredClone;
  load(context, 'background-coordinator-kernel.js');
  const kernel = vm.runInContext('WPCoordinatorKernel', context);
  const constants = vm.runInContext('WPConstants', context);
  const lease = constants.CONTROLLER_TAB_LEASE.build({ leaseId: 'controller', tabId: 12, sessionId: 'session' });
  const state = kernel.restoreFromStorage({
    [constants.STORAGE.CONTROLLER_TAB]: lease,
    [constants.STORAGE.ROOM_STATE]: { id: 'room-a', users: [] },
    [constants.STORAGE.SESSION_ID]: 'session',
    [constants.STORAGE.USER_ID]: 'user',
    [constants.STORAGE.WS_CONNECTED]: true,
  });
  const renewed = kernel.reduce(state, { type: 'controller.lease.claim', tabId: 12, payload: { tabId: 12 } }, 2000);
  assert.equal(renewed.room.id, 'room-a');
  assert.equal(renewed.sessionId, 'session');
  assert.equal(renewed.wsConnected, true);
  assert.equal(renewed.invariants.length, 0);
});
