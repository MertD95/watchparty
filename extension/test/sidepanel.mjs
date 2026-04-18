// WatchParty - Sidepanel browser test
// Verifies that the extension sidepanel stays in sync with the live Stremio page.

import path from 'path';
import { fileURLToPath } from 'url';
import { createBrowserDiagnostics } from './browser-diagnostics.mjs';
import { getExtensionId, launchExtensionContext } from './extension-context.mjs';
import { injectSeekableTestVideo } from './seekable-video.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const STREMIO_URL = 'https://web.stremio.com';
const TIMEOUT = 15000;

let passed = 0;
let failed = 0;
let currentDiagnostics = null;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed++;
  } else {
    console.error(`  FAIL ${label}`);
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
  return launchExtensionContext(EXT_PATH, {
    viewport: { width: 1440, height: 900 },
  });
}

async function openPopup(context, extId) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'popup');
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  return page;
}

async function openSidepanel(context, extId) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'sidepanel');
  await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  return page;
}

async function openStremio(context) {
  const page = await context.newPage();
  trackPageDiagnostics(page, 'stremio');
  await page.goto(STREMIO_URL, { waitUntil: 'domcontentloaded' });
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

async function setupTwoUsers() {
  const ctx1 = await launchWithExtension();
  const ctx2 = await launchWithExtension();

  const stremio1 = await openStremio(ctx1);
  const extId1 = await getExtensionId(ctx1);
  const popup1 = await openPopup(ctx1, extId1);
  await popup1.fill('#username-input', 'Alice');
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

  await openSidebarIfHidden(stremio1);
  await openSidebarIfHidden(stremio2);

  return { ctx1, ctx2, stremio1, stremio2, popup1, popup2, extId1, extId2 };
}

async function cleanupTwoUsers(env) {
  for (const page of [env.popup1, env.popup2, env.stremio1, env.stremio2, env.sidepanel]) {
    try { await page?.close(); } catch {}
  }
  await env.ctx1.close();
  await env.ctx2.close();
}

async function testSidepanelChatAndBookmarks() {
  console.log('\n-- Sidepanel chat and bookmark flow --');
  const env = await setupTwoUsers();

  try {
    env.sidepanel = await openSidepanel(env.ctx2, env.extId2);
    const roomStateReady = await env.sidepanel.waitForFunction(
      () => !document.getElementById('chat-container')?.classList.contains('hidden') && !!document.getElementById('sp-bookmark'),
      { timeout: TIMEOUT }
    ).then(() => true).catch(() => false);
    assert(roomStateReady, 'sidepanel loads the joined room state from storage');

    if (roomStateReady) {
      const statusText = await env.sidepanel.evaluate(() => document.getElementById('status')?.innerText || '');
      assert(statusText.includes('Synced to host'), 'peer sidepanel reflects the non-host role');

      await env.sidepanel.focus('#chat-input');
      await env.sidepanel.keyboard.type('Hello from the sidepanel');
      await env.sidepanel.keyboard.press('Enter');
      await env.sidepanel.waitForTimeout(800);

      const aliceSawChat = await env.stremio1.waitForFunction(
        () => document.getElementById('wp-chat-messages')?.innerText?.includes('Hello from the sidepanel'),
        { timeout: 5000 }
      ).then(() => true).catch(() => false);
      assert(aliceSawChat, 'sidepanel chat send reaches the other user overlay');

      const sidepanelChatState = await env.sidepanel.evaluate(() => ({
        inputValue: document.getElementById('chat-input')?.value || '',
        ownCount: [...document.querySelectorAll('#chat-messages .chat-msg')]
          .filter((el) => (el.innerText || '').includes('Hello from the sidepanel')).length,
      }));
      assert(sidepanelChatState.inputValue === '', 'sidepanel chat input clears after send');
      assert(sidepanelChatState.ownCount === 1, 'sidepanel keeps a single local echo for its own chat send');

      await injectMockVideo(env.stremio2, 2);
      await env.sidepanel.click('#sp-bookmark');
      const aliceSawBobBookmark = await env.stremio1.waitForFunction(
        () => [...document.querySelectorAll('.wp-bookmark-msg')].some((el) => {
          const text = el.innerText || '';
          return text.includes('Bob') && text.includes('0:02');
        }),
        { timeout: 5000 }
      ).then(() => true).catch(() => false);
      assert(aliceSawBobBookmark, 'sidepanel bookmark send uses the peer video time and reaches the host');

      await injectMockVideo(env.stremio1, 2);
      await env.stremio1.click('#wp-bookmark-btn');
      const bobSidepanelSawBookmark = await env.sidepanel.waitForFunction(
        () => [...document.querySelectorAll('.bookmark-msg')].some((el) => (el.innerText || '').includes('Alice') && (el.innerText || '').includes('0:02')),
        { timeout: 5000 }
      ).then(() => true).catch(() => false);
      assert(bobSidepanelSawBookmark, 'sidepanel receives bookmarks created by the other user');

      if (bobSidepanelSawBookmark) {
        await env.stremio2.evaluate(() => {
          const video = document.querySelector('video');
          if (video) video.currentTime = 0.1;
        });
        await env.sidepanel.click('.bookmark-time');
        await env.sidepanel.waitForTimeout(300);
        const peerVideoTime = await env.stremio2.evaluate(() => document.querySelector('video')?.currentTime || 0);
        assert(Math.abs(peerVideoTime - 2) < 0.1, `sidepanel bookmark seek updates the page video (${peerVideoTime.toFixed(1)}s)`);
      }
    }
  } finally {
    await cleanupTwoUsers(env);
  }
}

async function main() {
  console.log('WatchParty Sidepanel Tests');
  console.log('==========================');

  try {
    const res = await fetch('http://localhost:8181/health');
    if (!res.ok) throw new Error('health failed');
  } catch {
    console.error('ERROR: WS server not running on localhost:8181');
    console.error('Start it with: cd ../watchparty-server && npm run dev');
    process.exit(1);
  }

  try {
    currentDiagnostics = createBrowserDiagnostics();
    await testSidepanelChatAndBookmarks();
  } catch (error) {
    console.error(`  FAIL ${error.message}`);
    failed++;
  } finally {
    assertCleanDiagnostics('testSidepanelChatAndBookmarks');
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
