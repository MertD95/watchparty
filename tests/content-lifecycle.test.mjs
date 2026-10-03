import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Execute the real orchestrator, with browser effects stubbed and startup held
// until DOMContentLoaded. Test-only lexical access does not ship in the bundle.
function runtime() {
  const sent = [];
  const rendered = [];
  const storage = {};
  const callbacks = {};
  const backgroundMessages = [];
  const timers = [];
  let now = 1000;
  let randomId = 0;
  let connected = true;
  let ready = false;
  let generation = 1;
  let cryptoGeneration = 1;
  const crypto = {
    isEnabled: () => true,
    getGeneration: () => cryptoGeneration,
    isEncrypted: (value) => value.startsWith('enc:'),
    encrypt: async (value) => `enc:${value}`,
    decrypt: async (value) => value.slice(4),
    decryptResult: async (value) => ({ ok: true, content: await crypto.decrypt(value) }),
    clear: () => { cryptoGeneration += 1; },
    importKey: async () => {},
    onKeyLoaded: (cb) => { callbacks.keyLoaded = cb; },
  };
  const overlay = new Proxy({
    setActionDispatcher: (fn) => { callbacks.dispatch = fn; },
    appendChatMessage: (message) => rendered.push(message),
  }, { get: (target, key) => target[key] || (() => {}) });
  const socket = {
    isReady: () => connected, isConnected: () => connected,
    isApplicationReady: () => ready,
    markApplicationReady: () => { ready = true; }, markApplicationPending: () => { ready = false; },
    getConnectionGeneration: () => generation,
    getLastSeq: () => 7, clearQueue() {}, setRoomScope() {}, startClockSync() {},
    setServerCapabilities() {}, supportsCapability: () => true,
    getActiveBackend: () => 'local', getActiveWsUrl: () => 'ws://localhost:8181',
    setBackendMode: () => false,
    send: (msg) => { sent.push(msg); return true; },
    onConnect: (fn) => { callbacks.connect = fn; },
    onDisconnect: (fn) => { callbacks.disconnect = fn; },
    onMessage: (fn) => { callbacks.message = fn; },
    disconnect: () => { connected = false; generation += 1; callbacks.disconnect(); },
  };
  const context = vm.createContext({
    console, URL, structuredClone, AbortSignal,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++randomId).padStart(12, '0')}` },
    chrome: {
      runtime: { id: 'extension-id', onMessage: { addListener() {} }, sendMessage: async (message) => { backgroundMessages.push(message); return {}; } },
      storage: { onChanged: { addListener: (fn) => { callbacks.storage = fn; } } },
    },
    document: { body: null, addEventListener: (type, fn) => { callbacks[`document:${type}`] = fn; }, getElementById: () => null, querySelectorAll: () => [] },
    window: { addEventListener() {}, location: { hash: '#/player/test', origin: 'https://web.stremio.com' } },
    WPOverlay: overlay, WPWS: socket, WPCrypto: crypto,
    WPProfile: { start() {}, stop: async () => {} },
    WPRuntimeClock: { now: () => now, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
    WPRuntimeState: { get: async () => ({ ...storage }), set: async () => {}, remove: async () => {} },
    WPRoomKeys: { getAccessKey: async () => null, getInviteAccessToken: async () => null,
      getE2eKey: async () => null, setKeys: async () => {}, loadIntoCrypto: async () => {}, remove: async () => {} },
    WPPrivateRoomKeys: { normalize: (value) => value || null },
    WPStremioAdapter: { getCurrentContentContext: () => ({ launchUrl: null, meta: null }), getCurrentLaunchUrl: () => null, buildRuntimeSnapshot: () => ({}) },
    WPSync: new Proxy({}, { get: () => () => {} }),
  });
  for (const file of ['wp-actions.js', 'constants.js', 'wp-protocol.js', 'wp-room-domain.js', 'stremio-runtime-model.js', 'stremio-controller-kernel.js', 'playback-timeline.js', 'utils.js']) {
    vm.runInContext(fs.readFileSync(path.join(extension, file), 'utf8'), context, { filename: file });
  }
  const source = fs.readFileSync(path.join(extension, 'stremio-content.js'), 'utf8');
  const instrumented = source.replace(/\}\)\(\);\s*$/, `globalThis.testContent = {
    processPendingActions, joinRoomFromCommand, createRoomFromCommand, shareContentLink, onChatMessage,
    stagePendingRoomJoinCommand, applyLocalLeaveState, handleAction, commitRoomState, applyPlaybackUpdate, attachSync,
    applySharedRuntimeProjection, applyPassiveChatMessage, applyPassiveReadyCheck, nativeMatchesRoomMedia, syncPeerVideoToRoom,
    beginSessionRecovery, completeSessionRecovery, refreshControllerLease, refreshActiveVideoLease,
    getState() { return { room: roomState, inRoom, isHost, resumeRoomPending, recoverySuspended, sessionId, sessionToken, isControllerTab }; },
    setState(value) {
      if ('room' in value) roomState = value.room;
      if ('inRoom' in value) inRoom = value.inRoom;
      if ('controller' in value) isControllerTab = value.controller;
      if ('active' in value) isActiveVideoTab = value.active;
      if ('host' in value) isHost = value.host;
      if ('video' in value) video = value.video;
      if ('lease' in value) controllerLease = value.lease;
      sessionId = 'session'; sessionToken = 'secret'; userId = 'user';
    },
  }; })();`);
  vm.runInContext(instrumented, context, { filename: 'stremio-content.js' });
  const api = context.testContent;
  api.setState({ room: { id: 'room-a', public: false, ownerSessionId: 'session', users: [{ id: 'user', sessionId: 'session', name: 'Alice' }] }, inRoom: true, controller: true, active: true });
  return { api, context, callbacks, socket, crypto, sent, rendered, storage, backgroundMessages, timers,
    setNow(value) { now = value; } };
}

test('socket open and concurrent bootstrap wakeups produce exactly one rejoin', async () => {
  const { api, callbacks, sent, storage, context } = runtime();
  context.WPRoomKeys.getE2eKey = async () => 'existing-room-key';
  storage[vm.runInContext('WPConstants.STORAGE.CURRENT_ROOM', context)] = 'room-a';
  callbacks.connect();
  await Promise.all(Array.from({ length: 12 }, () => api.processPendingActions()));
  assert.deepEqual(sent.filter((msg) => msg.type === 'room.join' || msg.type === 'room.rejoin').map((msg) => msg.type), ['room.rejoin']);
});

test('a join waiting for keys cannot send after its controller has been deposed', async () => {
  const { api, context, sent } = runtime();
  const key = deferred();
  context.WPRoomKeys.getAccessKey = () => key.promise;
  const pending = api.joinRoomFromCommand({ roomId: 'room-b', username: 'Alice' });
  api.setState({ controller: false });
  key.resolve(null);
  await pending;
  assert.equal(sent.length, 0);
});

test('a newer room intent invalidates an earlier async join', async () => {
  const { api, context, sent } = runtime();
  const key = deferred();
  context.WPRoomKeys.getAccessKey = () => key.promise;
  const pending = api.joinRoomFromCommand({ roomId: 'room-b', username: 'Alice' });
  api.stagePendingRoomJoinCommand({ roomId: 'room-c', username: 'Alice' });
  key.resolve(null);
  await pending;
  assert.equal(sent.length, 0);
});

test('private chat without its encryption key fails closed and reports failure to the overlay', async () => {
  const { socket, crypto, callbacks, context, sent } = runtime();
  socket.markApplicationReady();
  crypto.isEnabled = () => false;
  const action = vm.runInContext('WPConstants.ACTION.ROOM_CHAT_SEND', context);
  const result = await callbacks.dispatch({ action, content: 'private secret' });
  assert.equal(result.handled, false);
  assert.match(result.error, /key is missing/);
  assert.equal(sent.length, 0);
});

test('private chat encryption finishing after a room switch cannot send to the new room', async () => {
  const { api, socket, crypto, callbacks, context, sent } = runtime();
  socket.markApplicationReady();
  const ciphertext = deferred();
  crypto.encrypt = () => ciphertext.promise;
  const action = vm.runInContext('WPConstants.ACTION.ROOM_CHAT_SEND', context);
  const pending = callbacks.dispatch({ action, content: 'private secret' });
  api.setState({ room: { id: 'room-b', public: false } });
  ciphertext.resolve('enc:private secret');
  assert.equal((await pending).handled, false);
  assert.equal(sent.length, 0);
});

test('decryption finishing after a room switch cannot display or relay old-room chat', async () => {
  const { api, crypto, rendered } = runtime();
  const plaintext = deferred();
  crypto.decrypt = () => plaintext.promise;
  const pending = api.onChatMessage({ id: 'message-a', content: 'enc:secret', user: 'other' }, { persist: false });
  api.setState({ room: { id: 'room-b', public: false } });
  plaintext.resolve('secret');
  await pending;
  assert.equal(rendered.length, 0);
});

test('preparing a private join does not replace the active key before membership is acknowledged', async () => {
  const { api, crypto } = runtime();
  const originalGeneration = crypto.getGeneration();
  const imported = [];
  crypto.importKey = async (key) => { imported.push(key); };
  await api.joinRoomFromCommand({ roomId: 'room-b', username: 'Alice', accessKey: 'access-b', e2eKey: 'key-b' });
  assert.equal(crypto.getGeneration(), originalGeneration);
  assert.equal(imported.length, 0, 'failed/rejected joins leave room A crypto untouched');
  api.commitRoomState({ id: 'room-b', public: false, users: [] }, { refreshOverlay: false });
  assert.deepEqual(imported, ['key-b']);
});

test('content resolved after route navigation is not published into the room', async () => {
  const { api, socket, context, sent } = runtime();
  socket.markApplicationReady();
  let route = 'https://web.stremio.com/#/player/first';
  context.WPStremioAdapter.getCurrentContentContext = () => ({ launchUrl: route, meta: null });
  const resolution = deferred();
  context.WPDirectPlay = { normalizeSharedStream: () => resolution.promise, buildJoinHint: () => null };
  const pending = api.shareContentLink();
  route = 'https://web.stremio.com/#/player/second';
  resolution.resolve({ url: 'https://media.example/first.mp4' });
  await pending;
  assert.equal(sent.length, 0);
});

test('failed ready command remains a failure through the content dispatcher', async () => {
  const { socket, callbacks, context } = runtime();
  socket.send = () => false;
  const action = vm.runInContext('WPConstants.ACTION.ROOM_READY_CHECK_UPDATE', context);
  const result = await callbacks.dispatch({ action, readyAction: 'confirm' });
  assert.equal(result.handled, false);
});

test('bookmarks reject missing media and use the selected player rather than an earlier preview', async () => {
  const app = runtime();
  const add = vm.runInContext('WPConstants.ACTION.ROOM_BOOKMARK_ADD', app.context);
  const seek = vm.runInContext('WPConstants.ACTION.ROOM_BOOKMARK_SEEK', app.context);
  app.socket.markApplicationReady();
  assert.equal((await app.callbacks.dispatch({ action: add })).handled, false);
  assert.equal((await app.callbacks.dispatch({ action: seek, time: 18 })).handled, false);
  assert.equal(app.sent.length, 0);
  const selected = { isConnected: true, currentTime: 42 };
  app.api.setState({ video: selected });
  assert.equal((await app.callbacks.dispatch({ action: add })).handled, true);
  assert.equal(app.sent.at(-1).payload.time, 42);
  assert.equal(app.sent.at(-1).payload.roomId, 'room-a');
  assert.equal((await app.callbacks.dispatch({ action: seek, time: 18 })).handled, true);
  assert.equal(selected.currentTime, 18);
});

test('room controls reject an old visible room target before sending any command', async () => {
  const app = runtime();
  for (const name of ['ROOM_BOOKMARK_ADD', 'ROOM_SETTINGS_UPDATE', 'ROOM_READY_CHECK_UPDATE', 'ROOM_REACTION_SEND', 'ROOM_LEAVE']) {
    const action = vm.runInContext(`WPConstants.ACTION.${name}`, app.context);
    const result = await app.callbacks.dispatch({ action, roomId: 'old-room', readyAction: 'initiate', settings: {}, emoji: '😀' });
    assert.equal(result.handled, false, name);
  }
  assert.equal(app.sent.length, 0);
});

test('passive ready check and countdown relays are room scoped and do not echo into controller', () => {
  const app = runtime();
  const shown = [];
  app.context.WPOverlay.showReadyCheck = (...args) => shown.push(['check', ...args]);
  app.context.WPOverlay.showCountdown = value => shown.push(['countdown', value]);
  app.api.setState({ controller: false });
  app.api.applyPassiveReadyCheck({ roomId: 'room-a', kind: 'state', action: 'started', confirmed: [], total: 2 });
  app.api.applyPassiveReadyCheck({ roomId: 'room-a', kind: 'countdown', seconds: 3 });
  assert.equal(shown.length, 2);
  app.api.applyPassiveReadyCheck({ roomId: 'other-room', kind: 'countdown', seconds: 2 });
  app.api.setState({ controller: true });
  app.api.applyPassiveReadyCheck({ roomId: 'room-a', kind: 'state', action: 'started' });
  assert.equal(shown.length, 2);
});

test('new passive tab restores an ongoing ready check from the shared snapshot', () => {
  const app = runtime();
  const shown = [];
  app.context.WPOverlay.showReadyCheck = (...args) => shown.push(args);
  app.api.setState({ controller: false });
  app.api.applySharedRuntimeProjection({ room: { id: 'room-a', public: true, users: [], readyCheck: { confirmed: ['session'], total: 2 } } });
  assert.equal(shown[0][0], 'started');
  assert.equal(shown[1][0], 'updated');
  app.api.applySharedRuntimeProjection({ room: { id: 'room-a', public: true, users: [], readyCheck: { confirmed: ['session'], total: 2 } } });
  assert.equal(shown.length, 2, 'unrelated state refresh must not reopen the dialog');
});

test('public to private transition is blocked while other members would lose access to the chat key', async () => {
  const { api, callbacks, context, sent, socket } = runtime();
  socket.markApplicationReady();
  api.setState({ room: { id: 'room-a', public: true, users: [{ id: 'user' }, { id: 'peer' }] } });
  const action = vm.runInContext('WPConstants.ACTION.ROOM_VISIBILITY_UPDATE', context);
  const result = await callbacks.dispatch({ action, public: false });
  assert.equal(result.handled, false);
  assert.equal(sent.length, 0);
});

test('host applies explicit server authority including equal-sequence recovery, not its delayed own echo', () => {
  const { api, context } = runtime();
  const applied = [];
  context.WPSync = { applyRemote: (player, options) => applied.push({ player, options }) };
  const player = { paused: true, time: 30, speed: 1, buffering: false, timeline: { epoch: 'epoch-a', sequence: 2, sampledAtServer: 1000 } };
  api.setState({ room: { id: 'room-a', player }, host: true, video: {} });
  assert.equal(api.applyPlaybackUpdate({ player, authority: 'server' }), true);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].options.authoritative, true);
  api.applyPlaybackUpdate({ player: { ...player, paused: false, timeline: { ...player.timeline, sequence: 3 } } });
  assert.equal(applied.length, 1, 'a normal publisher echo cannot override a newer local control');
});

test('encrypted chat containing the literal legacy placeholder is a real displayable message', async () => {
  const { api, rendered } = runtime();
  await api.onChatMessage({ id: 'message-a', content: 'enc:[encrypted message]', user: 'other' }, { persist: false, relay: false });
  assert.equal(rendered[0].content, '[encrypted message]');
});

test('a host snapshot received before native video exists restores paused position before publishing autoplay', () => {
  const { api, callbacks, context, sent } = runtime();
  let attached = false;
  let attachedVideo;
  let syncOptions;
  const restored = [];
  context.WPSync = new Proxy({
    isAttached: () => attached,
    attach: (video, options) => { attached = true; attachedVideo = video; syncOptions = options; },
    applyRemote: (player, options) => {
      restored.push({ player, options });
      attachedVideo.currentTime = player.time;
      attachedVideo.paused = player.paused;
      return true;
    },
  }, { get: (target, key) => target[key] || (() => {}) });
  const player = { time: 25, paused: true, buffering: false, speed: 1,
    timeline: { epoch: 'reload', sequence: 177, sampledAtServer: 1000 } };
  callbacks.message({ type: 'room.snapshot', payload: {
    id: 'room-a', public: true, owner: 'user', ownerSessionId: 'session', users: [], player,
  } });
  assert.equal(restored.length, 0, 'no native video exists yet');
  const listeners = new Map();
  const nativeVideo = {
    readyState: 0, paused: false, currentTime: 0.264,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
  };
  api.setState({ video: nativeVideo, host: true });
  api.attachSync();
  syncOptions.onSync({ paused: false, time: 0.264, buffering: true });
  assert.equal(sent.filter((message) => message.type === 'room.playback.publish').length, 0);
  nativeVideo.readyState = 4;
  listeners.get('canplay')();
  assert.equal(nativeVideo.paused, true);
  assert.equal(nativeVideo.currentTime, 25);
  assert.equal(restored[0].options.authoritative, true);
  assert.equal(listeners.size, 0, 'readiness listeners are removed after restoration');
});

function deferredHostVideo(player, apply) {
  const app = runtime();
  let attached = false;
  let syncOptions;
  const restored = [];
  const nativeVideo = { readyState: 4, paused: false, currentTime: 0,
    addEventListener() {}, removeEventListener() {} };
  app.context.WPSync = new Proxy({
    isAttached: () => attached,
    attach: (_video, options) => { attached = true; syncOptions = options; },
    applyRemote: (frame) => {
      restored.push(frame);
      if (apply && !apply(frame)) return false;
      nativeVideo.currentTime = frame.time;
      nativeVideo.paused = frame.paused;
      return true;
    },
  }, { get: (target, key) => target[key] || (() => {}) });
  app.callbacks.message({ type: 'room.snapshot', payload: {
    id: 'room-a', public: true, owner: 'user', ownerSessionId: 'session', users: [], player,
  } });
  return { ...app, nativeVideo, restored,
    attach() { app.api.setState({ video: nativeVideo, host: true }); app.api.attachSync(); },
    publish(state) { syncOptions.onSync(state); },
  };
}

test('content switching during host startup replaces the deferred old-epoch position', () => {
  const oldPlayer = { time: 125, paused: true, buffering: false, speed: 1,
    timeline: { epoch: 'old-content', sequence: 99, sampledAtServer: 1000 } };
  const nextPlayer = { time: 0, paused: true, buffering: true, speed: 1,
    timeline: { epoch: 'new-content', sequence: 1, sampledAtServer: 1100 } };
  const app = deferredHostVideo(oldPlayer);
  app.callbacks.message({ type: 'room.content.updated', payload: {
    stream: { url: 'https://media.example/new.mp4' }, player: nextPlayer,
  } });
  app.nativeVideo.currentSrc = 'https://media.example/new.mp4';
  app.attach();
  assert.equal(app.nativeVideo.currentTime, 0);
  assert.equal(app.restored.length, 1);
  assert.equal(app.restored[0].timeline.epoch, 'new-content');
  assert.equal(app.api.applyPlaybackUpdate({ player: oldPlayer, authority: 'server' }), false);
  assert.equal(app.nativeVideo.currentTime, 0, 'a delayed retired epoch cannot revive the old position');
});

test('a fresh projected same-sequence response unlocks slow-starting host media without publishing startup time', () => {
  const stale = { time: 25, paused: false, buffering: false, speed: 1,
    timeline: { epoch: 'content-a', sequence: 99, sampledAtServer: 1000 } };
  const app = deferredHostVideo(stale, (frame) => frame.timeline.sampledAtServer >= 21000);
  app.attach();
  app.publish({ time: 0, paused: false, buffering: false, speed: 1 });
  assert.equal(app.sent.filter((message) => message.type === 'room.playback.request').length, 1);
  assert.equal(app.sent.filter((message) => message.type === 'room.playback.publish').length, 0);
  const fresh = { ...stale, time: 45, timeline: { ...stale.timeline, sampledAtServer: 21000 } };
  app.callbacks.message({ type: 'room.playback.updated', payload: { player: fresh } });
  assert.equal(app.nativeVideo.currentTime, 45);
  app.publish({ time: 46, paused: false, buffering: false, speed: 1 });
  const publishes = app.sent.filter((message) => message.type === 'room.playback.publish');
  assert.equal(publishes.length, 1, 'normal host publishing resumes only after fresh authority applies');
  assert.equal(publishes[0].payload.player.time, 46);
});

test('room errors reach the pending lobby feedback surface', () => {
  const app = runtime();
  const errors = [];
  app.context.WPOverlay.showRoomError = (payload) => errors.push(payload);
  app.callbacks.message({ type: 'room.error', payload: { code: 'INVALID_ROOM_KEY', message: 'Invalid key' } });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'INVALID_ROOM_KEY');
});

test('private resume without the session-only chat key clears cached membership but retains invite recovery keys', async () => {
  const app = runtime();
  let removedKeys = 0;
  let detached = 0;
  const panels = [];
  app.context.WPRoomKeys.remove = async () => { removedKeys += 1; };
  app.context.WPSync = { detach: () => { detached += 1; } };
  app.context.WPOverlay.openSidebar = (panel) => panels.push(panel);
  await app.api.joinRoomFromCommand({ roomId: 'room-a', accessKey: 'existing-access-key' }, {}, { replay: true });
  const state = app.api.getState();
  assert.equal(state.inRoom, false);
  assert.equal(state.room, null);
  assert.equal(state.isHost, false);
  assert.equal(state.resumeRoomPending, false);
  assert.equal(removedKeys, 0, 'access/invite credentials remain available for full-invite recovery');
  assert.equal(detached, 1, 'cached playback authority is removed');
  assert.deepEqual(panels, ['room'], 'open the actual room lobby panel, not a nonexistent rooms tab');
  assert.equal(app.sent.length, 0, 'no join or leave is sent for membership this socket never acquired');
  assert.equal(app.socket.isApplicationReady(), true);
});

test('a failed private-room switch with a missing chat key does not clear the still-live original room', async () => {
  const app = runtime();
  app.socket.markApplicationReady();
  let removedKeys = 0;
  app.context.WPRoomKeys.remove = async () => { removedKeys += 1; };
  const cryptoGeneration = app.crypto.getGeneration();
  await app.api.joinRoomFromCommand({ roomId: 'room-b', accessKey: 'target-access-key' });
  const state = app.api.getState();
  assert.equal(state.inRoom, true);
  assert.equal(state.room.id, 'room-a');
  assert.equal(removedKeys, 0);
  assert.equal(app.crypto.getGeneration(), cryptoGeneration);
  assert.equal(app.sent.length, 0);
  assert.equal(app.socket.isApplicationReady(), true);
});

test('late public-room storage cleanup cannot clear the next room crypto context', async () => {
  const app = runtime();
  const removing = deferred();
  app.context.WPRoomKeys.remove = () => removing.promise;
  app.callbacks.message({ type: 'room.visibility.updated', payload: { public: true, visibility: 'public', listed: true } });
  app.api.commitRoomState({ id: 'room-b', public: false, users: [] }, { refreshOverlay: false });
  const generationB = app.crypto.getGeneration();
  removing.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.crypto.getGeneration(), generationB);
});

test('confirmed private-room keys install before storage awaits and cannot revive after switching rooms', async () => {
  const app = runtime();
  app.socket.markApplicationReady();
  app.api.setState({ room: { id: 'room-a', public: true, users: [] } });
  app.context.WPRoomKeys.getAccessKey = async () => 'access-a';
  app.context.WPRoomKeys.getE2eKey = async () => 'key-a';
  const cache = deferred();
  app.context.WPRoomKeys.setKeys = () => cache.promise;
  const imports = [];
  app.crypto.importKey = async (key) => { imports.push({ key, room: app.api.getState().room.id }); };
  const action = vm.runInContext('WPConstants.ACTION.ROOM_VISIBILITY_UPDATE', app.context);
  assert.equal((await app.callbacks.dispatch({ action, public: false })).handled, true);
  app.callbacks.message({ type: 'room.visibility.updated', payload: { public: false, visibility: 'invite-only', listed: true } });
  assert.deepEqual(imports, [{ key: 'key-a', room: 'room-a' }]);
  app.api.commitRoomState({ id: 'room-b', public: false, users: [] }, { refreshOverlay: false });
  const generationB = app.crypto.getGeneration();
  cache.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(imports.length, 1);
  assert.equal(app.crypto.getGeneration(), generationB);
});

for (const transition of ['room', 'controller', 'fence', 'newer-action']) {
  test(`a visibility key lookup is cancelled after ${transition} changes`, async () => {
    const app = runtime();
    app.socket.markApplicationReady();
    app.api.setState({ room: { id: 'room-a', public: true, users: [] }, lease: { leaseId: 'tab-a', fence: 5 } });
    const key = deferred();
    app.context.WPRoomKeys.getAccessKey = () => key.promise;
    app.context.WPRoomKeys.getE2eKey = async () => 'key-a';
    const action = vm.runInContext('WPConstants.ACTION.ROOM_VISIBILITY_UPDATE', app.context);
    const pending = app.callbacks.dispatch({ action, public: false });
    if (transition === 'room') app.api.setState({ room: { id: 'room-b', public: true, users: [] } });
    if (transition === 'controller') app.api.setState({ controller: false });
    if (transition === 'fence') app.api.setState({ lease: { leaseId: 'tab-a', fence: 6 } });
    if (transition === 'newer-action') await app.callbacks.dispatch({ action, public: true });
    key.resolve('access-a');
    assert.equal((await pending).handled, false);
    assert.equal(app.sent.some((msg) => msg.type === 'room.visibility.update' && msg.payload.public === false), false);
  });
}

test('a rejected room switch retains acknowledged membership, key and host despite intervening old-room deltas', async () => {
  const app = runtime();
  app.socket.markApplicationReady();
  app.api.setState({ host: true });
  const cryptoGeneration = app.crypto.getGeneration();
  await app.api.joinRoomFromCommand({ roomId: 'missing-room', username: 'Alice' });
  app.callbacks.message({ type: 'room.settings.updated', payload: { settings: { autoPause: true } } });
  app.callbacks.message({ type: 'room.error', payload: { command: 'room.join', roomId: 'missing-room', code: 'ROOM_NOT_FOUND' } });
  assert.equal(app.api.getState().room.id, 'room-a');
  assert.equal(app.api.getState().inRoom, true);
  assert.equal(app.api.getState().isHost, true);
  assert.equal(app.crypto.getGeneration(), cryptoGeneration);
  assert.equal(app.socket.isApplicationReady(), true);
  assert.equal(app.sent.some((message) => message.type === 'room.leave'), false);
});

test('a rejected cached rejoin clears stale membership rather than retaining an unauthenticated host', async () => {
  const app = runtime();
  app.api.setState({ room: { id: 'room-a', public: true, users: [], owner: 'user' }, host: true });
  await app.api.joinRoomFromCommand({ roomId: 'room-a', username: 'Alice' }, {}, { replay: true });
  app.callbacks.message({ type: 'room.error', payload: { command: 'room.rejoin', roomId: 'room-a', code: 'ROOM_NOT_FOUND' } });
  assert.equal(app.api.getState().room, null);
  assert.equal(app.api.getState().inRoom, false);
  assert.equal(app.api.getState().isHost, false);
});

test('an error for an older join target cannot finish the newer pending transition', async () => {
  const app = runtime();
  app.socket.markApplicationReady();
  await app.api.joinRoomFromCommand({ roomId: 'room-b', username: 'Alice' });
  await app.api.joinRoomFromCommand({ roomId: 'room-c', username: 'Alice' });
  app.callbacks.message({ type: 'room.error', payload: { command: 'room.join', roomId: 'room-b', code: 'ROOM_NOT_FOUND' } });
  assert.equal(app.socket.isApplicationReady(), false);
  assert.equal(app.api.getState().room.id, 'room-a');
});

function contentPublishingRuntime() {
  const app = runtime();
  app.socket.markApplicationReady();
  app.context.WPStremioAdapter.getCurrentContentContext = () => ({ launchUrl: 'https://web.stremio.com/#/player/current', meta: null });
  app.context.WPDirectPlay = { normalizeSharedStream: async (stream) => stream, buildJoinHint: () => null };
  return app;
}

test('content publication deduplication is scoped to room and controller fence', async () => {
  const app = contentPublishingRuntime();
  app.api.setState({ lease: { leaseId: 'tab-a', fence: 5 } });
  await app.api.shareContentLink();
  await app.api.shareContentLink();
  assert.equal(app.sent.length, 1, 'only an in-flight update is coalesced');
  app.api.setState({ room: { id: 'room-b', public: true, owner: 'user', users: [], stream: { url: 'other' } } });
  await app.api.shareContentLink();
  app.api.setState({ lease: { leaseId: 'tab-a', fence: 6 } });
  await app.api.shareContentLink();
  assert.equal(app.sent.length, 3);
  assert.equal(app.sent[1].payload.roomId, 'room-b');
  assert.equal(app.sent[2].payload.publisher.fence, 6);
});

test('canonical content acknowledgement controls deduplication and subsequent sibling changes are repaired', async () => {
  const app = contentPublishingRuntime();
  await app.api.shareContentLink();
  app.api.commitRoomState({ ...app.api.getState().room, stream: app.sent[0].payload.stream }, { refreshOverlay: false });
  await app.api.shareContentLink();
  assert.equal(app.sent.length, 1, 'acknowledged matching content does not republish');
  app.api.commitRoomState({ ...app.api.getState().room, stream: { url: 'https://web.stremio.com/#/player/sibling' } }, { refreshOverlay: false });
  await app.api.shareContentLink();
  assert.equal(app.sent.length, 2, 'the previous page-local key cannot hide a changed canonical stream');
});

test('failed, rejected and unacknowledged content sends remain retryable', async () => {
  const app = contentPublishingRuntime();
  const send = app.socket.send;
  app.socket.send = () => false;
  await app.api.shareContentLink();
  app.socket.send = send;
  await app.api.shareContentLink();
  assert.equal(app.sent.length, 1);
  app.callbacks.message({ type: 'room.error', payload: { command: 'room.content.update', code: 'COOLDOWN' } });
  await app.api.shareContentLink();
  assert.equal(app.sent.length, 2);
  app.setNow(4000);
  await app.api.shareContentLink();
  assert.equal(app.sent.length, 3);
});

function followerMediaRuntime({ blob = false, portable = true } = {}) {
  const app = runtime();
  app.socket.markApplicationReady();
  let route = 'https://web.stremio.com/#/player/source-a';
  app.context.WPStremioAdapter.getCurrentContentContext = () => ({ launchUrl: route, meta: null });
  app.context.WPDirectPlay = { classifyStream: (stream) => ({ hasDirectJoin: portable, url: stream.url }) };
  let attached = true;
  const applied = [];
  app.context.WPSync = new Proxy({
    isAttached: () => attached,
    attach: () => { attached = true; }, detach: () => { attached = false; },
    applyRemote: (player) => { applied.push(player); return true; },
  }, { get: (target, key) => target[key] || (() => {}) });
  const nativeVideo = { currentSrc: blob ? 'blob:source-a' : 'https://media.example/a.mp4', currentTime: 125,
    paused: false, readyState: 4, pause() { this.paused = true; }, addEventListener() {}, removeEventListener() {} };
  const oldStream = portable ? { url: route, ...(blob ? {} : { resolvedUrl: nativeVideo.currentSrc }) } : { url: nativeVideo.currentSrc };
  const nextStream = portable ? { url: 'https://web.stremio.com/#/player/source-b', ...(blob ? {} : { resolvedUrl: 'https://media.example/b.mp4' }) }
    : { url: 'https://media.example/b.mp4' };
  const player = { paused: true, time: 0, buffering: false, speed: 1, timeline: { epoch: 'new', sequence: 1, sampledAtServer: 1000 } };
  const joinHint = { mode: portable ? 'direct' : 'unavailable', directJoinType: portable ? 'direct-url' : null, failureReason: null };
  app.api.setState({ room: { id: 'room-a', public: true, owner: 'peer', users: [], stream: oldStream, joinHint,
    player: { ...player, time: 125, timeline: { ...player.timeline, epoch: 'old' } } }, host: false, video: nativeVideo });
  return { ...app, nativeVideo, applied, nextStream, player,
    change() { app.callbacks.message({ type: 'room.content.updated', payload: { stream: nextStream, player, joinHint } }); },
    setRoute(value) { route = value; }, attached: () => attached };
}

for (const blob of [false, true]) {
  test(`host source change blocks old ${blob ? 'blob/proxied' : 'direct'} media until the matching native player exists`, () => {
    const app = followerMediaRuntime({ blob });
    app.change();
    assert.equal(app.nativeVideo.paused, true);
    assert.equal(app.applied.length, 0, 'new timeline must not be applied to old video');
    assert.equal(app.attached(), false);
    assert.equal(app.context.window.location.hash, '/player/source-b');
    app.setRoute(app.nextStream.url);
    app.api.syncPeerVideoToRoom();
    assert.equal(app.applied.length, 0, 'route can change before the old video is replaced');
    app.nativeVideo.currentSrc = blob ? 'blob:source-b' : app.nextStream.resolvedUrl;
    app.api.syncPeerVideoToRoom();
    assert.equal(app.applied.length, 1);
    assert.equal(app.applied[0].timeline.epoch, 'new');
    assert.equal(app.attached(), true);
  });
}

test('a nonportable host source pauses mismatched media and does not navigate outside Stremio', () => {
  const app = followerMediaRuntime({ portable: false });
  app.change();
  assert.equal(app.nativeVideo.paused, true);
  assert.equal(app.applied.length, 0);
  assert.equal(app.context.window.location.hash, '#/player/test');
  assert.equal(app.context.window.location.href, undefined);
});

test('room-scoped companion chat rejects stale bridge actions and preserves client acknowledgement identity', async () => {
  const app = runtime();
  app.socket.markApplicationReady();
  app.api.setState({ room: { id: 'room-a', public: true, users: [] } });
  const action = vm.runInContext('WPConstants.ACTION.ROOM_CHAT_SEND', app.context);
  const clientMessageId = '12345678-1234-1234-1234-123456789abc';
  assert.equal((await app.callbacks.dispatch({ action, content: 'stale', roomId: 'room-b', clientMessageId })).handled, false);
  assert.equal(app.sent.length, 0);
  assert.equal((await app.callbacks.dispatch({ action, content: 'hello', roomId: 'room-a', clientMessageId })).handled, true);
  assert.equal(app.sent[0].payload.clientMessageId, clientMessageId);
  await app.api.onChatMessage({ id: 'server-message', user: 'user', content: 'hello', clientMessageId });
  const relay = app.backgroundMessages.find((message) => message.action === vm.runInContext('WPConstants.ACTION.ROOM_CHAT_EVENT', app.context));
  assert.equal(relay.payload.roomId, 'room-a');
  assert.equal(relay.payload.clientMessageId, clientMessageId);
});

test('passive room projection invalidates the previous room crypto and rejects its late chat relay', () => {
  const app = runtime();
  app.api.setState({ controller: false, active: false });
  const generation = app.crypto.getGeneration();
  app.api.applySharedRuntimeProjection({ room: { id: 'room-b', public: false, users: [] } });
  assert.equal(app.crypto.getGeneration(), generation + 1);
  app.api.applyPassiveChatMessage({ id: 'old', roomId: 'room-a', content: 'old room secret' });
  assert.equal(app.rendered.length, 0);
});

function episodeRoute(provider, id, type = 'series') {
  return `https://web.stremio.com/#/player/${provider}/streamTransport/metaTransport/${type}/tt123/${encodeURIComponent(id)}`;
}

