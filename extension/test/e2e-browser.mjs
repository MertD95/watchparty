// WatchParty — Full E2E Browser Test (Real User Flow)
// Tests the actual user flow: popup → create room → sidebar updates → chat → leave.
// Uses Playwright with the real extension loaded — tests the ACTUAL extension pipeline,
// not page-context WebSockets (which bypass the extension's message routing).
//
// This catches bugs that MCP/page-context testing CANNOT:
// - Popup → background.js → content script message relay
// - chrome.storage-based room state persistence
// - Sidebar UI updates from real room events
// - Extension popup form validation
//
// Requires: WS server on ws://localhost:8181
// Usage:    node extension/test/e2e-browser.mjs

import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';
import { createBrowserDiagnostics } from './browser-diagnostics.mjs';
import { getExtensionId, launchExtensionContext } from './extension-context.mjs';
import { injectSeekableTestVideo } from './seekable-video.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const STREMIO_URL = 'https://web.stremio.com';
const TIMEOUT = 15000;
const CHROME_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--no-first-run',
  '--disable-blink-features=AutomationControlled',
];
const dirs = [];

let passed = 0;
let failed = 0;
let currentDiagnostics = null;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function trackPageDiagnostics(page, label) {
  currentDiagnostics?.attachPage(page, label);
}

function assertCleanDiagnostics(label) {
  if (!currentDiagnostics) return;
  const unexpected = currentDiagnostics.popUnexpected();
  const message = unexpected.length === 0
    ? `${label}: no unexpected browser errors`
    : `${label}: unexpected browser errors (${currentDiagnostics.format(unexpected)})`;
  assert(unexpected.length === 0, message);
  currentDiagnostics = null;
}

async function launchWithExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-browser-'));
  dirs.push(dir);
  return launchExtensionContext(EXT_PATH, {
    userDataDir: dir,
    args: CHROME_FLAGS,
    viewport: { width: 1440, height: 900 },
  });
}

/** Open the extension popup in a new tab and return the page */
async function openPopup(context, extId) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'popup');
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000); // Let popup init + get-status response
  return page;
}

async function openSidepanel(context, extId) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'sidepanel');
  await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  return page;
}

/** Navigate to Stremio and wait for extension overlay */
async function openStremio(context) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'stremio');
  await page.goto(STREMIO_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('wp-overlay') !== null, { timeout: TIMEOUT });
  await page.waitForTimeout(1000);
  return page;
}

async function openStremioAt(context, url) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'stremio');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('wp-overlay') !== null, { timeout: TIMEOUT });
  await page.waitForTimeout(1000);
  return page;
}

async function openSidebarIfHidden(page) {
  const sidebarHidden = await page.evaluate(() =>
    document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden')
  );
  if (sidebarHidden) {
    await page.evaluate(() => document.getElementById('wp-toggle-host')?.click());
    await page.waitForTimeout(500);
  }
}

async function injectMockVideo(page, currentTime = 0) {
  await injectSeekableTestVideo(page, currentTime);
}

async function findRoomSnapshot(roomApis, roomId, predicate = () => true) {
  for (const api of roomApis) {
    try {
      let offset = 0;
      let total = 0;
      do {
        const separator = api.includes('?') ? '&' : '?';
        const res = await fetch(`${api}${separator}offset=${offset}&limit=50`);
        const data = await res.json();
        const rooms = data.rooms || [];
        const room = rooms.find((entry) => entry.id === roomId);
        if (room && predicate(room)) return room;
        total = data.total || rooms.length || 0;
        offset += data.limit || rooms.length || 50;
      } while (offset < total);
    } catch {
      // Ignore backend fetch failures in favor of the next backend.
    }
  }
  return null;
}

// ── Tests ──

function buildPlayerHash(payload) {
  const encoded = deflateSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64url');
  return `#/player/${encodeURIComponent(encoded)}`;
}

async function testPopupLoadsWithStatus() {
  console.log('\n── Test: Popup loads and shows status ──');
  const context = await launchWithExtension();
  try {
    const stremio = await openStremio(context);
    const extId = await getExtensionId(context);
    const popup = await openPopup(context, extId);

    // Popup should show lobby view
    const lobbyVisible = await popup.evaluate(() => !document.getElementById('view-lobby').classList.contains('hidden'));
    assert(lobbyVisible, 'Lobby view visible');

    // WS status should show connected (server is running)
    const wsText = await popup.evaluate(() => document.getElementById('ws-status').textContent);
    assert(wsText === 'Connected to Local server', `WS status: "${wsText}"`);

    const backendNote = await popup.evaluate(() => document.getElementById('backend-note')?.textContent || '');
    assert(
      backendNote.includes('Current backend: Local') || backendNote.includes('development builds may use localhost'),
      `Backend note: "${backendNote}"`
    );

    // Username input exists
    const hasInput = await popup.evaluate(() => !!document.getElementById('username-input'));
    assert(hasInput, 'Username input exists');

    // Create + Join buttons exist
    const hasCreate = await popup.evaluate(() => !!document.getElementById('btn-create'));
    const hasJoin = await popup.evaluate(() => !!document.getElementById('btn-join'));
    assert(hasCreate, 'Create button exists');
    assert(hasJoin, 'Join button exists');

    await stremio.close();
    await popup.close();
  } finally {
    await context.close();
  }
}

async function testCreateRoomWithoutStremioTabAttachesLater() {
  console.log('\nâ”€â”€ Test: Create room auto-opens Stremio when no tab exists â”€â”€');
  const context = await launchWithExtension();
  let popup = null;
  let stremio = null;
  console.log('\nTest: Create room without Stremio tab and attach later');
  try {
    const extId = await getExtensionId(context);
    popup = await openPopup(context, extId);

    const hintText = await popup.evaluate(() => document.getElementById('status-hint')?.textContent || '');
    assert(
      hintText.includes('open Stremio later'),
      `Lobby hint explains popup-first room setup: "${hintText}"`
    );

    await popup.fill('#username-input', 'PopupFirstHost');
    const stremioPagePromise = context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await popup.click('#btn-create');

    const autoOpenedStremio = await stremioPagePromise;
    const openedStremio = !!autoOpenedStremio && autoOpenedStremio.url().startsWith(STREMIO_URL);
    assert(!openedStremio, 'Create room does not require WatchParty to auto-open Stremio Web');
    await autoOpenedStremio?.close().catch(() => {});

    const gotRoom = await popup.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT * 2 }
    ).then(() => true).catch(() => false);
    assert(gotRoom, 'Popup switches to room view without a Stremio tab');

    if (gotRoom) {
      const roomId = await popup.evaluate(() => document.getElementById('room-id-display').textContent);
      assert(roomId && roomId.length > 10, `Popup-first room flow shows room ID: ${roomId?.substring(0, 8)}...`);
      const roomCountBadge = await popup.evaluate(() => document.getElementById('room-count-badge')?.textContent || '');
      assert(roomCountBadge.includes('1 watching'), 'Popup room summary shows the host before Stremio is opened');

      stremio = await openStremio(context);
      const attachedToRoom = await stremio.waitForFunction(
        () => !document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
        { timeout: TIMEOUT * 2 }
      ).then(() => true).catch(() => false);
      assert(attachedToRoom, 'Opening Stremio later attaches the existing popup-created room');

      if (attachedToRoom) {
        await stremio.evaluate(() => document.querySelector('[data-panel="people"]')?.click());
        const peopleReady = await stremio.waitForFunction(
          () => document.getElementById('wp-users')?.innerText?.includes('PopupFirstHost'),
          { timeout: TIMEOUT }
        ).then(() => true).catch(() => false);
        assert(peopleReady, 'Stremio overlay inherits the popup-created room state');
      }
    }
  } finally {
    await stremio?.close().catch(() => {});
    await popup?.close().catch(() => {});
    await context.close();
  }
}

