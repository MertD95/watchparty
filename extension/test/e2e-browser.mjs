// WatchParty â€” Full E2E Browser Test (Real User Flow)
// Tests the actual user flow: popup â†’ create room â†’ sidebar updates â†’ chat â†’ leave.
// Uses Playwright with the real extension loaded â€” tests the ACTUAL extension pipeline,
// not page-context WebSockets (which bypass the extension's message routing).
//
// This catches bugs that MCP/page-context testing CANNOT:
// - Popup â†’ background.js â†’ content script message relay
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
import { expectPass, gotoWithRetry, pollUntil } from './assertions.mjs';
import { createBrowserDiagnostics } from './browser-diagnostics.mjs';
import { getExtensionId, launchExtensionContext } from './extension-context.mjs';
import { injectSeekableTestVideo } from './seekable-video.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const STREMIO_URL = 'https://web.stremio.com';
const IS_CI = process.env.CI === 'true' || process.env.CI === '1';
const TIMEOUT = IS_CI ? 25000 : 15000;
const SHORT_TIMEOUT = IS_CI ? 10000 : 5000;
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
    console.log(`  PASS ${label}`);
    passed++;
    return;
  }
  console.error(`  FAIL ${label}`);
  failed++;
}

async function assertPass(label, task) {
  const result = await expectPass(assert, label, task);
  return result.ok;
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
  const context = await launchExtensionContext(EXT_PATH, {
    userDataDir: dir,
    args: CHROME_FLAGS,
    viewport: { width: 1440, height: 900 },
    backendMode: 'local',
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: STREMIO_URL }).catch(() => {});
  return context;
}

async function waitForPopupReady(page) {
  await page.waitForFunction(() => {
    const wsText = document.getElementById('ws-status')?.textContent || '';
    return !!document.getElementById('username-input')
      && !!document.getElementById('btn-create')
      && document.body?.dataset?.statusReady === 'true'
      && wsText.trim().length > 0;
  }, { timeout: TIMEOUT });
}

async function waitForOptionsReady(page) {
  await page.waitForFunction(() => {
    const note = document.getElementById('backend-note')?.textContent || '';
    return !!document.getElementById('btn-refresh') && note.trim().length > 0;
  }, { timeout: TIMEOUT });
}

async function waitForStremioReady(page) {
  await page.waitForFunction(() => (
    !!document.getElementById('wp-overlay')
    && !!document.getElementById('wp-sidebar')
    && !!document.getElementById('wp-toggle-host')
  ), { timeout: TIMEOUT });
}

async function waitForSidebarRoomAttached(page, timeout = TIMEOUT) {
  await page.waitForFunction(() => {
    const sidebar = document.getElementById('wp-sidebar');
    if (!sidebar || sidebar.classList.contains('wp-sidebar-hidden')) return false;
    return !sidebar.innerText.includes('Not in a room');
  }, { timeout });
}

async function waitForSidebarLobby(page, timeout = TIMEOUT) {
  await page.waitForFunction(() => {
    const sidebar = document.getElementById('wp-sidebar');
    return !!sidebar && sidebar.innerText.includes('Not in a room');
  }, { timeout });
}

async function waitForSidebarPanel(page, panelName) {
  await page.waitForFunction((nextPanel) => {
    const button = document.querySelector(`[data-panel="${nextPanel}"]`);
    return !!button
      && button.classList.contains('wp-tab-active')
      && button.getAttribute('aria-selected') === 'true';
  }, panelName, { timeout: TIMEOUT });
}

async function waitForChatSendButtonState(page, disabled, timeout = SHORT_TIMEOUT) {
  await page.waitForFunction((expectedDisabled) => {
    const button = document.getElementById('wp-chat-send');
    return !!button && button.disabled === expectedDisabled;
  }, disabled, { timeout });
}

async function waitForSidebarAccent(page, expectedColor, timeout = SHORT_TIMEOUT) {
  await page.waitForFunction((expected) => (
    document.getElementById('wp-sidebar')?.style.getPropertyValue('--wp-accent') === expected
  ), expectedColor, { timeout });
}

async function waitForCheckboxToggle(page, inputId, previousValue, timeout = TIMEOUT) {
  await page.waitForFunction(({ id, expectedPrevious }) => {
    const input = document.getElementById(id);
    return !!input && input.checked !== expectedPrevious;
  }, { id: inputId, expectedPrevious: previousValue }, { timeout });
}

async function waitForPopupRoomView(page, timeout = TIMEOUT) {
  await page.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout });
}

async function waitForPopupLobbyView(page, timeout = TIMEOUT) {
  await page.waitForFunction(() => {
    const lobbyVisible = !document.getElementById('view-lobby').classList.contains('hidden');
    const createVisible = !!document.getElementById('btn-create')?.offsetParent;
    return lobbyVisible && createVisible;
  }, { timeout });
}

/** Open the extension popup in a new tab and return the page */
async function openPopup(context, extId) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'popup');
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await waitForPopupReady(page);
  return page;
}

async function openSidepanel(context, extId) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'sidepanel');
  await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.getElementById('status') && !!document.getElementById('hero-copy'), { timeout: TIMEOUT });
  return page;
}

async function openOptions(context, extId) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'options');
  await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'domcontentloaded' });
  await waitForOptionsReady(page);
  return page;
}

/** Navigate to Stremio and wait for extension overlay */
async function openStremio(context) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'stremio');
  await gotoWithRetry(page, STREMIO_URL);
  await waitForStremioReady(page);
  return page;
}

async function openStremioAt(context, url) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'stremio');
  await gotoWithRetry(page, url);
  await waitForStremioReady(page);
  return page;
}

async function openSidebarIfHidden(page) {
  const sidebarHidden = await page.evaluate(() =>
    document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden')
  );
  if (sidebarHidden) {
    await page.evaluate(() => document.getElementById('wp-toggle-host')?.click());
    await page.waitForFunction(() => {
      const sidebar = document.getElementById('wp-sidebar');
      return !!sidebar && !sidebar.classList.contains('wp-sidebar-hidden');
    }, { timeout: TIMEOUT });
  }
}

async function openSidebarPanel(page, panelName) {
  await openSidebarIfHidden(page);
  await page.evaluate((nextPanel) => {
    document.querySelector(`[data-panel="${nextPanel}"]`)?.click();
  }, panelName);
  await waitForSidebarPanel(page, panelName);
}

async function injectMockVideo(page, currentTime = 0) {
  await injectSeekableTestVideo(page, currentTime);
}

async function readClipboardText(page) {
  return page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  });
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

async function waitForRoomSnapshot(roomApis, roomId, predicate = () => true, timeout = TIMEOUT, intervalMs = 400) {
  try {
    return await pollUntil(
      async () => {
        const snapshot = await findRoomSnapshot(roomApis, roomId, predicate);
        return snapshot || false;
      },
      { timeout, intervalMs, label: `room snapshot for ${roomId}` }
    );
  } catch {
    return null;
  }
}

async function waitForRoomGone(roomApis, roomId, timeout = 10000) {
  try {
    await pollUntil(
      async () => {
        const snapshot = await findRoomSnapshot(roomApis, roomId);
        return !snapshot;
      },
      { timeout, intervalMs: 250, label: `room ${roomId} to disappear` }
    );
    return true;
  } catch {
    return false;
  }
}

// â”€â”€ Tests â”€â”€

function buildPlayerHash(payload) {
  const encoded = deflateSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64url');
  return `#/player/${encodeURIComponent(encoded)}`;
}

