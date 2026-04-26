import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const EXT = path.resolve('extension');

let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed++;
  } else {
    console.error(`  FAIL ${label}`);
    failed++;
  }
}

function loadScript(context, file, exportName) {
  const source = fs.readFileSync(path.join(EXT, file), 'utf8');
  const exportLine = exportName ? `\nglobalThis.${exportName} = ${exportName};` : '';
  new vm.Script(`${source}${exportLine}`, { filename: file }).runInContext(context);
}

function createContext() {
  const sessionStore = new Map();
  const localStore = new Map();
  function makeStorageArea(store) {
    return {
      async get(keys) {
        if (keys == null) return Object.fromEntries(store);
        const keyList = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(keyList.filter((key) => store.has(key)).map((key) => [key, store.get(key)]));
      },
      async set(values) {
        for (const [key, value] of Object.entries(values || {})) store.set(key, value);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      },
    };
  }
  const context = vm.createContext({
    console,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    structuredClone: (value) => JSON.parse(JSON.stringify(value)),
    Date: { now: () => 1000 },
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    window: {
      location: {
        origin: 'https://web.stremio.com',
        hash: '#/player/https%3A%2F%2Fexample.test%2Fstream/stream-transport/meta-transport/movie/tt1/video1',
      },
    },
    document: {
      querySelector: () => null,
    },
    HTMLImageElement: class HTMLImageElement {},
    URLSearchParams,
    chrome: {
      storage: {
        session: makeStorageArea(sessionStore),
        local: makeStorageArea(localStore),
      },
    },
  });

  loadScript(context, 'wp-actions.js', 'WPAction');
  new vm.Script('globalThis.WPActionRoutes = WPActionRoutes;', { filename: 'wp-actions-routes' }).runInContext(context);
  loadScript(context, 'constants.js', 'WPConstants');
  loadScript(context, 'wp-room-domain.js', 'WPRoomDomain');
  loadScript(context, 'wp-protocol.js', 'WPProtocol');
  loadScript(context, 'stremio-runtime-model.js', 'WPStremioRuntimeModel');
  loadScript(context, 'runtime-clock.js', 'WPRuntimeClock');
  loadScript(context, 'room-keys.js', 'WPRoomKeys');
  loadScript(context, 'stremio-controller-kernel.js', 'WPControllerKernel');
  loadScript(context, 'stremio-adapter.js', 'WPStremioAdapter');
  loadScript(context, 'background-coordinator-kernel.js', 'WPCoordinatorKernel');
  return context;
}

async function testRoomKeySplit(context) {
  console.log('\n-- Access/E2E key split --');
  const { WPRoomKeys, WPConstants } = context;
  await WPRoomKeys.setKeys('room-1', {
    accessKey: 'access-key-123456',
    e2eKey: 'e2e-key-123456789',
  });
  ok(await WPRoomKeys.getAccessKey('room-1') === 'access-key-123456', 'room access key is stored separately');
  ok(await WPRoomKeys.getE2eKey('room-1') === 'e2e-key-123456789', 'room E2E key is stored separately');
  const invite = await WPRoomKeys.appendToInviteUrl('room-1', 'https://watchparty.test/r/room-1');
  ok(invite.includes('#accessKey=access-key-123456') && invite.includes('e2eKey=e2e-key-123456789'), 'invite URL carries separate access and E2E keys');
  ok(WPConstants.STORAGE.roomAccessKey('room-1') !== WPConstants.STORAGE.roomE2eKey('room-1'), 'access/E2E storage keys are distinct');
}