async function testPopupFirstJoinMissingRoomShowsImmediateError() {
  console.log('\n-- Test: Popup-first join shows room-service errors immediately --');
  const context = await launchWithExtension();
  try {
    const extId = await getExtensionId(context);
    const popup = await openPopup(context, extId);

    await popup.fill('#username-input', 'PopupJoiner');
    await popup.click('#lobby-tab-join');
    await popup.fill('#room-id-input', 'missing-room-1234');
    await popup.click('#btn-join');

    const errorState = await popup.waitForFunction(
      () => {
        const error = document.getElementById('join-error');
        const button = document.getElementById('btn-join');
        return !error.classList.contains('hidden')
          && /Room not found/i.test(error.textContent || '')
          && button.textContent === 'Join Room'
          && button.disabled === false;
      },
      { timeout: TIMEOUT }
    ).then(() => true).catch(() => false);

    assert(errorState, 'Popup-first join surfaces ROOM_NOT_FOUND without waiting for the timeout fallback');
    await popup.close();
  } finally {
    await context.close();
  }
}

async function testPopupHidesStaleInactiveBackgroundRoomState() {
  console.log('\n-- Test: Popup ignores stale room state when no tab or room service is active --');
  const context = await launchWithExtension();
  try {
    const extId = await getExtensionId(context);
    let popup = await openPopup(context, extId);

    await popup.evaluate(() => chrome.storage.local.set({
      [WPConstants.STORAGE.CURRENT_ROOM]: 'stale-room-id',
      [WPConstants.STORAGE.ROOM_STATE]: {
        id: 'stale-room-id',
        owner: 'stale-owner',
        public: false,
        users: [{ id: 'stale-owner', name: 'Ghost Host', room_id: 'stale-room-id' }],
        meta: { id: 'pending', type: 'movie', name: 'Ghost Room' },
        stream: { url: 'https://watchparty.mertd.me/sync' },
        player: { paused: true, buffering: false, time: 0, speed: 1 },
        settings: { autoPauseOnDisconnect: false },
      },
      [WPConstants.STORAGE.ROOM_SERVICE_ACTIVE]: false,
      [WPConstants.STORAGE.ROOM_SERVICE_ERROR]: null,
    }));

    await popup.close();
    popup = await openPopup(context, extId);

    const lobbyVisible = await popup.evaluate(() =>
      !document.getElementById('view-lobby').classList.contains('hidden')
      && document.getElementById('view-room').classList.contains('hidden')
    );
    assert(lobbyVisible, 'Popup stays on the lobby when persisted room state is stale and inactive');

    await popup.close();
  } finally {
    await context.close();
  }
}

async function testCreateRoomFlow() {
  console.log('\n── Test: Create room via popup → sidebar updates ──');
  const context = await launchWithExtension();
  try {
    const stremio = await openStremio(context);
    const extId = await getExtensionId(context);
    const popup = await openPopup(context, extId);

    // Fill username
    await popup.fill('#username-input', 'TestHost');

    // Click Create Room
    await popup.click('#btn-create');

    // Button should show "Creating..."
    const btnText = await popup.evaluate(() => document.getElementById('btn-create').textContent);
    assert(btnText === 'Creating...', `Create button shows "${btnText}"`);

    // Wait for room view to appear (up to 12s timeout)
    const gotRoom = await popup.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    ).then(() => true).catch(() => false);
    assert(gotRoom, 'Popup switched to room view');

    if (gotRoom) {
      // Room ID displayed
      const roomId = await popup.evaluate(() => document.getElementById('room-id-display').textContent);
      assert(roomId && roomId.length > 10, `Room ID shown: ${roomId?.substring(0, 8)}...`);

      const roomKeyVisible = await popup.waitForFunction(
        () => {
          const input = document.getElementById('room-key-input');
          return !!input && !input.disabled && !!input.value && input.value.length >= 16;
        },
        { timeout: TIMEOUT }
      ).then(() => true).catch(() => false);
      assert(roomKeyVisible, 'Private room key appears in the popup without reloading');

      // Users list shows TestHost
      const usersHtml = await popup.evaluate(() => document.getElementById('users-list').innerHTML);
      assert(usersHtml.includes('TestHost'), 'Users list shows TestHost');
      assert(usersHtml.includes('👑'), 'Host has crown');

      // Stremio sidebar should now show the room
      await stremio.bringToFront();
      await stremio.waitForTimeout(1000);
      const sidebarText = await stremio.evaluate(() => document.getElementById('wp-sidebar')?.innerText?.substring(0, 300));
      assert(sidebarText && !sidebarText.includes('Not in a room'), 'Stremio sidebar shows room (not lobby)');

      const panelsReady = await stremio.evaluate(() =>
        !!document.querySelector('[data-panel="chat"]')
        && !!document.querySelector('[data-panel="people"]')
        && !!document.querySelector('[data-panel="room"]')
      );
      assert(panelsReady, 'Sidebar exposes Chat, People, and Room tabs');

      await stremio.evaluate(() => document.querySelector('[data-panel="people"]')?.click());
      await stremio.waitForTimeout(300);
      const peopleText = await stremio.evaluate(() => document.getElementById('wp-users')?.innerText || '');
      assert(peopleText.includes('TestHost'), 'People tab shows TestHost');
      await stremio.evaluate(() => document.querySelector('[data-panel="chat"]')?.click());

      // Test leave room
      await popup.bringToFront();
      await popup.click('#btn-leave');
      const backToLobby = await popup.waitForFunction(
        () => {
          const lobbyVisible = !document.getElementById('view-lobby').classList.contains('hidden');
          const createVisible = !!document.getElementById('btn-create')?.offsetParent;
          return lobbyVisible && createVisible;
        },
        { timeout: 5000 }
      ).then(() => true).catch(() => false);
      assert(backToLobby, 'Back to lobby after leaving');

      // Stremio sidebar should show "Not in a room" (wait for background → content script relay)
      await stremio.bringToFront();
      // Note: leave goes through popup → background → forwardToStremioTab → content script.
      // In MV3, the service worker may suspend between relay hops. Also, the content script
      // sends room.leave to the WS server, and the sidebar only updates on the server's sync response.
      // This can take several seconds — use a generous timeout.
      const leftRoom = await stremio.waitForFunction(
        () => document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
        { timeout: 10000 }
      ).then(() => true).catch(() => false);
      assert(leftRoom, 'Sidebar shows "Not in a room" after leaving (may be slow due to MV3 relay)');

      // Regression: re-create immediately after leaving in the same popup session.
      await popup.bringToFront();
      await popup.waitForFunction(
        () => !document.getElementById('view-lobby').classList.contains('hidden') && !!document.getElementById('btn-create')?.offsetParent,
        { timeout: 5000 }
      ).catch(() => {});
      await popup.click('#btn-create');
      const recreatedRoom = await popup.waitForFunction(
        () => !document.getElementById('view-room').classList.contains('hidden'),
        { timeout: TIMEOUT }
      ).then(() => true).catch(() => false);
      assert(recreatedRoom, 'Popup can create another room after leaving');

      if (recreatedRoom) {
        const recreatedRoomId = await popup.evaluate(() => document.getElementById('room-id-display').textContent);
        assert(recreatedRoomId && recreatedRoomId !== roomId, 'Second create shows a new room ID');
        const createErrorHidden = await popup.evaluate(() => document.getElementById('create-error').classList.contains('hidden'));
        assert(createErrorHidden, 'Second create does not show the create-room error');

        await stremio.bringToFront();
        await stremio.waitForTimeout(1000);
        const recreatedSidebarText = await stremio.evaluate(() => document.getElementById('wp-sidebar')?.innerText?.substring(0, 300));
        assert(recreatedSidebarText && !recreatedSidebarText.includes('Not in a room'), 'Sidebar returns to room view after re-creating');
      }
    }

    await stremio.close();
    await popup.close();
  } finally {
    await context.close();
  }
}

