import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExtensionId, launchExtensionContext } from './extension-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const SITE_URL = 'https://watchparty.mertd.me';
const ROOMS_API = 'https://ws.mertd.me/rooms';
const DETAIL_URL = 'https://web.stremio.com/#/detail/movie/tt0468569';
const PLAYER_URL = 'https://web.stremio.com/#/player/eAEBOADH%2F3sieXRJZCI6Ik5LWWVhNjN0UW1JIiwiZGVzY3JpcHRpb24iOiJQcm9qZWN0IEhhaWwgTWFyeSJ9BqUSsQ%3D%3D';
const TIMEOUT = 25000;

let passed = 0;
let failed = 0;

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed++;
    return;
  }
  const suffix = detail ? ` :: ${detail}` : '';
  console.error(`  FAIL ${label}${suffix}`);
  failed++;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openPopup(context, extId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  return page;
}

async function openStremioAt(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('wp-overlay') !== null, { timeout: TIMEOUT });
  await page.waitForTimeout(1500);
  return page;
}

async function openSite(context) {
  const page = await context.newPage();
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('rooms-list') !== null, { timeout: TIMEOUT });
  await page.waitForTimeout(1200);
  return page;
}

async function setLiveBackend(popup) {
  await popup.click('#backend-live');
  await popup.waitForFunction(() => {
    const wsText = document.getElementById('ws-status')?.textContent || '';
    return wsText.includes('Live');
  }, { timeout: TIMEOUT });
}