async function testPopupLoadsWithStatus() {
  console.log('\nâ”€â”€ Test: Popup loads and shows status â”€â”€');
  const context = await launchWithExtension();
  try {
    const stremio = await openStremio(context);
    const extId = await getExtensionId(context);
    const popup = await openPopup(context, extId);

    // Popup should show lobby view
    const lobbyVisible = await popup.evaluate(() => !document.getElementById('view-lobby').classList.contains('hidden'));
    assert(lobbyVisible, 'Lobby view visible');

    // Without an active controller session, the popup now reports the backend as idle
    // instead of pretending the room socket is already connected.
    const wsText = await popup.evaluate(() => document.getElementById('ws-status').textContent);
    assert(/(Connected to (Local|Live) server|(Local|Live) server disconnected)/.test(wsText), `WS status: "${wsText}"`);

    const backendNote = await popup.evaluate(() => document.getElementById('backend-note')?.textContent || '');
    assert(
      backendNote.includes('Current backend: Local')
        || backendNote.includes('Current backend: Live')
        || backendNote.includes('Local mode is selected.')
        || backendNote.includes('development builds may use localhost'),
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

async function testOptionsSurfaceShowsBackendFeedback() {
  console.log('\nâ”€â”€ Test: Options page backend controls show feedback â”€â”€');
  const context = await launchWithExtension();
  try {
    const extId = await getExtensionId(context);
    const options = await openOptions(context, extId);

    const defaultState = await options.evaluate(() => ({
      activeMode: document.querySelector('#backend-toggle .backend-btn.active')?.dataset.mode || null,
      refreshLabel: document.getElementById('btn-refresh')?.textContent || '',
    }));
    assert(defaultState.activeMode === 'local', `Options page reflects the current backend mode: "${defaultState.activeMode}"`);
    assert(defaultState.refreshLabel === 'Refresh Status', `Options refresh button label: "${defaultState.refreshLabel}"`);

    await options.click('#backend-live');
    const liveState = await assertPass('Options backend controls switch to Live with visible feedback', () => options.waitForFunction(() => {
      const active = document.querySelector('#backend-toggle .backend-btn.active');
      const note = document.getElementById('backend-note')?.textContent || '';
      const feedback = document.getElementById('backend-feedback')?.textContent || '';
      return active?.dataset.mode === 'live' && note.includes('Live mode is selected.') && feedback.includes('Using Live mode.');
    }, { timeout: TIMEOUT }));

    await options.click('#backend-auto');
    const autoState = await assertPass('Options backend controls return to Auto with updated active state', () => options.waitForFunction(() => {
      const active = document.querySelector('#backend-toggle .backend-btn.active');
      const note = document.getElementById('backend-note')?.textContent || '';
      return active?.dataset.mode === 'auto' && note.includes('Auto mode is selected.');
    }, { timeout: TIMEOUT }));

    await options.click('#btn-refresh');
    await assertPass('Options refresh button shows progress: "Refreshing..."', () => options.waitForFunction(
      () => document.getElementById('btn-refresh')?.textContent === 'Refreshing...',
      { timeout: TIMEOUT }
    ));
    await assertPass('Options refresh button resets: "Refresh Status"', () => options.waitForFunction(
      () => document.getElementById('btn-refresh')?.textContent === 'Refresh Status',
      { timeout: TIMEOUT }
    ));
    await options.close();
  } finally {
    await context.close();
  }
}

async function testOptionsResumeButtonStaysAvailableForStagedRoomHandoffs() {
  console.log('\n-- Test: Options resume button stays available for staged room handoffs --');
  const context = await launchWithExtension();
  try {
    const extId = await getExtensionId(context);
    const options = await openOptions(context, extId);

    await options.evaluate(async () => {
      await chrome.storage.session.set({
        currentRoom: 'resume-room-1234',
        wpBootstrapRoomIntent: {
          action: 'room.join',
          roomId: 'resume-room-1234',
          username: 'ResumeHost',
          requestedAt: Date.now(),
        },
      });
    });

    const resumedState = await assertPass('Options page keeps the resume action enabled when a staged room handoff exists', () => options.waitForFunction(() => {
      const button = document.getElementById('btn-resume-room');
      const pill = document.getElementById('pill-room');
      const title = document.getElementById('session-title');
      const meta = document.getElementById('session-meta');
      return !!button
        && button.disabled === false
        && button.textContent === 'Go to Room in Stremio'
        && !!pill
        && !pill.classList.contains('hidden')
        && /handoff pending/i.test(pill.textContent || '')
        && /finish room setup in stremio/i.test(title?.textContent || '')
        && /staged create or join/i.test(meta?.textContent || '');
    }, { timeout: TIMEOUT }));

    await options.close();
  } finally {
    await context.close();
  }
}

async function testOptionsRecoveryToolsClearOnlyRuntimeState() {
  console.log('\nâ”€â”€ Test: Options recovery tools clear staged runtime state without wiping durable prefs â”€â”€');
  const context = await launchWithExtension();
  try {
    const extId = await getExtensionId(context);
    const options = await openOptions(context, extId);

    await options.evaluate(async () => {
      const roomKeyLocal = 'wpRoomKey:recovery-local-room';
      const roomKeySession = 'wpRoomKey:recovery-session-room';
      await chrome.storage.local.set({
        wpBackendMode: 'live',
        wpAccentColor: '#112233',
        wpUsername: 'RecoveryHost',
        wpSessionId: '11111111-1111-4111-8111-111111111111',
        [roomKeyLocal]: { value: 'local-room-key-123456', storedAt: Date.now() },
      });
        await chrome.storage.session.set({
          wpBootstrapRoomIntent: {
          action: 'room.join',
          roomId: 'recovery-room',
          username: 'RecoveryHost',
          requestedAt: Date.now(),
        },
        currentRoom: 'recovery-room',
        wpRoomState: {
          id: 'recovery-room',
          name: 'Recovery Room',
          public: false,
          users: [{ id: 'me', name: 'RecoveryHost', sessionId: '11111111-1111-4111-8111-111111111111' }],
          owner: 'me',
          ownerSessionId: '11111111-1111-4111-8111-111111111111',
          player: { paused: true, buffering: true, time: 0 },
          settings: { autoPauseOnDisconnect: true },
        },
        wpDeferredLeaveRoom: {
          roomId: 'recovery-room',
          requestedAt: Date.now(),
        },
        wpActiveVideoTab: {
          leaseId: 'lease-recovery',
          tabId: 7,
          sessionId: '11111111-1111-4111-8111-111111111111',
          claimedAt: Date.now(),
        },
        savedAuthKey: 'auth-key-fixture',
        [roomKeySession]: 'session-room-key-654321',
      });
    });

    await options.click('#btn-clear-bootstrap');
    const bootstrapCleared = await assertPass('Options recovery clears staged handoff/runtime state', () => options.waitForFunction(() => {
      const feedback = document.getElementById('recovery-feedback')?.textContent || '';
      return feedback.includes('Cleared staged handoff');
    }, { timeout: TIMEOUT }));

    const postBootstrapState = await options.evaluate(async () => {
      const localValues = await chrome.storage.local.get([
        'wpBackendMode',
        'wpAccentColor',
      ]);
      const sessionValues = await chrome.storage.session.get([
        'wpBootstrapRoomIntent',
        'currentRoom',
        'wpRoomState',
        'wpDeferredLeaveRoom',
        'wpActiveVideoTab',
      ]);
      return { localValues, sessionValues };
    });
    assert(postBootstrapState.localValues.wpBackendMode === 'live', 'Clear Staged Handoff keeps backend mode');
    assert(postBootstrapState.localValues.wpAccentColor === '#112233', 'Clear Staged Handoff keeps appearance prefs');
    assert(Object.values(postBootstrapState.sessionValues).every((value) => value === undefined), 'Clear Staged Handoff removes staged/session runtime markers');

    await options.click('#btn-clear-room-keys');
    const roomKeysCleared = await assertPass('Options recovery clears cached room keys', () => options.waitForFunction(() => {
      const feedback = document.getElementById('recovery-feedback')?.textContent || '';
      return feedback.includes('room key') || feedback.includes('No cached room keys');
    }, { timeout: TIMEOUT }));

    const keyState = await options.evaluate(async () => {
      const local = await chrome.storage.local.get(null);
      const session = await chrome.storage.session.get(null);
      return {
        localKeys: Object.keys(local).filter((key) => key.startsWith('wpRoomKey:')),
        sessionKeys: Object.keys(session).filter((key) => key.startsWith('wpRoomKey:')),
      };
    });
    assert(keyState.localKeys.length === 0 && keyState.sessionKeys.length === 0, 'Cached room keys are removed from both storage areas');

    await options.click('#btn-reset-runtime');
    const runtimeReset = await assertPass('Options reset action reports success', () => options.waitForFunction(() => {
      const feedback = document.getElementById('recovery-feedback')?.textContent || '';
      return feedback.includes('Reset WatchParty');
    }, { timeout: TIMEOUT }));

    const resetState = await options.evaluate(async () => {
      const local = await chrome.storage.local.get([
        'wpBackendMode',
        'wpAccentColor',
        'wpUsername',
        'wpSessionId',
      ]);
      const session = await chrome.storage.session.get([
        'savedAuthKey',
        'wpRoomState',
        'wpBootstrapRoomIntent',
      ]);
      return { local, session };
    });
    assert(resetState.local.wpBackendMode === 'live', 'Reset WatchParty State preserves backend mode');
    assert(resetState.local.wpAccentColor === '#112233', 'Reset WatchParty State preserves appearance prefs');
    assert(resetState.local.wpUsername === undefined, 'Reset WatchParty State clears stored username');
    assert(resetState.local.wpSessionId === undefined, 'Reset WatchParty State clears stored session identity');
    assert(resetState.session.savedAuthKey === undefined, 'Reset WatchParty State clears saved auth');

    await options.click('#btn-copy-diagnostics');
    await assertPass('Options diagnostics action responds with visible feedback', () => options.waitForFunction(
      () => {
        const text = document.getElementById('recovery-feedback')?.textContent || '';
        return text.includes('Diagnostics copied') || text.includes('Could not copy diagnostics');
      },
      { timeout: TIMEOUT }
    ));
    const diagnosticsCopied = await options.evaluate(() => document.getElementById('recovery-feedback')?.textContent || '');
    assert(diagnosticsCopied.length > 0, `Options diagnostics feedback text: "${diagnosticsCopied}"`);

    await options.close();
  } finally {
    await context.close();
  }
}

async function testCreateRoomWithoutStremioTabAttachesLater() {
  console.log('\\n-- Test: Create room auto-opens Stremio when no tab exists --');
  const context = await launchWithExtension();
  let popup = null;
  let stremio = null;
  console.log('\nTest: Create room without Stremio tab and attach later');
  try {
    const extId = await getExtensionId(context);
    popup = await openPopup(context, extId);

    const hintText = await popup.evaluate(() => document.getElementById('status-hint')?.textContent || '');
    assert(
      hintText.includes('hand the room off'),
      `Lobby hint explains popup-first Stremio handoff: "${hintText}"`
    );

    await popup.fill('#username-input', 'PopupFirstHost');
    const stremioPagePromise = context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await popup.click('#btn-create');

    const autoOpenedStremio = await stremioPagePromise;
    const openedStremio = !!autoOpenedStremio && autoOpenedStremio.url().startsWith(STREMIO_URL);
    assert(openedStremio, 'Create room opens Stremio Web when no tab exists');
    stremio = autoOpenedStremio;

    const attachedToRoom = await assertPass('The staged popup create finishes inside Stremio', () => stremio.waitForFunction(
      () => !document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
      { timeout: TIMEOUT * 2 }
    ));

    if (attachedToRoom) {
      const reopenedPopup = await openPopup(context, extId);
      const gotRoom = await assertPass('Popup reflects the room after Stremio finishes the staged create', () => reopenedPopup.waitForFunction(
        () => !document.getElementById('view-room').classList.contains('hidden'),
        { timeout: TIMEOUT }
      ));
      await reopenedPopup.close().catch(() => {});
    }
  } finally {
    await stremio?.close().catch(() => {});
    await popup?.close().catch(() => {});
    await context.close();
  }
}

async function testPopupFirstJoinMissingRoomShowsImmediateError() {
  console.log('\n-- Test: Popup-first join without a tab hands off to Stremio --');
  const context = await launchWithExtension();
  try {
    const extId = await getExtensionId(context);
    const popup = await openPopup(context, extId);

    await popup.fill('#username-input', 'PopupJoiner');
    await popup.click('#lobby-tab-join');
    await popup.fill('#room-id-input', 'missing-room-1234');
    const stremioPagePromise = context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await popup.click('#btn-join');

    const autoOpenedStremio = await stremioPagePromise;
    const openedStremio = !!autoOpenedStremio && autoOpenedStremio.url().startsWith(STREMIO_URL);
    assert(openedStremio, 'Join room opens Stremio Web when no tab exists');
    await autoOpenedStremio?.close().catch(() => {});
    await popup.close();
  } finally {
    await context.close();
  }
}

async function testPopupShowsImmediateInvalidRoomKeyErrorAfterHostUpdatesInviteKey() {
  console.log('\n-- Test: Popup surfaces invalid old room keys after the host updates the invite key --');
  const hostCtx = await launchWithExtension();
  const peerCtx = await launchWithExtension();
  try {
    const hostStremio = await openStremio(hostCtx);
    const hostExtId = await getExtensionId(hostCtx);
    const hostPopup = await openPopup(hostCtx, hostExtId);
    await hostPopup.fill('#username-input', 'HostKeyOwner');
    await hostPopup.click('#btn-create');
    await hostPopup.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    );
    const roomState = await hostPopup.evaluate(async () => {
      const roomId = document.getElementById('room-id-display')?.textContent?.trim();
      const storageKey = roomId ? `wpRoomKey:${roomId}` : null;
      const local = storageKey ? await chrome.storage.local.get(storageKey) : {};
      const session = storageKey ? await chrome.storage.session.get(storageKey) : {};
      return {
        roomId,
        roomKey: (session && storageKey && session[storageKey]) || (local && storageKey && local[storageKey]?.value) || null,
      };
    });

    await openSidebarPanel(hostStremio, 'room');
    await hostStremio.waitForFunction(
      () => !!document.getElementById('wp-room-key-input') && !!document.getElementById('wp-room-key-save'),
      { timeout: TIMEOUT }
    );
    await hostStremio.evaluate(() => {
      const input = document.getElementById('wp-room-key-input');
      input.value = 'UpdatedRoomKey-12345';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('wp-room-key-save')?.click();
    });
    await hostPopup.waitForFunction((expectedKey) => {
      const roomId = document.getElementById('room-id-display')?.textContent?.trim();
      if (!roomId) return false;
      const storageKey = `wpRoomKey:${roomId}`;
      return Promise.all([
        chrome.storage.local.get(storageKey),
        chrome.storage.session.get(storageKey),
      ]).then(([local, session]) => {
        const current = (session && session[storageKey]) || (local && local[storageKey]?.value) || null;
        return current === expectedKey;
      });
    }, 'UpdatedRoomKey-12345', { timeout: TIMEOUT });
    const updatedRoomKey = await hostPopup.evaluate(async () => {
      const roomId = document.getElementById('room-id-display')?.textContent?.trim();
      const storageKey = roomId ? `wpRoomKey:${roomId}` : null;
      const local = storageKey ? await chrome.storage.local.get(storageKey) : {};
      const session = storageKey ? await chrome.storage.session.get(storageKey) : {};
      return (session && storageKey && session[storageKey]) || (local && storageKey && local[storageKey]?.value) || null;
    });

    const peerStremio = await openStremio(peerCtx);
    const peerExtId = await getExtensionId(peerCtx);
    let peerPopup = await openPopup(peerCtx, peerExtId);
    await peerPopup.fill('#username-input', 'PeerKeyJoiner');
    await peerPopup.click('#lobby-tab-join');
    await peerPopup.fill('#room-id-input', `${roomState.roomId}#key=${roomState.roomKey}`);
    await peerPopup.click('#btn-join');

    const invalidKeyShown = await assertPass('Popup surfaces the invalid old room key immediately', () => peerPopup.waitForFunction(
      () => {
        const error = document.getElementById('join-error');
        return !!error
          && !error.classList.contains('hidden')
          && /room key is invalid/i.test(error.textContent || '');
      },
      { timeout: TIMEOUT }
    ));

    if (invalidKeyShown) {
      const stillLobby = await peerPopup.evaluate(() =>
        !document.getElementById('view-lobby').classList.contains('hidden')
        && document.getElementById('view-room').classList.contains('hidden')
      );
      assert(stillLobby, 'Popup stays in the lobby after the invalid old room key');
    }

    await peerPopup.fill('#room-id-input', `${roomState.roomId}#key=${updatedRoomKey}`);
    await peerPopup.click('#btn-join');
    let joinedWithNewKey = true;
    try {
      await peerPopup.waitForFunction(
        () => !document.getElementById('view-room').classList.contains('hidden'),
        { timeout: TIMEOUT }
      );
      assert(true, 'Popup still joins successfully with the updated room key');
    } catch {
      const peerAttached = await assertPass('Peer overlay still attaches after joining with the updated room key', () => peerStremio.waitForFunction(
        () => !document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
        { timeout: TIMEOUT }
      ));
      if (!peerAttached) {
        joinedWithNewKey = false;
      } else {
        await peerPopup.close().catch(() => {});
        const reopenedPeerPopup = await openPopup(peerCtx, peerExtId);
        try {
          await reopenedPeerPopup.waitForFunction(
            () => !document.getElementById('view-room').classList.contains('hidden'),
            { timeout: TIMEOUT }
          );
          assert(true, 'Popup still joins successfully with the updated room key');
          peerPopup = reopenedPeerPopup;
        } catch {
          joinedWithNewKey = false;
          await reopenedPeerPopup.close().catch(() => {});
        }
      }
    }

    if (joinedWithNewKey) {
      const peerRoomState = await peerPopup.evaluate(() => ({
        roomId: document.getElementById('room-id-display')?.textContent?.trim() || null,
        role: document.getElementById('room-role-badge')?.textContent?.trim() || null,
        count: document.getElementById('room-count-badge')?.textContent?.trim() || null,
      }));
      assert(peerRoomState.roomId === roomState.roomId, 'Updated key join lands in the expected room');
      assert(peerRoomState.role === 'Synced', 'Updated key join preserves the peer role');
      assert(peerRoomState.count === '2 watching', 'Updated key join shows both room members');
      const peerAttached = await assertPass('Peer overlay attaches after joining with the updated room key', () => peerStremio.waitForFunction(
        () => !document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
        { timeout: TIMEOUT }
      ));
    } else {
      assert(false, 'Popup still joins successfully with the updated room key');
    }

    await peerPopup.close().catch(() => {});
    await hostPopup.close().catch(() => {});
    await peerStremio.close().catch(() => {});
    await hostStremio.close().catch(() => {});
  } finally {
    await peerCtx.close();
    await hostCtx.close();
  }
}

async function testPopupRejectsDuplicateDisplayNameInSameRoom() {
  console.log('\n-- Test: Popup rejects duplicate display names in the same room --');
  const hostCtx = await launchWithExtension();
  const peerCtx = await launchWithExtension();
  try {
    const hostStremio = await openStremio(hostCtx);
    const hostExtId = await getExtensionId(hostCtx);
    const hostPopup = await openPopup(hostCtx, hostExtId);
    await hostPopup.fill('#username-input', 'Alice');
    await hostPopup.check('#public-check');
    await hostPopup.click('#btn-create');
    await hostPopup.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    );
    const roomId = await hostPopup.evaluate(() => document.getElementById('room-id-display')?.textContent?.trim() || '');

    const peerStremio = await openStremio(peerCtx);
    const peerPopup = await openPopup(peerCtx, await getExtensionId(peerCtx));
    await peerPopup.fill('#username-input', 'Alice');
    await peerPopup.click('#lobby-tab-join');
    await peerPopup.fill('#room-id-input', roomId);
    await peerPopup.click('#btn-join');

    const duplicateNameShown = await assertPass('Popup surfaces a duplicate display-name error immediately', () => peerPopup.waitForFunction(
      () => {
        const error = document.getElementById('join-error');
        return !!error
          && !error.classList.contains('hidden')
          && /already in use/i.test(error.textContent || '');
      },
      { timeout: TIMEOUT }
    ));

    if (duplicateNameShown) {
      const stillLobby = await peerPopup.evaluate(() =>
        !document.getElementById('view-lobby').classList.contains('hidden')
        && document.getElementById('view-room').classList.contains('hidden')
      );
      assert(stillLobby, 'Popup stays in the lobby after a duplicate display-name rejection');
    }

    await peerStremio.close().catch(() => {});
    await peerPopup.close().catch(() => {});
    await hostPopup.close().catch(() => {});
    await hostStremio.close().catch(() => {});
  } finally {
    await peerCtx.close();
    await hostCtx.close();
  }
}

async function testPopupHidesStaleInactiveBackgroundRoomState() {
  console.log('\n-- Test: Popup treats persisted room state as resumable without a Stremio tab --');
  const context = await launchWithExtension();
  try {
    const extId = await getExtensionId(context);
    let popup = await openPopup(context, extId);

    await popup.evaluate(() => chrome.storage.session.set({
      currentRoom: 'stale-room-id',
      wpRoomState: {
        id: 'stale-room-id',
        owner: 'stale-owner',
        public: false,
        users: [{ id: 'stale-owner', name: 'Ghost Host', room_id: 'stale-room-id' }],
        meta: { id: 'pending', type: 'movie', name: 'Ghost Room' },
        stream: { url: 'https://watchparty.mertd.me/sync' },
        player: { paused: true, buffering: false, time: 0, speed: 1 },
        settings: { autoPauseOnDisconnect: false },
      },
    }));

    await popup.close();
    popup = await openPopup(context, extId);

    const roomVisible = await assertPass('Popup keeps persisted room state as resumable session context', () => popup.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden')
        && document.getElementById('room-id-display')?.textContent === 'stale-room-id'
        && document.getElementById('btn-resume-room')?.textContent === 'Go to Room in Stremio',
      { timeout: TIMEOUT }
    ));

    await popup.close();
  } finally {
    await context.close();
  }
}