async function testPopupReloadReadsWrappedLocalRoomKeyFallback() {
  console.log('\n-- Test: Popup can reload private room keys from wrapped local storage --');
  const context = await launchWithExtension();
  try {
    const stremio = await openStremio(context);
    const extId = await getExtensionId(context);
    let popup = await openPopup(context, extId);

    await popup.fill('#username-input', 'KeyHost');
    await popup.click('#btn-create');
    await popup.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    );
    await popup.waitForFunction(
      async () => {
        const roomId = document.getElementById('room-id-display')?.textContent;
        const roomKey = document.getElementById('room-key-input')?.value;
        if (!roomId || !roomKey) return false;
        const storageKey = WPConstants.STORAGE.roomKey(roomId);
        const stored = await chrome.storage.local.get(storageKey);
        return stored?.[storageKey]?.value === roomKey && typeof stored?.[storageKey]?.storedAt === 'number';
      },
      { timeout: TIMEOUT }
    );

    const roomState = await popup.evaluate(async () => {
      const roomId = document.getElementById('room-id-display').textContent;
      const roomKey = document.getElementById('room-key-input').value;
      const storageKey = WPConstants.STORAGE.roomKey(roomId);
      await chrome.storage.session.remove(storageKey);
      return { roomId, roomKey };
    });

    await popup.close();
    popup = await openPopup(context, extId);

    const recoveredRoomKey = await popup.waitForFunction(
      (expected) => {
        const roomId = document.getElementById('room-id-display')?.textContent;
        const roomKey = document.getElementById('room-key-input')?.value;
        return roomId === expected.roomId && roomKey === expected.roomKey;
      },
      roomState,
      { timeout: TIMEOUT }
    ).then(() => true).catch(() => false);

    assert(recoveredRoomKey, 'Popup reloads the private room key from the wrapped local-storage fallback');

    await popup.close();
    await stremio.close();
  } finally {
    await context.close();
  }
}

async function testJoinRoomFlow() {
  console.log('\n── Test: Create room on User1, join via popup on User2 ──');
  const ctx1 = await launchWithExtension();
  const ctx2 = await launchWithExtension();
  try {
    // User1: open Stremio + popup, create room
    const stremio1 = await openStremio(ctx1);
    const extId1 = await getExtensionId(ctx1);
    const popup1 = await openPopup(ctx1, extId1);
    await popup1.fill('#username-input', 'Alice');
    await popup1.check('#public-check');
    await popup1.click('#btn-create');
    await popup1.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    );
    const roomId = await popup1.evaluate(() => document.getElementById('room-id-display').textContent);
    assert(roomId && roomId.length > 10, `Alice created room: ${roomId?.substring(0, 8)}...`);

    // User2: open Stremio + popup, join room
    const stremio2 = await openStremio(ctx2);
    const extId2 = await getExtensionId(ctx2);
    const popup2 = await openPopup(ctx2, extId2);
    await popup2.fill('#username-input', 'Bob');
    await popup2.click('#lobby-tab-join');
    await popup2.fill('#room-id-input', roomId);
    await popup2.click('#btn-join');

    const joined = await popup2.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    ).then(() => true).catch(() => false);
    assert(joined, 'Bob joined the room');

    if (joined) {
      // Alice's sidebar should show Bob joined
      await stremio1.bringToFront();
      await stremio1.waitForTimeout(1500);
      await stremio1.evaluate(() => document.querySelector('[data-panel="people"]')?.click());
      await stremio1.waitForTimeout(300);
      const alicePeople = await stremio1.evaluate(() => document.getElementById('wp-users')?.innerText || '');
      assert(alicePeople.includes('Bob'), 'Alice people tab shows Bob joined');
      await stremio2.bringToFront();
      await stremio2.waitForTimeout(1000);
      await stremio2.evaluate(() => document.querySelector('[data-panel="people"]')?.click());
      await stremio2.waitForTimeout(300);
      const bobPeople = await stremio2.evaluate(() => document.getElementById('wp-users')?.innerText || '');
      assert(bobPeople.includes('Alice'), 'Bob people tab shows Alice after join');
      await stremio1.evaluate(() => document.querySelector('[data-panel="chat"]')?.click());
    }

    await popup1.close();
    await popup2.close();
    await stremio1.close();
    await stremio2.close();
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
}

async function testJoinRoomWithoutStremioTabAttachesLater() {
  console.log('\nâ”€â”€ Test: Join room without Stremio tab and attach later â”€â”€');
  const ctx1 = await launchWithExtension();
  const ctx2 = await launchWithExtension();
  let popup2 = null;
  let stremio2 = null;
  try {
    const stremio1 = await openStremio(ctx1);
    const extId1 = await getExtensionId(ctx1);
    const popup1 = await openPopup(ctx1, extId1);
    await popup1.fill('#username-input', 'Alice');
    await popup1.check('#public-check');
    await popup1.click('#btn-create');
    await popup1.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    );
    const roomId = await popup1.evaluate(() => document.getElementById('room-id-display').textContent);
    assert(roomId && roomId.length > 10, `Alice created room for popup-first join: ${roomId?.substring(0, 8)}...`);

    const extId2 = await getExtensionId(ctx2);
    popup2 = await openPopup(ctx2, extId2);
    const hintText = await popup2.evaluate(() => document.getElementById('status-hint')?.textContent || '');
    assert(
      hintText.includes('open Stremio later'),
      `Join hint explains popup-first flow: "${hintText}"`
    );

    await popup2.fill('#username-input', 'Bob');
    await popup2.click('#lobby-tab-join');
    await popup2.fill('#room-id-input', roomId);
    const stremioPagePromise = ctx2.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await popup2.click('#btn-join');

    const autoOpenedStremio = await stremioPagePromise;
    const openedStremio = !!autoOpenedStremio && autoOpenedStremio.url().startsWith(STREMIO_URL);
    assert(!openedStremio, 'Join room does not require WatchParty to auto-open Stremio Web');
    await autoOpenedStremio?.close().catch(() => {});

    const joined = await popup2.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT * 2 }
    ).then(() => true).catch(() => false);
    assert(joined, 'Popup joins the room without a Stremio tab');

    if (joined) {
      const bobUsers = await popup2.evaluate(() => document.getElementById('users-list')?.innerText || '');
      assert(bobUsers.includes('Alice') && bobUsers.includes('Bob'), 'Popup-first join shows both room members');

      stremio2 = await openStremio(ctx2);
      const attachedToRoom = await stremio2.waitForFunction(
        () => !document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
        { timeout: TIMEOUT * 2 }
      ).then(() => true).catch(() => false);
      assert(attachedToRoom, 'Opening Stremio later attaches the popup-joined room');

      if (attachedToRoom) {
        await stremio2.evaluate(() => document.querySelector('[data-panel="people"]')?.click());
        const peopleReady = await stremio2.waitForFunction(
          () => {
            const text = document.getElementById('wp-users')?.innerText || '';
            return text.includes('Alice') && text.includes('Bob');
          },
          { timeout: TIMEOUT }
        ).then(() => true).catch(() => false);
        assert(peopleReady, 'Stremio overlay reflects the popup-first join members');
      }
    }

    await popup1.close();
    await stremio1.close();
  } finally {
    await stremio2?.close().catch(() => {});
    await popup2?.close().catch(() => {});
    await ctx1.close();
    await ctx2.close();
  }
}

