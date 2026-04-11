// WatchParty 10-User Comprehensive Test
// Tests all multi-user interactions with 9 WS bots

import WebSocket from 'ws';
import http from 'http';

const USERS = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Hank', 'Ivy'];
let passed = 0, failed = 0, total = 0;

function ok(c, l) { total++; if(c){console.log('  ✓ '+l);passed++}else{console.error('  ✗ '+l);failed++} }

// Track all connections for cleanup on crash
globalThis._allPeers = [];

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:8181');
    const received = { room:[], sync:[], message:[], typing:[], reaction:[], bookmark:[], readyCheck:[], countdown:[], autopause:[], error:[] };
    ws.on('open', () => ws.send(JSON.stringify({type:'user.update',payload:{username:name}})));
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (received[m.type]) received[m.type].push(m.payload);
      if (m.type === 'user') {
        const peer = { ws, name, id: m.payload.user.id, received,
          send: (t,p) => ws.send(JSON.stringify({type:t,payload:p})),
          close: () => ws.close()
        };
        globalThis._allPeers.push(peer);
        resolve(peer);
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout: ' + name)), 5000);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getRooms() {
  return new Promise(r => http.get('http://localhost:8181/rooms', res => {
    let b=''; res.on('data',d=>b+=d); res.on('end',()=>r(JSON.parse(b)));
  }));
}