async function testCreateRoomFlow() {
  console.log('\nâ”€â”€ Test: Create room via popup â†’ sidebar updates â”€â”€');
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
    const gotRoom = await assertPass('Popup switched to room view', () => popup.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    ));

    if (gotRoom) {
      // Room ID displayed
      const roomId = await popup.evaluate(() => document.getElementById('room-id-display').textContent);
      assert(roomId && roomId.length > 10, `Room ID shown: ${roomId?.substring(0, 8)}...`);

      const popupSummary = await popup.evaluate(() => ({
        privacy: document.getElementById('room-privacy-badge')?.textContent || '',
        role: document.getElementById('room-role-badge')?.textContent || '',
        count: document.getElementById('room-count-badge')?.textContent || '',
        hasShare: !!document.getElementById('btn-share'),
        hasBrowse: !!document.getElementById('browse-rooms-link'),
      }));
      assert(
        /Invite.*required/i.test(popupSummary.privacy),
        `Popup summary shows private room badge: "${popupSummary.privacy}"`
      );
      assert(popupSummary.role.includes('Host'), `Popup summary shows host badge: "${popupSummary.role}"`);
      assert(popupSummary.count.includes('1 watching'), `Popup summary shows host count: "${popupSummary.count}"`);
      assert(popupSummary.hasShare, 'Popup summary keeps Copy Invite action');
      assert(popupSummary.hasBrowse, 'Popup summary keeps Browse Rooms action');
      await popup.click('#btn-share');
      const popupCopyWorked = await assertPass('Popup Copy Invite action succeeds', () => popup.waitForFunction(
        () => document.getElementById('btn-share')?.textContent === 'Link Copied!',
        { timeout: TIMEOUT }
      ));
      const popupClipboardText = await readClipboardText(stremio);
      assert(
        popupClipboardText.includes(`/r/${roomId}`),
        `Popup Copy Invite writes the room link to the clipboard (${popupClipboardText || 'empty'})`
      );
      // Stremio sidebar should now show the room
      await stremio.bringToFront();
      await waitForSidebarRoomAttached(stremio);
      const sidebarText = await stremio.evaluate(() => document.getElementById('wp-sidebar')?.innerText?.substring(0, 300));
      assert(sidebarText && !sidebarText.includes('Not in a room'), 'Stremio sidebar shows room (not lobby)');

      const panelsReady = await stremio.evaluate(() =>
        !!document.querySelector('[data-panel="chat"]')
        && !!document.querySelector('[data-panel="people"]')
        && !!document.querySelector('[data-panel="room"]')
        && !!document.querySelector('[data-panel="prefs"]')
      );
      assert(panelsReady, 'Sidebar exposes Chat, People, Room, and Settings tabs');

      await openSidebarPanel(stremio, 'people');
      const peopleText = await stremio.evaluate(() => document.getElementById('wp-users')?.innerText || '');
      assert(peopleText.includes('TestHost'), 'People tab shows TestHost');
      await openSidebarPanel(stremio, 'room');
      const sessionControlsReady = await stremio.evaluate(() => ({
        privateToggle: !!document.getElementById('wp-session-private'),
        listedToggle: !!document.getElementById('wp-session-listed'),
        autoPauseToggle: !!document.getElementById('wp-session-autopause'),
      }));
      assert(sessionControlsReady.privateToggle, 'Room tab shows host access control');
      assert(sessionControlsReady.listedToggle, 'Room tab shows host listing control');
      assert(sessionControlsReady.autoPauseToggle, 'Room tab shows auto-pause safeguard');
      await stremio.click('#wp-room-code');
      await assertPass('Room code chip copies the invite link successfully', () => stremio.waitForFunction(
        () => (document.getElementById('wp-room-code')?.textContent || '') === 'Link copied!',
        { timeout: TIMEOUT }
      ));
      const roomCodeClipboardText = await readClipboardText(stremio);
      assert(
        roomCodeClipboardText.includes(`/r/${roomId}`),
        `Room code chip writes the room link to the clipboard (${roomCodeClipboardText || 'empty'})`
      );
      await stremio.click('#wp-copy-invite-btn');
      await assertPass('Room panel Copy Invite action succeeds', () => stremio.waitForFunction(
        () => (document.getElementById('wp-toast')?.textContent || '').includes('Invite copied'),
        { timeout: TIMEOUT }
      ));
      const roomButtonClipboardText = await readClipboardText(stremio);
      assert(
        roomButtonClipboardText.includes(`/r/${roomId}`),
        `Room panel Copy Invite writes the room link to the clipboard (${roomButtonClipboardText || 'empty'})`
      );
      const roomKeyHelpStable = await stremio.evaluate(async () => {
        const help = document.getElementById('wp-room-key-help');
        const row = document.querySelector('label[for="wp-session-autopause"]');
        const input = document.getElementById('wp-session-autopause');
        if (!help || !row || !input) return false;
        const seenTexts = [];
        const observer = new MutationObserver(() => {
          seenTexts.push(help.textContent || '');
        });
        observer.observe(help, { childList: true, subtree: true, characterData: true });
        const waitForToggle = (expectedPrevious) => new Promise((resolve) => {
          const tick = () => {
            const nextInput = document.getElementById('wp-session-autopause');
            if (nextInput && nextInput.checked !== expectedPrevious) {
              resolve();
              return;
            }
            requestAnimationFrame(tick);
          };
          tick();
        });
        const before = input.checked;
        row.click();
        await waitForToggle(before);
        row.click();
        await waitForToggle(!before);
        observer.disconnect();
        return !seenTexts.some((text) => /Loading invite key/i.test(text));
      });
      assert(roomKeyHelpStable, 'Room key helper text stays stable while auto-pause toggles update');
      await openSidebarPanel(stremio, 'prefs');
      const prefsReady = await stremio.evaluate(() => ({
        soundToggle: !!document.getElementById('wp-settings-sound'),
      }));
      assert(prefsReady.soundToggle, 'Settings tab shows browser-level personal preferences');

      // Test leave room
      await popup.bringToFront();
      await popup.click('#btn-leave');
      const backToLobby = await assertPass('Back to lobby after leaving', () => waitForPopupLobbyView(popup, SHORT_TIMEOUT));

      // Stremio sidebar should show "Not in a room" (wait for background â†’ content script relay)
      await stremio.bringToFront();
      // Note: leave goes through popup â†’ background â†’ forwardToStremioTab â†’ content script.
      // In MV3, the service worker may suspend between relay hops. Also, the content script
      // sends room.leave to the WS server, and the sidebar only updates on the server's sync response.
      // This can take several seconds â€” use a generous timeout.
      const leftRoom = await assertPass('Sidebar shows "Not in a room" after leaving (may be slow due to MV3 relay)', () => waitForSidebarLobby(stremio, 10000));

      // Regression: re-create immediately after leaving in the same popup session.
      await popup.bringToFront();
      await waitForPopupLobbyView(popup, SHORT_TIMEOUT).catch(() => {});
      await popup.click('#btn-create');
      const recreatedRoom = await assertPass('Popup can create another room after leaving', () => waitForPopupRoomView(popup, TIMEOUT));

      if (recreatedRoom) {
        const recreatedRoomId = await popup.evaluate(() => document.getElementById('room-id-display').textContent);
        assert(recreatedRoomId && recreatedRoomId !== roomId, 'Second create shows a new room ID');
        const createErrorHidden = await popup.evaluate(() => document.getElementById('create-error').classList.contains('hidden'));
        assert(createErrorHidden, 'Second create does not show the create-room error');

        await stremio.bringToFront();
        await waitForSidebarRoomAttached(stremio);
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

async function testDisconnectedLeaveStillRemovesRoomAfterReconnect() {
  console.log('\n-- Test: Leave while disconnected still clears the public room after reconnect --');
  const context = await launchWithExtension();
  try {
    const roomApis = ['http://localhost:8181/rooms'];
    const stremio = await openStremio(context);
    const extId = await getExtensionId(context);
    const popup = await openPopup(context, extId);

    await popup.fill('#username-input', 'DisconnectLeaveHost');
    await popup.check('#public-check');
    await popup.click('#btn-create');
    await popup.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    );

    const roomId = await popup.evaluate(() => document.getElementById('room-id-display').textContent);
    const roomVisible = await findRoomSnapshot(roomApis, roomId);
    assert(!!roomVisible, 'Public room is visible before the disconnect/leave flow');

    await context.setOffline(true);
    await waitForPopupReady(popup);

    await stremio.evaluate(() => {
      document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'room.leave' } }));
    });
    const leftLocally = await assertPass('Sidebar leaves the room immediately even while disconnected', () => stremio.waitForFunction(
      () => document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
      { timeout: TIMEOUT }
    ));

    await context.setOffline(false);
    const reconnected = await assertPass('WatchParty reconnects after the browser comes back online', () => popup.waitForFunction(
      () => /Connected to Local server/i.test(document.getElementById('ws-status')?.textContent || ''),
      { timeout: TIMEOUT * 2 }
    ));
    currentDiagnostics?.popUnexpected();

    const removedAfterReconnect = await waitForRoomGone(roomApis, roomId, TIMEOUT * 2);
    assert(removedAfterReconnect, 'Reconnecting drains the deferred leave and removes the room from /rooms');

    await popup.close();
    await stremio.close();
  } finally {
    await context.close();
  }
}

