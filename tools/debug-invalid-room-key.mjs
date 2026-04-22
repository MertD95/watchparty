import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const workspace = path.resolve('C:/Users/mertd/WatchParty');
const extensionPath = path.join(workspace, 'watchparty', 'extension');
const root = path.join(workspace, '.tmp-invalid-room-key-debug');
const hostProfile = path.join(root, 'host');
const peerProfile = path.join(root, 'peer');

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function launch(profile, username) {
  clean(profile);
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = worker.url().split('/')[2];
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.evaluate((value) => chrome.storage.local.set({ wpBackendMode: 'local', wpUsername: value }), username);
  await popup.reload();
  await popup.waitForTimeout(1200);
  const stremio = await context.newPage();
  await stremio.goto('https://web.stremio.com/#/');
  await stremio.waitForTimeout(2500);
  return { context, popup, stremio };
}

async function main() {
  clean(root);
  fs.mkdirSync(root, { recursive: true });
  const host = await launch(hostProfile, 'HostKeyOwner');
  const peer = await launch(peerProfile, 'PeerKeyJoiner');

  try {
    await peer.popup.evaluate(() => {
      window.__msgs = [];
      chrome.runtime.onMessage.addListener((message) => {
        window.__msgs.push({
          type: message.type,
          action: message.action,
          payload: message.payload || null,
        });
      });
    });

    await host.popup.fill('#username-input', 'HostKeyOwner');
    await host.popup.click('#btn-create');
    await host.popup.waitForFunction(() => !document.getElementById('view-room').classList.contains('hidden'), { timeout: 25000 });
    const room = await host.popup.evaluate(async () => {
      const roomId = document.getElementById('room-id-display').textContent.trim();
      const key = `wpRoomKey:${roomId}`;
      const local = await chrome.storage.local.get(key);
      const session = await chrome.storage.session.get(key);
      return {
        roomId,
        roomKey: session[key] || local[key]?.value || null,
      };
    });

    await host.stremio.evaluate(() => {
      const roomTab = [...document.querySelectorAll('[role="tab"]')].find((el) => (el.textContent || '').trim() === 'Room');
      roomTab?.click();
    });
    await host.stremio.waitForTimeout(700);
    await host.stremio.evaluate(() => {
      const input = document.getElementById('wp-room-key-input');
      input.value = 'UpdatedRoomKey-12345';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('wp-room-key-save')?.click();
    });
    await host.stremio.waitForTimeout(1500);
    const newKey = await host.popup.evaluate(async () => {
      const roomId = document.getElementById('room-id-display').textContent.trim();
      const key = `wpRoomKey:${roomId}`;
      const local = await chrome.storage.local.get(key);
      const session = await chrome.storage.session.get(key);
      return session[key] || local[key]?.value || null;
    });

    await peer.popup.fill('#username-input', 'PeerKeyJoiner');
    await peer.popup.click('#lobby-tab-join');
    await peer.popup.fill('#room-id-input', `${room.roomId}#key=${room.roomKey}`);
    await peer.popup.click('#btn-join');
    await peer.popup.waitForTimeout(6000);

    const state = await peer.popup.evaluate(() => ({
      joinErrorHidden: document.getElementById('join-error').classList.contains('hidden'),
      joinError: document.getElementById('join-error').textContent,
      roomHidden: document.getElementById('view-room').classList.contains('hidden'),
      lobbyHidden: document.getElementById('view-lobby').classList.contains('hidden'),
      msgs: window.__msgs,
    }));

    console.log(JSON.stringify({ room, newKey, state }, null, 2));
  } finally {
    await peer.context.close();
    await host.context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
