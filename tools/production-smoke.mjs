import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const workspace = path.resolve('C:/Users/mertd/WatchParty');
const extensionPath = path.join(workspace, 'watchparty', 'extension');
const artifactsRoot = path.join(workspace, '.playwright-prod-smoke');
const primaryProfile = path.join(artifactsRoot, 'primary');
const peerProfile = path.join(artifactsRoot, 'peer');
const LIVE_LANDING = 'https://watchparty.mertd.me';
const LIVE_BACKEND = 'https://ws.mertd.me';
const STREMIO_PLAYER = 'https://web.stremio.com/#/player/eAEBOADH%2F3sieXRJZCI6Ik5LWWVhNjN0UW1JIiwiZGVzY3JpcHRpb24iOiJQcm9qZWN0IEhhaWwgTWFyeSJ9BqUSsQ%3D%3D';
const STREMIO_HOME = 'https://web.stremio.com/#/';
const IGNORE_PATTERNS = [
  /qt\\.webChannelTransport/i,
  /apple-mobile-web-app-capable/i,
  /overflow: visible/i,
  /favicon\\.ico/i,
];

function cleanDir(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function isIgnored(text) { return IGNORE_PATTERNS.some((pattern) => pattern.test(text || '')); }
function attachConsole(page, bucket, label) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (!isIgnored(text)) bucket.push(`[${label}] ${text}`);
  });
  page.on('pageerror', (error) => {
    const text = error?.message || String(error);
    if (!isIgnored(text)) bucket.push(`[${label}] ${text}`);
  });
}
async function fetchJson(url) {
  const res = await fetch(url);
  return { status: res.status, json: await res.json() };
}
async function waitFor(predicate, timeoutMs, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}
async function launchExtensionProfile(userDataDir, username) {
  cleanDir(userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });
  const consoleErrors = [];
  context.on('page', (page) => attachConsole(page, consoleErrors, 'page'));
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extensionId = worker.url().split('/')[2];
  const popup = await context.newPage();
  attachConsole(popup, consoleErrors, 'popup');
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate((value) => chrome.storage.local.set({ wpUsername: value, wpBackendMode: 'live' }), username);
  await popup.reload();
  await popup.waitForTimeout(1200);
  const stremio = await context.newPage();
  attachConsole(stremio, consoleErrors, 'stremio');
  await stremio.goto(STREMIO_HOME);
  await stremio.waitForTimeout(2000);
  return { context, popup, stremio, extensionId, consoleErrors };
}
async function launchWebProfile() {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  attachConsole(page, consoleErrors, 'web');
  return { browser, context, page, consoleErrors };
}
async function clickRoomAction(page, roomId, selector) {
  return page.evaluate(({ roomId, selector }) => {
    const card = document.querySelector(`.room-card[data-room-id="${roomId}"]`);
    if (!card) return false;
    const button = card.querySelector(selector);
    if (!button) return false;
    button.click();
    return true;
  }, { roomId, selector });
}