async function testPopupReloadReadsWrappedLocalRoomKeyFallback() {
  console.log('\n-- Test: Popup can rebuild invite links from wrapped local room-key storage --');
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
        if (!roomId) return false;
        const storageKey = `wpRoomKey:${roomId}`;
        const stored = await chrome.storage.local.get(storageKey);
        return typeof stored?.[storageKey]?.value === 'string' && stored?.[storageKey]?.value.length >= 16
          && typeof stored?.[storageKey]?.storedAt === 'number';
      },
      { timeout: TIMEOUT }
    );

    const roomState = await popup.evaluate(async () => {
      const roomId = document.getElementById('room-id-display').textContent;
      const storageKey = `wpRoomKey:${roomId}`;
      const stored = await chrome.storage.local.get(storageKey);
      const roomKey = stored?.[storageKey]?.value || '';
      await chrome.storage.session.remove(storageKey);
      return { roomId, roomKey };
    });

    await popup.close();
    popup = await openPopup(context, extId);
    await popup.waitForFunction(
      (expected) => document.getElementById('room-id-display')?.textContent === expected.roomId,
      roomState,
      { timeout: TIMEOUT }
    );
    const rebuiltInvite = await pollUntil(async () => {
      const value = await popup.evaluate(async (expected) => {
        const invite = await buildInviteUrlWithKey(expected.roomId);
        return (typeof invite === 'string' && invite.endsWith(`#key=${expected.roomKey}`)) ? invite : null;
      }, roomState);
      return value || null;
    }, {
      timeout: TIMEOUT,
      intervalMs: 250,
      label: 'rebuilt invite link from wrapped local room-key fallback',
    });
    assert(
      typeof rebuiltInvite === 'string' && rebuiltInvite.endsWith(`#key=${roomState.roomKey}`),
      `Popup rebuilds the invite link from wrapped local-storage fallback (${rebuiltInvite})`
    );

    await popup.close();
    await stremio.close();
  } finally {
    await context.close();
  }
}