async function run() {
  console.log('\n=== 10-User Comprehensive Test ===\n');

  // Create host
  console.log('── Setup: Connect 9 bots ──');
  const host = await connect('HostBot');
  host.send('room.new', { meta:{id:'tt1745960',type:'movie',name:'Top Gun: Maverick'}, stream:{url:'http://x.com/s.mp4'}, public:true });
  await sleep(1000);
  const roomId = host.received.room[0]?.id || host.received.sync[0]?.id;
  ok(!!roomId, 'Room created: ' + (roomId?.substring(0,8)||'NONE'));

  // Connect 8 peers
  const peers = [];
  for (const name of USERS) {
    const p = await connect(name);
    p.send('room.join', { id: roomId });
    await sleep(200);
    peers.push(p);
  }
  await sleep(2000);

  // ── Test 1: All users joined ──
  console.log('\n── Test 1: All 9 users visible ──');
  const lastSync = host.received.sync[host.received.sync.length - 1];
  const userCount = lastSync?.users?.length || 0;
  ok(userCount === 10, 'Host sees ' + userCount + '/10 users');
  const names = lastSync?.users?.map(u => u.name) || [];
  ok(names.includes('Alice'), 'Alice joined');
  ok(names.includes('Hank'), 'Hank joined');
  ok(names.includes('HostBot'), 'HostBot present');

  // ── Test 2: Chat broadcast ──
  console.log('\n── Test 2: Chat (each user sends, all receive) ──');
  for (const p of [host, ...peers]) p.received.message = [];

  for (const p of peers) {
    p.send('room.message', { content: 'Hi from ' + p.name });
    await sleep(400);
  }
  await sleep(2000);

  const hostMsgs = host.received.message.map(m => m.content);
  ok(hostMsgs.length >= 9, 'Host got ' + hostMsgs.length + '/9 chats');
  ok(hostMsgs.includes('Hi from Alice'), 'Got Alice chat');
  ok(hostMsgs.includes('Hi from Ivy'), 'Got Ivy chat');

  // Check peer-to-peer: Alice sees Bob's message
  const aliceMsgs = peers[0].received.message.map(m => m.content);
  ok(aliceMsgs.some(c => c.includes('Bob')), 'Alice sees Bob chat');
  ok(aliceMsgs.some(c => c.includes('Ivy')), 'Alice sees Ivy chat');

  // ── Test 3: Typing ──
  console.log('\n── Test 3: Typing indicators ──');
  host.received.typing = [];
  peers[0].send('room.typing', { typing: true });
  peers[1].send('room.typing', { typing: true });
  peers[2].send('room.typing', { typing: true });
  await sleep(1000);
  ok(host.received.typing.length >= 3, 'Host got ' + host.received.typing.length + '/3 typing events');

  // ── Test 4: Reactions ──
  console.log('\n── Test 4: Reactions from multiple users ──');
  host.received.reaction = [];
  const emojis = ['🍿', '🔥', '😂', '❤️', '👏'];
  for (let i = 0; i < 5; i++) {
    peers[i].send('room.reaction', { emoji: emojis[i] });
    await sleep(100);
  }
  await sleep(1000);
  ok(host.received.reaction.length >= 5, 'Host got ' + host.received.reaction.length + '/5 reactions');
  for (const e of emojis) {
    ok(host.received.reaction.some(r => r.emoji === e), 'Got ' + e);
  }

  // ── Test 5: Bookmarks ──
  console.log('\n── Test 5: Bookmarks from multiple users ──');
  host.received.bookmark = [];
  peers[0].send('room.bookmark', { time: 120 });
  peers[3].send('room.bookmark', { time: 300 });
  peers[6].send('room.bookmark', { time: 600 });
  await sleep(1000);
  ok(host.received.bookmark.length >= 3, 'Host got ' + host.received.bookmark.length + '/3 bookmarks');
  ok(host.received.bookmark.some(b => b.time === 120), '2:00 bookmark');
  ok(host.received.bookmark.some(b => b.time === 600), '10:00 bookmark');

  // ── Test 6: Presence ──
  console.log('\n── Test 6: Presence (3 users go away, come back) ──');
  host.received.sync = [];
  peers[0].send('user.presence', { status: 'away' });
  peers[1].send('user.presence', { status: 'away' });
  peers[2].send('user.presence', { status: 'away' });
  await sleep(2000);
  let syncData = host.received.sync[host.received.sync.length - 1];
  const awayCount = syncData?.users?.filter(u => u.status === 'away').length || 0;
  ok(awayCount >= 3, awayCount + '/3 users away');

  peers[0].send('user.presence', { status: 'active' });
  peers[1].send('user.presence', { status: 'active' });
  peers[2].send('user.presence', { status: 'active' });
  await sleep(2000);
  syncData = host.received.sync[host.received.sync.length - 1];
  const activeCount = syncData?.users?.filter(u => u.status === 'active').length || 0;
  ok(activeCount >= 9, activeCount + '/10 users active (some may still be syncing)');

  // ── Test 7: Playback status ──
  console.log('\n── Test 7: Playback status ──');
  host.received.sync = [];
  peers[0].send('user.playbackStatus', { status: 'playing' });
  peers[1].send('user.playbackStatus', { status: 'buffering' });
  peers[2].send('user.playbackStatus', { status: 'paused' });
  await sleep(2000);
  syncData = host.received.sync[host.received.sync.length - 1];
  ok(syncData?.users?.find(u => u.name === 'Alice')?.playbackStatus === 'playing', 'Alice playing');
  ok(syncData?.users?.find(u => u.name === 'Bob')?.playbackStatus === 'buffering', 'Bob buffering');
  ok(syncData?.users?.find(u => u.name === 'Charlie')?.playbackStatus === 'paused', 'Charlie paused');

  // ── Test 8: Ready check ──
  console.log('\n── Test 8: Ready check (host starts, all confirm) ──');
  for (const p of [host, ...peers]) p.received.readyCheck = [];
  for (const p of [host, ...peers]) p.received.countdown = [];

  host.send('room.readyCheck', { action: 'initiate' });
  await sleep(500);
  ok(peers[0].received.readyCheck.some(r => r.action === 'started'), 'Alice sees ready check');
  ok(peers[0].received.readyCheck.some(r => r.total === 10), 'Total = 10');

  // All confirm
  for (const p of [...peers, host]) {
    p.send('room.readyCheck', { action: 'confirm' });
    await sleep(50);
  }
  await sleep(3000);
  ok(peers[0].received.countdown.length > 0, 'Countdown triggered');
  ok(peers[0].received.countdown.some(c => c.seconds === 3), 'Countdown starts at 3');

  // ── Test 9: Permissions ──
  console.log('\n── Test 9: Non-host permissions rejected ──');
  peers[0].received.error = [];
  peers[0].send('room.updateOwnership', { userId: peers[0].id });
  await sleep(500);
  ok(peers[0].received.error.some(e => e.type === 'owner'), 'Ownership transfer rejected');

  peers[1].received.error = [];
  peers[1].send('room.readyCheck', { action: 'initiate' });
  await sleep(500);
  ok(peers[1].received.error.some(e => e.type === 'owner'), 'Ready check initiate rejected');

  // ── Test 10: Ownership transfer ──
  console.log('\n── Test 10: Ownership transfer ──');
  host.received.sync = [];
  host.send('room.updateOwnership', { userId: peers[0].id });
  await sleep(1000);
  syncData = host.received.sync[host.received.sync.length - 1];
  ok(syncData?.owner === peers[0].id, 'Alice is new owner');

  // Transfer back
  peers[0].send('room.updateOwnership', { userId: host.id });
  await sleep(500);

  // ── Test 11: User leave ──
  console.log('\n── Test 11: Users leaving ──');
  host.received.sync = [];
  peers[7].send('room.leave', {}); // Hank leaves
  await sleep(1000);
  syncData = host.received.sync[host.received.sync.length - 1];
  ok(syncData?.users?.length === 9, 'After Hank leaves: ' + (syncData?.users?.length||0) + '/9');
  ok(!syncData?.users?.some(u => u.name === 'Hank'), 'Hank gone from list');

  // 3 more leave
  peers[5].send('room.leave', {});
  peers[6].send('room.leave', {});
  peers[4].send('room.leave', {});
  await sleep(1500);
  syncData = host.received.sync[host.received.sync.length - 1];
  ok(syncData?.users?.length === 6, 'After 4 leave: ' + (syncData?.users?.length||0) + '/6');

  // ── Test 12: Rooms API ──
  console.log('\n── Test 12: Rooms API ──');
  const roomsData = await getRooms();
  const room = roomsData.rooms.find(r => r.meta?.id === 'tt1745960');
  ok(!!room, 'Room in API');
  ok(room.users === 6, 'API shows ' + room.users + '/6 users');
  ok(room.public === true, 'Room is public');
  ok(room.meta.name === 'Top Gun: Maverick', 'Meta correct');

  // ── Cleanup ──
  console.log('\n── Cleanup ──');
  for (const p of peers) { try { p.send('room.leave', {}); } catch {} }
  host.send('room.leave', {});
  await sleep(500);
  for (const p of peers) try { p.close(); } catch {}
  host.close();

  console.log('\n' + '='.repeat(50));
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed (' + total + ' total)');
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('FATAL:', e.message);
  // Force-close all connections on crash to avoid zombie leaks
  for (const p of (globalThis._allPeers || [])) { try { p.ws.terminate(); } catch {} }
  process.exit(1);
});