test('different personal providers for the same episode can sync without sharing their source URLs', () => {
  const app = followerMediaRuntime({ portable: false });
  app.api.setState({ room: { ...app.api.getState().room,
    stream: { url: episodeRoute('host-provider', 'tt123:1:2'), videoId: 'tt123:1:2', resolvedUrl: 'https://debrid.example/host-secret' } } });
  app.setRoute(episodeRoute('own-provider', 'tt123:1:2'));
  app.nativeVideo.currentSrc = 'https://other-provider.example/my-secret';
  app.api.syncPeerVideoToRoom();
  assert.equal(app.applied.length, 1);
  assert.equal(app.nativeVideo.paused, false, 'media identity checking itself does not pause matching provider content');
});

test('changing the host provider for the same episode does not interrupt a matching personal provider', () => {
  const app = followerMediaRuntime({ portable: false });
  const episode = 'tt123:1:2';
  app.api.setState({ room: { ...app.api.getState().room, stream: { url: episodeRoute('host-provider', episode), videoId: episode } } });
  app.setRoute(episodeRoute('own-provider', episode));
  app.callbacks.message({ type: 'room.content.updated', payload: {
    stream: { url: episodeRoute('new-host-provider', episode), videoId: episode }, player: app.player,
  } });
  assert.equal(app.applied.length, 1);
  assert.equal(app.context.window.location.hash, '#/player/test');
});

