import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtensionContext } from './extension-context.mjs';

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

async function waitForRoomByOwner(username, predicate = () => true, timeout = 15000) {
  const started = Date.now();
  while ((Date.now() - started) < timeout) {
    const data = await fetchPublicRooms();
    const room = data?.rooms?.find((entry) => entry.owner === username && predicate(entry)) || null;
    if (room) return room;
    await sleep(800);
  }
  return null;
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

async function createRoomViaWebsite(page, { username, roomName, isPublic }) {
  const hasWebsiteFirstUi = await page.evaluate(() => ({
    hasProfile: !!document.getElementById('profile-name-input'),
    hasCreateButton: !!document.getElementById('hero-primary-btn'),
    hasCreateModal: !!document.getElementById('create-modal'),
  }));

  if (!hasWebsiteFirstUi.hasProfile || !hasWebsiteFirstUi.hasCreateButton || !hasWebsiteFirstUi.hasCreateModal) {
    throw new Error(
      'Live landing page is still serving the legacy UI. Missing website-first controls: '
      + JSON.stringify(hasWebsiteFirstUi)
    );
  }

  await page.fill('#profile-name-input', username);
  await page.click('#hero-primary-btn');
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('create-modal')).display !== 'none',
    { timeout: TIMEOUT }
  );

  await page.fill('#create-room-name', roomName);
  const currentlyPublic = await page.isChecked('#create-room-public');
  if (currentlyPublic !== isPublic) await page.click('#create-room-public');

  await page.click('#create-submit-btn');
  const reachedStremio = await page.waitForFunction(
    () => location.origin === 'https://web.stremio.com' && document.getElementById('wp-overlay') !== null,
    { timeout: TIMEOUT }
  ).then(() => true).catch(() => false);

  return { reachedStremio };
}

async function waitForRoomAttached(page, timeout = TIMEOUT) {
  return page.waitForFunction(
    () => {
      const sidebar = document.getElementById('wp-sidebar');
      return !!sidebar && !sidebar.innerText.includes('Not in a room');
    },
    { timeout }
  ).then(() => true).catch(() => false);
}

async function leaveRoomViaOverlay(page) {
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'leave-room' } }));
  });
  await page.waitForFunction(
    () => document.getElementById('wp-sidebar')?.innerText?.includes('Not in a room'),
    { timeout: TIMEOUT }
  ).catch(() => {});
  await page.waitForTimeout(1200);
}

async function withLiveExtension(runScenario) {
  const context = await launchExtensionContext(EXT_PATH, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    backendMode: 'live',
  });
  try {
    await runScenario({ context });
  } finally {
    await context.close();
  }
}

async function testPublicDetailRoomAppearsWithReadableTitle() {
  console.log('\n-- Live Smoke: public detail room --');
  await withLiveExtension(async ({ context }) => {
    const suffix = Date.now().toString().slice(-6);
    const username = `Detail${suffix}`;
    const roomName = `detail-${suffix}`;
    const stremio = await openStremioAt(context, DETAIL_URL);
    const site = await openSite(context);
    const lobby = await openSite(context);
    try {
      const created = await createRoomViaWebsite(lobby, { username, roomName, isPublic: true });
      assert(created.reachedStremio, 'website create hands off to Stremio');
      const attached = await waitForRoomAttached(stremio);
      assert(attached, 'existing detail page attaches the room after website create');

      const apiRoom = await waitForRoomByOwner(username);
      assert(!!apiRoom, 'detail room appears in live /rooms', username);
      assert(apiRoom?.meta?.name === 'The Dark Knight', 'detail room publishes readable title', JSON.stringify(apiRoom));

      const siteSeen = await waitForSiteUser(site, username);
      assert(siteSeen, 'detail room appears on live website without refresh', username);

      const cards = await getSiteCards(site);
      const card = cards.find((entry) => entry.text.includes(username)) || null;
      assert(!!card, 'detail room card exists on website', JSON.stringify(cards));
      assert(card?.text.includes('The Dark Knight'), 'detail room card shows readable title', JSON.stringify(card));
      assert(card?.directDisabled === true, 'detail room keeps Direct Join disabled before player playback', JSON.stringify(card));

      await leaveRoomViaOverlay(stremio);
      const removedFromApi = await waitForRoomGoneInApi(apiRoom?.id);
      assert(removedFromApi, 'detail room disappears from live /rooms after leave', apiRoom?.id);
      const removedFromSite = await waitForSiteUserGone(site, username);
      assert(removedFromSite, 'detail room disappears from website without refresh', username);
    } finally {
      await Promise.allSettled([lobby.close(), stremio.close(), site.close()]);
    }
  });
}