function testControllerRoomReducer(context) {
  console.log('\n-- Controller room reducer --');
  const { WPControllerKernel, WPProtocol } = context;
  const baseRoom = {
    id: 'room-1',
    owner: 'user-1',
    ownerSessionId: 'session-1',
    users: [{ id: 'user-1', sessionId: 'session-1', name: 'Host', room_id: 'room-1' }],
    player: { paused: true, buffering: false, time: 10 },
    settings: {},
    bookmarks: [],
    messages: [],
  };

  const playback = WPControllerKernel.reduceRoomState(baseRoom, {
    type: WPProtocol.EVENT.ROOM_PLAYBACK_UPDATED,
    payload: { player: { paused: false, buffering: false, time: 25 } },
  });
  ok(playback.changed && playback.room.player.time === 25, 'playback deltas are applied by reducer');
  ok(playback.previousPlayerTime === 10, 'playback reducer reports previous player time');
  ok(baseRoom.player.time === 10, 'reducer does not mutate input room');

  const upsert = WPControllerKernel.reduceRoomState(baseRoom, {
    type: WPProtocol.EVENT.ROOM_MEMBER_UPSERTED,
    payload: { user: { id: 'user-2', sessionId: 'session-2', name: 'Peer', room_id: 'room-1' } },
  });
  ok(upsert.room.users.length === 2, 'member upsert adds new logical user');

  const visibility = WPControllerKernel.reduceRoomState(baseRoom, {
    type: WPProtocol.EVENT.ROOM_VISIBILITY_UPDATED,
    payload: { public: false, visibility: 'private', listed: false },
  });
  ok(visibility.room.public === false && visibility.room.listed === false, 'visibility reducer applies room access state');
  ok(visibility.effects.some((effect) => effect.type === 'room-key-visibility-confirmed'), 'visibility reducer emits key confirmation effect');
}

function testAdapterRuntimeSnapshot(context) {
  console.log('\n-- Stremio adapter runtime snapshot --');
  const { WPConstants, WPRoomDomain, WPStremioAdapter, WPStremioRuntimeModel } = context;
  const snapshot = WPStremioAdapter.buildRuntimeSnapshot({
    hasVideo: true,
    joinHint: {
      mode: WPRoomDomain.JOIN_HINT_MODE.DIRECT,
      directJoinType: WPRoomDomain.DIRECT_JOIN_TYPE.PORTABLE,
    },
  });
  ok(snapshot.route === WPConstants.ADAPTER_ROUTE.PLAYER, 'adapter classifies player routes');
  ok(snapshot.availability === WPConstants.ADAPTER_AVAILABILITY.DIRECT_JOIN_READY, 'adapter reports direct-join readiness');
  ok(snapshot.contentMeta?.id === 'tt1', 'adapter derives player metadata from route');
  ok(WPStremioRuntimeModel.deriveAdapterAvailability(snapshot) === snapshot.availability, 'adapter uses runtime-model availability derivation');
}

function testCoordinatorKernel(context) {
  console.log('\n-- Background coordinator kernel --');
  const { WPCoordinatorKernel, WPConstants } = context;
  let state = WPCoordinatorKernel.createInitialState();
  state = WPCoordinatorKernel.reduce(state, {
    type: 'bootstrap.pending',
    payload: { pending: true },
  }, 1000);
  ok(state.mode === WPConstants.COORDINATOR_MODE.BOOTSTRAP_PENDING, 'bootstrap intent drives coordinator mode');

  state = WPCoordinatorKernel.reduce(state, {
    type: 'session.state.publish',
    tabId: 12,
    payload: {
      room: { id: 'room-1', users: [], messages: [] },
      sessionId: 'session-1',
      wsConnected: true,
    },
  }, 1100);
  ok(state.mode === WPConstants.COORDINATOR_MODE.BOOTSTRAP_PENDING, 'bootstrap mode remains authoritative until cleared');

  state = WPCoordinatorKernel.reduce(state, {
    type: 'bootstrap.pending',
    payload: { pending: false },
  }, 1200);
  ok(state.mode === WPConstants.COORDINATOR_MODE.CONTROLLER_ACTIVE, 'active controller mode derives from tab and websocket state');

  state = WPCoordinatorKernel.reduce(state, {
    type: 'controller.released',
    tabId: 12,
    payload: { room: state.room, sessionId: state.sessionId },
  }, 1300);
  ok(state.mode === WPConstants.COORDINATOR_MODE.CONTROLLER_MISSING, 'release transitions to missing controller when room remains');
  ok(state.recentEvents.length > 0, 'coordinator keeps a bounded event log');
}

const context = createContext();
await testRoomKeySplit(context);
testControllerRoomReducer(context);
testAdapterRuntimeSnapshot(context);
testCoordinatorKernel(context);

console.log(`\nRuntime kernel tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