test('known episode mismatch wins over a shared/fixed provider URL and a shared series title', () => {
  const app = followerMediaRuntime({ portable: false });
  app.api.setState({ room: { ...app.api.getState().room, meta: { id: 'tt123', type: 'series' },
    stream: { url: episodeRoute('host-provider', 'tt123:1:2'), videoId: 'tt123:1:2', resolvedUrl: app.nativeVideo.currentSrc } } });
  app.setRoute(episodeRoute('own-provider', 'tt123:1:1'));
  app.api.syncPeerVideoToRoom();
  assert.equal(app.applied.length, 0);
  assert.equal(app.nativeVideo.paused, true);
});

test('movie identity fallback matches a provider route even when the canonical stream omitted videoId', () => {
  const app = followerMediaRuntime({ portable: false });
  app.api.setState({ room: { ...app.api.getState().room, meta: { id: 'tt123', type: 'movie' },
    stream: { url: 'https://web.stremio.com/#/player/host-provider', resolvedUrl: 'https://provider.example/host' } } });
  app.setRoute(episodeRoute('own-provider', 'tt123', 'movie'));
  assert.equal(app.api.nativeMatchesRoomMedia(), true);
});

test('nonportable trusted routes never auto-open another account provider on episode change', () => {
  const app = followerMediaRuntime();
  app.context.WPDirectPlay.classifyStream = () => ({ hasDirectJoin: false, url: null, directJoinType: 'debrid-url' });
  app.change();
  assert.equal(app.applied.length, 0);
  assert.equal(app.context.window.location.hash, '#/player/test');
});

