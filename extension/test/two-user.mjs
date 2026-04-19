// WatchParty — Two Real Users E2E Test
// Two independent Chromium instances with separate chrome.storage.
// Each test has a 60s timeout and guaranteed browser cleanup.
//
// Requires: WS server on ws://localhost:8181
// Usage:    node extension/test/two-user.mjs

import WebSocket from 'ws';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createBrowserDiagnostics } from './browser-diagnostics.mjs';
import { getExtensionId, launchExtensionContext } from './extension-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const STREMIO = 'https://web.stremio.com';
const TIMEOUT = 15000;
const TEST_TIMEOUT = 60000;
const PRIVATE_ROOM_KEY = 'private-room-key-1234';

let passed = 0, failed = 0;
function ok(cond, label) { if (cond) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}`); failed++; } }

let currentDiagnostics = null;

function trackPageDiagnostics(page, label) {
  currentDiagnostics?.attachPage(page, label);
}

function assertCleanDiagnostics(label) {
  if (!currentDiagnostics) return;
  const unexpected = currentDiagnostics.popUnexpected();
  const message = unexpected.length === 0
    ? `${label}: no unexpected browser errors`
    : `${label}: unexpected browser errors (${currentDiagnostics.format(unexpected)})`;
  ok(unexpected.length === 0, message);
  currentDiagnostics = null;
}

const CHROME_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--no-first-run',
  '--disable-blink-features=AutomationControlled',
];
const dirs = [];

async function launch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wp-${label}-`));
  dirs.push(dir);
  return launchExtensionContext(EXT_PATH, {
    userDataDir: dir,
    args: CHROME_FLAGS,
    viewport: { width: 1280, height: 720 },
  });
}

async function stremio(ctx) {
  const p = await ctx.newPage();
  trackPageDiagnostics(p, 'stremio');
  await p.goto(STREMIO, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!document.getElementById('wp-overlay'), { timeout: TIMEOUT });
  await p.waitForTimeout(1000);
  return p;
}

async function popup(ctx, extId) {
  const p = await ctx.newPage();
  trackPageDiagnostics(p, 'popup');
  await p.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  return p;
}