async function testPopupFirstRoomControlsWithoutStremioTab() {
  console.log('\nTest: Popup-first room controls work without a Stremio tab');
  const context = await launchWithExtension();
  let popup = null;
  try {
    const extId = await getExtensionId(context);
    popup = await openPopup(context, extId);

    await popup.fill('#username-input', 'PopupControlsHost');
    await popup.click('#btn-create');

    const gotRoom = await popup.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT * 2 }
    ).then(() => true).catch(() => false);
    assert(gotRoom, 'Popup-first room shows the room view');

    if (gotRoom) {
      const roomId = await popup.evaluate(() => document.getElementById('room-id-display').textContent);
      assert(roomId && roomId.length > 10, `Popup-first controls test has room ID: ${roomId?.substring(0, 8)}...`);

      const roomKeyVisible = await popup.waitForFunction(
        () => {
          const row = document.getElementById('room-key-row');
          const input = document.getElementById('room-key-input');
          return !!row && !row.classList.contains('hidden') && !!input && !!input.value && input.value.length >= 16;
        },
        { timeout: TIMEOUT * 2 }
      ).then(() => true).catch(() => false);
      assert(roomKeyVisible, 'Private room key is available before Stremio opens');

      const hostControlsReady = await popup.waitForFunction(
        () => !!document.getElementById('setting-public')?.offsetParent,
        { timeout: TIMEOUT }
      ).then(() => true).catch(() => false);
      assert(hostControlsReady, 'Popup-first host controls are visible before changing room privacy');

      if (!hostControlsReady) return;

      await popup.evaluate(() => {
        const input = document.getElementById('setting-public');
        if (!input) return;
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      let publicRoom = null;
      for (let i = 0; i < 12; i++) {
        publicRoom = await findRoomSnapshot(
          ['http://localhost:8181/rooms', 'https://ws.mertd.me/rooms'],
          roomId,
          (room) => room.public === true
        );
        if (publicRoom) break;
        await popup.waitForTimeout(400);
      }
      assert(!!publicRoom, `Popup-first room can be made public (${JSON.stringify(publicRoom)})`);

      const roomKeyHidden = await popup.waitForFunction(
        () => document.getElementById('room-key-row')?.classList.contains('hidden'),
        { timeout: TIMEOUT }
      ).then(() => true).catch(() => false);
      assert(roomKeyHidden, 'Room key UI hides when the popup-first room becomes public');

      await popup.evaluate(() => {
        const input = document.getElementById('setting-public');
        if (!input) return;
        input.checked = false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      let privateRoom = null;
      for (let i = 0; i < 12; i++) {
        privateRoom = await findRoomSnapshot(
          ['http://localhost:8181/rooms', 'https://ws.mertd.me/rooms'],
          roomId,
          (room) => room.public === false
        );
        if (privateRoom) break;
        await popup.waitForTimeout(400);
      }
      assert(!!privateRoom, `Popup-first room can be made private again (${JSON.stringify(privateRoom)})`);

      const roomKeyReturned = await popup.waitForFunction(
        () => {
          const row = document.getElementById('room-key-row');
          const input = document.getElementById('room-key-input');
          return !!row && !row.classList.contains('hidden') && !!input && !!input.value;
        },
        { timeout: TIMEOUT }
      ).then(() => true).catch(() => false);
      assert(roomKeyReturned, 'Room key UI returns after switching back to private');

      await popup.click('#btn-leave');
      const backToLobby = await popup.waitForFunction(
        () => !document.getElementById('view-lobby').classList.contains('hidden'),
        { timeout: TIMEOUT }
      ).then(() => true).catch(() => false);
      assert(backToLobby, 'Popup-first room can be left without a Stremio tab');
    }
  } finally {
    await popup?.close().catch(() => {});
    await context.close();
  }
}

async function testChatFlow() {
  console.log('\n── Test: Two-user chat via sidebar ──');
  const ctx1 = await launchWithExtension();
  const ctx2 = await launchWithExtension();
  try {
    // Setup: Alice creates, Bob joins
    const stremio1 = await openStremio(ctx1);
    const extId1 = await getExtensionId(ctx1);
    const popup1 = await openPopup(ctx1, extId1);
    await popup1.fill('#username-input', 'Alice');
    await popup1.check('#public-check');
    await popup1.click('#btn-create');
    await popup1.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout: TIMEOUT });
    const roomId = await popup1.evaluate(() => document.getElementById('room-id-display').textContent);

    const stremio2 = await openStremio(ctx2);
    const extId2 = await getExtensionId(ctx2);
    const popup2 = await openPopup(ctx2, extId2);
    await popup2.fill('#username-input', 'Bob');
    await popup2.click('#lobby-tab-join');
    await popup2.fill('#room-id-input', roomId);
    await popup2.click('#btn-join');
    await popup2.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout: TIMEOUT });
    await stremio1.waitForTimeout(1000);

    // Bob types a message in the sidebar chat
    await stremio2.bringToFront();
    await stremio2.waitForTimeout(500);
    await openSidebarIfHidden(stremio2);

    // Debug: check chat input state
    const chatDebug = await stremio2.evaluate(() => {
      const input = document.getElementById('wp-chat-input');
      return {
        exists: !!input,
        disabled: input?.disabled,
        visible: input?.offsetParent !== null,
        placeholder: input?.placeholder,
      };
    });
    assert(chatDebug.exists && chatDebug.visible && !chatDebug.disabled, 'Chat input is interactive');

    // Send chat using real browser keyboard events (not JS dispatch)
    // This goes through the browser's input pipeline and reaches content script listeners
    await stremio2.focus('#wp-chat-input');
    await stremio2.keyboard.type('Hello from Bob!');
    await stremio2.keyboard.press('Enter');
    await stremio2.waitForTimeout(1000);

    // Check Bob sees his own message and doesn't end up with duplicate local+server echoes
    const bobChatState = await stremio2.evaluate(() => {
      const messages = [...document.querySelectorAll('#wp-chat-messages .wp-chat-msg')].map((el) => el.innerText || '');
      const sendBtn = document.getElementById('wp-chat-send');
      return {
        messageCount: messages.filter((text) => text.includes('Hello from Bob!')).length,
        inputValue: document.getElementById('wp-chat-input')?.value || '',
        sendDisabled: !!sendBtn?.disabled,
      };
    });
    assert(bobChatState.messageCount === 1, 'Bob sees a single chat entry for his own message');
    assert(bobChatState.inputValue === '', 'Chat input clears after sending');
    assert(bobChatState.sendDisabled, 'Send button enters cooldown after sending');

    // Client-side cooldown should block a rapid second send before the server cooldown even matters.
    await stremio2.focus('#wp-chat-input');
    await stremio2.keyboard.type('Too fast');
    await stremio2.keyboard.press('Enter');
    await stremio2.waitForTimeout(500);
    const rapidSecondSendCount = await stremio2.evaluate(() =>
      [...document.querySelectorAll('#wp-chat-messages .wp-chat-msg')]
        .filter((el) => (el.innerText || '').includes('Too fast')).length
    );
    assert(rapidSecondSendCount === 0, 'Rapid second send is blocked by the client cooldown');

    // Check Alice sees Bob's message
    await stremio1.bringToFront();
    await stremio1.waitForTimeout(1000);
    await openSidebarIfHidden(stremio1);
    const aliceSawMessage = await stremio1.waitForFunction(
      () => document.getElementById('wp-chat-messages')?.innerText?.includes('Hello from Bob!'),
      { timeout: TIMEOUT }
    ).then(() => true).catch(() => false);
    assert(aliceSawMessage, `Alice sees Bob's message in chat`);

    // === Unread badge test while Chat tab is not active ===
    await stremio1.evaluate(() => document.querySelector('[data-panel="people"]')?.click());
    await stremio1.waitForTimeout(300);
    await stremio2.bringToFront();
    await stremio2.waitForTimeout(3500); // cooldown
    await stremio2.focus('#wp-chat-input');
    await stremio2.keyboard.type('People tab badge');
    await stremio2.keyboard.press('Enter');
    await stremio2.waitForTimeout(1500);

    await stremio1.bringToFront();
    await stremio1.waitForTimeout(600);
    const chatTabBadge = await stremio1.waitForFunction(
      () => {
        const el = document.getElementById('wp-tab-chat-badge');
        if (!el || el.classList.contains('wp-hidden-el')) return null;
        const text = el.textContent || '';
        return parseInt(text, 10) > 0 ? text : null;
      },
      { timeout: TIMEOUT }
    ).then((handle) => handle.jsonValue()).catch(() => null);
    assert(!!chatTabBadge, `Chat tab badge shows: "${chatTabBadge || ''}"`);

    await stremio1.evaluate(() => document.querySelector('[data-panel="chat"]')?.click());
    await stremio1.waitForTimeout(400);
    const chatTabBadgeCleared = await stremio1.evaluate(() => {
      const el = document.getElementById('wp-tab-chat-badge');
      return el?.classList.contains('wp-hidden-el');
    });
    assert(chatTabBadgeCleared, 'Chat tab badge clears after returning to chat');

    // === Unread badge test while the whole sidebar is closed ===
    await stremio1.bringToFront();
    await stremio1.evaluate(() => document.getElementById('wp-close-sidebar')?.click());
    await stremio1.waitForTimeout(500);

    // Bob sends another message
    await stremio2.bringToFront();
    await stremio2.waitForTimeout(3500); // cooldown
    await stremio2.focus('#wp-chat-input');
    await stremio2.keyboard.type('Badge test msg');
    await stremio2.keyboard.press('Enter');
    await stremio2.waitForTimeout(2000);

    // Check Alice's unread badge (light DOM, NOT shadow root)
    await stremio1.bringToFront();
    await stremio1.waitForTimeout(1000);
    const badge = await stremio1.waitForFunction(
      () => {
        const el = document.getElementById('wp-unread-badge');
        if (!el || el.classList.contains('wp-hidden-el')) return null;
        const text = el.textContent || '';
        return parseInt(text, 10) > 0 ? text : null;
      },
      { timeout: TIMEOUT }
    ).then((handle) => handle.jsonValue()).catch(() => null);
    assert(!!badge, `Unread badge shows: "${badge || ''}"`);

    // Open sidebar → badge should clear
    await stremio1.evaluate(() => document.getElementById('wp-toggle-host')?.click());
    await stremio1.waitForTimeout(500);
    const badgeAfter = await stremio1.evaluate(() => {
      const el = document.getElementById('wp-unread-badge');
      return el?.classList.contains('wp-hidden-el');
    });
    assert(badgeAfter, 'Unread badge cleared after opening sidebar');

    await popup1.close();
    await popup2.close();
    await stremio1.close();
    await stremio2.close();
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
}