test('a delayed join detail navigation cannot override a newer room or user navigation', () => {
  for (const transition of ['room', 'route', 'video']) {
    const app = runtime();
    app.context.WPStremioAdapter.getCurrentContentInfo = () => null;
    app.api.commitRoomState({ id: 'room-b', public: true, owner: 'peer', users: [], meta: { id: 'tt123', type: 'movie' } }, { lifecycle: 'joined' });
    const delayedNavigation = app.timers.find((timer) => timer.ms === 500);
    assert.ok(delayedNavigation);
    if (transition === 'room') app.api.commitRoomState({ id: 'room-c', public: true, users: [] }, { refreshOverlay: false });
    if (transition === 'route') app.context.window.location.hash = '#/player/user-choice';
    if (transition === 'video') app.api.setState({ video: { currentSrc: 'https://media.example/current.mp4' } });
    const previousHash = app.context.window.location.hash;
    delayedNavigation.fn();
    assert.equal(app.context.window.location.hash, previousHash);
  }
});

test('delayed away presence from the old room cannot update a new membership', () => {
  const app = runtime();
  app.socket.markApplicationReady();
  app.context.document.visibilityState = 'hidden';
  app.callbacks['document:visibilitychange']();
  const away = app.timers.find((timer) => timer.ms === 10000);
  assert.ok(away);
  app.api.commitRoomState({ id: 'room-b', public: true, users: [] }, { refreshOverlay: false });
  away.fn();
  assert.equal(app.sent.length, 0);
});