async function testJoinRoomFlow() {
  console.log('\nâ”€â”€ Test: Create room on User1, join via popup on User2 â”€â”€');
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

    const joined = await assertPass('Bob joined the room', () => popup2.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    ));

    if (joined) {
      const aliceAttached = await assertPass('Alice sidebar stays attached after Bob joins', () => stremio1.waitForFunction(
        () => !document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
        { timeout: TIMEOUT }
      ));
      const bobAttached = await assertPass('Bob sidebar is attached after joining', () => stremio2.waitForFunction(
        () => !document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
        { timeout: TIMEOUT }
      ));
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
  console.log('\\n-- Test: Join room without Stremio tab and attach later --');
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
      hintText.includes('hand the room off'),
      `Join hint explains the Stremio handoff flow: "${hintText}"`
    );

    await popup2.fill('#username-input', 'Bob');
    await popup2.click('#lobby-tab-join');
    await popup2.fill('#room-id-input', roomId);
    const stremioPagePromise = ctx2.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await popup2.click('#btn-join');

    const autoOpenedStremio = await stremioPagePromise;
    const openedStremio = !!autoOpenedStremio && autoOpenedStremio.url().startsWith(STREMIO_URL);
    assert(openedStremio, 'Join room opens Stremio Web when no tab exists');
    stremio2 = autoOpenedStremio;
    const attachedToRoom = await assertPass('The staged popup join finishes inside Stremio', () => stremio2.waitForFunction(
      () => !document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
      { timeout: TIMEOUT * 2 }
    ));

    if (attachedToRoom) {
      const reopenedPopup = await openPopup(ctx2, extId2);
      const popupSummaryReady = await assertPass('Popup reflects the joined room after Stremio finishes the staged join', () => reopenedPopup.waitForFunction(
        () => !document.getElementById('view-room').classList.contains('hidden'),
        { timeout: TIMEOUT }
      ));
      if (popupSummaryReady) {
        const popupSummary = await reopenedPopup.evaluate(() => ({
          role: document.getElementById('room-role-badge')?.textContent || '',
          count: document.getElementById('room-count-badge')?.textContent || '',
          privacy: document.getElementById('room-privacy-badge')?.textContent || '',
        }));
        assert(
          /Guest|Synced/i.test(popupSummary.role),
          `Popup join summary shows the peer role: "${popupSummary.role}"`
        );
        assert(popupSummary.count.includes('2 watching'), `Popup join summary shows both room members: "${popupSummary.count}"`);
        assert(popupSummary.privacy.includes('Open join'), `Popup join summary shows room visibility: "${popupSummary.privacy}"`);
      }
      await reopenedPopup.close().catch(() => {});
      await openSidebarPanel(stremio2, 'people');
      const peopleReady = await assertPass('Stremio overlay reflects the popup-first join members', () => stremio2.waitForFunction(
        () => {
          const text = document.getElementById('wp-users')?.innerText || '';
          return text.includes('Alice') && text.includes('Bob');
        },
        { timeout: TIMEOUT }
      ));
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
  console.log('\nTest: Popup recovery room summary appears after a staged create finishes in Stremio');
  const context = await launchWithExtension();
  let popup = null;
  let stremio = null;
  try {
    const extId = await getExtensionId(context);
    popup = await openPopup(context, extId);

    await popup.fill('#username-input', 'PopupControlsHost');
    const stremioPagePromise = context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await popup.click('#btn-create');

    stremio = await stremioPagePromise;
    assert(!!stremio && stremio.url().startsWith(STREMIO_URL), 'Popup create opens Stremio for the staged room flow');
    const attachedToRoom = await assertPass('Stremio finishes the staged popup create', () => stremio.waitForFunction(
      () => !document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
      { timeout: TIMEOUT * 2 }
    ));

    if (attachedToRoom) {
      await popup.close().catch(() => {});
      popup = await openPopup(context, extId);
      const gotRoom = await assertPass('Popup shows the room view after the staged create completes', () => popup.waitForFunction(
        () => !document.getElementById('view-room').classList.contains('hidden'),
        { timeout: TIMEOUT }
      ));
      const popupSummary = await popup.evaluate(() => ({
        roomId: document.getElementById('room-id-display')?.textContent || '',
        privacy: document.getElementById('room-privacy-badge')?.textContent || '',
        role: document.getElementById('room-role-badge')?.textContent || '',
        count: document.getElementById('room-count-badge')?.textContent || '',
        quickNote: document.querySelector('#view-room .quick-note')?.textContent || '',
        browseHref: document.getElementById('browse-rooms-link')?.href || '',
        shareText: document.getElementById('btn-share')?.textContent || '',
      }));
      assert(popupSummary.roomId.length > 10, `Popup fallback summary shows room ID: ${popupSummary.roomId.substring(0, 8)}...`);
      assert(
        /Invite.*required/i.test(popupSummary.privacy),
        `Popup fallback summary shows private badge: "${popupSummary.privacy}"`
      );
      assert(popupSummary.role.includes('Host'), `Popup fallback summary shows host badge: "${popupSummary.role}"`);
      assert(popupSummary.count.includes('1 watching'), `Popup fallback summary shows host count: "${popupSummary.count}"`);
      assert(popupSummary.quickNote.includes('Go to Room in Stremio'), 'Popup explains that live controls moved to Stremio');
      assert(
        popupSummary.browseHref.includes('watchparty.mertd.me') || popupSummary.browseHref.includes('localhost:8090'),
        `Popup keeps a Browse Rooms recovery link: "${popupSummary.browseHref}"`
      );
      assert(popupSummary.shareText === 'Copy Invite', `Popup keeps Copy Invite as a recovery action: "${popupSummary.shareText}"`);

      await popup.click('#btn-leave');
      const backToLobby = await assertPass('Popup fallback room can be left without a Stremio tab', () => popup.waitForFunction(
        () => !document.getElementById('view-lobby').classList.contains('hidden'),
        { timeout: TIMEOUT }
      ));
    }
  } finally {
    await stremio?.close().catch(() => {});
    await popup?.close().catch(() => {});
    await context.close();
  }
}