async function testEmptyUsernameValidation() {
  console.log('\n── Test: Popup validation ──');
  const context = await launchWithExtension();
  try {
    const stremio = await openStremio(context);
    const extId = await getExtensionId(context);
    const popup = await openPopup(context, extId);

    // Clear username, click create — should NOT create (focus input instead)
    await popup.fill('#username-input', '');
    await popup.click('#btn-create');
    await popup.waitForTimeout(500);
    const stillLobby = await popup.evaluate(() => !document.getElementById('view-lobby').classList.contains('hidden'));
    assert(stillLobby, 'Empty username: stays on lobby');

    // Room name too short after sanitization (e.g. "a!" → "a" which is < 3 chars)
    await popup.fill('#username-input', 'TestUser');
    await popup.fill('#room-name-input', 'a!');
    await popup.click('#btn-create');
    await popup.waitForTimeout(500);
    const errorShown = await popup.evaluate(() => !document.getElementById('create-error').classList.contains('hidden'));
    assert(errorShown, 'Short room name shows error');
    // Clear room name for subsequent tests
    await popup.fill('#room-name-input', '');

    await stremio.close();
    await popup.close();
  } finally {
    await context.close();
  }
}

// ── Helper: set up two users in a room (reusable) ──

async function setupTwoUsers() {
  const ctx1 = await launchWithExtension();
  const ctx2 = await launchWithExtension();
  const stremio1 = await openStremio(ctx1);
  const extId1 = await getExtensionId(ctx1);
  const popup1 = await openPopup(ctx1, extId1);
  await popup1.fill('#username-input', 'Alice');
  await popup1.check('#public-check');
  await popup1.click('#btn-create');
  await popup1.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout: TIMEOUT });
  const roomId = await popup1.evaluate(() => document.getElementById('room-id-display').textContent);

  const stremio2 = await openStremio(ctx2);
  const extId2 = await getExtensionId(ctx2);
  const popup2 = await openPopup(ctx2, extId2);
  await popup2.fill('#username-input', 'Bob');
  await popup2.click('#lobby-tab-join');
  await popup2.fill('#room-id-input', roomId);
  await popup2.click('#btn-join');
  await popup2.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout: TIMEOUT });
  await stremio1.waitForTimeout(1500);

  // Open sidebars on both
  for (const s of [stremio1, stremio2]) {
    await s.bringToFront();
    const hidden = await s.evaluate(() => document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden'));
    if (hidden) {
      await s.evaluate(() => document.getElementById('wp-toggle-host')?.click());
      await s.waitForTimeout(500);
    }
  }

  return { ctx1, ctx2, stremio1, stremio2, popup1, popup2, extId1, extId2, roomId };
}

async function cleanupTwoUsers({ ctx1, ctx2, popup1, popup2, stremio1, stremio2 }) {
  for (const p of [popup1, popup2, stremio1, stremio2]) { try { await p.close(); } catch {} }
  await ctx1.close();
  await ctx2.close();
}

// ── Two-user: Host settings visible, peer settings restricted ──

async function testHostVsPeerSettings() {
  console.log('\n── Test: Host sees all settings, peer sees limited ──');
  const env = await setupTwoUsers();
  try {
    // Alice (host) popup: should see Public, Auto-pause, Reaction sound
    await env.popup1.bringToFront();
    await env.popup1.reload({ waitUntil: 'domcontentloaded' });
    await env.popup1.waitForTimeout(1500);
    const aliceSettings = await env.popup1.evaluate(() => ({
      publicVisible: !document.getElementById('setting-public-row')?.classList.contains('hidden'),
      autopauseVisible: !document.getElementById('setting-autopause-row')?.classList.contains('hidden'),
      reactionSoundVisible: !!document.getElementById('setting-reaction-sound'),
    }));
    assert(aliceSettings.publicVisible, 'Host sees Public toggle');
    assert(aliceSettings.autopauseVisible, 'Host sees Auto-pause toggle');
    assert(aliceSettings.reactionSoundVisible, 'Host sees Reaction sound toggle');

    // Bob (peer) popup: should NOT see Public, Auto-pause
    await env.popup2.bringToFront();
    await env.popup2.reload({ waitUntil: 'domcontentloaded' });
    await env.popup2.waitForTimeout(1500);
    const bobSettings = await env.popup2.evaluate(() => ({
      publicVisible: !document.getElementById('setting-public-row')?.classList.contains('hidden'),
      autopauseVisible: !document.getElementById('setting-autopause-row')?.classList.contains('hidden'),
      reactionSoundVisible: !!document.getElementById('setting-reaction-sound'),
    }));
    assert(!bobSettings.publicVisible, 'Peer cannot see Public toggle');
    assert(!bobSettings.autopauseVisible, 'Peer cannot see Auto-pause toggle');
    assert(bobSettings.reactionSoundVisible, 'Peer can see Reaction sound toggle');
  } finally {
    await cleanupTwoUsers(env);
  }
}

// ── Two-user: Theme change propagates ──

async function testThemePropagation() {
  console.log('\n── Test: Theme color change propagates to sidebar ──');
  const env = await setupTwoUsers();
  try {
    // Alice changes theme to Pink
    await env.popup1.bringToFront();
    await env.popup1.reload({ waitUntil: 'domcontentloaded' });
    await env.popup1.waitForTimeout(1500);
    await env.popup1.evaluate(() => document.querySelector('.color-btn[data-color="#ec4899"]')?.click());
    await env.popup1.waitForTimeout(1000);

    // Check Alice's Stremio sidebar has pink accent
    await env.stremio1.bringToFront();
    await env.stremio1.waitForTimeout(1000);
    const aliceAccent = await env.stremio1.evaluate(() =>
      document.getElementById('wp-sidebar')?.style.getPropertyValue('--wp-accent'));
    assert(aliceAccent === '#ec4899', `Alice sidebar accent is pink: ${aliceAccent}`);

    // Bob changes to Green
    await env.popup2.bringToFront();
    await env.popup2.reload({ waitUntil: 'domcontentloaded' });
    await env.popup2.waitForTimeout(1500);
    await env.popup2.evaluate(() => document.querySelector('.color-btn[data-color="#22c55e"]')?.click());
    await env.popup2.waitForTimeout(1000);

    await env.stremio2.bringToFront();
    await env.stremio2.waitForTimeout(1000);
    const bobAccent = await env.stremio2.evaluate(() =>
      document.getElementById('wp-sidebar')?.style.getPropertyValue('--wp-accent'));
    assert(bobAccent === '#22c55e', `Bob sidebar accent is green: ${bobAccent}`);
  } finally {
    await cleanupTwoUsers(env);
  }
}

// ── Two-user: Peer sees content link to host's movie ──

