import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadBackground({ realTimers = false } = {}) {
  const local = {};
  const session = {};
  const tabs = new Map([[1, { id: 1, url: 'https://web.stremio.com/' }], [2, { id: 2, url: 'https://web.stremio.com/' }]]);
  const listeners = {};
  const calls = [];
  const area = (values) => ({
    async get(keys) { return keys === null ? { ...values } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]])); },
    async set(valuesToSet) { Object.assign(values, valuesToSet); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
  });
  const chrome = {
    runtime: {
      id: 'test-extension', getManifest: () => ({ version: 'test', update_url: 'store', host_permissions: [] }),
      onMessage: { addListener(handler) { listeners.message = handler; } },
      onInstalled: { addListener() {} }, sendMessage: async () => {},
    },
    storage: { local: area(local), session: area(session) },
    tabs: {
      async get(tabId) { if (!tabs.has(tabId)) throw new Error('No such tab'); return tabs.get(tabId); },
      async query() { return [...tabs.values()]; },
      async sendMessage(tabId, message) { calls.push({ tabId, message }); return { handled: true }; },
      onRemoved: { addListener(handler) { listeners.removed = handler; } },
    },
    action: { setBadgeBackgroundColor() {}, setBadgeText() {}, onClicked: { addListener() {} } },
  };
  const context = vm.createContext({ chrome, console: { warn() {} }, URL, structuredClone, crypto: { randomUUID: () => 'id' },
    setTimeout: realTimers ? setTimeout : (callback) => { queueMicrotask(callback); return 1; }, clearTimeout });
  context.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(root, 'extension', file), 'utf8'), context, { filename: file });
  const source = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
  // Run the real worker's imports, message routes, and lease logic without its
  // unrelated startup polling/network effects.
  vm.runInContext(source.slice(0, source.indexOf('// ── Start ──')), context, { filename: 'background.js' });
  vm.runInContext("rememberSurfaceTab('stremio', 1); rememberSurfaceTab('stremio', 2);", context);
  const constants = vm.runInContext('WPConstants', context);
  return { context, chrome, local, session, calls, tabs, constants, listeners };
}

test('the background preserves content action rejections and does not reroute them to another tab', async () => {
  const { context, chrome, constants } = loadBackground();
  const attempted = [];
  chrome.tabs.sendMessage = async (tabId) => { attempted.push(tabId); return { handled: false, error: 'The room changed.' }; };
  context.message = { action: constants.ACTION.ROOM_CHAT_SEND, content: 'draft', clientMessageId: 'message-1' };
  const result = await vm.runInContext('relayLiveRoomAction(message)', context);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'The room changed.');
  assert.deepEqual(attempted, [1]);
});

test('an unclaimed controller route still falls through to the current owning tab', async () => {
  const { context, chrome, constants } = loadBackground();
  const attempted = [];
  chrome.tabs.sendMessage = async (tabId) => {
    attempted.push(tabId);
    return tabId === 1 ? { handled: false } : { handled: true, pending: true, clientMessageId: 'message-1' };
  };
  context.message = { action: constants.ACTION.ROOM_CHAT_SEND, content: 'draft' };
  const result = await vm.runInContext('relayLiveRoomAction(message)', context);
  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal(result.clientMessageId, 'message-1');
  assert.deepEqual(attempted, [1, 2]);
});

test('a tab without an acknowledgement cannot falsely report an action as delivered', async () => {
  const { context, chrome, constants } = loadBackground();
  const attempted = [];
  chrome.tabs.sendMessage = async (tabId) => { attempted.push(tabId); return tabId === 1 ? undefined : { handled: true }; };
  context.message = { action: constants.ACTION.ROOM_CHAT_SEND, content: 'draft' };
  const result = await vm.runInContext('relayLiveRoomAction(message)', context);
  assert.equal(result.ok, true);
  assert.deepEqual(attempted, [1, 2]);
});

test('a delayed broadcast port rejection cannot revoke a replacement content instance on the same tab', async () => {
  const { context, chrome, session, constants } = loadBackground();
  let rejectOldPort;
  const oldPort = new Promise((_, reject) => { rejectOldPort = reject; });
  chrome.tabs.sendMessage = (tabId) => tabId === 1 ? oldPort : Promise.resolve({ handled: true });
  await vm.runInContext("broadcastToStremioTabs({ action: WPConstants.ACTION.STATUS_UPDATED })", context);
  session[constants.STORAGE.CONTROLLER_TAB] = constants.CONTROLLER_TAB_LEASE.build({ leaseId: 'replacement-controller', tabId: 1 });
  session[constants.STORAGE.ACTIVE_VIDEO_TAB] = constants.VIDEO_TAB_LEASE.build({ leaseId: 'replacement-video', tabId: 1 });
  vm.runInContext('coordinatorState.controllerTabId = 1; coordinatorState.wsConnected = true;', context);
  rejectOldPort(new Error('The message port closed before a response was received.'));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.equal(session[constants.STORAGE.CONTROLLER_TAB]?.leaseId, 'replacement-controller');
  assert.equal(session[constants.STORAGE.ACTIVE_VIDEO_TAB]?.leaseId, 'replacement-video');
  assert.equal(vm.runInContext('coordinatorState.wsConnected', context), true);
});