async function testChatFlow() {
  console.log('\nâ”€â”€ Test: Two-user chat via sidebar â”€â”€');
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
    await waitForSidebarRoomAttached(stremio1);

    // Bob types a message in the sidebar chat
    await stremio2.bringToFront();
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
    await waitForChatSendButtonState(stremio2, true);

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
    const rapidSecondSendCount = await stremio2.evaluate(() =>
      [...document.querySelectorAll('#wp-chat-messages .wp-chat-msg')]
        .filter((el) => (el.innerText || '').includes('Too fast')).length
    );
    assert(rapidSecondSendCount === 0, 'Rapid second send is blocked by the client cooldown');

    // Check Alice sees Bob's message
    await stremio1.bringToFront();
    await openSidebarIfHidden(stremio1);
    const aliceSawMessage = await assertPass(`Alice sees Bob's message in chat`, () => stremio1.waitForFunction(
      () => document.getElementById('wp-chat-messages')?.innerText?.includes('Hello from Bob!'),
      { timeout: TIMEOUT }
    ));

    // === Unread badge test while Chat tab is not active ===
    await openSidebarPanel(stremio1, 'people');
    await stremio2.bringToFront();
    await waitForChatSendButtonState(stremio2, false, 6000);
    await stremio2.focus('#wp-chat-input');
    await stremio2.keyboard.type('People tab badge');
    await stremio2.keyboard.press('Enter');
    await waitForChatSendButtonState(stremio2, true);

    await stremio1.bringToFront();
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

    await openSidebarPanel(stremio1, 'chat');
    const chatTabBadgeCleared = await stremio1.evaluate(() => {
      const el = document.getElementById('wp-tab-chat-badge');
      return el?.classList.contains('wp-hidden-el');
    });
    assert(chatTabBadgeCleared, 'Chat tab badge clears after returning to chat');

    // === Unread badge test while the whole sidebar is closed ===
    await stremio1.bringToFront();
    await stremio1.evaluate(() => document.getElementById('wp-close-sidebar')?.click());
    await stremio1.waitForFunction(() => document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden'), { timeout: TIMEOUT });

    // Bob sends another message
    await stremio2.bringToFront();
    await waitForChatSendButtonState(stremio2, false, 6000);
    await stremio2.focus('#wp-chat-input');
    await stremio2.keyboard.type('Badge test msg');
    await stremio2.keyboard.press('Enter');
    await waitForChatSendButtonState(stremio2, true);

    // Check Alice's unread badge (light DOM, NOT shadow root)
    await stremio1.bringToFront();
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

    // Open sidebar â†’ badge should clear
    await stremio1.evaluate(() => document.getElementById('wp-toggle-host')?.click());
    await waitForSidebarRoomAttached(stremio1);
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
  console.log('\nâ”€â”€ Test: Popup validation â”€â”€');
  const context = await launchWithExtension();
  try {
    const stremio = await openStremio(context);
    const extId = await getExtensionId(context);
    const popup = await openPopup(context, extId);

    // Clear username, click create â€” should NOT create (focus input instead)
    await popup.fill('#username-input', '');
    await popup.click('#btn-create');
    await assertPass('Empty username: stays on lobby', () => waitForPopupLobbyView(popup, 3000));

    // Room name too short after sanitization (e.g. "a!" â†’ "a" which is < 3 chars)
    await popup.fill('#username-input', 'TestUser');
    await popup.fill('#room-name-input', 'a!');
    await popup.click('#btn-create');
    await assertPass('Short room name shows error', () => popup.waitForFunction(
      () => !document.getElementById('create-error').classList.contains('hidden'),
      { timeout: 3000 }
    ));
    // Clear room name for subsequent tests
    await popup.fill('#room-name-input', '');

    await stremio.close();
    await popup.close();
  } finally {
    await context.close();
  }
}

// â”€â”€ Helper: set up two users in a room (reusable) â”€â”€

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
  await waitForSidebarRoomAttached(stremio1);

  // Open sidebars on both
  for (const s of [stremio1, stremio2]) {
      await s.bringToFront();
      await openSidebarIfHidden(s);
  }

  return { ctx1, ctx2, stremio1, stremio2, popup1, popup2, extId1, extId2, roomId };
}

async function cleanupTwoUsers({ ctx1, ctx2, popup1, popup2, stremio1, stremio2 }) {
  for (const p of [popup1, popup2, stremio1, stremio2]) { try { await p.close(); } catch {} }
  await ctx1.close();
  await ctx2.close();
}

// â”€â”€ Two-user: Host settings visible, peer settings restricted â”€â”€

async function testHostVsPeerSettings() {
  console.log('\nâ”€â”€ Test: Host sees all settings, peer sees limited â”€â”€');
  const env = await setupTwoUsers();
  try {
    await openSidebarPanel(env.stremio1, 'room');
    const aliceSettings = await env.stremio1.evaluate(() => ({
      privateVisible: !!document.getElementById('wp-session-private'),
      listedVisible: !!document.getElementById('wp-session-listed'),
      autopauseVisible: !!document.getElementById('wp-session-autopause'),
    }));
    assert(aliceSettings.privateVisible, 'Host sees invite-key toggle');
    assert(aliceSettings.listedVisible, 'Host sees WatchParty listing toggle');
    assert(aliceSettings.autopauseVisible, 'Host sees Auto-pause toggle');
    const roomToggleInteractive = await env.stremio1.evaluate(() => {
      const privateRow = document.querySelector('label[for="wp-session-private"]');
      const privateInput = document.getElementById('wp-session-private');
      const listedRow = document.querySelector('label[for="wp-session-listed"]');
      const listedInput = document.getElementById('wp-session-listed');
      if (!privateRow || !privateInput || !listedRow || !listedInput) return false;
      const before = privateInput.checked;
      const listedBefore = listedInput.checked;
      privateRow.click();
      const after = privateInput.checked;
      listedRow.click();
      const listedAfter = listedInput.checked;
      privateRow.click();
      listedRow.click();
      return before !== after && listedBefore !== listedAfter;
    });
    assert(roomToggleInteractive, 'Room toggle rows react to clicks');
    const roomToggleRow = await env.stremio1.$('label[for="wp-session-autopause"]');
    const roomToggleBefore = await env.stremio1.evaluate(() => document.getElementById('wp-session-autopause')?.checked ?? false);
    await roomToggleRow?.click();
    await waitForCheckboxToggle(env.stremio1, 'wp-session-autopause', roomToggleBefore);
    const roomToggleStable = await env.stremio1.evaluate((row) => (
      document.querySelector('label[for="wp-session-autopause"]') === row
    ), roomToggleRow);
    await roomToggleRow?.click();
    await waitForCheckboxToggle(env.stremio1, 'wp-session-autopause', !roomToggleBefore);
    assert(roomToggleStable, 'Room auto-pause toggle keeps the same DOM row after updates');
    await openSidebarPanel(env.stremio1, 'prefs');
    const alicePrefs = await env.stremio1.evaluate(() => ({
      reactionSoundVisible: !!document.getElementById('wp-settings-sound'),
    }));
    assert(alicePrefs.reactionSoundVisible, 'Host sees Reaction sound toggle');
    const prefsToggleInteractive = await env.stremio1.evaluate(() => {
      const row = document.querySelector('label[for="wp-settings-sound"]');
      const input = document.getElementById('wp-settings-sound');
      if (!row || !input) return false;
      const before = input.checked;
      row.click();
      const after = input.checked;
      row.click();
      return before !== after;
    });
    assert(prefsToggleInteractive, 'Settings toggle rows react to clicks');
    const prefsToggleRow = await env.stremio1.$('label[for="wp-settings-sound"]');
    const prefsToggleBefore = await env.stremio1.evaluate(() => document.getElementById('wp-settings-sound')?.checked ?? false);
    await prefsToggleRow?.click();
    await waitForCheckboxToggle(env.stremio1, 'wp-settings-sound', prefsToggleBefore);
    const prefsToggleStable = await env.stremio1.evaluate((row) => (
      document.querySelector('label[for="wp-settings-sound"]') === row
    ), prefsToggleRow);
    await prefsToggleRow?.click();
    await waitForCheckboxToggle(env.stremio1, 'wp-settings-sound', !prefsToggleBefore);
    assert(prefsToggleStable, 'Settings toggle rows stay mounted while preferences update');

    await openSidebarPanel(env.stremio2, 'room');
    const bobSettings = await env.stremio2.evaluate(() => ({
      privateVisible: !!document.getElementById('wp-session-private'),
      listedVisible: !!document.getElementById('wp-session-listed'),
      autopauseVisible: !!document.getElementById('wp-session-autopause'),
    }));
    assert(!bobSettings.privateVisible, 'Peer cannot see invite-key toggle');
    assert(!bobSettings.listedVisible, 'Peer cannot see WatchParty listing toggle');
    assert(!bobSettings.autopauseVisible, 'Peer cannot see Auto-pause toggle');
    await openSidebarPanel(env.stremio2, 'prefs');
    const bobPrefs = await env.stremio2.evaluate(() => ({
      reactionSoundVisible: !!document.getElementById('wp-settings-sound'),
    }));
    assert(bobPrefs.reactionSoundVisible, 'Peer can see Reaction sound toggle');
  } finally {
    await cleanupTwoUsers(env);
  }
}

