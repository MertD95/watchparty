// WatchParty E2E Test — Multi-user sync, chat, reactions
// Simulates User 2 via direct WebSocket while User 1 is the MCP browser.
//
// Usage:
//   node test-e2e.mjs                    # run all tests
//   node test-e2e.mjs --room <roomId>    # join an existing room (for MCP pairing)
//
// Requires: WS server running on ws://localhost:8181

import WebSocket from 'ws';

const WS_URL = 'ws://localhost:8181';
const TIMEOUT = 10000;

// ── WebSocket helpers ──

// Track all open connections so we can force-close leaked ones between tests
const _openSockets = new Set();

/** Connect and wait for the server's 'ready' event before resolving. */
function connect(url = WS_URL) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    _openSockets.add(ws);
    ws.on('close', () => _openSockets.delete(ws));
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), TIMEOUT);
    ws.on('message', function onReady(data) {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ready') {
        clearTimeout(timer);
        ws.off('message', onReady);
        ws._ready = msg; // Stash for tests that need the ready payload
        resolve(ws);
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function closeAllSockets() {
  for (const ws of _openSockets) {
    try { ws.terminate(); } catch {}
  }
  _openSockets.clear();
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function waitFor(ws, type, timeout = TIMEOUT) {
  // connect() already consumed the 'ready' event — return the stashed copy
  if (type === 'ready' && ws._ready) {
    const msg = ws._ready;
    ws._ready = null;
    return Promise.resolve(msg);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${type}"`)), timeout);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

async function setUsername(ws, name) {
  send(ws, { type: 'user.update', payload: { username: name } });
  await waitFor(ws, 'user');
}

async function createRoom(ws, meta, opts = {}) {
  send(ws, {
    type: 'room.new',
    payload: {
      meta,
      stream: { url: 'https://example.com/stream.m3u8' },
      public: opts.public || false,
    },
  });
  return await waitFor(ws, 'room');
}

async function joinRoom(ws, roomId) {
  send(ws, { type: 'room.join', payload: { id: roomId } });
  // Server sends 'sync' (not 'room') when joining an existing room
  return await waitFor(ws, 'sync');
}

function collectMessages(ws, duration = 2000) {
  return new Promise((resolve) => {
    const msgs = [];
    const handler = (data) => msgs.push(JSON.parse(data.toString()));
    ws.on('message', handler);
    setTimeout(() => { ws.off('message', handler); resolve(msgs); }, duration);
  });
}

// ── Test runner ──

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Tests ──

async function testServerConnection() {
  console.log('\n── Test: Server connection ──');
  const ws = await connect();
  const ready = await waitFor(ws, 'ready');
  assert(typeof ready.payload?.user?.id === 'string' && ready.payload.user.id.length > 10, 'Server sends ready with valid UUID');
  ws.close();
}

async function testRoomCreationAndJoin() {
  console.log('\n── Test: Room creation & join ──');

  const ws1 = await connect();
  const ready1 = await waitFor(ws1, 'ready');
  const user1Id = ready1.payload.user.id;
  await setUsername(ws1, 'Alice');
  const roomMsg1 = await createRoom(ws1, { id: 'tt1375666', type: 'movie', name: 'Inception' });
  const roomId = roomMsg1.payload.id;

  assert(roomId, 'Room created with ID: ' + roomId);
  assert(roomMsg1.payload.owner === user1Id, 'Creator is room owner');
  assert(roomMsg1.payload.meta.name === 'Inception', 'Room has correct meta');
  assert(roomMsg1.payload.users.length === 1, 'Room has 1 user');

  const ws2 = await connect();
  const ready2 = await waitFor(ws2, 'ready');
  const user2Id = ready2.payload.user.id;
  await setUsername(ws2, 'Bob');
  const roomMsg2 = await joinRoom(ws2, roomId);

  assert(roomMsg2.payload.users.length === 2, 'Room now has 2 users');
  assert(roomMsg2.payload.users.some(u => u.name === 'Alice'), 'Alice is in users');
  assert(roomMsg2.payload.users.some(u => u.name === 'Bob'), 'Bob is in users');
  assert(roomMsg2.payload.owner === user1Id, 'Alice is still owner');

  ws1.close();
  ws2.close();
}

async function testChat() {
  console.log('\n── Test: Chat messages ──');

  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0111161', type: 'movie', name: 'The Shawshank Redemption' });

  const ws2 = await connect();
  const ws2Ready = await waitFor(ws2, 'ready');
  const user2Id = ws2Ready.payload.user.id;
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);
  await new Promise(r => setTimeout(r, 3100));

  const chatPromise = waitFor(ws1, 'message');
  send(ws2, { type: 'room.message', payload: { content: 'Hello Alice!' } });
  const chatMsg = await chatPromise;
  assert(chatMsg.payload.content === 'Hello Alice!', 'Alice receives Bob\'s message');
  assert(chatMsg.payload.user === user2Id, 'Message sender is Bob\'s ID');
  assert(typeof chatMsg.payload.date === 'number' && chatMsg.payload.date > Date.now() - 5000, 'Message has recent timestamp');

  // Alice sends chat back (wait for cooldown)
  await new Promise(r => setTimeout(r, 3100));
  const chatPromise2 = waitFor(ws2, 'message');
  send(ws1, { type: 'room.message', payload: { content: 'Hi Bob!' } });
  const chatMsg2 = await chatPromise2;
  assert(chatMsg2.payload.content === 'Hi Bob!', 'Bob receives Alice\'s message');

  ws1.close();
  ws2.close();
}

async function testPlayerSync() {
  console.log('\n── Test: Player sync ──');

  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0468569', type: 'movie', name: 'The Dark Knight' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);
  // Drain the sync that fires when Bob joins
  await waitFor(ws2, 'sync').catch(() => {});

  // Alice (host) sends play at 42.5s
  send(ws1, {
    type: 'player.sync',
    payload: { paused: false, buffering: false, time: 42.5, speed: 1 },
  });

  const sync = await waitFor(ws2, 'sync');
  assert(sync.payload.player.time === 42.5, 'Bob receives time=42.5');
  assert(sync.payload.player.paused === false, 'Bob receives paused=false');
  assert(sync.payload.player.speed === 1, 'Bob receives speed=1');

  // Alice pauses
  send(ws1, {
    type: 'player.sync',
    payload: { paused: true, buffering: false, time: 55.0, speed: 1 },
  });

  const sync2 = await waitFor(ws2, 'sync');
  assert(sync2.payload.player.paused === true, 'Bob receives pause at 55s');
  assert(sync2.payload.player.time === 55.0, 'Bob receives time=55.0');

  // Alice seeks to 120s
  send(ws1, {
    type: 'player.sync',
    payload: { paused: false, buffering: false, time: 120.0, speed: 1 },
  });

  const sync3 = await waitFor(ws2, 'sync');
  assert(sync3.payload.player.time === 120.0, 'Bob receives seek to 120s');

  ws1.close();
  ws2.close();
}

async function testReactions() {
  console.log('\n── Test: Reactions ──');

  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0133093', type: 'movie', name: 'The Matrix' });

  const ws2 = await connect();
  const r2 = await waitFor(ws2, 'ready');
  const bobId = r2.payload.user.id;
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  // Bob sends reaction
  send(ws2, { type: 'room.reaction', payload: { emoji: '🔥' } });

  const reaction = await waitFor(ws1, 'reaction');
  assert(reaction.payload.emoji === '🔥', 'Alice receives 🔥 reaction');
  assert(reaction.payload.user === bobId, 'Reaction sender is Bob\'s ID');

  ws1.close();
  ws2.close();
}

async function testTyping() {
  console.log('\n── Test: Typing indicators ──');

  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0109830', type: 'movie', name: 'Forrest Gump' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  // Bob starts typing
  send(ws2, { type: 'room.typing', payload: { typing: true } });

  const typing = await waitFor(ws1, 'typing');
  assert(typing.payload.typing === true, 'Alice sees Bob typing');

  // Bob stops typing
  send(ws2, { type: 'room.typing', payload: { typing: false } });

  const stopped = await waitFor(ws1, 'typing');
  assert(stopped.payload.typing === false, 'Alice sees Bob stopped typing');

  ws1.close();
  ws2.close();
}

async function testOwnershipTransfer() {
  console.log('\n── Test: Ownership transfer ──');
  const ws1 = await connect();
  const ready1 = await waitFor(ws1, 'ready');
  const user1Id = ready1.payload.user.id;
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0137523', type: 'movie', name: 'Fight Club' });

  const ws2 = await connect();
  const ready2 = await waitFor(ws2, 'ready');
  const user2Id = ready2.payload.user.id;
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  // Alice transfers ownership to Bob
  send(ws1, { type: 'room.updateOwnership', payload: { userId: user2Id } });

  const sync = await waitFor(ws2, 'sync');
  assert(sync.payload.owner === user2Id, 'Bob is now the owner');

  ws1.close();
  ws2.close();
}

async function testRoomLeave() {
  console.log('\n── Test: Room leave ──');

  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0120737', type: 'movie', name: 'LOTR' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);
  await new Promise(r => setTimeout(r, 300));

  // Bob leaves
  send(ws2, { type: 'room.leave', payload: {} });

  const sync = await waitFor(ws1, 'sync');
  assert(sync.payload.users.length === 1, 'Room has 1 user after Bob leaves');
  assert(sync.payload.users[0].name === 'Alice', 'Only Alice remains');

  ws1.close();
  ws2.close();
}

// ── Error cases & validation ──

async function testJoinNonexistentRoom() {
  console.log('\n── Test: Join nonexistent room ──');
  const ws = await connect();
  await waitFor(ws, 'ready');
  await setUsername(ws, 'Alice');
  send(ws, { type: 'room.join', payload: { id: 'nonexistent-room-id' } });
  const err = await waitFor(ws, 'error');
  assert(err.payload.type === 'room', 'Server returns room error for nonexistent room');
  ws.close();
}

async function testDoubleJoinDeduplicates() {
  console.log('\n── Test: Double join deduplicates ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0001', type: 'movie', name: 'Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  // Bob joins again
  send(ws2, { type: 'room.join', payload: { id: room.payload.id } });
  const sync = await waitFor(ws2, 'sync');
  const bobCount = sync.payload.users.filter(u => u.name === 'Bob').length;
  assert(bobCount === 1, 'Bob appears exactly once after double join');
  ws1.close(); ws2.close();
}

async function testNonOwnerCannotTransfer() {
  console.log('\n── Test: Non-owner cannot transfer ownership ──');
  const ws1 = await connect();
  const r1 = await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0002', type: 'movie', name: 'Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  // Bob tries to transfer ownership
  send(ws2, { type: 'room.updateOwnership', payload: { userId: r1.payload.user.id } });
  const err = await waitFor(ws2, 'error');
  assert(err.payload.type === 'owner', 'Non-owner gets owner error on transfer');
  ws1.close(); ws2.close();
}

async function testNonOwnerCannotTogglePublic() {
  console.log('\n── Test: Non-owner cannot toggle public ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0003', type: 'movie', name: 'Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  send(ws2, { type: 'room.updatePublic', payload: { public: true } });
  const err = await waitFor(ws2, 'error');
  assert(err.payload.type === 'owner', 'Non-owner gets owner error on public toggle');
  ws1.close(); ws2.close();
}

async function testChatCooldownEnforced() {
  console.log('\n── Test: Chat cooldown enforcement ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  await createRoom(ws1, { id: 'tt0004', type: 'movie', name: 'Test' });

  // Wait for cooldown from room creation
  await new Promise(r => setTimeout(r, 3100));

  send(ws1, { type: 'room.message', payload: { content: 'First message' } });
  // Immediately send second (within cooldown)
  send(ws1, { type: 'room.message', payload: { content: 'Second message' } });
  const err = await waitFor(ws1, 'error');
  assert(err.payload.type === 'cooldown', 'Server enforces chat cooldown');
  ws1.close();
}

async function testEmptyUsernameRejected() {
  console.log('\n── Test: Empty username rejected ──');
  const ws = await connect();
  await waitFor(ws, 'ready');
  send(ws, { type: 'user.update', payload: { username: '' } });
  const err = await waitFor(ws, 'error');
  assert(err.payload.type === 'validation', 'Empty username returns validation error');
  ws.close();
}

async function testLongUsernameRejected() {
  console.log('\n── Test: Username >25 chars rejected ──');
  const ws = await connect();
  await waitFor(ws, 'ready');
  send(ws, { type: 'user.update', payload: { username: 'A'.repeat(26) } });
  const err = await waitFor(ws, 'error');
  assert(err.payload.type === 'validation', 'Long username returns validation error');
  ws.close();
}

async function testEmptyMessageRejected() {
  console.log('\n── Test: Empty chat message rejected ──');
  const ws = await connect();
  await waitFor(ws, 'ready');
  await setUsername(ws, 'Alice');
  await createRoom(ws, { id: 'tt0005', type: 'movie', name: 'Test' });
  await new Promise(r => setTimeout(r, 3100));
  send(ws, { type: 'room.message', payload: { content: '' } });
  const err = await waitFor(ws, 'error');
  assert(err.payload.type === 'validation', 'Empty message returns validation error');
  ws.close();
}

async function testOversizedMessageRejected() {
  console.log('\n── Test: Message >300 chars rejected ──');
  const ws = await connect();
  await waitFor(ws, 'ready');
  await setUsername(ws, 'Alice');
  await createRoom(ws, { id: 'tt0006', type: 'movie', name: 'Test' });
  await new Promise(r => setTimeout(r, 3100));
  send(ws, { type: 'room.message', payload: { content: 'X'.repeat(301) } });
  const err = await waitFor(ws, 'error');
  assert(err.payload.type === 'validation', 'Oversized message returns validation error');
  ws.close();
}

async function testOwnerAutoTransferOnDisconnect() {
  console.log('\n── Test: Ownership auto-transfers on host disconnect ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0007', type: 'movie', name: 'Test' });

  const ws2 = await connect();
  const r2 = await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  // Alice disconnects
  ws1.close();

  const sync = await waitFor(ws2, 'sync');
  assert(sync.payload.owner === r2.payload.user.id, 'Bob becomes owner after Alice disconnects');
  assert(sync.payload.users.length === 1, 'Only Bob remains');
  ws2.close();
}

async function testEmptyRoomGracePeriod() {
  console.log('\n── Test: Empty room kept during grace period ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0008', type: 'movie', name: 'Test' });
  const roomId = room.payload.id;
  ws1.close();

  // Wait for server to process disconnect
  await new Promise(r => setTimeout(r, 500));

  // Room should still exist (5-min grace period) — Bob can rejoin
  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  send(ws2, { type: 'room.join', payload: { id: roomId } });
  const sync = await waitFor(ws2, 'sync');
  assert(sync.payload.users.length === 1, 'Bob is alone in the room');
  assert(sync.payload.users[0].name === 'Bob', 'Bob joined the empty room');
  ws2.close();
}

async function testClockPingPong() {
  console.log('\n── Test: Clock ping/pong ──');
  const ws = await connect();
  await waitFor(ws, 'ready');
  const clientTime = Date.now();
  send(ws, { type: 'clock.ping', payload: { clientTime } });
  const pong = await waitFor(ws, 'clock.pong');
  assert(pong.payload.clientTime === clientTime, 'Pong echoes clientTime');
  assert(typeof pong.payload.serverTime === 'number', 'Pong has serverTime');
  assert(Math.abs(pong.payload.serverTime - clientTime) < 5000, 'Server time is within 5s of client');
  ws.close();
}

async function testPublicRoomListing() {
  console.log('\n── Test: Public room HTTP listing ──');
  const ws = await connect();
  await waitFor(ws, 'ready');
  await setUsername(ws, 'Alice');
  const room = await createRoom(ws, { id: 'tt0009', type: 'movie', name: 'Public Movie' }, { public: true });

  // Fetch public rooms via HTTP
  const res = await fetch('http://localhost:8181/rooms');
  const data = await res.json();
  const rooms = data.rooms || data;
  const found = rooms.find(r => r.id === room.payload.id);
  assert(found !== undefined, 'Public room appears in /rooms listing');
  assert(found.meta.name === 'Public Movie', 'Listing has correct meta');

  ws.close();
}

async function testUnicodeInChat() {
  console.log('\n── Test: Unicode and special chars in chat ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt0010', type: 'movie', name: 'Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);
  await new Promise(r => setTimeout(r, 3100));

  const testMsg = '🎬 <script>alert(1)</script> مرحبا 你好';
  const chatPromise = waitFor(ws1, 'message');
  send(ws2, { type: 'room.message', payload: { content: testMsg } });
  const chatMsg = await chatPromise;
  assert(chatMsg.payload.content === testMsg, 'Unicode + HTML chars preserved exactly');
  ws1.close(); ws2.close();
}

async function testAutoLeaveOnNewRoom() {
  console.log('\n── Test: Creating new room auto-leaves old room ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room1 = await createRoom(ws1, { id: 'tt0011', type: 'movie', name: 'Room A' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room1.payload.id);

  // Set up listener BEFORE Alice creates new room
  const bobSyncPromise = waitFor(ws2, 'sync');

  // Alice creates a new room (should auto-leave room A)
  const room2 = await createRoom(ws1, { id: 'tt0012', type: 'movie', name: 'Room B' });
  assert(room2.payload.meta.name === 'Room B', 'Alice is now in Room B');

  const sync = await bobSyncPromise;
  assert(sync.payload.users.length === 1, 'Bob is alone in Room A');
  ws1.close(); ws2.close();
}

// ── Phase 2: Presence, playback status, auto-pause, room settings ──

async function testPresenceIndicators() {
  console.log('\n── Test: Presence indicators (AFK) ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt2001', type: 'movie', name: 'Presence Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  // Bob goes AFK
  send(ws2, { type: 'user.presence', payload: { status: 'away' } });
  const sync = await waitFor(ws1, 'sync');
  const bob = sync.payload.users.find(u => u.name === 'Bob');
  assert(bob?.status === 'away', 'Bob shows as away');

  // Bob comes back
  send(ws2, { type: 'user.presence', payload: { status: 'active' } });
  const sync2 = await waitFor(ws1, 'sync');
  const bob2 = sync2.payload.users.find(u => u.name === 'Bob');
  assert(bob2?.status === 'active', 'Bob shows as active again');

  ws1.close(); ws2.close();
}

async function testPlaybackStatus() {
  console.log('\n── Test: Playback status per user ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt2002', type: 'movie', name: 'Playback Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  // Bob reports playing
  send(ws2, { type: 'user.playbackStatus', payload: { status: 'playing' } });
  const sync = await waitFor(ws1, 'sync');
  const bob = sync.payload.users.find(u => u.name === 'Bob');
  assert(bob?.playbackStatus === 'playing', 'Bob shows as playing');

  // Bob reports buffering
  send(ws2, { type: 'user.playbackStatus', payload: { status: 'buffering' } });
  const sync2 = await waitFor(ws1, 'sync');
  const bob2 = sync2.payload.users.find(u => u.name === 'Bob');
  assert(bob2?.playbackStatus === 'buffering', 'Bob shows as buffering');

  // Bob reports paused
  send(ws2, { type: 'user.playbackStatus', payload: { status: 'paused' } });
  const sync3 = await waitFor(ws1, 'sync');
  const bob3 = sync3.payload.users.find(u => u.name === 'Bob');
  assert(bob3?.playbackStatus === 'paused', 'Bob shows as paused');

  ws1.close(); ws2.close();
}

async function testRoomSettings() {
  console.log('\n── Test: Room settings (owner-only) ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt2003', type: 'movie', name: 'Settings Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  // Alice enables auto-pause
  send(ws1, { type: 'room.updateSettings', payload: { autoPauseOnDisconnect: true } });
  const sync = await waitFor(ws2, 'sync');
  assert(sync.payload.settings?.autoPauseOnDisconnect === true, 'Auto-pause enabled');

  // Bob (non-owner) tries to change settings
  send(ws2, { type: 'room.updateSettings', payload: { autoPauseOnDisconnect: false } });
  const err = await waitFor(ws2, 'error');
  assert(err.payload.type === 'owner', 'Non-owner cannot change settings');

  ws1.close(); ws2.close();
}

async function testAutoPauseOnDisconnect() {
  console.log('\n── Test: Auto-pause on disconnect ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt2004', type: 'movie', name: 'AutoPause Test' });

  // Enable auto-pause
  send(ws1, { type: 'room.updateSettings', payload: { autoPauseOnDisconnect: true } });
  await waitFor(ws1, 'sync');

  // Set player to playing
  send(ws1, { type: 'player.sync', payload: { paused: false, buffering: false, time: 60 } });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);
  await new Promise(r => setTimeout(r, 300));

  // Collect messages on Alice's side
  const msgPromise = collectMessages(ws1, 3000);

  // Bob disconnects
  ws2.close();

  const msgs = await msgPromise;
  const autopause = msgs.find(m => m.type === 'autopause');
  const syncAfter = msgs.filter(m => m.type === 'sync').pop();

  assert(autopause !== undefined, 'Alice receives autopause event');
  assert(autopause?.payload?.name === 'Bob', 'Autopause names Bob');
  assert(syncAfter?.payload?.player?.paused === true, 'Player is now paused');

  ws1.close();
}

// ── Phase 3: Ready check, bookmarks ──

async function testReadyCheckFlow() {
  console.log('\n── Test: Ready check full flow ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt3001', type: 'movie', name: 'Ready Test' });

  // Set player to paused
  send(ws1, { type: 'player.sync', payload: { paused: true, buffering: false, time: 0 } });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);
  await new Promise(r => setTimeout(r, 300));

  // Alice initiates ready check
  send(ws1, { type: 'room.readyCheck', payload: { action: 'initiate' } });
  const rc1 = await waitFor(ws2, 'readyCheck');
  assert(rc1.payload.action === 'started', 'Bob receives ready check started');
  assert(rc1.payload.total === 2, 'Total is 2 users');
  assert(rc1.payload.confirmed.length === 0, 'No one confirmed yet');

  // Alice confirms
  send(ws1, { type: 'room.readyCheck', payload: { action: 'confirm' } });
  const rc2 = await waitFor(ws2, 'readyCheck');
  assert(rc2.payload.action === 'updated', 'Updated after Alice confirms');
  assert(rc2.payload.confirmed.length === 1, '1 confirmed');

  // Bob confirms — should trigger countdown
  const msgPromise = collectMessages(ws1, 5000);
  send(ws2, { type: 'room.readyCheck', payload: { action: 'confirm' } });

  const msgs = await msgPromise;
  const countdowns = msgs.filter(m => m.type === 'countdown');
  const syncs = msgs.filter(m => m.type === 'sync');

  const countdownValues = countdowns.map(c => c.payload.seconds);
  assert(countdowns.length === 4, `Received exactly 4 countdown events (3,2,1,0), got ${countdowns.length}`);
  assert(countdownValues[0] === 3, 'First countdown is 3');
  assert(countdownValues[1] === 2, 'Second countdown is 2');
  assert(countdownValues[2] === 1, 'Third countdown is 1');
  assert(countdownValues[3] === 0, 'Fourth countdown is 0');

  // After countdown, player should be unpaused
  const finalSync = syncs.pop();
  assert(finalSync?.payload?.player?.paused === false, 'Player auto-plays after countdown');

  ws1.close(); ws2.close();
}

async function testReadyCheckCancel() {
  console.log('\n── Test: Ready check cancel ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt3002', type: 'movie', name: 'Cancel Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);
  await new Promise(r => setTimeout(r, 300));

  // Alice initiates
  send(ws1, { type: 'room.readyCheck', payload: { action: 'initiate' } });
  await waitFor(ws2, 'readyCheck');

  // Alice cancels
  send(ws1, { type: 'room.readyCheck', payload: { action: 'cancel' } });
  const rc = await waitFor(ws2, 'readyCheck');
  assert(rc.payload.action === 'cancelled', 'Ready check cancelled');

  ws1.close(); ws2.close();
}

async function testReadyCheckNonOwnerCannotInitiate() {
  console.log('\n── Test: Non-owner cannot initiate ready check ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt3003', type: 'movie', name: 'Auth Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  // Bob tries to initiate
  send(ws2, { type: 'room.readyCheck', payload: { action: 'initiate' } });
  const err = await waitFor(ws2, 'error');
  assert(err.payload.type === 'owner', 'Non-owner cannot initiate ready check');

  ws1.close(); ws2.close();
}

async function testBookmarks() {
  console.log('\n── Test: Shared bookmarks ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt3004', type: 'movie', name: 'Bookmark Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);
  await new Promise(r => setTimeout(r, 300));

  // Bob bookmarks at 1:23:45 (5025 seconds)
  send(ws2, { type: 'room.bookmark', payload: { time: 5025, label: 'Epic scene!' } });
  const bm = await waitFor(ws1, 'bookmark');
  assert(bm.payload.time === 5025, 'Bookmark time is 5025');
  assert(bm.payload.label === 'Epic scene!', 'Bookmark has correct label');
  assert(bm.payload.userName === 'Bob', 'Bookmark shows Bob as creator');
  assert(typeof bm.payload.date === 'number', 'Bookmark has timestamp');

  ws1.close(); ws2.close();
}

async function testBookmarkAutoLabel() {
  console.log('\n── Test: Bookmark auto-generates label ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt3005', type: 'movie', name: 'AutoLabel Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);
  await new Promise(r => setTimeout(r, 300));

  // Bookmark without label
  send(ws2, { type: 'room.bookmark', payload: { time: 90 } });
  const bm = await waitFor(ws1, 'bookmark');
  assert(bm.payload.label === 'Bookmark at 1:30', `Auto-label is exact "Bookmark at 1:30", got "${bm.payload.label}"`);

  ws1.close(); ws2.close();
}

async function testPublicRoomEnhancedData() {
  console.log('\n── Test: Public room listing with enhanced data ──');
  const ws = await connect();
  await waitFor(ws, 'ready');
  await setUsername(ws, 'Alice');
  const room = await createRoom(ws, { id: 'tt4001', type: 'movie', name: 'Enhanced Listing' }, { public: true });

  // Set player state
  send(ws, { type: 'player.sync', payload: { paused: false, buffering: false, time: 300 } });
  await new Promise(r => setTimeout(r, 300));

  // Add a bookmark
  send(ws, { type: 'room.bookmark', payload: { time: 120, label: 'Cool part' } });
  await waitFor(ws, 'bookmark');
  await new Promise(r => setTimeout(r, 300));

  const res = await fetch('http://localhost:8181/rooms');
  const data = await res.json();
  const found = data.rooms?.find(r => r.id === room.payload.id);

  assert(found !== undefined, 'Room in listing');
  assert(found.paused === false, 'Listing shows playing state');
  assert(found.time === 300, 'Listing shows current time');
  assert(found.bookmarks === 1, 'Listing shows bookmark count');

  ws.close();
}

async function testThreeUserSync() {
  console.log('\n── Test: Three-user sync ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt5001', type: 'movie', name: '3-User Test' });

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, room.payload.id);

  const ws3 = await connect();
  await waitFor(ws3, 'ready');
  await setUsername(ws3, 'Charlie');
  await joinRoom(ws3, room.payload.id);
  await new Promise(r => setTimeout(r, 300));

  // Alice (host) plays at 100s
  send(ws1, { type: 'player.sync', payload: { paused: false, buffering: false, time: 100 } });

  const sync2 = await waitFor(ws2, 'sync');
  const sync3 = await waitFor(ws3, 'sync');

  assert(sync2.payload.player.time === 100, 'Bob receives time=100');
  assert(sync3.payload.player.time === 100, 'Charlie receives time=100');
  assert(sync2.payload.users.length === 3, 'Room has 3 users');

  ws1.close(); ws2.close(); ws3.close();
}

async function testDisconnectReconnectFlow() {
  console.log('\n── Test: Disconnect + reconnect rejoins room ──');
  const ws1 = await connect();
  await waitFor(ws1, 'ready');
  await setUsername(ws1, 'Alice');
  const room = await createRoom(ws1, { id: 'tt5002', type: 'movie', name: 'Reconnect Test' });
  const roomId = room.payload.id;

  const ws2 = await connect();
  await waitFor(ws2, 'ready');
  await setUsername(ws2, 'Bob');
  await joinRoom(ws2, roomId);

  // Bob disconnects — drain Alice's sync about Bob leaving
  ws2.close();
  await collectMessages(ws1, 1000);

  // Bob reconnects and rejoins
  const ws3 = await connect();
  await waitFor(ws3, 'ready');
  await setUsername(ws3, 'Bob');

  // Set up listener BEFORE joining
  const syncPromise = waitFor(ws1, 'sync');
  send(ws3, { type: 'room.join', payload: { id: roomId } });
  await waitFor(ws3, 'sync');

  const sync = await syncPromise;
  assert(sync.payload.users.some(u => u.name === 'Bob'), 'Bob is back in room');
  assert(sync.payload.users.length === 2, 'Room has 2 users again');

  ws1.close(); ws3.close();
}

// ── MCP pairing mode: join an existing room created from the browser ──

async function testMCPPairing(roomId) {
  console.log(`\n── MCP Pairing: joining room ${roomId} ──`);

  const ws = await connect();
  const ready = await waitFor(ws, 'ready');
  console.log(`  Connected as ${ready.payload.user.id}`);

  send(ws, { type: 'user.update', payload: { username: 'Bot-User-2' } });
  send(ws, { type: 'room.join', payload: { id: roomId } });

  const room = await waitFor(ws, 'room');
  assert(room.payload.users.length >= 2, `Room has ${room.payload.users.length} users`);
  console.log('  Users:', room.payload.users.map(u => u.name).join(', '));

  // Send a chat message
  send(ws, { type: 'room.message', payload: { content: 'Hello from the test bot!' } });
  console.log('  Sent chat: "Hello from the test bot!"');

  // Send a reaction
  send(ws, { type: 'room.reaction', payload: { emoji: '👋' } });
  console.log('  Sent reaction: 👋');

  // Listen for sync events for 5 seconds
  console.log('  Listening for sync events (5s)...');
  const msgs = await collectMessages(ws, 5000);
  const syncs = msgs.filter(m => m.type === 'sync');
  const chats = msgs.filter(m => m.type === 'message');
  console.log(`  Received: ${syncs.length} syncs, ${chats.length} chats`);

  ws.close();
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const roomIdx = args.indexOf('--room');

  if (roomIdx !== -1 && args[roomIdx + 1]) {
    // MCP pairing mode
    await testMCPPairing(args[roomIdx + 1]);
  } else {
    // Full test suite
    console.log('WatchParty E2E Tests');
    console.log('====================');

    const tests = [
      // Core flows
      testServerConnection,
      testRoomCreationAndJoin,
      testChat,
      testPlayerSync,
      testReactions,
      testTyping,
      testOwnershipTransfer,
      testRoomLeave,
      // Error cases & validation
      testJoinNonexistentRoom,
      testDoubleJoinDeduplicates,
      testNonOwnerCannotTransfer,
      testNonOwnerCannotTogglePublic,
      testChatCooldownEnforced,
      testEmptyUsernameRejected,
      testLongUsernameRejected,
      testEmptyMessageRejected,
      testOversizedMessageRejected,
      // Lifecycle
      testOwnerAutoTransferOnDisconnect,
      testEmptyRoomGracePeriod,
      testClockPingPong,
      testPublicRoomListing,
      // Edge cases
      testUnicodeInChat,
      testAutoLeaveOnNewRoom,
      // Phase 2: Presence, playback status, auto-pause, settings
      testPresenceIndicators,
      testPlaybackStatus,
      testRoomSettings,
      testAutoPauseOnDisconnect,
      // Phase 3: Ready check, bookmarks
      testReadyCheckFlow,
      testReadyCheckCancel,
      testReadyCheckNonOwnerCannotInitiate,
      testBookmarks,
      testBookmarkAutoLabel,
      // Enhanced features
      testPublicRoomEnhancedData,
      testThreeUserSync,
      testDisconnectReconnectFlow,
    ];
    for (const test of tests) {
      try { await test(); } catch (e) { console.error('  ✗ FATAL:', e.message); failed++; }
      // Force-close any leaked connections from failed tests
      closeAllSockets();
    }

    console.log(`\n${'='.repeat(30)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
