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
  const sseClients = new Set();

  function snapshot() {
    return JSON.stringify({ rooms, total: rooms.length });
  }

  function broadcastRooms() {
    const data = `data: ${snapshot()}\n\n`;
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
    "setInterval(() => { if (!sseActive) loadPublicRooms(); }, 15000);",
    "setInterval(() => { if (!sseActive) loadPublicRooms(); }, 150);"
  );
  landingHtml = replaceOnce(landingHtml, '}, 2000);', '}, 100);');
  landingHtml = replaceOnce(landingHtml, '}, 500);', '}, 50);');

  const apiServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/rooms') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(snapshot());
      return;
    }

    if (url.pathname === '/rooms/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${snapshot()}\n\n`);
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
    setRooms(nextRooms) {
      rooms = nextRooms;
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
    window.__navTargets = [];
    window.__sseEvents = [];
    window.__watchpartyCaptureNavigation = (url) => window.__navTargets.push(url);
    const NativeEventSource = window.EventSource;
    window.EventSource = function (...args) {
      const source = new NativeEventSource(...args);
      source.addEventListener('open', () => window.__sseEvents.push({ type: 'open' }));
      source.addEventListener('message', (event) => window.__sseEvents.push({ type: 'message', data: event.data }));
      source.addEventListener('error', () => window.__sseEvents.push({ type: 'error' }));
      return source;
    };
    window.EventSource.prototype = NativeEventSource.prototype;
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'watchparty-join-room') {
        window.__joinMessages.push(event.data);
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

    const initialButtons = await page.evaluate(() => ({
      joinText: document.querySelector('.room-card .room-join-btn')?.textContent || '',
      directText: document.querySelector('.room-card .room-direct-btn')?.textContent || '',
      directDisabled: document.querySelector('.room-card .room-direct-btn')?.disabled ?? true,
    }));
    ok(initialButtons.joinText === 'Join Room', 'landing renders a Join Room button');
    ok(initialButtons.directText === 'Direct Join' && initialButtons.directDisabled === false, 'landing renders an enabled Direct Join button when the stream is available');

    await page.evaluate(() => {
      window.__joinMessages = [];
      window.__navTargets = [];
    });
    await page.click('.room-card .room-join-btn');
    await page.waitForFunction(() => window.__joinMessages.length > 0 && window.__navTargets.length > 0, { timeout: 3000 });
    const roomJoinAction = await page.evaluate(() => ({
      joinMessage: window.__joinMessages[0] || null,
      navTarget: window.__navTargets[0] || null,
    }));
    ok(roomJoinAction.joinMessage?.roomId === 'room-1', 'Join Room posts the room ID to the extension bridge');
    ok(roomJoinAction.joinMessage?.preferDirectJoin === false, 'Join Room keeps direct-join preference off');
    ok(roomJoinAction.navTarget === 'https://web.stremio.com/#/detail/movie/tt1375666', 'Join Room navigates to the Stremio title page');

    await page.evaluate(() => {
      window.__joinMessages = [];
      window.__navTargets = [];
    });
    await page.click('.room-card .room-direct-btn');
    await page.waitForFunction(() => window.__joinMessages.length > 0 && window.__navTargets.length > 0, { timeout: 3000 });
    const directJoinAction = await page.evaluate(() => ({
      joinMessage: window.__joinMessages[0] || null,
      navTarget: window.__navTargets[0] || null,
    }));
    ok(directJoinAction.joinMessage?.roomId === 'room-1', 'Direct Join also posts the room ID to the extension bridge');
    ok(directJoinAction.joinMessage?.preferDirectJoin === true, 'Direct Join sets the prefer-direct intent for the extension');
    ok(directJoinAction.navTarget === 'https://web.stremio.com/#/detail/movie/tt1375666', 'Direct Join still navigates to the Stremio title page while the extension resolves the private player URL');

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

    await page.goto(`http://localhost:${PAGE_PORT}/r/test-room-123`, { waitUntil: 'domcontentloaded' });

    const joinMessageObserved = await page.waitForFunction(() => window.__joinMessages.length > 0, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    ok(joinMessageObserved, 'redirect page posts the join-room message immediately');

    const joinMessage = await page.evaluate(() => window.__joinMessages[0] || null);
    ok(joinMessage?.roomId === 'test-room-123', 'redirect page posts the correct room ID');

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