test('a confirmed closed tab still releases its controller and active-video leases', async () => {
  const { context, session, constants, tabs, listeners } = loadBackground();
  session[constants.STORAGE.CONTROLLER_TAB] = constants.CONTROLLER_TAB_LEASE.build({ leaseId: 'closed-controller', tabId: 1 });
  session[constants.STORAGE.ACTIVE_VIDEO_TAB] = constants.VIDEO_TAB_LEASE.build({ leaseId: 'closed-video', tabId: 1 });
  vm.runInContext('coordinatorState.controllerTabId = 1; coordinatorState.wsConnected = true;', context);
  tabs.delete(1);
  listeners.removed(1);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.equal(session[constants.STORAGE.CONTROLLER_TAB], undefined);
  assert.equal(session[constants.STORAGE.ACTIVE_VIDEO_TAB], undefined);
  assert.equal(vm.runInContext('coordinatorState.wsConnected', context), false);
});

test('a restarted worker routes the first action to the persisted controller, not the first enumerated tab', async () => {
  const { context, session, constants, calls } = loadBackground();
  session[constants.STORAGE.CONTROLLER_TAB] = constants.CONTROLLER_TAB_LEASE.build({ leaseId: 'controller-two', tabId: 2 });
  context.message = { action: constants.ACTION.ROOM_CHAT_SEND, content: 'draft' };
  assert.equal((await vm.runInContext('relayLiveRoomAction(message)', context)).ok, true);
  assert.deepEqual(calls.map((call) => call.tabId), [2]);
});

test('coordinator handoff cannot inherit the previous tab socket connection', () => {
  const { context } = loadBackground();
  const kernel = vm.runInContext('WPCoordinatorKernel', context);
  const connected = { ...kernel.createInitialState(), controllerTabId: 1, wsConnected: true };
  const renewal = kernel.reduce(connected, { type: 'controller.lease.claim', payload: { tabId: 1 } });
  assert.equal(renewal.wsConnected, true);
  const handoff = kernel.reduce(connected, { type: 'controller.lease.claim', payload: { tabId: 2 } });
  assert.equal(handoff.wsConnected, false);
  assert.equal(handoff.controllerTabId, 2);
});

test('ready-check, bookmark, and reaction routes do not report success without a controller', async () => {
  const { context, tabs, constants } = loadBackground();
  tabs.clear();
  vm.runInContext('knownStremioTabIds.clear()', context);
  for (const action of [constants.ACTION.ROOM_READY_CHECK_UPDATE, constants.ACTION.ROOM_BOOKMARK_ADD, constants.ACTION.ROOM_REACTION_SEND]) {
    context.action = action;
    const result = await vm.runInContext('new Promise((resolve) => messageHandlers[action]({ action }, {}, resolve))', context);
    assert.equal(result.ok, false, action);
  }
});

function recoveryRuntime() {
  const env = loadBackground({ realTimers: true });
  const { local, session, constants: c, chrome, calls } = env;
  Object.assign(local, { wpUsername: 'Alice', wpSessionId: 'old-session', wpSessionToken: 'old-token',
    wpAccentColor: '#123456', wpCompactChat: true, wpBackendMode: 'live', wpControllerFence: 31,
    'wpRoomAccessKey:room-a': 'private-access', unrelatedPreference: 'keep' });
  Object.assign(session, { currentRoom: 'room-a', wpRoomState: { id: 'room-a', users: [] }, wpWsConnected: true,
    wpControllerTab: c.CONTROLLER_TAB_LEASE.build({ leaseId: 'old-controller', tabId: 1 }),
    'wpRoomE2eKey:room-a': 'private-chat', 'wpRoomChatHistory:room-a': [{ content: 'private' }] });
  chrome.tabs.sendMessage = async (tabId, message) => {
    calls.push({ tabId, message });
    return { ok: true, handled: true, recoveryId: message.recoveryId };
  };
  return env;
}

