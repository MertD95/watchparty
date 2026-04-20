import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const API_PORT = Number(process.env.WP_LANDING_TEST_API_PORT || 8181);
const PAGE_PORT = Number(process.env.WP_LANDING_TEST_PAGE_PORT || 8096);
const LANDING_PATH = path.resolve('landing', 'index.html');

let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed++;
  } else {
    console.error(`  FAIL ${label}`);
    failed++;
  }
}

function createServers() {
  let rooms = [];
  let revision = 0;
  let queuedRoomsResponse = null;
  const sseClients = new Set();

  function snapshot(override) {
    const payload = override || { rooms, total: rooms.length, revision };
    return JSON.stringify(payload);
  }

  function broadcastRooms() {
    const data = `id: ${revision}\ndata: ${snapshot()}\n\n`;
    for (const res of [...sseClients]) {
      try {
        res.write(data);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function replaceOnce(source, search, replacement) {
    if (!source.includes(search)) {
      throw new Error(`Landing fixture transform not found: ${search}`);
    }
    return source.replace(search, replacement);
  }

  let landingHtml = fs.readFileSync(LANDING_PATH, 'utf8');
  landingHtml = replaceOnce(
    landingHtml,
    "const WS_API = IS_DEV ? 'ws://localhost:8181' : 'wss://ws.mertd.me';",
    `const WS_API = IS_DEV ? 'ws://localhost:${API_PORT}' : 'wss://ws.mertd.me';`
  );
  landingHtml = replaceOnce(
    landingHtml,
    "const ROOMS_API = IS_DEV ? 'http://localhost:8181/rooms' : 'https://ws.mertd.me/rooms';",
    `const ROOMS_API = IS_DEV ? 'http://localhost:${API_PORT}/rooms' : 'https://ws.mertd.me/rooms';`
  );
  landingHtml = replaceOnce(landingHtml, 'setInterval(loadPublicRooms, 10000);', 'setInterval(loadPublicRooms, 100);');
  landingHtml = replaceOnce(
    landingHtml,
    `setInterval(() => {
      const stale = !lastRoomsUpdateAt || (Date.now() - lastRoomsUpdateAt) > 20000;
      if (!sseActive || stale) loadPublicRooms();
    }, 15000);`,
    `setInterval(() => {
      const stale = !lastRoomsUpdateAt || (Date.now() - lastRoomsUpdateAt) > 200;
      if (!sseActive || stale) loadPublicRooms();
    }, 150);`
  );
  landingHtml = replaceOnce(landingHtml, '}, 2000);', '}, 100);');
  landingHtml = replaceOnce(landingHtml, '}, 500);', '}, 50);');

  const apiServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/rooms') {
      const body = queuedRoomsResponse ? snapshot(queuedRoomsResponse) : snapshot();
      queuedRoomsResponse = null;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/rooms/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`id: ${revision}\ndata: ${snapshot()}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const pageServer = http.createServer((req, res) => {
    if (!req.url || req.url === '/' || req.url.startsWith('/r/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(landingHtml);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return {
    async start() {
      await Promise.all([
        new Promise((resolve) => apiServer.listen(API_PORT, resolve)),
        new Promise((resolve) => pageServer.listen(PAGE_PORT, resolve)),
      ]);
    },
    setRooms(nextRooms, options = {}) {
      rooms = nextRooms;
      if (options.bumpRevision !== false) revision++;
    },
    queueRoomsResponseSnapshot(payload) {
      queuedRoomsResponse = payload;
    },
    broadcastRooms,
    getSseClientCount() {
      return sseClients.size;
    },
    dropSseConnections() {
      for (const res of [...sseClients]) {
        res.destroy();
        sseClients.delete(res);
      }
    },
    async close() {
      for (const res of [...sseClients]) {
        try {
          res.end();
        } catch {}
      }
      sseClients.clear();
      await Promise.all([
        new Promise((resolve) => apiServer.close(resolve)),
        new Promise((resolve) => pageServer.close(resolve)),
      ]);
    },
  };
}

async function main() {
  console.log('WatchParty Landing Tests');
  console.log('========================');

  const servers = createServers();
  await servers.start();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.addInitScript(() => {
    window.__joinMessages = [];
    window.__bridgeMessages = [];
    window.__navTargets = [];
    window.__alerts = [];
    window.__sseEvents = [];
    window.__watchpartyExtStatus = { hasStremioTab: true };
    window.__watchpartyCaptureNavigation = (url) => window.__navTargets.push(url);
    window.__watchpartyCaptureAlert = (message) => window.__alerts.push(message);
    const markExtensionPresent = () => document.documentElement?.setAttribute('data-watchparty-ext', '1');
    if (document.documentElement) {
      markExtensionPresent();
    } else {
      document.addEventListener('DOMContentLoaded', markExtensionPresent, { once: true });
    }
    const NativeEventSource = window.EventSource;
    window.EventSource = function (...args) {
      const source = new NativeEventSource(...args);
      source.addEventListener('open', () => window.__sseEvents.push({ type: 'open' }));
      source.addEventListener('message', (event) => window.__sseEvents.push({ type: 'message', data: event.data, lastEventId: event.lastEventId || null }));
      source.addEventListener('error', () => window.__sseEvents.push({ type: 'error' }));
      return source;
    };
    window.EventSource.prototype = NativeEventSource.prototype;
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'watchparty-join-room') {
        window.__joinMessages.push(event.data);
      }
      if ([
        'watchparty-create-room',
        'watchparty-open-stremio',
        'watchparty-resume-room',
        'watchparty-open-options',
      ].includes(event.data?.type)) {
        window.__bridgeMessages.push(event.data);
      }
      if (event.data?.type === 'watchparty-ext-request' && event.data.action === 'get-status') {
        window.postMessage({
          type: 'watchparty-ext-response',
          requestId: event.data.requestId,
          data: window.__watchpartyExtStatus,
        }, event.origin || location.origin);
      }
    });
  });

  try {
    servers.setRooms([
      {
        id: 'room-1',
        name: null,
        meta: { id: 'tt1375666', type: 'movie', name: 'Inception' },
        hasDirectJoin: true,
        directJoinType: 'direct-url',
        users: 2,
        owner: 'Alice',
        paused: false,
        time: 125,
        bookmarks: 1,
        public: true,
      },
    ]);

    await page.goto(`http://localhost:${PAGE_PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.room-card');

    const initialCard = await page.evaluate(() => ({
      cards: document.querySelectorAll('.room-card').length,
      text: document.getElementById('rooms-list')?.innerText || '',
      emptyVisible: (() => {
        const empty = document.getElementById('rooms-empty');
        return empty ? getComputedStyle(empty).display !== 'none' : false;
      })(),
    }));
    ok(initialCard.cards === 1, 'landing renders the initial public room list');
    ok(initialCard.text.includes('Inception') && initialCard.text.includes('Alice'), 'landing shows room metadata and owner');
    ok(initialCard.text.includes('2:05'), 'landing formats room playback time');
    ok(initialCard.emptyVisible === false, 'empty-state hides when rooms exist');
    const initialSummary = await page.locator('#hero-live-summary').textContent();
    ok(initialSummary === '2 people across 1 room, 1 title identified.', 'landing hero summary reflects the initial room and title counts');

    const initialButtons = await page.evaluate(() => ({
      joinText: document.querySelector('.room-card .room-join-btn')?.textContent || '',
      directText: document.querySelector('.room-card .room-direct-btn')?.textContent || '',
      directDisabled: document.querySelector('.room-card .room-direct-btn')?.disabled ?? true,
    }));
    ok(initialButtons.joinText === 'Join Room', 'landing renders a Join Room button');
    ok(initialButtons.directText === 'Direct Join' && initialButtons.directDisabled === false, 'landing renders an enabled Direct Join button when the stream is available');

    await page.fill('#profile-name-input', 'Tester');

    await page.evaluate(() => {
      window.__bridgeMessages = [];
      window.__navTargets = [];
    });
    await page.click('#hero-primary-btn');
    const createModalOpened = await page.waitForFunction(
      () => getComputedStyle(document.getElementById('create-modal')).display !== 'none',
      { timeout: 3000 }
    ).then(() => true).catch(() => false);
    ok(createModalOpened, 'landing opens the create-room modal from the hero action');
    await page.fill('#create-room-name', 'team-room');
    await page.click('#create-room-public');
    await page.click('#create-submit-btn');
    await page.waitForFunction(() => window.__bridgeMessages.length >= 2, { timeout: 3000 });
    const createAction = await page.evaluate(() => ({
      createMessage: window.__bridgeMessages.find((entry) => entry.type === 'watchparty-create-room') || null,
      openMessage: window.__bridgeMessages.find((entry) => entry.type === 'watchparty-open-stremio') || null,
      navTarget: window.__navTargets[0] || null,
    }));
    ok(createAction.createMessage?.username === 'Tester', 'Create Room carries the website display name into the extension bridge');
    ok(createAction.createMessage?.roomName === 'team-room', 'Create Room forwards the chosen room name');
    ok(createAction.createMessage?.public === true, 'Create Room forwards the selected privacy mode');
    ok(createAction.openMessage?.url === 'https://web.stremio.com', 'Create Room asks the extension background to open or focus Stremio');
    ok(createAction.navTarget == null, 'Create Room keeps the landing page in place while the extension hands off to Stremio');

    await page.evaluate(() => {
      window.__watchpartyExtStatus = {
        hasStremioTab: true,
        username: 'Tester',
        userId: 'user-1',
        room: {
          id: 'created-room',
          name: 'team-room',
          public: true,
          users: [{ id: 'user-1', name: 'Tester' }],
        },
      };
    });
    const heroRoomVisible = await page.waitForFunction(
      () => {
        const card = document.getElementById('hero-room-card');
        const title = document.getElementById('hero-room-title')?.textContent?.trim();
        const resume = document.getElementById('hero-resume-btn');
        return card
          && !card.classList.contains('hidden')
          && title === 'team-room'
          && resume
          && !resume.classList.contains('hidden');
      },
      { timeout: 4000 }
    ).then(() => true).catch(() => false);
    ok(heroRoomVisible, 'landing shows the active-room hero card after website-first room creation');

    const initialRoomNodeToken = await page.evaluate(() => {
      const card = document.querySelector('.room-card[data-room-id="room-1"]') || document.querySelector('.room-card');
      card.__nodeToken = card.__nodeToken || 'room-1-stable-node';
      return card.__nodeToken;
    });

    servers.setRooms([
      {
        id: 'room-1',
        name: null,
        meta: { id: 'tt1375666', type: 'movie', name: 'Inception' },
        hasDirectJoin: true,
        directJoinType: 'direct-url',
        users: 2,
        owner: 'Alice',
        paused: false,
        time: 130,
        bookmarks: 2,
        public: true,
      },
    ]);
    servers.broadcastRooms();

    const cardPatchedInPlace = await page.waitForFunction(
      (token) => {
        const card = document.querySelector('.room-card[data-room-id="room-1"]');
        return card?.__nodeToken === token && document.body.innerText.includes('2:10');
      },
      initialRoomNodeToken,
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    ok(cardPatchedInPlace, 'landing patches an existing room card in place when the same room updates');

    servers.setRooms([
      {
        id: 'room-1',
        name: 'custom-room-name',
        meta: { id: 'tt1375666', type: 'movie', name: 'Inception' },
        hasDirectJoin: true,
        directJoinType: 'direct-url',
        users: 2,
        owner: 'Alice',
        paused: false,
        time: 130,
        bookmarks: 2,
        public: true,
      },
    ]);
    servers.broadcastRooms();
    const customRoomNameVisible = await page.waitForFunction(
      () => document.querySelector('.room-card[data-room-id="room-1"] .room-title')?.textContent?.trim() === 'custom-room-name',
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    ok(customRoomNameVisible, 'landing room cards prefer the custom room name when it exists');

    const sseRevisionObserved = await page.waitForFunction(
      () => window.__sseEvents.some((event) => event.type === 'message' && !!event.lastEventId),
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    ok(sseRevisionObserved, 'landing receives SSE revision IDs from the server');

    await page.evaluate(() => {
      window.__joinMessages = [];
      window.__bridgeMessages = [];
      window.__navTargets = [];
      window.__alerts = [];
    });
    await page.click('.room-card .room-join-btn');
    await page.waitForFunction(() => window.__joinMessages.length > 0 && window.__bridgeMessages.some((entry) => entry.type === 'watchparty-open-stremio'), { timeout: 3000 });
    const roomJoinAction = await page.evaluate(() => ({
      joinMessage: window.__joinMessages[0] || null,
      openMessage: window.__bridgeMessages.find((entry) => entry.type === 'watchparty-open-stremio') || null,
      navTarget: window.__navTargets[0] || null,
    }));
    ok(roomJoinAction.joinMessage?.roomId === 'room-1', 'Join Room posts the room ID to the extension bridge');
    ok(roomJoinAction.joinMessage?.username === 'Tester', 'Join Room carries the website display name into the extension bridge');
    ok(roomJoinAction.joinMessage?.preferDirectJoin === false, 'Join Room keeps direct-join preference off');
    ok(roomJoinAction.openMessage?.url === 'https://web.stremio.com/#/detail/movie/tt1375666', 'Join Room asks the extension background to open or focus the Stremio title page');
    ok(roomJoinAction.navTarget == null, 'Join Room keeps the landing page in place while the extension handles the Stremio tab');

    await page.evaluate(() => {
      window.__joinMessages = [];
      window.__bridgeMessages = [];
      window.__navTargets = [];
      window.__alerts = [];
      window.__watchpartyExtStatus = { hasStremioTab: true };
    });
    await page.click('.room-card .room-direct-btn');
    await page.waitForFunction(() => window.__joinMessages.length > 0, { timeout: 3000 });
    const directJoinAction = await page.evaluate(() => ({
      joinMessage: window.__joinMessages[0] || null,
      openMessage: window.__bridgeMessages.find((entry) => entry.type === 'watchparty-open-stremio') || null,
      navTarget: window.__navTargets[0] || null,
    }));
    ok(directJoinAction.joinMessage?.roomId === 'room-1', 'Direct Join also posts the room ID to the extension bridge');
    ok(directJoinAction.joinMessage?.preferDirectJoin === true, 'Direct Join sets the prefer-direct intent for the extension');
    ok(directJoinAction.openMessage?.url === 'https://web.stremio.com', 'Direct Join asks the extension background to open or focus Stremio Web');
    ok(directJoinAction.navTarget == null, 'Direct Join keeps the landing page in place when the extension handles the Stremio tab');
    ok((await page.evaluate(() => window.__alerts.length)) === 0, 'portable Direct Join does not show a warning');

    await page.evaluate(() => {
      window.__joinMessages = [];
      window.__bridgeMessages = [];
      window.__navTargets = [];
      window.__alerts = [];
      window.__watchpartyExtStatus = { hasStremioTab: false };
    });
    await page.click('.room-card .room-direct-btn');
    await page.waitForFunction(() => window.__joinMessages.length > 0 && window.__bridgeMessages.some((entry) => entry.type === 'watchparty-open-stremio'), { timeout: 3000 });
    const directJoinNoTabAction = await page.evaluate(() => ({
      joinMessage: window.__joinMessages[0] || null,
      openMessage: window.__bridgeMessages.find((entry) => entry.type === 'watchparty-open-stremio') || null,
      navTarget: window.__navTargets[0] || null,
    }));
    ok(directJoinNoTabAction.joinMessage?.roomId === 'room-1', 'Direct Join still posts the room ID when no Stremio tab is open');
    ok(directJoinNoTabAction.joinMessage?.preferDirectJoin === true, 'Direct Join keeps the prefer-direct intent when it needs to bootstrap Stremio');
    ok(directJoinNoTabAction.openMessage?.url === 'https://web.stremio.com', 'Direct Join asks the extension background to open Stremio Web when no Stremio tab is available');
    ok(directJoinNoTabAction.navTarget == null, 'Direct Join no longer navigates the landing page directly');

    servers.setRooms([
      {
        id: 'room-title-a',
        name: null,
        meta: { id: 'tt1375666', type: 'movie', name: 'Inception' },
        hasDirectJoin: true,
        directJoinType: 'direct-url',
        users: 2,
        owner: 'Alice',
        paused: false,
        time: 140,
        bookmarks: 1,
        public: true,
      },
      {
        id: 'room-title-b',
        name: null,
        meta: { id: 'tt1375666', type: 'movie', name: 'Inception' },
        hasDirectJoin: false,
        directJoinType: null,
        users: 1,
        owner: 'Bob',
        paused: true,
        time: 12,
        bookmarks: 0,
        public: true,
      },
      {
        id: 'room-placeholder',
        name: null,
        meta: { id: 'pending', type: 'movie', name: 'WatchParty Session' },
        hasDirectJoin: false,
        directJoinType: null,
        users: 1,
        owner: 'Charlie',
        paused: true,
        time: 0,
        bookmarks: 0,
        public: true,
      },
    ]);
    servers.broadcastRooms();

    const summaryExcludesPlaceholder = await page.waitForFunction(
      () => (document.getElementById('hero-live-summary')?.textContent || '').trim() === '4 people across 3 rooms, 1 title identified.',
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    ok(summaryExcludesPlaceholder, 'landing hero summary deduplicates identical titles and ignores WatchParty Session placeholders');

    servers.setRooms([
      {
        id: 'room-debrid',
        name: null,
        meta: { id: 'tt0468569', type: 'movie', name: 'The Dark Knight' },
        hasDirectJoin: false,
        directJoinType: 'debrid-url',
        users: 2,
        owner: 'DebridHost',
        paused: false,
        time: 55,
        bookmarks: 0,
        public: true,
      },
    ]);
    servers.broadcastRooms();

    const debridReady = await page.waitForFunction(
      () => document.body.innerText.includes('DebridHost') && document.querySelector('.room-card .room-direct-btn')?.disabled === false,
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    ok(debridReady, 'landing keeps the debrid fallback button clickable');

    const debridButtonState = await page.evaluate(() => ({
      directDisabled: document.querySelector('.room-card .room-direct-btn')?.disabled ?? true,
      directTitle: document.querySelector('.room-card .room-direct-btn')?.title || '',
    }));
    ok(debridButtonState.directDisabled === false, 'debrid fallback keeps the Direct Join button enabled');
    ok(debridButtonState.directTitle.includes('choose your own stream'), 'debrid fallback explains that the peer must choose their own stream');

    await page.evaluate(() => {
      window.__joinMessages = [];
      window.__bridgeMessages = [];
      window.__navTargets = [];
      window.__alerts = [];
    });
    await page.click('.room-card .room-direct-btn');
    await page.waitForFunction(() => window.__joinMessages.length > 0 && window.__bridgeMessages.some((entry) => entry.type === 'watchparty-open-stremio') && window.__alerts.length > 0, { timeout: 3000 });
    const debridJoinAction = await page.evaluate(() => ({
      joinMessage: window.__joinMessages[0] || null,
      openMessage: window.__bridgeMessages.find((entry) => entry.type === 'watchparty-open-stremio') || null,
      navTarget: window.__navTargets[0] || null,
      alertMessage: window.__alerts[0] || null,
    }));
    ok(debridJoinAction.joinMessage?.roomId === 'room-debrid', 'debrid fallback still joins the selected room');
    ok(debridJoinAction.joinMessage?.preferDirectJoin === false, 'debrid fallback does not request direct-play intent');
    ok(debridJoinAction.openMessage?.url === 'https://web.stremio.com/#/detail/movie/tt0468569', 'debrid fallback asks the extension background to open or focus the Stremio title page');
    ok(debridJoinAction.navTarget == null, 'debrid fallback keeps the landing page in place while the extension handles the tab handoff');
    ok((debridJoinAction.alertMessage || '').includes('choose your own stream'), 'debrid fallback shows a warning before navigating');

    servers.setRooms([
      {
        id: 'room-reconnect',
        name: null,
        meta: { id: 'tt0103874', type: 'movie', name: 'Dracula' },
        hasDirectJoin: false,
        directJoinType: 'debrid-url',
        users: 0,
        owner: 'Test',
        paused: true,
        time: 3520,
        bookmarks: 0,
        public: false,
        listingState: 'reconnecting',
        graceRemainingMs: 180000,
      },
    ]);
    servers.broadcastRooms();

    const reconnectingReady = await page.waitForFunction(
      () => {
        const text = document.getElementById('rooms-list')?.innerText || '';
        return text.includes('Dracula') && text.includes('Reconnecting...');
      },
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    ok(reconnectingReady, 'landing keeps reconnecting rooms visible during disconnect grace');

    const reconnectingRoomState = await page.evaluate(() => ({
      usersText: document.querySelector('.room-card .room-users')?.textContent || '',
      reconnectingClass: document.querySelector('.room-card')?.classList.contains('room-card-reconnecting') ?? false,
      usersTitle: document.querySelector('.room-card .room-users')?.title || '',
    }));
    ok(reconnectingRoomState.usersText === 'Reconnecting...', 'landing labels reconnecting rooms explicitly');
    ok(reconnectingRoomState.reconnectingClass === true, 'landing styles reconnecting rooms differently');
    ok(/keeping this room visible/i.test(reconnectingRoomState.usersTitle), 'landing explains the reconnect grace window');
    const reconnectingLayoutOk = await page.evaluate(() => {
      const card = document.querySelector('.room-card');
      const poster = card?.querySelector('.room-poster-slot');
      const users = card?.querySelector('.room-users');
      const actions = card?.querySelector('.room-actions');
      if (!poster || !users || !actions) return false;
      const posterRect = poster.getBoundingClientRect();
      const usersRect = users.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      return usersRect.left > posterRect.right + 8 && actionsRect.left >= usersRect.right - 1;
    });
    ok(reconnectingLayoutOk, 'landing keeps reconnecting status aligned with the room content instead of under the poster');

    servers.setRooms([
      {
        id: 'room-private',
        name: null,
        meta: { id: 'tt0133093', type: 'movie', name: 'The Matrix' },
        hasDirectJoin: true,
        directJoinType: 'direct-url',
        users: 2,
        owner: 'Neo',
        paused: true,
        time: 30,
        bookmarks: 0,
        public: false,
      },
    ]);
    servers.broadcastRooms();

    const privateReady = await page.waitForFunction(
      () => {
        const text = (document.querySelector('.room-card')?.innerText || '').toLowerCase();
        return text.includes('neo') && text.includes('private') && text.includes('invite required');
      },
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    ok(privateReady, 'landing renders private rooms in the active room list with an invite-required hint');

    await page.evaluate(() => {
      window.__joinMessages = [];
      window.__bridgeMessages = [];
      window.__navTargets = [];
      window.__alerts = [];
      window.__watchpartyExtStatus = { hasStremioTab: true };
    });
    await page.click('.room-card .room-join-btn');
    const privateJoinModalReady = await page.waitForFunction(
      () => getComputedStyle(document.getElementById('uuid-modal')).display !== 'none' && window.__joinMessages.length === 0,
      { timeout: 3000 }
    ).then(() => true).catch(() => false);
    ok(privateJoinModalReady, 'private room Join Room opens the key modal before posting a join');
    await page.fill('#uuid-input', 'invite-private-room-key');
    await page.click('#uuid-submit-btn');
    await page.waitForFunction(() => window.__joinMessages.length > 0 && window.__bridgeMessages.some((entry) => entry.type === 'watchparty-open-stremio'), { timeout: 3000 });
    const privateJoinAction = await page.evaluate(() => ({
      joinMessage: window.__joinMessages[0] || null,
      openMessage: window.__bridgeMessages.find((entry) => entry.type === 'watchparty-open-stremio') || null,
      navTarget: window.__navTargets[0] || null,
    }));
    ok(privateJoinAction.joinMessage?.roomId === 'room-private', 'private room Join Room posts the listed room ID after key entry');
    ok(privateJoinAction.joinMessage?.roomKey === 'invite-private-room-key', 'private room Join Room forwards the entered room key');
    ok(privateJoinAction.openMessage?.url === 'https://web.stremio.com/#/detail/movie/tt0133093', 'private room Join Room asks the extension background to open or focus the Stremio title page');
    ok(privateJoinAction.navTarget == null, 'private room Join Room keeps the landing page in place during the handoff');

    await page.evaluate(() => {
      window.__joinMessages = [];
      window.__bridgeMessages = [];
      window.__navTargets = [];
      window.__alerts = [];
      window.__watchpartyExtStatus = { hasStremioTab: true };
    });
    await page.click('.room-card .room-direct-btn');
    const privateDirectJoinModalReady = await page.waitForFunction(
      () => getComputedStyle(document.getElementById('uuid-modal')).display !== 'none' && window.__joinMessages.length === 0,
      { timeout: 3000 }
    ).then(() => true).catch(() => false);
    ok(privateDirectJoinModalReady, 'private room Direct Join also waits for the room key');
    await page.fill('#uuid-input', `http://localhost:${PAGE_PORT}/r/room-private#key=invite-private-room-key`);
    await page.click('#uuid-submit-btn');
    await page.waitForFunction(() => window.__joinMessages.length > 0, { timeout: 3000 });
    const privateDirectJoinAction = await page.evaluate(() => ({
      joinMessage: window.__joinMessages[0] || null,
      openMessage: window.__bridgeMessages.find((entry) => entry.type === 'watchparty-open-stremio') || null,
      navTarget: window.__navTargets[0] || null,
    }));
    ok(privateDirectJoinAction.joinMessage?.roomId === 'room-private', 'private room Direct Join posts the listed room ID after key entry');
    ok(privateDirectJoinAction.joinMessage?.roomKey === 'invite-private-room-key', 'private room Direct Join forwards the entered room key');
    ok(privateDirectJoinAction.joinMessage?.preferDirectJoin === true, 'private room Direct Join keeps the direct-play preference');
    ok(privateDirectJoinAction.openMessage?.url === 'https://web.stremio.com', 'private room Direct Join asks the extension background to open or focus Stremio Web');
    ok(privateDirectJoinAction.navTarget == null, 'private room Direct Join stays on the landing page when the extension has a Stremio tab');

    const sseReady = await page.waitForFunction(
      () => window.__sseEvents.some((event) => event.type === 'message'),
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    ok(sseReady, 'landing establishes an SSE subscription');

    servers.setRooms([
      {
        id: 'room-1',
        name: null,
        meta: { id: 'tt1375666', type: 'movie', name: 'Inception' },
        hasDirectJoin: true,
        directJoinType: 'direct-url',
        users: 2,
        owner: 'Alice',
        paused: false,
        time: 125,
        bookmarks: 1,
        public: true,
      },
      {
        id: 'room-2',
        name: null,
        meta: { id: 'tt0816692', type: 'movie', name: 'Interstellar' },
        hasDirectJoin: false,
        directJoinType: null,
        users: 3,
        owner: 'Bob',
        paused: true,
        time: 300,
        bookmarks: 4,
        public: true,
      },
    ]);
    servers.broadcastRooms();

    const sseUpdated = await page.waitForFunction(
      () => document.querySelectorAll('.room-card').length === 2 && document.body.innerText.includes('Interstellar'),
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    ok(sseUpdated, 'landing updates the room list from SSE pushes');

    servers.queueRoomsResponseSnapshot({
      rooms: [
        {
          id: 'room-stale',
          name: null,
          meta: { id: 'tt9999999', type: 'movie', name: 'Stale Snapshot' },
          hasDirectJoin: false,
          directJoinType: null,
          users: 1,
          owner: 'Laggy',
          paused: true,
          time: 5,
          bookmarks: 0,
          public: true,
        },
      ],
      total: 1,
      revision: 1,
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(200);
    const staleFetchIgnored = await page.evaluate(() => {
      const text = document.getElementById('rooms-list')?.innerText || '';
      return !text.includes('Stale Snapshot') && text.includes('Interstellar');
    });
    ok(staleFetchIgnored, 'landing ignores stale /rooms snapshots that arrive after a newer SSE update');

    servers.setRooms([
      {
        id: 'room-3',
        name: null,
        meta: { id: 'tt0110912', type: 'movie', name: 'Pulp Fiction' },
        hasDirectJoin: false,
        directJoinType: null,
        users: 4,
        owner: 'Carol',
        paused: false,
        time: 42,
        bookmarks: 0,
        public: true,
      },
    ]);
    servers.dropSseConnections();

    const fallbackUpdated = await page.waitForFunction(
      () => document.querySelectorAll('.room-card').length === 1 && document.body.innerText.includes('Pulp Fiction'),
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    ok(fallbackUpdated, 'landing falls back to polling after the SSE stream drops');

    await page.goto(`http://localhost:${PAGE_PORT}/r/test-room-123#key=redirect-room-key-1234`, { waitUntil: 'domcontentloaded' });

    const joinMessageObserved = await page.waitForFunction(() => window.__joinMessages.length > 0, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    ok(joinMessageObserved, 'redirect page posts the join-room message immediately');

    const joinMessage = await page.evaluate(() => window.__joinMessages[0] || null);
    ok(joinMessage?.roomId === 'test-room-123', 'redirect page posts the correct room ID');
    ok(joinMessage?.roomKey === 'redirect-room-key-1234', 'redirect page forwards the invite room key to the extension bridge');

    const noExtensionWarning = await page.waitForFunction(
      () => getComputedStyle(document.getElementById('no-ext-warning')).display !== 'none',
      { timeout: 3000 }
    ).then(() => true).catch(() => false);
    ok(noExtensionWarning, 'redirect page shows the missing-extension warning when no extension responds');
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await servers.close().catch(() => {});
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