function membershipRaceRuntime() {
  const app = contentPublishingRuntime();
  const imports = [];
  const cached = [];
  app.crypto.importKey = async (key) => { imports.push({ key, roomId: app.api.getState().room.id }); };
  app.context.WPRoomKeys.setKeys = async (roomId, keys) => { cached.push({ roomId, ...keys }); };
  app.context.WPPrivateRoomKeys.resolveCreateKeys = async () => ({ accessKey: 'access-created-b', e2eKey: 'e2e-created-b' });
  const create = { username: 'Alice', public: false, meta: { id: 'new-title', type: 'movie', name: 'New title' }, stream: { url: 'https://media.example/new.mp4' } };
  return { ...app, imports, cached, create };
}

test('overlapping private join then private create adopt only keys belonging to each acknowledged request', async () => {
  const app = membershipRaceRuntime();
  await app.api.joinRoomFromCommand({ roomId: 'joined-a', username: 'Alice', accessKey: 'access-joined-a', e2eKey: 'e2e-joined-a' });
  await app.api.createRoomFromCommand(app.create);
  const join = app.sent.find((message) => message.type === 'room.join');
  const create = app.sent.find((message) => message.type === 'room.create');
  assert.notEqual(join.payload.clientRequestId, create.payload.clientRequestId);
  assert.equal(app.sent.some((message) => message.type === 'room.leave'), false);
  app.callbacks.message({ type: 'room.snapshot', payload: { id: 'joined-a', public: false, owner: 'user', users: [], clientRequestId: join.payload.clientRequestId } });
  assert.equal(app.socket.isApplicationReady(), false, 'a newer membership request is still outstanding');
  app.callbacks.message({ type: 'room.snapshot', payload: { id: 'created-b', public: false, owner: 'user', users: [], clientRequestId: create.payload.clientRequestId } });
  assert.deepEqual(app.imports, [{ key: 'e2e-joined-a', roomId: 'joined-a' }, { key: 'e2e-created-b', roomId: 'created-b' }]);
  assert.equal(app.cached.some((entry) => entry.roomId === 'joined-a' && entry.e2eKey === 'e2e-created-b'), false);
  assert.equal(app.socket.isApplicationReady(), true);
});