async function sidebar(page) {
  const h = await page.evaluate(() => document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden'));
  if (h) { await page.evaluate(() => document.getElementById('wp-toggle-host')?.click()); await page.waitForTimeout(500); }
}

async function findRoomInListing(roomId, predicate = () => true, options = {}) {
  const { attempts = 8, delayMs = 400 } = options;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let offset = 0;
    let total = 0;
    do {
      const res = await fetch(`http://localhost:8181/rooms?offset=${offset}&limit=50`);
      const payload = await res.json();
      const rooms = payload.rooms || [];
      const room = rooms.find((entry) => entry.id === roomId);
      if (room && predicate(room)) return room;
      total = payload.total || rooms.length || 0;
      offset += payload.limit || rooms.length || 50;
    } while (offset < total);

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return null;
}

async function runTest(name, fn) {
  console.log(`\n── ${name} ──`);
  const contexts = [];
  currentDiagnostics = createBrowserDiagnostics();
  const wrappedLaunch = async (label) => { const ctx = await launch(label); contexts.push(ctx); return ctx; };
  try {
    await Promise.race([
      fn(wrappedLaunch),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT (${TEST_TIMEOUT/1000}s)`)), TEST_TIMEOUT)),
    ]);
  } catch (e) {
    console.error(`  ✗ FATAL: ${e.message}`);
    failed++;
  } finally {
    for (const ctx of contexts) { try { await ctx.close(); } catch {} }
    assertCleanDiagnostics(name);
  }
}

// ── Tests ──

async function main() {
  console.log('WatchParty Two-User E2E Tests');
  console.log('=============================\n');
  try { const r = await fetch('http://localhost:8181/health'); if (!r.ok) throw 0; console.log('Server: running\n'); }
  catch { console.error('ERROR: Server not running'); process.exit(1); }

  // TEST 1: Two users — full flow
  await runTest('Two-user: create, join, chat, settings, leave', async (launch) => {
    const ctxA = await launch('alice');
    const ctxB = await launch('bob');
    const pageA = await stremio(ctxA);
    const pageB = await stremio(ctxB);

    for (const p of [pageA, pageB]) await p.evaluate(() => document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'leave-room' } })));
    await pageA.waitForTimeout(1500);
    ok(await pageA.evaluate(() => document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room')), 'Alice clean');
    ok(await pageB.evaluate(() => document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room')), 'Bob clean');

    const extA = await getExtensionId(ctxA);
    const popA = await popup(ctxA, extA);
    await popA.fill('#username-input', 'Alice');
    await popA.check('#public-check');
    await popA.click('#btn-create');
    await popA.waitForFunction(() => !document.getElementById('view-room')?.classList.contains('hidden'), { timeout: TIMEOUT });
    const roomId = await popA.evaluate(() => document.getElementById('room-id-display')?.textContent);
    ok(!!roomId, `Room created: ${roomId?.substring(0, 8)}`);
    await popA.close();

    await pageA.waitForFunction(() => !document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'), { timeout: 8000 });
    ok(true, 'Alice sidebar in room');

    const extB = await getExtensionId(ctxB);
    const popB = await popup(ctxB, extB);
    await popB.fill('#username-input', 'Bob');
    await popB.click('#lobby-tab-join');
    await popB.fill('#room-id-input', roomId);
    await popB.click('#btn-join');
    await popB.waitForFunction(() => !document.getElementById('view-room')?.classList.contains('hidden'), { timeout: TIMEOUT });
    ok(true, 'Bob joined');
    await popB.close();

    await sidebar(pageA);
    await sidebar(pageB);
    await pageA.evaluate(() => document.querySelector('[data-panel="people"]')?.click());
    await pageB.evaluate(() => document.querySelector('[data-panel="people"]')?.click());
    await pageA.waitForTimeout(300);
    await pageB.waitForTimeout(300);
    ok(await pageB.evaluate(() => document.getElementById('wp-users')?.innerText?.includes('Alice')), 'Bob sees Alice');
    ok(await pageA.waitForFunction(() => document.getElementById('wp-users')?.innerText?.includes('Bob'), { timeout: 5000 }).then(() => true).catch(() => false), 'Alice sees Bob');

    await pageA.evaluate(() => document.querySelector('[data-panel="room"]')?.click());
    await pageB.evaluate(() => document.querySelector('[data-panel="room"]')?.click());
    await pageA.waitForTimeout(300);
    await pageB.waitForTimeout(300);
    ok(await pageA.evaluate(() => !!document.getElementById('wp-session-public')), 'Host sees Session Controls in the sidebar');
    ok(await pageA.evaluate(() => !!document.getElementById('wp-session-autopause')), 'Host sees auto-pause safeguard in the sidebar');
    ok(await pageB.evaluate(() => !document.getElementById('wp-session-public')), 'Peer does not see host-only session controls');
    ok(await pageA.evaluate(() => !!document.getElementById('wp-settings-sound')), 'Host sees personal browser settings in the sidebar');
    ok(await pageB.evaluate(() => !!document.getElementById('wp-settings-sound')), 'Peer sees personal browser settings in the sidebar');

    await pageA.evaluate(() => document.querySelector('[data-panel="chat"]')?.click());
    await pageB.evaluate(() => document.querySelector('[data-panel="chat"]')?.click());
    await pageA.waitForTimeout(200);
    await pageB.waitForTimeout(200);

    await pageB.focus('#wp-chat-input');
    await pageB.keyboard.type('Hi from Bob');
    await pageB.keyboard.press('Enter');
    ok(await pageA.waitForFunction(() => document.getElementById('wp-chat-messages')?.innerText?.includes('Hi from Bob'), { timeout: 8000 }).then(() => true).catch(() => false), 'Alice sees Bob chat');

    await pageA.bringToFront();
    await pageA.waitForTimeout(3500);
    await pageA.focus('#wp-chat-input');
    await pageA.keyboard.type('Hi from Alice');
    await pageA.keyboard.press('Enter');
    ok(await pageA.waitForFunction(() => document.getElementById('wp-chat-messages')?.innerText?.includes('Hi from Alice'), { timeout: 5000 }).then(() => true).catch(() => false), 'Alice chat round-trip');

    await pageA.evaluate(() => {
      document.querySelector('[data-panel="room"]')?.click();
      document.querySelector('.wp-color-btn[data-color="#ec4899"]')?.click();
    });
    await pageB.evaluate(() => {
      document.querySelector('[data-panel="room"]')?.click();
      document.querySelector('.wp-color-btn[data-color="#22c55e"]')?.click();
    });
    await pageA.waitForTimeout(1000);
    ok(await pageA.evaluate(() => document.getElementById('wp-sidebar')?.style.getPropertyValue('--wp-accent') === '#ec4899'), 'Alice pink');
    await pageB.waitForTimeout(1000);
    ok(await pageB.evaluate(() => document.getElementById('wp-sidebar')?.style.getPropertyValue('--wp-accent') === '#22c55e'), 'Bob green');

    const popB3 = await popup(ctxB, extB);
    await popB3.click('#btn-leave');
    await popB3.close();
    let bobGone = false;
    for (let i = 0; i < 10; i++) { await pageA.waitForTimeout(500); bobGone = await pageA.evaluate(() => !document.getElementById('wp-users')?.innerText?.includes('Bob')); if (bobGone) break; }
    ok(bobGone, 'Alice sees Bob left');

    const popA3 = await popup(ctxA, extA);
    await popA3.click('#btn-leave');
    await popA3.close();
    ok(await pageA.waitForFunction(() => document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'), { timeout: 10000 }).then(() => true).catch(() => false), 'Alice left');
  });

  // TEST 2: Public/private room via direct WS (server verification)
  await runTest('Public/private room API', async () => {
    const ws1 = new WebSocket('ws://localhost:8181');
    const pubId = await new Promise(resolve => {
      ws1.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'ready') { ws1.send(JSON.stringify({ type: 'user.update', payload: { username: 'Host' } })); ws1.send(JSON.stringify({ type: 'room.new', payload: { meta: { id: 'tt1', type: 'movie', name: 'PubTest' }, stream: { url: 'http://x/s' }, public: true } })); } if (m.type === 'room') resolve(m.payload.id); });
    });
    const publicRoom = await findRoomInListing(pubId, (room) => room.public === true && room.owner === 'Host');
    ok(!!publicRoom, 'Public in /rooms');
    ok(publicRoom?.owner === 'Host', 'Owner = Host');

    ws1.send(JSON.stringify({ type: 'room.updatePublic', payload: { public: false, roomKey: PRIVATE_ROOM_KEY } }));
    const privateRoom = await findRoomInListing(pubId, (room) => room.public === false);
    ok(!!privateRoom, 'Private room stays listed after toggle private');

    ws1.send(JSON.stringify({ type: 'room.updatePublic', payload: { public: true } }));
    const publicAgain = await findRoomInListing(pubId, (room) => room.public === true);
    ok(!!publicAgain, 'Visible after toggle public');
    ws1.close();
  });

  // TEST 3: Sidebar UI
  await runTest('Sidebar UI', async (launch) => {
    const ctx = await launch('ui');
    const page = await stremio(ctx);
    const ext = await getExtensionId(ctx);
    const pop = await popup(ctx, ext);
    await pop.fill('#username-input', 'Host');
    await pop.click('#btn-create');
    await pop.waitForFunction(() => !document.getElementById('view-room')?.classList.contains('hidden'), { timeout: TIMEOUT });
    await pop.close();
    await page.waitForTimeout(2000);
    await sidebar(page);

    await page.evaluate(() => document.getElementById('wp-close-sidebar')?.click());
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden')), '× closes');
    await page.evaluate(() => document.getElementById('wp-toggle-host')?.click());
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden')), 'Toggle opens');
    ok(await page.evaluate(() => {
      const pushTarget = document.getElementById('app') || document.body;
      return Math.round(pushTarget.getBoundingClientRect().width) < window.innerWidth;
    }), 'App content pushed');

    await page.evaluate(() => document.querySelector('[data-panel="people"]')?.click());
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.querySelector('[data-panel="people"]')?.getAttribute('aria-selected') === 'true'), 'People tab activates');
    await page.evaluate(() => document.querySelector('[data-panel="room"]')?.click());
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.querySelector('[data-panel="room"]')?.getAttribute('aria-selected') === 'true'), 'Room tab activates');

    await page.evaluate(() => document.querySelector('[data-panel="chat"]')?.click());
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.querySelector('[data-panel="chat"]')?.getAttribute('aria-selected') === 'true'), 'Chat tab activates');

    await page.keyboard.press('Alt+w');
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden')), 'Alt+W closes');
    await page.keyboard.press('Alt+w');
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden')), 'Alt+W opens');

    await page.focus('#wp-chat-input');
    await page.keyboard.press('Alt+w');
    await page.waitForTimeout(300);
    ok(await page.evaluate(() =>
      !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden')
      && document.activeElement?.id === 'wp-chat-input'
    ), 'Alt+W ignored while chat input is focused');
    await page.keyboard.type('mute');
    ok(await page.evaluate(() => document.getElementById('wp-chat-input')?.value === 'mute'), 'Chat input keeps typed keys local');
    await page.evaluate(() => { document.getElementById('wp-chat-input').value = ''; });

    await page.setViewportSize({ width: 360, height: 844 });
    await page.waitForTimeout(600);
    ok(await page.evaluate(() => !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden')), 'Sidebar stays open on narrow viewport');
    ok(await page.evaluate(() => {
      const toggle = document.getElementById('wp-toggle-host');
      if (!toggle) return false;
      const style = getComputedStyle(toggle);
      const rect = toggle.getBoundingClientRect();
      return style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0;
    }), 'Mobile open hides launcher');
    ok(await page.evaluate(() => {
      const tabbar = document.getElementById('wp-tabbar');
      const roomTab = document.querySelector('[data-panel="room"]');
      if (!tabbar || !roomTab) return false;
      const tabRect = tabbar.getBoundingClientRect();
      const roomRect = roomTab.getBoundingClientRect();
      return roomRect.left >= tabRect.left - 1 && roomRect.right <= tabRect.right + 1 && roomRect.width > 0;
    }), 'Room tab remains unobstructed on mobile');
    await page.evaluate(() => document.getElementById('wp-close-sidebar')?.click());
    const mobileClosed = await page.waitForFunction(
      () => document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden'),
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    ok(mobileClosed, 'Mobile close button closes sidebar');
    const mobileLauncherRestored = await page.waitForFunction(() => {
      const toggle = document.getElementById('wp-toggle-host');
      if (!toggle) return false;
      const style = getComputedStyle(toggle);
      const rect = toggle.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }, { timeout: 5000 }).then(() => true).catch(() => false);
    ok(mobileLauncherRestored, 'Mobile close restores launcher');
    await page.evaluate(() => document.getElementById('wp-toggle-host')?.click());
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-panel="chat"]')?.click());
    await page.waitForTimeout(200);

    await page.evaluate(() => document.querySelector('#wp-emoji-btn')?.click());
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => !document.getElementById('wp-emoji-picker')?.classList.contains('wp-hidden-el')), 'Emoji opens');
    await page.evaluate(() => document.querySelector('#wp-emoji-btn')?.click());
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector('#wp-gif-btn')?.click());
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => { const p = document.getElementById('wp-gif-picker'); return p && !p.classList.contains('wp-hidden-el') && !!p.querySelector('input'); }), 'GIF opens');
    await page.focus('#wp-gif-search');
    await page.keyboard.type('cats');
    await page.keyboard.press('Alt+w');
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => {
      const sidebarHidden = document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden');
      return !sidebarHidden && document.getElementById('wp-gif-search')?.value === 'cats';
    }), 'GIF search keeps keyboard focus and ignores Alt+W');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    ok(await page.evaluate(() => {
      const picker = document.getElementById('wp-gif-picker');
      return picker?.classList.contains('wp-hidden-el') && !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden');
    }), 'Escape closes GIF picker without closing the sidebar');
    await page.evaluate(() => document.querySelector('#wp-gif-btn')?.click());
  });

  // TEST 4: SPA navigation
  await runTest('SPA navigation in room', async (launch) => {
    const ctx = await launch('spa');
    const page = await stremio(ctx);
    const ext = await getExtensionId(ctx);
    const pop = await popup(ctx, ext);
    await pop.fill('#username-input', 'Nav');
    await pop.click('#btn-create');
    await pop.waitForFunction(() => !document.getElementById('view-room')?.classList.contains('hidden'), { timeout: TIMEOUT });
    await pop.close();
    await page.waitForTimeout(2000);

    for (const h of ['#/', '#/discover', '#/library', '#/settings']) {
      await page.evaluate(hash => window.location.hash = hash.slice(1), h);
      await page.waitForTimeout(1000);
      ok(await page.evaluate(() => !!document.getElementById('wp-overlay') && !!document.getElementById('wp-sidebar')), `Persists on ${h}`);
    }
  });

  // TEST 5: Named room
  await runTest('Named room rejoin', async (launch) => {
    const ctx = await launch('named');
    const page = await stremio(ctx);
    const ext = await getExtensionId(ctx);
    const roomName = `persist-test-${Date.now().toString().slice(-6)}`;
    const pop1 = await popup(ctx, ext);
    await pop1.fill('#username-input', 'Alice');
    await pop1.fill('#room-name-input', roomName);
    await pop1.check('#public-check');
    await pop1.click('#btn-create');
    await pop1.waitForFunction(() => !document.getElementById('view-room')?.classList.contains('hidden'), { timeout: TIMEOUT });
    const id1 = await pop1.evaluate(() => document.getElementById('room-id-display')?.textContent);
    ok(!!id1, `Created: ${id1?.substring(0, 8)}`);
    await pop1.close();

    await page.evaluate(() => document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'leave-room' } })));
    await page.waitForFunction(() => document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'), { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const pop2 = await popup(ctx, ext);
    await pop2.fill('#username-input', 'Alice');
    await pop2.fill('#room-name-input', roomName);
    await pop2.check('#public-check');
    await pop2.click('#btn-create');
    await pop2.waitForFunction(() => !document.getElementById('view-room')?.classList.contains('hidden'), { timeout: TIMEOUT });
    const id2 = await pop2.evaluate(() => document.getElementById('room-id-display')?.textContent);
    ok(id2 === id1, `Same ID: ${id2?.substring(0, 8)}`);
    await pop2.close();
  });

  // TEST 6: Invite link
  await runTest('Invite link copy', async (launch) => {
    const ctx = await launch('inv');
    await stremio(ctx);
    const ext = await getExtensionId(ctx);
    const pop = await popup(ctx, ext);
    await pop.fill('#username-input', 'Host');
    await pop.click('#btn-create');
    await pop.waitForFunction(() => !document.getElementById('view-room')?.classList.contains('hidden'), { timeout: TIMEOUT });
    await pop.click('#btn-share');
    await pop.waitForTimeout(500);
    ok((await pop.evaluate(() => document.getElementById('btn-share')?.textContent))?.includes('Copied'), 'Copy confirmed');
    await pop.close();
  });

  console.log(`\n${'='.repeat(30)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(failed > 0 ? 1 : 0);
}

main();