test('clear saved room quiesces every tab before deleting state and preserves identity, preferences and private keys', async () => {
  const { context, local, session, calls } = recoveryRuntime();
  assert.equal((await vm.runInContext("recoverSession('clear-room')", context)).ok, true);
  assert.equal(session.currentRoom, undefined);
  assert.equal(session.wpRoomState, undefined);
  assert.equal(session.wpControllerTab, undefined);
  assert.equal(session['wpRoomChatHistory:room-a'], undefined);
  assert.equal(local.wpUsername, 'Alice');
  assert.equal(local.wpSessionId, 'old-session');
  assert.equal(local['wpRoomAccessKey:room-a'], 'private-access');
  assert.equal(session['wpRoomE2eKey:room-a'], 'private-chat');
  assert.equal(local.wpAccentColor, '#123456');
  assert.equal(vm.runInContext('coordinatorState.room', context), null);
  const actions = calls.filter(call => call.message.action.startsWith('session.recovery.'));
  assert.deepEqual(actions.map(call => [call.tabId, call.message.action]), [
    [1, 'session.recovery.begin'], [2, 'session.recovery.begin'],
    [1, 'session.recovery.complete'], [2, 'session.recovery.complete'],
  ]);
});

test('reset clears private runtime and identity without deleting preferences or the monotonic controller fence', async () => {
  const { context, local, session } = recoveryRuntime();
  assert.equal((await vm.runInContext("recoverSession('reset')", context)).ok, true);
  for (const key of ['wpUsername', 'wpSessionId', 'wpSessionToken', 'wpRoomAccessKey:room-a']) assert.equal(local[key], undefined);
  for (const key of ['currentRoom', 'wpRoomState', 'wpRoomE2eKey:room-a', 'wpRoomChatHistory:room-a']) assert.equal(session[key], undefined);
  assert.equal(local.wpAccentColor, '#123456');
  assert.equal(local.wpBackendMode, 'live');
  assert.equal(local.wpControllerFence, 31);
  assert.equal(local.unrelatedPreference, 'keep');
  assert.equal(vm.runInContext('recoveryInFlight', context), false);
});

test('a tab that cannot quiesce prevents destructive reset and reports failure', async () => {
  const { context, chrome, local, session } = recoveryRuntime();
  chrome.tabs.sendMessage = async (tabId, message) => tabId === 2 && message.action === 'session.recovery.begin'
    ? { handled: false } : { ok: true, recoveryId: message.recoveryId };
  const result = await vm.runInContext("recoverSession('reset')", context);
  assert.equal(result.ok, false);
  assert.match(result.error, /Refresh your Stremio tabs/);
  assert.equal(local.wpSessionId, 'old-session');
  assert.equal(session.currentRoom, 'room-a');
  assert.equal(vm.runInContext('recoveryInFlight', context), false);
});

test('private keys cannot be forgotten while a room is active, saved, or pending', async () => {
  const { context, local, session } = recoveryRuntime();
  const result = await vm.runInContext("recoverSession('forget-keys')", context);
  assert.equal(result.ok, false);
  assert.match(result.error, /Leave your room/);
  assert.equal(local['wpRoomAccessKey:room-a'], 'private-access');
  assert.equal(session['wpRoomE2eKey:room-a'], 'private-chat');
});

test('a refused storage deletion is never reported as successful recovery', async () => {
  const { context, chrome } = recoveryRuntime();
  chrome.storage.session.remove = async () => { throw new Error('Storage unavailable'); };
  const result = await vm.runInContext("recoverSession('clear-room')", context);
  assert.equal(result.ok, false);
  assert.match(result.error, /Storage unavailable/);
});

test('recovery rejects concurrent mutations and stale controller publications while allowing status reads', async () => {
  const { context, chrome, listeners, constants, session } = recoveryRuntime();
  let continueRecovery;
  const wait = new Promise(resolve => { continueRecovery = resolve; });
  chrome.tabs.sendMessage = async (_tabId, message) => {
    if (message.action === 'session.recovery.begin') await wait;
    return { ok: true, recoveryId: message.recoveryId };
  };
  const pending = vm.runInContext("recoverSession('clear-room')", context);
  let result;
  listeners.message({ type: 'watchparty-ext', action: constants.ACTION.ROOM_CREATE },
    { url: 'chrome-extension://test-extension/popup.html' }, response => { result = response; });
  assert.equal(result.ok, false);
  assert.match(result.error, /recovery is running/);
  context.stale = { controllerLeaseId: 'old-controller', room: { id: 'resurrected' } };
  const publication = await vm.runInContext('applyCurrentControllerPublication(stale, { tab: { id: 1 } }, () => updateCoordinatorState(stale, { tab: { id: 1 } }))', context);
  assert.equal(publication.ok, false);
  continueRecovery();
  assert.equal((await pending).ok, true);
  assert.equal(session.wpRoomState, undefined);
});