async function fetchPublicRooms() {
  try {
    const response = await fetch(ROOMS_API, {
      headers: { 'cache-control': 'no-cache' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data?.rooms) ? data : null;
  } catch {
    return null;
  }
}

async function waitForRoomInApi(roomId, timeout = 15000) {
  const started = Date.now();
  while ((Date.now() - started) < timeout) {
    const data = await fetchPublicRooms();
    const room = data?.rooms?.find((entry) => entry.id === roomId) || null;
    if (room) return room;
    await sleep(800);
  }
  return null;
}

async function waitForRoomGoneInApi(roomId, timeout = 15000) {
  const started = Date.now();
  while ((Date.now() - started) < timeout) {
    const data = await fetchPublicRooms();
    if (data && !data.rooms.some((entry) => entry.id === roomId)) return true;
    await sleep(800);
  }
  return false;
}

async function waitForSiteUser(page, username, timeout = 15000) {
  return page.waitForFunction(
    (expected) => (document.getElementById('rooms-list')?.innerText || '').includes(expected),
    username,
    { timeout }
  ).then(() => true).catch(() => false);
}

async function waitForSiteUserGone(page, username, timeout = 15000) {
  return page.waitForFunction(
    (expected) => !(document.getElementById('rooms-list')?.innerText || '').includes(expected),
    username,
    { timeout }
  ).then(() => true).catch(() => false);
}

async function getSiteCards(page) {
  return page.evaluate(() => [...document.querySelectorAll('.room-card')].map((card) => ({
    text: card.innerText,
    directDisabled: card.querySelector('.room-direct-btn')?.disabled ?? null,
    directTitle: card.querySelector('.room-direct-btn')?.title || '',
  })));
}

async function createRoomViaPopup(popup, { username, roomName, isPublic }) {
  await popup.fill('#username-input', username);
  await popup.fill('#room-name-input', roomName);
  const currentlyPublic = await popup.isChecked('#public-check');
  if (currentlyPublic !== isPublic) await popup.click('#public-check');
  await popup.click('#btn-create');
  const roomVisible = await popup.waitForFunction(
    () => !document.getElementById('view-room').classList.contains('hidden'),
    { timeout: TIMEOUT }
  ).then(() => true).catch(() => false);
  await popup.waitForTimeout(1000);
  return {
    roomVisible,
    roomId: await popup.locator('#room-id-display').innerText().catch(() => ''),
    roomMeta: await popup.locator('#room-meta').innerText().catch(() => ''),
    wsStatus: await popup.locator('#ws-status').innerText().catch(() => ''),
  };
}

async function leaveRoomViaPopup(popup) {
  await popup.click('#btn-leave').catch(() => {});
  await popup.waitForTimeout(1200);
}

async function withLiveExtension(runScenario) {
  const context = await launchExtensionContext(EXT_PATH, {
    headless: true,
    viewport: { width: 1440, height: 900 },
  });
  try {
    const extId = await getExtensionId(context);
    await runScenario({ context, extId });
  } finally {
    await context.close();
  }
}

async function testPublicDetailRoomAppearsWithReadableTitle() {
  console.log('\n-- Live Smoke: public detail room --');
  await withLiveExtension(async ({ context, extId }) => {
    const suffix = Date.now().toString().slice(-6);
    const username = `Detail${suffix}`;
    const roomName = `detail-${suffix}`;
    const site = await openSite(context);
    const stremio = await openStremioAt(context, DETAIL_URL);
    const popup = await openPopup(context, extId);
    try {
      await setLiveBackend(popup);
      const created = await createRoomViaPopup(popup, { username, roomName, isPublic: true });
      assert(created.roomVisible, 'detail create reaches room view', JSON.stringify(created));
      assert(created.wsStatus.includes('Live'), 'detail create uses live backend', created.wsStatus);
      assert(created.roomMeta === 'The Dark Knight', 'detail create seeds popup title', created.roomMeta);

      const apiRoom = await waitForRoomInApi(created.roomId);
      assert(!!apiRoom, 'detail room appears in live /rooms', created.roomId);
      assert(apiRoom?.meta?.name === 'The Dark Knight', 'detail room publishes readable title', JSON.stringify(apiRoom));

      const siteSeen = await waitForSiteUser(site, username);
      assert(siteSeen, 'detail room appears on live website without refresh', username);

      const cards = await getSiteCards(site);
      const card = cards.find((entry) => entry.text.includes(username)) || null;
      assert(!!card, 'detail room card exists on website', JSON.stringify(cards));
      assert(card?.text.includes('The Dark Knight'), 'detail room card shows readable title', JSON.stringify(card));
      assert(card?.directDisabled === true, 'detail room keeps Direct Join disabled before player playback', JSON.stringify(card));

      await leaveRoomViaPopup(popup);
      const removedFromApi = await waitForRoomGoneInApi(created.roomId);
      assert(removedFromApi, 'detail room disappears from live /rooms after leave', created.roomId);
      const removedFromSite = await waitForSiteUserGone(site, username);
      assert(removedFromSite, 'detail room disappears from website without refresh', username);
    } finally {
      await Promise.allSettled([popup.close(), stremio.close(), site.close()]);
    }
  });
}

async function testPublicPlayerRoomAppearsWithDirectJoinEnabled() {
  console.log('\n-- Live Smoke: public player room --');
  await withLiveExtension(async ({ context, extId }) => {
    const suffix = Date.now().toString().slice(-6);
    const username = `Player${suffix}`;
    const roomName = `player-${suffix}`;
    const site = await openSite(context);
    const stremio = await openStremioAt(context, PLAYER_URL);
    const popup = await openPopup(context, extId);
    try {
      await setLiveBackend(popup);
      const created = await createRoomViaPopup(popup, { username, roomName, isPublic: true });
      assert(created.roomVisible, 'player create reaches room view', JSON.stringify(created));
      assert(created.wsStatus.includes('Live'), 'player create uses live backend', created.wsStatus);

      const apiRoom = await waitForRoomInApi(created.roomId);
      assert(!!apiRoom, 'player room appears in live /rooms', created.roomId);
      assert(apiRoom?.hasDirectJoin === true, 'player room advertises Direct Join', JSON.stringify(apiRoom));
      assert(apiRoom?.directJoinType === 'direct-url', 'player room exposes direct-url classification', JSON.stringify(apiRoom));

      const siteSeen = await waitForSiteUser(site, username);
      assert(siteSeen, 'player room appears on live website without refresh', username);

      const cards = await getSiteCards(site);
      const card = cards.find((entry) => entry.text.includes(username)) || null;
      assert(!!card, 'player room card exists on website', JSON.stringify(cards));
      assert(card?.directDisabled === false, 'player room enables Direct Join on website', JSON.stringify(card));

      await leaveRoomViaPopup(popup);
      const removedFromApi = await waitForRoomGoneInApi(created.roomId);
      assert(removedFromApi, 'player room disappears from live /rooms after leave', created.roomId);
      const removedFromSite = await waitForSiteUserGone(site, username);
      assert(removedFromSite, 'player room disappears from website without refresh', username);
    } finally {
      await Promise.allSettled([popup.close(), stremio.close(), site.close()]);
    }
  });
}

async function testPrivateRoomAppearsOnWebsite() {
  console.log('\n-- Live Smoke: private room listed --');
  await withLiveExtension(async ({ context, extId }) => {
    const suffix = Date.now().toString().slice(-6);
    const username = `Private${suffix}`;
    const roomName = `private-${suffix}`;
    const site = await openSite(context);
    const stremio = await openStremioAt(context, DETAIL_URL);
    const popup = await openPopup(context, extId);
    try {
      await setLiveBackend(popup);
      const created = await createRoomViaPopup(popup, { username, roomName, isPublic: false });
      assert(created.roomVisible, 'private create reaches room view', JSON.stringify(created));

      const apiRoom = await waitForRoomInApi(created.roomId);
      assert(!!apiRoom, 'private room appears in live /rooms', created.roomId);
      assert(apiRoom?.public === false, 'private room keeps its private flag in /rooms', JSON.stringify(apiRoom));

      const siteSeen = await waitForSiteUser(site, username);
      assert(siteSeen, 'private room appears on website without refresh', username);

      const siteCards = await getSiteCards(site);
      const card = siteCards.find((entry) => entry.text.includes(username)) || null;
      assert(!!card, 'private room card exists on website', JSON.stringify(siteCards));
      assert(card?.text.includes('Private'), 'private room card shows the private badge', JSON.stringify(card));

      await leaveRoomViaPopup(popup);
      const removedFromApi = await waitForRoomGoneInApi(created.roomId);
      assert(removedFromApi, 'private room disappears from /rooms after leave', created.roomId);
      const removedFromSite = await waitForSiteUserGone(site, username);
      assert(removedFromSite, 'private room disappears from website without refresh', username);
    } finally {
      await Promise.allSettled([popup.close(), stremio.close(), site.close()]);
    }
  });
}

async function testLatePageLoadStillSeesRoom() {
  console.log('\n-- Live Smoke: late page load --');
  await withLiveExtension(async ({ context, extId }) => {
    const suffix = Date.now().toString().slice(-6);
    const username = `Late${suffix}`;
    const roomName = `late-${suffix}`;
    const stremio = await openStremioAt(context, DETAIL_URL);
    const popup = await openPopup(context, extId);
    try {
      await setLiveBackend(popup);
      const created = await createRoomViaPopup(popup, { username, roomName, isPublic: true });
      assert(created.roomVisible, 'late-load create reaches room view', JSON.stringify(created));

      const apiRoom = await waitForRoomInApi(created.roomId);
      assert(!!apiRoom, 'late-load room appears in live /rooms before site opens', created.roomId);

      const site = await openSite(context);
      try {
        const seen = await waitForSiteUser(site, username);
        assert(seen, 'late-opened website sees existing room immediately', username);
        const cards = await getSiteCards(site);
        const card = cards.find((entry) => entry.text.includes(username)) || null;
        assert(card?.text.includes('The Dark Knight'), 'late-opened website shows readable title', JSON.stringify(card));
      } finally {
        await site.close();
      }

      await leaveRoomViaPopup(popup);
      const removedFromApi = await waitForRoomGoneInApi(created.roomId);
      assert(removedFromApi, 'late-load room disappears from /rooms after leave', created.roomId);
    } finally {
      await Promise.allSettled([popup.close(), stremio.close()]);
    }
  });
}

async function main() {
  console.log('WatchParty Live Landing Smoke');
  console.log('=============================');
  console.log(`Site: ${SITE_URL}`);
  console.log(`Rooms API: ${ROOMS_API}`);

  const tests = [
    testPublicDetailRoomAppearsWithReadableTitle,
    testPublicPlayerRoomAppearsWithDirectJoinEnabled,
    testPrivateRoomAppearsOnWebsite,
    testLatePageLoadStillSeesRoom,
  ];

  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      console.error(`  FAIL ${test.name}: ${error.message}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