test('an unsolicited current-room snapshot cannot consume a pending create encryption key', async () => {
  const app = membershipRaceRuntime();
  await app.api.createRoomFromCommand(app.create);
  const create = app.sent.find((message) => message.type === 'room.create');
  app.callbacks.message({ type: 'room.snapshot', payload: { id: 'room-a', public: false, owner: 'user', users: [] } });
  assert.equal(app.imports.length, 0);
  assert.equal(app.socket.isApplicationReady(), false);
  app.callbacks.message({ type: 'room.snapshot', payload: { id: 'created-b', public: false, owner: 'user', users: [], clientRequestId: create.payload.clientRequestId } });
  assert.deepEqual(app.imports, [{ key: 'e2e-created-b', roomId: 'created-b' }]);
});

test('failed create keeps the acknowledged original room and does not clear its encryption key', async () => {
  const app = membershipRaceRuntime();
  const originalGeneration = app.crypto.getGeneration();
  await app.api.createRoomFromCommand({ ...app.create, public: true });
  const create = app.sent.find((message) => message.type === 'room.create');
  assert.equal(app.api.getState().room.id, 'room-a');
  assert.equal(app.crypto.getGeneration(), originalGeneration);
  app.callbacks.message({ type: 'room.error', payload: { command: 'room.create', clientRequestId: create.payload.clientRequestId, code: 'COOLDOWN' } });
  assert.equal(app.api.getState().room.id, 'room-a');
  assert.equal(app.crypto.getGeneration(), originalGeneration);
  assert.equal(app.socket.isApplicationReady(), true);
});