test('a tab opened during reset waits for the fresh identity rather than racing credential deletion', async () => {
  const { context, chrome, local, session } = recoveryRuntime();
  let releaseBegins;
  let sawBegin;
  const waiting = new Promise(resolve => { releaseBegins = resolve; });
  const began = new Promise(resolve => { sawBegin = resolve; });
  chrome.tabs.sendMessage = async (_tabId, message) => {
    if (message.action === 'session.recovery.begin') { sawBegin(); await waiting; }
    if (message.action === 'session.recovery.complete') {
      context.completionId = message.recoveryId;
      const identity = await vm.runInContext('new Promise(resolve => messageHandlers[WPConstants.ACTION.SESSION_IDENTITY_GET]({ recoveryId: completionId }, {}, resolve))', context);
      assert.equal(identity.ok, true);
      assert.notEqual(identity.sessionId, 'old-session');
    }
    return { ok: true, recoveryId: message.recoveryId };
  };
  const reset = vm.runInContext("recoverSession('reset')", context);
  await began;
  let resolved = false;
  const newTabIdentity = vm.runInContext('new Promise(resolve => messageHandlers[WPConstants.ACTION.SESSION_IDENTITY_GET]({}, {}, resolve))', context)
    .then(result => { resolved = true; return result; });
  await Promise.resolve();
  assert.equal(resolved, false);
  releaseBegins();
  assert.equal((await reset).ok, true);
  const identity = await newTabIdentity;
  assert.equal(identity.sessionId, local.wpSessionId);
  assert.notEqual(identity.sessionId, 'old-session');
  assert.equal(session.currentRoom, undefined);
});

test('forget keys while idle removes only private invite material', async () => {
  const { context, local, session } = recoveryRuntime();
  for (const key of Object.keys(session)) {
    if (!key.startsWith('wpRoomE2eKey:')) delete session[key];
  }
  const result = await vm.runInContext("recoverSession('forget-keys')", context);
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(local['wpRoomAccessKey:room-a'], undefined);
  assert.equal(session['wpRoomE2eKey:room-a'], undefined);
  assert.equal(local.wpSessionId, 'old-session');
  assert.equal(local.wpAccentColor, '#123456');
});

test('scoped resume refuses a different live room without focusing or opening a tab', async () => {
  const { context, session, calls } = loadBackground();
  session.currentRoom = 'room-new';
  session.wpRoomState = { id: 'room-new' };
  const result = await vm.runInContext("resumeRoomInStremio('room-old')", context);
  assert.equal(result.ok, false);
  assert.match(result.error, /room changed/);
  assert.equal(calls.length, 0);
});

test('resume matches a pending join target and still supports the unscoped toolbar', async () => {
  for (const scoped of [true, false]) {
    const { context, session, constants } = loadBackground();
    session.wpBootstrapRoomIntent = constants.BOOTSTRAP_ROOM_INTENT.buildJoin({ roomId: 'pending-room', username: 'Alice' });
    const result = await vm.runInContext(scoped ? "resumeRoomInStremio('pending-room')" : 'resumeRoomInStremio()', context);
    assert.equal(result.ok, true);
  }
});

test('a different pending join overrides an old room target for scoped resume', async () => {
  const { context, session, constants } = loadBackground();
  session.currentRoom = 'room-old';
  session.wpBootstrapRoomIntent = constants.BOOTSTRAP_ROOM_INTENT.buildJoin({ roomId: 'room-new', username: 'Alice' });
  assert.equal((await vm.runInContext("resumeRoomInStremio('room-old')", context)).ok, false);
});

test('clipboard timeout covers an offscreen creation that never completes', async () => {
  const { context, chrome } = loadBackground();
  chrome.runtime.getURL = file => `chrome-extension://test-extension/${file}`;
  chrome.runtime.getContexts = async () => [];
  chrome.offscreen = { createDocument: () => new Promise(() => {}) };
  const result = await vm.runInContext("copyToClipboard('diagnostics')", context);
  assert.equal(result.ok, false);
  assert.match(result.error, /Clipboard did not respond/);
});

test('clipboard timeout covers an offscreen document that never acknowledges copying', async () => {
  const { context, chrome } = loadBackground();
  chrome.runtime.getURL = file => `chrome-extension://test-extension/${file}`;
  chrome.runtime.getContexts = async () => [{}];
  chrome.offscreen = {};
  chrome.runtime.sendMessage = () => {};
  const result = await vm.runInContext("copyToClipboard('diagnostics')", context);
  assert.equal(result.ok, false);
  assert.match(result.error, /Clipboard did not respond/);
});
