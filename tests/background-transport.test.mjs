import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadBackground() {
  const local = {};
  const session = {};
  const tabs = new Map([[1, { id: 1, url: 'https://web.stremio.com/' }], [2, { id: 2, url: 'https://web.stremio.com/' }]]);
  const listeners = {};
  const calls = [];
  const area = (values) => ({
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]])); },
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
  const context = vm.createContext({ chrome, console: { warn() {} }, URL, structuredClone, crypto: { randomUUID: () => 'id' }, setTimeout: (callback) => { queueMicrotask(callback); return 1; } });
  context.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(root, 'extension', file), 'utf8'), context, { filename: file });
  const source = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
  // Run the real worker's imports, message routes, and lease logic without its
  // unrelated startup polling/network effects.
  vm.runInContext(source.slice(0, source.indexOf('// ── Start ──')), context, { filename: 'background.js' });
  vm.runInContext("rememberSurfaceTab('stremio', 1); rememberSurfaceTab('stremio', 2);", context);
  const constants = vm.runInContext('WPConstants', context);
  return { context, chrome, session, calls, tabs, constants, listeners };
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