async function run() {
  cleanDir(artifactsRoot);
  fs.mkdirSync(artifactsRoot, { recursive: true });
  const results = { backend: null, landingWeb: null, landingExtension: null, host: null, peer: null, cleanup: null, consoleErrors: [] };
  const web = await launchWebProfile();
  const host = await launchExtensionProfile(primaryProfile, 'ProdHost');
  const peer = await launchExtensionProfile(peerProfile, 'ProdPeer');
  try {
    results.backend = {
      ready: await fetchJson(`${LIVE_BACKEND}/ready`),
      roomsBefore: await fetchJson(`${LIVE_BACKEND}/rooms`),
    };

    await web.page.goto(LIVE_LANDING);
    await web.page.waitForTimeout(1500);
    results.landingWeb = await web.page.evaluate(() => ({
      extensionDetected: document.documentElement.hasAttribute('data-watchparty-ext'),
      heroPrimary: document.getElementById('hero-primary-btn')?.textContent?.trim() || null,
      settingsVisible: !document.getElementById('hero-settings-btn')?.classList.contains('hidden'),
      summary: document.getElementById('hero-live-summary')?.textContent?.trim() || null,
    }));

    const hostLanding = await host.context.newPage();
    attachConsole(hostLanding, host.consoleErrors, 'host-landing');
    await hostLanding.goto(LIVE_LANDING);
    await hostLanding.waitForTimeout(2000);
    results.landingExtension = await hostLanding.evaluate(() => ({
      extensionDetected: document.documentElement.hasAttribute('data-watchparty-ext'),
      heroPrimary: document.getElementById('hero-primary-btn')?.textContent?.trim() || null,
      settingsVisible: !document.getElementById('hero-settings-btn')?.classList.contains('hidden'),
    }));

    await host.stremio.goto(STREMIO_PLAYER);
    await host.stremio.waitForTimeout(3500);
    const hostPreCreate = await host.popup.evaluate(() => ({
      stremioStatus: document.getElementById('stremio-status')?.textContent?.trim() || null,
      wsStatus: document.getElementById('ws-status')?.textContent?.trim() || null,
    }));
    await host.popup.fill('#username-input', 'ProdHost');
    const publicCheck = host.popup.locator('#public-check');
    if (!(await publicCheck.isChecked())) await publicCheck.check();
    await host.popup.click('#btn-create');
    await host.popup.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout: 25000 });
    const roomState = await host.popup.evaluate(async () => ({
      roomId: document.getElementById('room-id-display')?.textContent?.trim() || null,
      privacy: document.getElementById('room-privacy-badge')?.textContent?.trim() || null,
      role: document.getElementById('room-role-badge')?.textContent?.trim() || null,
      count: document.getElementById('room-count-badge')?.textContent?.trim() || null,
      wsStatus: document.getElementById('ws-status')?.textContent?.trim() || null,
    }));
    await host.stremio.waitForFunction(() => !!document.getElementById('wp-sidebar') && !(document.getElementById('wp-sidebar')?.innerText || '').includes('Not in a room'), { timeout: 25000 });
    const listedRoom = await waitFor(async () => {
      const { json } = await fetchJson(`${LIVE_BACKEND}/rooms`);
      return Array.isArray(json.rooms) ? json.rooms.find((room) => room.id === roomState.roomId) || null : null;
    }, 20000);

    const peerLanding = await peer.context.newPage();
    attachConsole(peerLanding, peer.consoleErrors, 'peer-landing');
    await peerLanding.goto(LIVE_LANDING);
    await peerLanding.waitForTimeout(2000);
    const peerLandingState = await peerLanding.evaluate(() => ({
      extensionDetected: document.documentElement.hasAttribute('data-watchparty-ext'),
      summary: document.getElementById('hero-live-summary')?.textContent?.trim() || null,
      cards: [...document.querySelectorAll('.room-card')].map((card) => ({ roomId: card.dataset.roomId || null, text: card.innerText.trim() })),
    }));
    await waitFor(async () => clickRoomAction(peerLanding, roomState.roomId, '.room-direct-btn'), 10000, 500);
    await peer.stremio.waitForFunction(() => !!document.getElementById('wp-sidebar') && !(document.getElementById('wp-sidebar')?.innerText || '').includes('Not in a room'), { timeout: 25000 });
    const peerPopup = await peer.context.newPage();
    attachConsole(peerPopup, peer.consoleErrors, 'peer-popup');
    await peerPopup.goto(`chrome-extension://${peer.extensionId}/popup.html`);
    await peerPopup.waitForTimeout(1200);
    await peerPopup.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout: 15000 });
    const peerPopupState = await peerPopup.evaluate(() => ({
      roomId: document.getElementById('room-id-display')?.textContent?.trim() || null,
      role: document.getElementById('room-role-badge')?.textContent?.trim() || null,
      count: document.getElementById('room-count-badge')?.textContent?.trim() || null,
      privacy: document.getElementById('room-privacy-badge')?.textContent?.trim() || null,
    }));

    await peer.stremio.evaluate(() => {
      const chatTab = [...document.querySelectorAll('[role=\"tab\"]')].find((el) => (el.textContent || '').trim() === 'Chat');
      chatTab?.click();
    });
    await peer.stremio.waitForTimeout(600);
    await peer.stremio.fill('#wp-chat-input', 'Production smoke hello');
    await peer.stremio.keyboard.press('Enter');
    await host.stremio.evaluate(() => {
      const chatTab = [...document.querySelectorAll('[role=\"tab\"]')].find((el) => (el.textContent || '').trim() === 'Chat');
      chatTab?.click();
    });
    await host.stremio.waitForFunction(() => (document.getElementById('wp-chat-messages')?.innerText || '').includes('Production smoke hello'), { timeout: 15000 });

    results.host = {
      preCreate: hostPreCreate,
      roomState,
      listedRoom,
      overlay: await host.stremio.evaluate(() => ({
        sidebarText: (document.getElementById('wp-sidebar')?.innerText || '').slice(0, 280),
        chatText: (document.getElementById('wp-chat-messages')?.innerText || '').slice(0, 240),
      })),
    };
    results.peer = {
      landing: peerLandingState,
      popup: peerPopupState,
      overlay: await peer.stremio.evaluate(() => ({
        url: location.href,
        sidebarText: (document.getElementById('wp-sidebar')?.innerText || '').slice(0, 280),
        chatText: (document.getElementById('wp-chat-messages')?.innerText || '').slice(0, 240),
      })),
    };

    for (const page of [peer.stremio, host.stremio]) {
      await page.evaluate(() => {
        const roomTab = [...document.querySelectorAll('[role=\"tab\"]')].find((el) => (el.textContent || '').trim() === 'Room');
        roomTab?.click();
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const leaveButton = [...document.querySelectorAll('#wp-sidebar button')].find((el) => (el.textContent || '').trim() === 'Leave Room');
        leaveButton?.click();
      });
      await page.waitForFunction(() => (document.getElementById('wp-sidebar')?.innerText || '').includes('Not in a room'), { timeout: 15000 }).catch(() => null);
    }
    const roomsAfter = await waitFor(async () => {
      const { json } = await fetchJson(`${LIVE_BACKEND}/rooms`);
      return Array.isArray(json.rooms) && !json.rooms.some((room) => room.id === roomState.roomId) ? json : null;
    }, 20000);
    results.cleanup = { roomsAfter, roomStillListed: false };
  } finally {
    results.consoleErrors = [...web.consoleErrors, ...host.consoleErrors, ...peer.consoleErrors];
    await web.context.close();
    await web.browser.close();
    await host.context.close();
    await peer.context.close();
  }
  console.log(JSON.stringify(results, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