async function testPublicPlayerRoomAppearsWithDirectJoinEnabled() {
  console.log('\n-- Live Smoke: public player room --');
  await withLiveExtension(async ({ context }) => {
    const suffix = Date.now().toString().slice(-6);
    const username = `Player${suffix}`;
    const roomName = `player-${suffix}`;
    const stremio = await openStremioAt(context, PLAYER_URL);
    const site = await openSite(context);
    const lobby = await openSite(context);
    try {
      const created = await createRoomViaWebsite(lobby, { username, roomName, isPublic: true });
      assert(created.reachedStremio, 'website create hands off to Stremio from the player page');
      const attached = await waitForRoomAttached(stremio);
      assert(attached, 'existing player page attaches the room after website create');

      const apiRoom = await waitForRoomByOwner(username);
      assert(!!apiRoom, 'player room appears in live /rooms', username);
      assert(apiRoom?.hasDirectJoin === true, 'player room advertises Direct Join', JSON.stringify(apiRoom));
      assert(apiRoom?.directJoinType === 'direct-url', 'player room exposes direct-url classification', JSON.stringify(apiRoom));

      const siteSeen = await waitForSiteUser(site, username);
      assert(siteSeen, 'player room appears on live website without refresh', username);

      const cards = await getSiteCards(site);
      const card = cards.find((entry) => entry.text.includes(username)) || null;
      assert(!!card, 'player room card exists on website', JSON.stringify(cards));
      assert(card?.directDisabled === false, 'player room enables Direct Join on website', JSON.stringify(card));

      await leaveRoomViaOverlay(stremio);
      const removedFromApi = await waitForRoomGoneInApi(apiRoom?.id);
      assert(removedFromApi, 'player room disappears from live /rooms after leave', apiRoom?.id);
      const removedFromSite = await waitForSiteUserGone(site, username);
      assert(removedFromSite, 'player room disappears from website without refresh', username);
    } finally {
      await Promise.allSettled([lobby.close(), stremio.close(), site.close()]);
    }
  });
}

async function testPrivateRoomAppearsOnWebsite() {
  console.log('\n-- Live Smoke: private room listed --');
  await withLiveExtension(async ({ context }) => {
    const suffix = Date.now().toString().slice(-6);
    const username = `Private${suffix}`;
    const roomName = `private-${suffix}`;
    const stremio = await openStremioAt(context, DETAIL_URL);
    const site = await openSite(context);
    const lobby = await openSite(context);
    try {
      const created = await createRoomViaWebsite(lobby, { username, roomName, isPublic: false });
      assert(created.reachedStremio, 'private website create hands off to Stremio');
      const attached = await waitForRoomAttached(stremio);
      assert(attached, 'existing detail page attaches the private room after website create');

      const apiRoom = await waitForRoomByOwner(username);
      assert(!!apiRoom, 'private room appears in live /rooms', username);
      assert(apiRoom?.public === false, 'private room keeps its private flag in /rooms', JSON.stringify(apiRoom));

      const siteSeen = await waitForSiteUser(site, username);
      assert(siteSeen, 'private room appears on website without refresh', username);

      const siteCards = await getSiteCards(site);
      const card = siteCards.find((entry) => entry.text.includes(username)) || null;
      assert(!!card, 'private room card exists on website', JSON.stringify(siteCards));
      assert(card?.text.includes('Private'), 'private room card shows the private badge', JSON.stringify(card));

      await leaveRoomViaOverlay(stremio);
      const removedFromApi = await waitForRoomGoneInApi(apiRoom?.id);
      assert(removedFromApi, 'private room disappears from /rooms after leave', apiRoom?.id);
      const removedFromSite = await waitForSiteUserGone(site, username);
      assert(removedFromSite, 'private room disappears from website without refresh', username);
    } finally {
      await Promise.allSettled([lobby.close(), stremio.close(), site.close()]);
    }
  });
}

async function testLatePageLoadStillSeesRoom() {
  console.log('\n-- Live Smoke: late page load --');
  await withLiveExtension(async ({ context }) => {
    const suffix = Date.now().toString().slice(-6);
    const username = `Late${suffix}`;
    const roomName = `late-${suffix}`;
    const stremio = await openStremioAt(context, DETAIL_URL);
    const lobby = await openSite(context);
    try {
      const created = await createRoomViaWebsite(lobby, { username, roomName, isPublic: true });
      assert(created.reachedStremio, 'late-load website create hands off to Stremio');
      const attached = await waitForRoomAttached(stremio);
      assert(attached, 'late-load detail page attaches the room after website create');

      const apiRoom = await waitForRoomByOwner(username);
      assert(!!apiRoom, 'late-load room appears in live /rooms before site opens', username);

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

      await leaveRoomViaOverlay(stremio);
      const removedFromApi = await waitForRoomGoneInApi(apiRoom?.id);
      assert(removedFromApi, 'late-load room disappears from /rooms after leave', apiRoom?.id);
    } finally {
      await Promise.allSettled([lobby.close(), stremio.close()]);
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