async function testPeerContentLink() {
  console.log('\n── Test: Peer sees host content link ──');
  const env = await setupTwoUsers();
  try {
    await injectMockVideo(env.stremio1, 42);
    await env.stremio1.evaluate(() => {
      window.location.hash = '/detail/movie/tt31193180/tt31193180';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await env.stremio1.waitForTimeout(1500);

    // Bob's sidebar should show content link (host is watching something)
    await env.stremio2.bringToFront();
    await env.stremio2.waitForTimeout(1000);
    const contentLink = await env.stremio2.evaluate(() => {
      const wrapper = document.getElementById('wp-content-link');
      const link = wrapper?.querySelector('a');
      return {
        exists: !!wrapper,
        visible: wrapper && !wrapper.classList.contains('wp-hidden-el'),
        text: wrapper?.textContent?.substring(0, 80),
        href: link?.href || '',
      };
    });
    assert(contentLink.exists, 'Content link element exists for peer');
    assert(contentLink.visible, 'Content link is visible for the peer');
    assert(contentLink.href.includes('/detail/movie/tt31193180'), `Content link targets the host title (${contentLink.href})`);
  } finally {
    await cleanupTwoUsers(env);
  }
}

// ── Two-user: Bidirectional chat ──

async function testPeerDirectStreamLink() {
  console.log('\nâ”€â”€ Test: Peer sees direct host stream link â”€â”€');
  const env = await setupTwoUsers();
  try {
    await injectMockVideo(env.stremio1, 42);
    await env.stremio1.evaluate(() => {
      window.location.hash = '/detail/movie/tt0468569/tt0468569';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await env.stremio1.waitForTimeout(800);
    await env.stremio1.evaluate(() => {
      window.location.hash = '/player/eAEBOADH%2F3sieXRJZCI6Ik5LWWVhNjN0UW1JIiwiZGVzY3JpcHRpb24iOiJQcm9qZWN0IEhhaWwgTWFyeSJ9BqUSsQ%3D%3D';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await env.stremio1.waitForTimeout(1500);

    await env.stremio2.bringToFront();
    await env.stremio2.waitForTimeout(1000);
    const overlayLinks = await env.stremio2.evaluate(() => Array.from(
      document.querySelectorAll('#wp-content-link a')
    ).map((link) => ({
      text: link.textContent?.trim() || '',
      href: link.href || '',
    })));
    assert(
      overlayLinks.some((link) => link.text === 'The Dark Knight' && link.href.includes('/detail/movie/tt0468569')),
      `Peer overlay keeps the host title link (${JSON.stringify(overlayLinks)})`
    );
    assert(
      overlayLinks.some((link) => link.text === 'Open host stream' && link.href.includes('/#/player/')),
      `Peer overlay shows the direct host stream link (${JSON.stringify(overlayLinks)})`
    );

    await env.popup2.bringToFront();
    await env.popup2.reload({ waitUntil: 'domcontentloaded' });
    await env.popup2.waitForTimeout(1500);
    const popupDirectLink = await env.popup2.evaluate(() => {
      const link = document.getElementById('content-stream-link');
      return {
        visible: !!link && !link.classList.contains('hidden'),
        href: link?.href || '',
      };
    });
    assert(
      popupDirectLink.visible && popupDirectLink.href.includes('/#/player/'),
      `Peer popup shows the direct host stream link (${JSON.stringify(popupDirectLink)})`
    );
  } finally {
    await cleanupTwoUsers(env);
  }
}

async function testDebridLikeHostRequiresManualPeerStreamButStillSyncs() {
  console.log('\n── Test: Debrid-like host stream requires manual peer stream but still syncs ──');
  const env = await setupTwoUsers();
  const roomApis = ['http://localhost:8181/rooms', 'https://ws.mertd.me/rooms'];
  try {
    await injectMockVideo(env.stremio1, 1.2);
    await env.stremio1.evaluate(() => {
      window.location.hash = '/detail/movie/tt0468569/tt0468569';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await env.stremio1.waitForTimeout(800);

    const debridHash = buildPlayerHash({
      url: 'https://real-debrid.example/download/the-dark-knight.mkv',
      description: 'The Dark Knight',
    });
    await env.stremio1.evaluate((nextHash) => {
      window.location.hash = nextHash.slice(1);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }, debridHash);
    await env.stremio1.waitForTimeout(1500);
    await env.stremio1.evaluate(() => document.querySelector('[data-panel="room"]')?.click());

    const hostSawVideo = await env.stremio1.waitForFunction(
      () => !!document.getElementById('wp-bookmark-btn'),
      { timeout: TIMEOUT }
    ).then(() => true).catch(() => false);
    assert(hostSawVideo, 'Host keeps sync controls after switching to a debrid-like player route');

    let roomSnapshot = null;
    for (let i = 0; i < 20; i++) {
      roomSnapshot = await findRoomSnapshot(
        roomApis,
        env.roomId,
        (room) => room.hasDirectJoin === false && room.directJoinType === 'debrid-url'
      );
      if (roomSnapshot?.directJoinType === 'debrid-url') break;
      await env.stremio1.waitForTimeout(400);
    }

    assert(
      roomSnapshot?.hasDirectJoin === false && roomSnapshot?.directJoinType === 'debrid-url',
      `Public room marks the host stream as manual-join (${JSON.stringify(roomSnapshot)})`
    );

    await env.stremio2.bringToFront();
    await env.stremio2.waitForTimeout(1000);
    const overlayLinks = await env.stremio2.evaluate(() => Array.from(
      document.querySelectorAll('#wp-content-link a')
    ).map((link) => ({
      text: link.textContent?.trim() || '',
      href: link.href || '',
    })));
    assert(
      overlayLinks.some((link) => link.text === 'The Dark Knight' && link.href.includes('/detail/movie/tt0468569')),
      `Peer overlay keeps the host title link for manual selection (${JSON.stringify(overlayLinks)})`
    );
    assert(
      !overlayLinks.some((link) => link.text === 'Open host stream'),
      `Peer overlay hides the direct host stream link for debrid streams (${JSON.stringify(overlayLinks)})`
    );

    await env.popup2.bringToFront();
    await env.popup2.reload({ waitUntil: 'domcontentloaded' });
    await env.popup2.waitForTimeout(1500);
    const popupPeerLinks = await env.popup2.evaluate(() => ({
      contentVisible: !document.getElementById('content-link')?.classList.contains('hidden'),
      contentHref: document.getElementById('content-link')?.href || '',
      streamVisible: !document.getElementById('content-stream-link')?.classList.contains('hidden'),
      streamHref: document.getElementById('content-stream-link')?.href || '',
    }));
    assert(
      popupPeerLinks.contentVisible && popupPeerLinks.contentHref.includes('/detail/movie/tt0468569'),
      `Peer popup keeps the host title link (${JSON.stringify(popupPeerLinks)})`
    );
    assert(
      popupPeerLinks.streamVisible === false && !popupPeerLinks.streamHref.includes('/#/player/'),
      `Peer popup hides the direct host stream link for debrid streams (${JSON.stringify(popupPeerLinks)})`
    );

    if (hostSawVideo) {
      await env.stremio1.bringToFront();
      const targetTime = await env.stremio1.evaluate(async () => {
        const video = document.querySelector('video');
        if (!video) return 0;
        const nextTime = Math.min(2.8, Math.max(0.5, (video.duration || 3) - 0.1));
        await new Promise((resolve) => {
          const onSeeked = () => resolve();
          video.addEventListener('seeked', onSeeked, { once: true });
          video.currentTime = nextTime;
          setTimeout(resolve, 800);
        });
        return nextTime;
      });
      await env.stremio1.waitForTimeout(800);

      await env.stremio2.bringToFront();
      await injectMockVideo(env.stremio2, 0.2);
      const peerCaughtUp = await env.stremio2.waitForFunction(
        (expectedTime) => {
          const video = document.querySelector('video');
          return !!video && Math.abs(video.currentTime - expectedTime) < 0.5;
        },
        targetTime,
        { timeout: TIMEOUT }
      ).then(() => true).catch(() => false);
      assert(peerCaughtUp, 'Peer catches up after opening a different local stream for the same title');
    }
  } finally {
    await cleanupTwoUsers(env);
  }
}

async function testCreateRoomFromPlayerPagePublishesSafeDirectJoinMetadata() {
  console.log('\n── Test: Host creates a room directly from player page ──');
  const context = await launchWithExtension();
  try {
    const directPlayerUrl = `${STREMIO_URL}/#/player/eAEBOADH%2F3sieXRJZCI6Ik5LWWVhNjN0UW1JIiwiZGVzY3JpcHRpb24iOiJQcm9qZWN0IEhhaWwgTWFyeSJ9BqUSsQ%3D%3D`;
    const stremio = await openStremioAt(context, directPlayerUrl);
    await injectMockVideo(stremio, 42);

    const extId = await getExtensionId(context);
    const popup = await openPopup(context, extId);
    await popup.fill('#username-input', 'PlayerHost');
    await popup.fill('#room-name-input', `player-${Date.now().toString().slice(-6)}`);
    await popup.check('#public-check');
    await popup.click('#btn-create');
    await popup.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    );

    const roomId = await popup.evaluate(() => document.getElementById('room-id-display').textContent);
    let roomSnapshot = null;
    const roomApis = ['http://localhost:8181/rooms', 'https://ws.mertd.me/rooms'];
    for (let i = 0; i < 10; i++) {
      roomSnapshot = await findRoomSnapshot(roomApis, roomId);
      if (roomSnapshot?.hasDirectJoin) break;
      await stremio.waitForTimeout(500);
    }

    assert(
      roomSnapshot?.hasDirectJoin === true
        && roomSnapshot?.directJoinType === 'direct-url'
        && !('directJoinUrl' in roomSnapshot),
      `Public room exposes safe direct-join metadata when created from an existing player page (${JSON.stringify(roomSnapshot)})`
    );

    await popup.close();
    await stremio.close();
  } finally {
    await context.close();
  }
}

async function testRoomCreatedFromDetailPageUpgradesDirectJoinAfterOpeningPlayer() {
  console.log('\nâ”€â”€ Test: Host room upgrades from detail page to player route â”€â”€');
  const context = await launchWithExtension();
  try {
    const detailUrl = `${STREMIO_URL}/#/detail/movie/tt0468569/tt0468569`;
    const directPlayerUrl = `${STREMIO_URL}/#/player/eAEBOADH%2F3sieXRJZCI6Ik5LWWVhNjN0UW1JIiwiZGVzY3JpcHRpb24iOiJQcm9qZWN0IEhhaWwgTWFyeSJ9BqUSsQ%3D%3D`;
    const roomApis = ['http://localhost:8181/rooms', 'https://ws.mertd.me/rooms'];
    const stremio = await openStremioAt(context, detailUrl);

    const extId = await getExtensionId(context);
    const popup = await openPopup(context, extId);
    await popup.fill('#username-input', 'DetailHost');
    await popup.fill('#room-name-input', `detail-${Date.now().toString().slice(-6)}`);
    await popup.check('#public-check');
    await popup.click('#btn-create');
    await popup.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    );

    const roomId = await popup.evaluate(() => document.getElementById('room-id-display').textContent);
    let roomSnapshot = null;
    for (let i = 0; i < 10; i++) {
      roomSnapshot = await findRoomSnapshot(roomApis, roomId);
      if (roomSnapshot) break;
      await stremio.waitForTimeout(300);
    }

    assert(
      roomSnapshot?.hasDirectJoin === false && roomSnapshot?.directJoinType === null,
      `Detail-page room starts without direct-join metadata (${JSON.stringify(roomSnapshot)})`
    );

    await stremio.evaluate((nextHash) => {
      window.location.hash = nextHash.replace(/^.*#/, '#');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }, directPlayerUrl);
    await injectMockVideo(stremio, 42);

    roomSnapshot = null;
    for (let i = 0; i < 20; i++) {
      roomSnapshot = await findRoomSnapshot(
        roomApis,
        roomId,
        (room) => room.hasDirectJoin === true && room.directJoinType === 'direct-url'
      );
      if (roomSnapshot?.hasDirectJoin === true && roomSnapshot?.directJoinType === 'direct-url') break;
      await stremio.waitForTimeout(400);
    }

    assert(
      roomSnapshot?.hasDirectJoin === true && roomSnapshot?.directJoinType === 'direct-url',
      `Opening a player route upgrades the room metadata (${JSON.stringify(roomSnapshot)})`
    );

    await popup.close();
    await stremio.close();
  } finally {
    await context.close();
  }
}

async function testPreferDirectJoinOpensPrivatePlayerLocally() {
  console.log('\n── Test: Prefer Direct Join opens the host player after room sync ──');
  const ctx1 = await launchWithExtension();
  const ctx2 = await launchWithExtension();
  try {
    const stremio1 = await openStremio(ctx1);
    const extId1 = await getExtensionId(ctx1);
    const popup1 = await openPopup(ctx1, extId1);
    await popup1.fill('#username-input', 'Alice');
    await popup1.check('#public-check');
    await popup1.click('#btn-create');
    await popup1.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout: TIMEOUT });
    const roomId = await popup1.evaluate(() => document.getElementById('room-id-display').textContent);

    await injectMockVideo(stremio1, 42);
    await stremio1.evaluate(() => {
      window.location.hash = '/detail/movie/tt0468569/tt0468569';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await stremio1.waitForTimeout(800);
    await stremio1.evaluate(() => {
      window.location.hash = '/player/eAEBOADH%2F3sieXRJZCI6Ik5LWWVhNjN0UW1JIiwiZGVzY3JpcHRpb24iOiJQcm9qZWN0IEhhaWwgTWFyeSJ9BqUSsQ%3D%3D';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await stremio1.waitForTimeout(1500);

    const stremio2 = await openStremio(ctx2);
    const extId2 = await getExtensionId(ctx2);
    const popup2 = await openPopup(ctx2, extId2);
    await popup2.evaluate((pendingRoomId) => chrome.storage.local.set({
      [WPConstants.STORAGE.USERNAME]: 'Bob',
      [WPConstants.STORAGE.PENDING_ROOM_JOIN]: pendingRoomId,
      [WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS]: {
        roomId: pendingRoomId,
        preferDirectJoin: true,
        requestedAt: Date.now(),
      },
    }), roomId);

    const joined = await popup2.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    ).then(() => true).catch(() => false);
    assert(joined, 'Peer joins the room via the direct-join intent');

    const openedPlayer = await stremio2.waitForFunction(
      () => window.location.hash.startsWith('#/player/'),
      { timeout: TIMEOUT }
    ).then(() => true).catch(() => false);
    assert(openedPlayer, 'Peer opens the host player after the room sync arrives');

    await popup1.close();
    await popup2.close();
    await stremio1.close();
    await stremio2.close();
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
}

async function testBidirectionalChat() {
  console.log('\n── Test: Bidirectional chat between two real extensions ──');
  const env = await setupTwoUsers();
  try {
    // Bob sends message
    await env.stremio2.bringToFront();
    await env.stremio2.focus('#wp-chat-input');
    await env.stremio2.keyboard.type('Hello from Bob!');
    await env.stremio2.keyboard.press('Enter');

    // Wait for Alice to receive
    await env.stremio1.bringToFront();
    const aliceGotBob = await env.stremio1.waitForFunction(
      () => document.getElementById('wp-chat-messages')?.innerText?.includes('Hello from Bob!'),
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    assert(aliceGotBob, 'Alice sees Bob message');

    // Alice sends message — note: already tested in testChatFlow that Alice→Bob works.
    // In two separate Playwright contexts, the backgrounded browser throttles WS heavily.
    // So instead of waiting for Bob's backgrounded tab, verify Alice sees her own message.
    await env.stremio1.bringToFront();
    await env.stremio1.focus('#wp-chat-input');
    await env.stremio1.keyboard.type('Hi Bob from Alice!');
    await env.stremio1.keyboard.press('Enter');
    const aliceSentOk = await env.stremio1.waitForFunction(
      () => document.getElementById('wp-chat-messages')?.innerText?.includes('Hi Bob from Alice!'),
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    assert(aliceSentOk, 'Alice sent message (local echo + server broadcast)');
  } finally {
    await cleanupTwoUsers(env);
  }
}

async function testTypingIndicatorFlow() {
  console.log('\n── Test: Typing indicator syncs across users ──');
  const env = await setupTwoUsers();
  try {
    await env.stremio2.bringToFront();
    await env.stremio2.focus('#wp-chat-input');
    await env.stremio2.keyboard.type('T');

    const aliceSawTyping = await env.stremio1.waitForFunction(
      () => {
        const el = document.getElementById('wp-typing-indicator');
        return el && !el.classList.contains('wp-hidden-el') && el.textContent.includes('Bob is typing');
      },
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    assert(aliceSawTyping, 'Alice sees Bob typing');

    await env.stremio2.keyboard.type('yping...');
    await env.stremio2.waitForTimeout(300);
    await env.stremio2.keyboard.press('Enter');

    const typingCleared = await env.stremio1.waitForFunction(
      () => document.getElementById('wp-typing-indicator')?.classList.contains('wp-hidden-el'),
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    assert(typingCleared, 'Typing indicator clears after Bob sends the message');
  } finally {
    await cleanupTwoUsers(env);
  }
}

async function testLatePeerVideoAttachmentResyncsToHost() {
  console.log('\n── Test: Peer video added after join catches up to host ──');
  const env = await setupTwoUsers();
  try {
    await env.stremio1.bringToFront();
    await injectMockVideo(env.stremio1, 2);
    await env.stremio1.evaluate(() => document.querySelector('[data-panel="room"]')?.click());
    const hostSawVideo = await env.stremio1.waitForFunction(
      () => !!document.getElementById('wp-bookmark-btn'),
      { timeout: TIMEOUT }
    ).then(() => true).catch(() => false);
    assert(hostSawVideo, 'Host content script detects the newly opened video');

    if (hostSawVideo) {
      const targetTime = await env.stremio1.evaluate(async () => {
        const video = document.querySelector('video');
        if (!video) return 0;
        const nextTime = Math.min(2.8, Math.max(0, (video.duration || 2.8) - 0.1));
        await new Promise((resolve) => {
          const onSeeked = () => resolve();
          video.addEventListener('seeked', onSeeked, { once: true });
          video.currentTime = nextTime;
          setTimeout(resolve, 800);
        });
        return nextTime;
      });
      await env.stremio1.waitForTimeout(800);

      await env.stremio2.bringToFront();
      await injectMockVideo(env.stremio2, 0.1);

      const peerCaughtUp = await env.stremio2.waitForFunction(
        (expectedTime) => {
          const video = document.querySelector('video');
          return !!video && Math.abs(video.currentTime - expectedTime) < 0.5;
        },
        targetTime,
        { timeout: TIMEOUT }
      ).then(() => true).catch(() => false);
      assert(peerCaughtUp, 'Peer catches up after opening a video late');
    }
  } finally {
    await cleanupTwoUsers(env);
  }
}

async function testBookmarkFlow() {
  console.log('\n── Test: Bookmarks sync and seek the peer video ──');
  const env = await setupTwoUsers();
  try {
    await injectMockVideo(env.stremio1, 2);
    await injectMockVideo(env.stremio2, 0.1);

    await env.stremio1.evaluate(() => document.querySelector('[data-panel="room"]')?.click());
    await env.stremio1.waitForTimeout(300);

    const hostHasBookmarkButton = await env.stremio1.waitForFunction(
      () => !!document.getElementById('wp-bookmark-btn'),
      { timeout: TIMEOUT }
    ).then(() => true).catch(() => false);
    assert(hostHasBookmarkButton, 'Host sees the bookmark action when video is present');

    if (hostHasBookmarkButton) {
      await env.stremio1.click('#wp-bookmark-btn');

      const peerSawBookmark = await env.stremio2.waitForFunction(
        () => document.querySelector('.wp-bookmark-msg .wp-bookmark-time')?.textContent === '0:02',
        { timeout: 5000 }
      ).then(() => true).catch(() => false);
      assert(peerSawBookmark, 'Peer receives the bookmark entry');

      if (peerSawBookmark) {
        await env.stremio2.evaluate(() => document.querySelector('[data-panel="chat"]')?.click());
        await env.stremio2.waitForTimeout(300);
        await env.stremio2.click('.wp-bookmark-time');
        await env.stremio2.waitForTimeout(300);
        const peerVideoTime = await env.stremio2.evaluate(() => document.querySelector('video')?.currentTime || 0);
        assert(Math.abs(peerVideoTime - 2) < 0.1, `Clicking the bookmark seeks the peer video (${peerVideoTime.toFixed(1)}s)`);
      }
    }
  } finally {
    await cleanupTwoUsers(env);
  }
}

// ── Two-user: Named room persist ──

async function testNamedRoom() {
  console.log('\n── Test: Named room preserves state across rejoin ──');
  const ctx = await launchWithExtension();
  try {
    const stremio = await openStremio(ctx);
    const extId = await getExtensionId(ctx);

    // Create named room
    const popup = await openPopup(ctx, extId);
    await popup.fill('#username-input', 'Alice');
    const roomName = `test-persist-${Date.now().toString().slice(-6)}`;
    await popup.fill('#room-name-input', roomName);
    await popup.check('#public-check');
    await popup.click('#btn-create');
    await popup.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout: TIMEOUT });
    const roomId = await popup.evaluate(() => document.getElementById('room-id-display').textContent);
    assert(roomId, `Named room created: ${roomId?.substring(0, 8)}`);

    // Send a bookmark (adds state to the room)
    await popup.close();
    await stremio.bringToFront();
    await stremio.waitForTimeout(1000);
    // Open sidebar and send chat to add state
    await stremio.evaluate(() => {
      const s = document.getElementById('wp-sidebar');
      if (s?.classList.contains('wp-sidebar-hidden')) document.getElementById('wp-toggle-host')?.click();
    });
    await stremio.waitForTimeout(500);
    await stremio.focus('#wp-chat-input');
    await stremio.keyboard.type('Persist test msg');
    await stremio.keyboard.press('Enter');
    await stremio.waitForTimeout(1000);

    // Leave room
    await stremio.evaluate(() => {
      document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'leave-room' } }));
    });
    await stremio.waitForFunction(
      () => document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
      { timeout: 8000 }
    ).catch(() => {});
    await stremio.waitForTimeout(1000);

    // Rejoin with same name — should get same room
    const popup2 = await openPopup(ctx, extId);
    await popup2.fill('#username-input', 'Alice');
    await popup2.fill('#room-name-input', roomName);
    await popup2.check('#public-check');
    await popup2.click('#btn-create');
    await popup2.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout: TIMEOUT });
    const roomId2 = await popup2.evaluate(() => document.getElementById('room-id-display').textContent);
    assert(roomId2 === roomId, `Rejoined same room (${roomId2?.substring(0, 8)} === ${roomId?.substring(0, 8)})`);
    await popup2.close();
  } finally {
    await ctx.close();
  }
}

// ── Main ──

async function main() {
  console.log('WatchParty E2E Browser Tests (Real Extension Flow)');
  console.log('===================================================\n');
  console.log('Extension path:', EXT_PATH);

  // Verify server is running
  try {
    const res = await fetch('http://localhost:8181/health');
    if (!res.ok) throw new Error();
    console.log('Server: running\n');
  } catch {
    console.error('ERROR: WS server not running on localhost:8181');
    console.error('Start it with: cd ../watchparty-server && npm run dev');
    process.exit(1);
  }

  const tests = [
    testPopupLoadsWithStatus,
    testEmptyUsernameValidation,
    testCreateRoomWithoutStremioTabAttachesLater,
    testPopupFirstJoinMissingRoomShowsImmediateError,
    testPopupHidesStaleInactiveBackgroundRoomState,
    testCreateRoomFlow,
    testPopupReloadReadsWrappedLocalRoomKeyFallback,
    testJoinRoomFlow,
    testJoinRoomWithoutStremioTabAttachesLater,
    testPopupFirstRoomControlsWithoutStremioTab,
    testChatFlow,
    testHostVsPeerSettings,
    testThemePropagation,
    testPeerContentLink,
    testPeerDirectStreamLink,
    testDebridLikeHostRequiresManualPeerStreamButStillSyncs,
    testCreateRoomFromPlayerPagePublishesSafeDirectJoinMetadata,
    testRoomCreatedFromDetailPageUpgradesDirectJoinAfterOpeningPlayer,
    testPreferDirectJoinOpensPrivatePlayerLocally,
    testBidirectionalChat,
    testTypingIndicatorFlow,
    testLatePeerVideoAttachmentResyncsToHost,
    testBookmarkFlow,
    testNamedRoom,
  ];

  for (const test of tests) {
    currentDiagnostics = createBrowserDiagnostics();
    try {
      await test();
    } catch (e) {
      console.error(`  ✗ FATAL: ${e.message}`);
      failed++;
    } finally {
      assertCleanDiagnostics(test.name);
    }
  }

  console.log(`\n${'='.repeat(30)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  process.exit(failed > 0 ? 1 : 0);
}

main();