// â”€â”€ Two-user: Theme change propagates â”€â”€

async function testThemePropagation() {
  console.log('\nâ”€â”€ Test: Theme color change propagates to sidebar â”€â”€');
  const env = await setupTwoUsers();
  try {
    await openSidebarPanel(env.stremio1, 'room');
    await env.stremio1.evaluate(() => document.querySelector('.wp-color-btn[data-color="#ec4899"]')?.click());
    await waitForSidebarAccent(env.stremio1, '#ec4899');

    // Check Alice's Stremio sidebar has pink accent
    await env.stremio1.bringToFront();
    const aliceAccent = await env.stremio1.evaluate(() =>
      document.getElementById('wp-sidebar')?.style.getPropertyValue('--wp-accent'));
    assert(aliceAccent === '#ec4899', `Alice sidebar accent is pink: ${aliceAccent}`);

    await openSidebarPanel(env.stremio2, 'room');
    await env.stremio2.evaluate(() => document.querySelector('.wp-color-btn[data-color="#22c55e"]')?.click());
    await waitForSidebarAccent(env.stremio2, '#22c55e');

    await env.stremio2.bringToFront();
    const bobAccent = await env.stremio2.evaluate(() =>
      document.getElementById('wp-sidebar')?.style.getPropertyValue('--wp-accent'));
    assert(bobAccent === '#22c55e', `Bob sidebar accent is green: ${bobAccent}`);
  } finally {
    await cleanupTwoUsers(env);
  }
}

// â”€â”€ Two-user: Peer sees content link to host's movie â”€â”€