test('an accepted intermediate join remains the actual room when the later create is rejected', async () => {
  const app = membershipRaceRuntime();
  await app.api.joinRoomFromCommand({ roomId: 'joined-a', username: 'Alice', accessKey: 'access-joined-a', e2eKey: 'e2e-joined-a' });
  await app.api.createRoomFromCommand(app.create);
  const join = app.sent.find((message) => message.type === 'room.join');
  const create = app.sent.find((message) => message.type === 'room.create');
  app.callbacks.message({ type: 'room.snapshot', payload: { id: 'joined-a', public: false, owner: 'user', users: [], clientRequestId: join.payload.clientRequestId } });
  app.callbacks.message({ type: 'room.error', payload: { command: 'room.create', clientRequestId: create.payload.clientRequestId, code: 'COOLDOWN' } });
  assert.equal(app.api.getState().room.id, 'joined-a');
  assert.deepEqual(app.imports, [{ key: 'e2e-joined-a', roomId: 'joined-a' }]);
  assert.equal(app.socket.isApplicationReady(), true);
});

test('legacy servers receive one membership command at a time without unsupported request IDs', async () => {
  const app = membershipRaceRuntime();
  app.socket.supportsCapability = () => false;
  await app.api.joinRoomFromCommand({ roomId: 'joined-a', username: 'Alice' });
  await app.api.createRoomFromCommand(app.create);
  const membership = () => app.sent.filter((message) => ['room.join', 'room.create'].includes(message.type));
  assert.equal(membership().length, 1);
  assert.equal('clientRequestId' in membership()[0].payload, false);
  app.callbacks.message({ type: 'room.snapshot', payload: { id: 'joined-a', public: true, owner: 'user', users: [] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(membership().length, 2);
  assert.equal(membership()[1].type, 'room.create');
  assert.equal('clientRequestId' in membership()[1].payload, false);
});

test('sanitized nonportable join hints cannot be overridden by a seemingly portable player URL', () => {
  const app = followerMediaRuntime();
  app.callbacks.message({ type: 'room.content.updated', payload: {
    stream: { url: app.nextStream.url }, player: app.player,
    joinHint: { mode: 'title_only', directJoinType: 'debrid-url', failureReason: 'Choose your own stream' },
  } });
  assert.equal(app.applied.length, 0);
  assert.equal(app.context.window.location.hash, '#/player/test');
});

for (const legacy of [false, true]) {
  test(`leave cancels a sent join and its late snapshot cannot resurrect membership (${legacy ? 'legacy' : 'correlated'})`, async () => {
    const app = membershipRaceRuntime();
    if (legacy) app.socket.supportsCapability = () => false;
    await app.api.joinRoomFromCommand({ roomId: 'joined-b', username: 'Alice' });
    const join = app.sent.find((message) => message.type === 'room.join');
    const leave = vm.runInContext('WPConstants.ACTION.ROOM_LEAVE', app.context);
    await app.callbacks.dispatch({ action: leave });
    assert.equal(app.api.getState().inRoom, false);
    assert.deepEqual(app.sent.filter((message) => ['room.join', 'room.leave'].includes(message.type)).map((message) => message.type), ['room.join', 'room.leave']);
    app.callbacks.message({ type: 'room.snapshot', payload: { id: 'joined-b', public: true, owner: 'user', users: [], clientRequestId: join.payload.clientRequestId } });
    assert.equal(app.api.getState().room, null);
    assert.equal(app.api.getState().inRoom, false);
    assert.equal(app.api.getState().isHost, false);
  });
}

test('ignoring a cancelled join snapshot never sends a second leave that could remove a newer explicit join', async () => {
  const app = membershipRaceRuntime();
  await app.api.joinRoomFromCommand({ roomId: 'cancelled-b', username: 'Alice' });
  const firstJoin = app.sent.find((message) => message.type === 'room.join');
  await app.callbacks.dispatch({ action: vm.runInContext('WPConstants.ACTION.ROOM_LEAVE', app.context) });
  await app.api.joinRoomFromCommand({ roomId: 'new-c', username: 'Alice' });
  const nextJoin = app.sent.filter((message) => message.type === 'room.join')[1];
  app.callbacks.message({ type: 'room.snapshot', payload: { id: 'cancelled-b', public: true, owner: 'user', users: [], clientRequestId: firstJoin.payload.clientRequestId } });
  assert.equal(app.api.getState().room, null);
  assert.equal(app.socket.isApplicationReady(), false);
  app.callbacks.message({ type: 'room.snapshot', payload: { id: 'new-c', public: true, owner: 'user', users: [], clientRequestId: nextJoin.payload.clientRequestId } });
  assert.equal(app.api.getState().room.id, 'new-c');
  assert.equal(app.sent.filter((message) => message.type === 'room.leave').length, 1);
});

test('leave also cancels a pending create with no room ID and never imports its late key', async () => {
  const app = membershipRaceRuntime();
  app.api.setState({ room: null, inRoom: false });
  await app.api.createRoomFromCommand(app.create);
  const create = app.sent.find((message) => message.type === 'room.create');
  await app.callbacks.dispatch({ action: vm.runInContext('WPConstants.ACTION.ROOM_LEAVE', app.context) });
  app.callbacks.message({ type: 'room.snapshot', payload: { id: 'created-b', public: false, owner: 'user', users: [], clientRequestId: create.payload.clientRequestId } });
  assert.equal(app.api.getState().room, null);
  assert.equal(app.imports.length, 0);
  assert.equal(app.sent.filter((message) => message.type === 'room.leave').length, 1);
});

test('a cancelled asynchronous bootstrap cannot rejoin from its stale storage response', async () => {
  const app = runtime();
  const read = deferred();
  app.context.WPRuntimeState.get = () => read.promise;
  const bootstrap = app.api.processPendingActions();
  await app.callbacks.dispatch({ action: vm.runInContext('WPConstants.ACTION.ROOM_LEAVE', app.context) });
  read.resolve({ [vm.runInContext('WPConstants.STORAGE.CURRENT_ROOM', app.context)]: 'room-a' });
  await bootstrap;
  assert.equal(app.api.getState().room, null);
  assert.equal(app.sent.some((message) => ['room.join', 'room.rejoin'].includes(message.type)), false);
});

test('legacy staged membership waits for response without a microtask loop, and rejection wakes it', async () => {
  const app = membershipRaceRuntime();
  app.socket.supportsCapability = () => false;
  let reads = 0;
  app.context.WPRuntimeState.get = async () => {
    reads += 1;
    if (reads > 5) app.api.setState({ controller: false }); // keep a regression failure bounded
    return {};
  };
  await app.api.joinRoomFromCommand({ roomId: 'missing-b', username: 'Alice' });
  await app.api.createRoomFromCommand(app.create);
  await app.api.processPendingActions();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 0, 'pending legacy membership must sleep until its acknowledgement/error');
  app.callbacks.message({ type: 'room.error', payload: { code: 'ROOM_NOT_FOUND' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.sent.filter((message) => message.type === 'room.create').length, 1);
  assert.ok(reads <= 2);
});

test('recovery leaves and disconnects the controller, blocks passive projections and prevents lease resurrection', async () => {
  const app = runtime();
  const message = { recoveryId: 'recovery-a', kind: 'clear-room' };
  assert.equal((await app.api.beginSessionRecovery(message)).ok, true);
  assert.equal(app.sent.filter(entry => entry.type === 'room.leave').length, 1);
  assert.equal(app.socket.isConnected(), false);
  assert.equal(app.api.getState().room, null);
  assert.equal(app.api.getState().isControllerTab, false);
  assert.equal(app.api.getState().recoverySuspended, true);
  app.api.applySharedRuntimeProjection({ room: { id: 'stale-room' }, wsConnected: true });
  assert.equal(app.api.getState().room, null);
  assert.equal(await app.api.refreshControllerLease({ force: true }), false);
  assert.equal(await app.api.refreshActiveVideoLease({ force: true }), false);
  app.callbacks.storage({ currentRoom: { newValue: 'stale-room' }, wpBootstrapRoomIntent: { newValue: {} } }, 'session');
  assert.equal(app.api.getState().resumeRoomPending, false);
  const rejected = await app.callbacks.dispatch({ action: 'room.create', username: 'Alice' });
  assert.equal(rejected.handled, false);
  assert.match(rejected.error, /recovery/);
});

test('recovery cancels and drains a pending room bootstrap before acknowledging storage can be cleared', async () => {
  const app = runtime();
  const read = deferred();
  app.context.WPRuntimeState.get = () => read.promise;
  app.api.processPendingActions();
  let acknowledged = false;
  const recovery = app.api.beginSessionRecovery({ recoveryId: 'recovery-b', kind: 'reset' }).then(result => { acknowledged = true; return result; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  read.resolve({ currentRoom: 'stale-room', wpUsername: 'Old name' });
  assert.equal((await recovery).ok, true);
  assert.equal(app.sent.some(entry => ['room.join', 'room.rejoin', 'room.create'].includes(entry.type)), false);
  assert.equal(app.api.getState().room, null);
});

test('reset completion adopts a fresh shared identity while staying out of the old room', async () => {
  const app = runtime();
  let resetIdentity = 0;
  app.context.WPOverlay.resetSessionIdentity = () => { resetIdentity += 1; };
  app.context.chrome.runtime.sendMessage = async message => message.action === 'session.identity.get'
    ? { ok: true, sessionId: 'new-session', sessionToken: 'new-token' } : { ok: true };
  const message = { recoveryId: 'recovery-c', kind: 'reset' };
  await app.api.beginSessionRecovery(message);
  assert.equal((await app.api.completeSessionRecovery({ recoveryId: 'wrong-id' })).ok, false);
  assert.equal((await app.api.completeSessionRecovery(message)).ok, true);
  const state = app.api.getState();
  assert.equal(state.sessionId, 'new-session');
  assert.equal(state.sessionToken, 'new-token');
  assert.equal(state.recoverySuspended, false);
  assert.equal(state.room, null);
  assert.equal(state.inRoom, false);
  assert.equal(state.resumeRoomPending, false);
  assert.equal(resetIdentity, 1);
  assert.equal(await app.api.refreshControllerLease({ force: true }), false);
});

test('failed recovery identity initialization does not unsuspend an old in-memory session', async () => {
  const app = runtime();
  const message = { recoveryId: 'recovery-d', kind: 'reset' };
  await app.api.beginSessionRecovery(message);
  assert.equal((await app.api.completeSessionRecovery(message)).ok, false);
  assert.equal(app.api.getState().recoverySuspended, true);
  assert.equal(app.api.getState().room, null);
});