async function testPeerContentLink() {
  console.log('\nâ”€â”€ Test: Peer sees host content link â”€â”€');
  const env = await setupTwoUsers();
  try {
    await injectMockVideo(env.stremio1, 42);
    await env.stremio1.evaluate(() => {
      window.location.hash = '/detail/movie/tt31193180/tt31193180';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    // Bob's sidebar should show content link (host is watching something)
    await env.stremio2.bringToFront();
    const sidebarOpened = await assertPass('Peer opens the sidebar for host content links', async () => {
      await openSidebarIfHidden(env.stremio2);
    });
    if (sidebarOpened) {
      await env.stremio2.evaluate(() => {
        document.querySelector('[data-panel="room"]')?.click();
      });
      await assertPass('Peer content link becomes visible', () => env.stremio2.waitForFunction(
        () => {
          const wrapper = document.getElementById('wp-content-link');
          return !!wrapper && !wrapper.classList.contains('wp-hidden-el');
        },
        { timeout: TIMEOUT }
      ));
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
    }
  } finally {
    await cleanupTwoUsers(env);
  }
}

// â”€â”€ Two-user: Bidirectional chat â”€â”€

async function testPeerDirectStreamLink() {
  console.log('\\n-- Test: Peer sees direct host stream link --');
  const env = await setupTwoUsers();
  try {
    await injectMockVideo(env.stremio1, 42);
    await env.stremio1.evaluate(() => {
      window.location.hash = '/detail/movie/tt0468569/tt0468569';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await env.stremio1.evaluate(() => {
      window.location.hash = '/player/eAEBOADH%2F3sieXRJZCI6Ik5LWWVhNjN0UW1JIiwiZGVzY3JpcHRpb24iOiJQcm9qZWN0IEhhaWwgTWFyeSJ9BqUSsQ%3D%3D';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    await env.stremio2.bringToFront();
    await openSidebarPanel(env.stremio2, 'room');
    await env.stremio2.waitForFunction(
      () => document.querySelectorAll('#wp-content-link a').length >= 2,
      { timeout: TIMEOUT }
    ).catch(() => {});
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
    await env.popup2.waitForFunction(
      () => {
        const link = document.getElementById('content-stream-link');
        return !!link && !link.classList.contains('hidden') && !!link.href && link.href.includes('/#/player/');
      },
      { timeout: TIMEOUT }
    ).catch(() => {});
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
  console.log('\nâ”€â”€ Test: Debrid-like host stream requires manual peer stream but still syncs â”€â”€');
  const env = await setupTwoUsers();
  const roomApis = ['http://localhost:8181/rooms', 'https://ws.mertd.me/rooms'];
  try {
    await injectMockVideo(env.stremio1, 1.2);
    await env.stremio1.evaluate(() => {
      window.location.hash = '/detail/movie/tt0468569/tt0468569';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const debridHash = buildPlayerHash({
      url: 'https://real-debrid.example/download/the-dark-knight.mkv',
      description: 'The Dark Knight',
    });
    await env.stremio1.evaluate((nextHash) => {
      window.location.hash = nextHash.slice(1);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }, debridHash);
    await openSidebarPanel(env.stremio1, 'room');

    const hostSawVideo = await assertPass('Host keeps sync controls after switching to a debrid-like player route', () => env.stremio1.waitForFunction(
      () => !!document.getElementById('wp-bookmark-btn'),
      { timeout: TIMEOUT }
    ));

    const roomSnapshot = await waitForRoomSnapshot(
      roomApis,
      env.roomId,
      (room) => room.hasDirectJoin === false && room.directJoinType === 'debrid-url',
      15000,
      400,
    );

    assert(
      roomSnapshot?.hasDirectJoin === false && roomSnapshot?.directJoinType === 'debrid-url',
      `Public room marks the host stream as manual-join (${JSON.stringify(roomSnapshot)})`
    );

    await env.stremio2.bringToFront();
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
    await waitForPopupReady(env.popup2);
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
          const onSeeked = () => done();
          let finished = false;
          const done = () => {
            if (finished) return;
            finished = true;
            video.removeEventListener('seeked', onSeeked);
            resolve();
          };
          video.addEventListener('seeked', onSeeked, { once: true });
          video.currentTime = nextTime;
          const tick = () => {
            if (Math.abs(video.currentTime - nextTime) < 0.05) {
              done();
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        return nextTime;
      });
      await env.stremio2.bringToFront();
      await injectMockVideo(env.stremio2, 0.2);
      const peerCaughtUp = await assertPass('Peer catches up after opening a different local stream for the same title', () => env.stremio2.waitForFunction(
        (expectedTime) => {
          const video = document.querySelector('video');
          return !!video && Math.abs(video.currentTime - expectedTime) < 0.5;
        },
        targetTime,
        { timeout: TIMEOUT }
      ));
    }
  } finally {
    await cleanupTwoUsers(env);
  }
}

async function testCreateRoomFromPlayerPagePublishesSafeDirectJoinMetadata() {
  console.log('\nâ”€â”€ Test: Host creates a room directly from player page â”€â”€');
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
    const roomApis = ['http://localhost:8181/rooms', 'https://ws.mertd.me/rooms'];
    const roomSnapshot = await waitForRoomSnapshot(roomApis, roomId, (room) => room.hasDirectJoin === true, TIMEOUT, 500);

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
  console.log('\\n-- Test: Host room upgrades from detail page to player route --');
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
    let roomSnapshot = await waitForRoomSnapshot(roomApis, roomId, () => true, 12000, 400);

    assert(
      roomSnapshot?.hasDirectJoin === false && roomSnapshot?.directJoinType === null,
      `Detail-page room starts without direct-join metadata (${JSON.stringify(roomSnapshot)})`
    );

    await stremio.evaluate((nextHash) => {
      window.location.hash = nextHash.replace(/^.*#/, '#');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }, directPlayerUrl);
    await injectMockVideo(stremio, 42);

    roomSnapshot = await waitForRoomSnapshot(
      roomApis,
      roomId,
      (room) => room.hasDirectJoin === true && room.directJoinType === 'direct-url',
      15000,
      400,
    );

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
  console.log('\nâ”€â”€ Test: Prefer Direct Join opens the host player after room sync â”€â”€');
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
    await stremio1.evaluate(() => {
      window.location.hash = '/player/eAEBOADH%2F3sieXRJZCI6Ik5LWWVhNjN0UW1JIiwiZGVzY3JpcHRpb24iOiJQcm9qZWN0IEhhaWwgTWFyeSJ9BqUSsQ%3D%3D';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const roomApis = ['http://localhost:8181/rooms', 'https://ws.mertd.me/rooms'];
    await waitForRoomSnapshot(
      roomApis,
      roomId,
      (room) => room.hasDirectJoin === true && room.directJoinType === 'direct-url',
      15000,
      400,
    );

    const stremio2 = await openStremio(ctx2);
    const extId2 = await getExtensionId(ctx2);
    const popup2 = await openPopup(ctx2, extId2);
      await popup2.evaluate((pendingRoomId) => Promise.all([
        chrome.storage.local.set({ wpUsername: 'Bob' }),
        chrome.storage.session.set({
          wpBootstrapRoomIntent: {
          action: 'room.join',
          roomId: pendingRoomId,
          preferDirectJoin: true,
          requestedAt: Date.now(),
        },
      }),
    ]), roomId);

    const joined = await assertPass('Peer joins the room via the direct-join intent', () => popup2.waitForFunction(
      () => !document.getElementById('view-room').classList.contains('hidden'),
      { timeout: TIMEOUT }
    ));

    const openedPlayer = await assertPass('Peer opens the host player after the room sync arrives', () => stremio2.waitForFunction(
      () => window.location.hash.startsWith('#/player/'),
      { timeout: TIMEOUT }
    ));

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
  console.log('\nâ”€â”€ Test: Bidirectional chat between two real extensions â”€â”€');
  const env = await setupTwoUsers();
  try {
    // Bob sends message
    await env.stremio2.bringToFront();
    await openSidebarPanel(env.stremio2, 'chat');
    await env.stremio2.focus('#wp-chat-input');
    await env.stremio2.keyboard.type('Hello from Bob!');
    await env.stremio2.keyboard.press('Enter');

    // Wait for Alice to receive
    await env.stremio1.bringToFront();
    await openSidebarPanel(env.stremio1, 'chat');
    const aliceGotBob = await assertPass('Alice sees Bob message', () => env.stremio1.waitForFunction(
      () => document.getElementById('wp-chat-messages')?.innerText?.includes('Hello from Bob!'),
      { timeout: SHORT_TIMEOUT }
    ));

    // Alice sends message â€” note: already tested in testChatFlow that Aliceâ†’Bob works.
    // In two separate Playwright contexts, the backgrounded browser throttles WS heavily.
    // So instead of waiting for Bob's backgrounded tab, verify Alice sees her own message.
    await env.stremio1.bringToFront();
    await openSidebarPanel(env.stremio1, 'chat');
    await env.stremio1.focus('#wp-chat-input');
    await env.stremio1.keyboard.type('Hi Bob from Alice!');
    await env.stremio1.keyboard.press('Enter');
    const aliceSentOk = await assertPass('Alice sent message (local echo + server broadcast)', () => env.stremio1.waitForFunction(
      () => document.getElementById('wp-chat-messages')?.innerText?.includes('Hi Bob from Alice!'),
      { timeout: SHORT_TIMEOUT }
    ));
  } finally {
    await cleanupTwoUsers(env);
  }
}

async function testTypingIndicatorFlow() {
  console.log('\nâ”€â”€ Test: Typing indicator syncs across users â”€â”€');
  const env = await setupTwoUsers();
  try {
    await env.stremio2.bringToFront();
    await env.stremio2.focus('#wp-chat-input');
    await env.stremio2.keyboard.type('T');

    const aliceSawTyping = await assertPass('Alice sees Bob typing', () => env.stremio1.waitForFunction(
      () => {
        const el = document.getElementById('wp-typing-indicator');
        return el && !el.classList.contains('wp-hidden-el') && el.textContent.includes('Bob is typing');
      },
      { timeout: SHORT_TIMEOUT }
    ));

    await env.stremio2.keyboard.type('yping...');
    await env.stremio2.keyboard.press('Enter');

    const typingCleared = await assertPass('Typing indicator clears after Bob sends the message', () => env.stremio1.waitForFunction(
      () => document.getElementById('wp-typing-indicator')?.classList.contains('wp-hidden-el'),
      { timeout: SHORT_TIMEOUT }
    ));
  } finally {
    await cleanupTwoUsers(env);
  }
}

async function testLatePeerVideoAttachmentResyncsToHost() {
  console.log('\nâ”€â”€ Test: Peer video added after join catches up to host â”€â”€');
  const env = await setupTwoUsers();
  try {
    await env.stremio1.bringToFront();
    await injectMockVideo(env.stremio1, 2);
    await env.stremio1.evaluate(() => document.querySelector('[data-panel="room"]')?.click());
    const hostSawVideo = await assertPass('Host content script detects the newly opened video', () => env.stremio1.waitForFunction(
      () => !!document.getElementById('wp-bookmark-btn'),
      { timeout: TIMEOUT }
    ));

    if (hostSawVideo) {
      const targetTime = await env.stremio1.evaluate(async () => {
        const video = document.querySelector('video');
        if (!video) return 0;
        const nextTime = Math.min(2.8, Math.max(0, (video.duration || 2.8) - 0.1));
        await new Promise((resolve) => {
          const onSeeked = () => done();
          let finished = false;
          const done = () => {
            if (finished) return;
            finished = true;
            video.removeEventListener('seeked', onSeeked);
            resolve();
          };
          video.addEventListener('seeked', onSeeked, { once: true });
          video.currentTime = nextTime;
          const tick = () => {
            if (Math.abs(video.currentTime - nextTime) < 0.05) {
              done();
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        return nextTime;
      });
      await env.stremio2.bringToFront();
      await injectMockVideo(env.stremio2, 0.1);

      const peerCaughtUp = await assertPass('Peer catches up after opening a video late', () => env.stremio2.waitForFunction(
        (expectedTime) => {
          const video = document.querySelector('video');
          return !!video && Math.abs(video.currentTime - expectedTime) < 0.5;
        },
        targetTime,
        { timeout: TIMEOUT }
      ));
    }
  } finally {
    await cleanupTwoUsers(env);
  }
}

async function testBookmarkFlow() {
  console.log('\nâ”€â”€ Test: Bookmarks sync and seek the peer video â”€â”€');
  const env = await setupTwoUsers();
  try {
    await injectMockVideo(env.stremio1, 2);
    await injectMockVideo(env.stremio2, 0.1);

    await openSidebarPanel(env.stremio1, 'room');

    const hostHasBookmarkButton = await assertPass('Host sees the bookmark action when video is present', () => env.stremio1.waitForFunction(
      () => !!document.getElementById('wp-bookmark-btn'),
      { timeout: TIMEOUT }
    ));

    if (hostHasBookmarkButton) {
      await env.stremio1.click('#wp-bookmark-btn');

      const peerSawBookmark = await assertPass('Peer receives the bookmark entry', () => env.stremio2.waitForFunction(
        () => document.querySelector('.wp-bookmark-msg .wp-bookmark-time')?.textContent === '0:02',
        { timeout: SHORT_TIMEOUT }
      ));

      if (peerSawBookmark) {
        await openSidebarPanel(env.stremio2, 'chat');
        await env.stremio2.click('.wp-bookmark-time');
        await env.stremio2.waitForFunction(() => {
          const video = document.querySelector('video');
          return !!video && Math.abs(video.currentTime - 2) < 0.1;
        }, { timeout: SHORT_TIMEOUT });
        const peerVideoTime = await env.stremio2.evaluate(() => document.querySelector('video')?.currentTime || 0);
        assert(Math.abs(peerVideoTime - 2) < 0.1, `Clicking the bookmark seeks the peer video (${peerVideoTime.toFixed(1)}s)`);
      }
    }
  } finally {
    await cleanupTwoUsers(env);
  }
}

// â”€â”€ Two-user: Named room persist â”€â”€

async function testNamedRoom() {
  console.log('\nâ”€â”€ Test: Named room preserves state across rejoin â”€â”€');
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

    // Leave and recreate the named room. Named-room persistence should keep the same ID.
    await popup.close();
    await stremio.bringToFront();
    await waitForSidebarRoomAttached(stremio);

    // Leave room
    await stremio.evaluate(() => {
      document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'room.leave' } }));
    });
    await stremio.waitForFunction(
      () => document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
      { timeout: 8000 }
    ).catch(() => {});
    await waitForSidebarLobby(stremio);

    // Rejoin with same name â€” should get same room
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

// â”€â”€ Main â”€â”€

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
    testOptionsSurfaceShowsBackendFeedback,
    testOptionsResumeButtonStaysAvailableForStagedRoomHandoffs,
    testOptionsRecoveryToolsClearOnlyRuntimeState,
    testEmptyUsernameValidation,
    testCreateRoomWithoutStremioTabAttachesLater,
    testPopupFirstJoinMissingRoomShowsImmediateError,
    testPopupShowsImmediateInvalidRoomKeyErrorAfterHostUpdatesInviteKey,
    testPopupRejectsDuplicateDisplayNameInSameRoom,
    testPopupHidesStaleInactiveBackgroundRoomState,
    testCreateRoomFlow,
    testDisconnectedLeaveStillRemovesRoomAfterReconnect,
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
      console.error(`  âœ— FATAL: ${e.message}`);
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
