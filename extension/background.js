// WatchParty for Stremio — Background Service Worker
// Manages: Stremio server detection, WebSocket relay connection, room state, clock sync.

const STREMIO_BASE = 'http://localhost:11470';
const STREMIO_API = 'https://api.strem.io';
const WS_URL_PROD = 'wss://ws.mertd.me';
const WS_URL_DEV = 'ws://localhost:8181';
const POLL_INTERVAL_MS = 5000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const CLOCK_SAMPLES = 6;
const STREMIO_WEB_URLS = ['https://web.stremio.com/*', 'https://web.strem.io/*', 'https://app.strem.io/*'];
const WATCHPARTY_URLS = ['https://watchparty.mertd.me/*', 'http://localhost:8080/*', 'http://localhost:8090/*'];

// --- State ---
let stremioRunning = false;
let stremioSettings = null;
let ws = null;
let wsConnected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let userId = null;
let roomState = null; // Current room state from server
let clockOffset = 0;  // Server clock - local clock (ms)
let clockSamples = [];
const stats = { bytesProxied: 0, requestsProxied: 0, lastLatencyMs: 0 };

// ── Stremio server detection ──

async function checkStremio() {
  const prev = stremioRunning;
  const start = Date.now();
  try {
    const res = await fetch(`${STREMIO_BASE}/stats.json`, { signal: AbortSignal.timeout(3000) });
    stremioRunning = res.ok;
    stats.lastLatencyMs = Date.now() - start;
  } catch {
    stremioRunning = false;
    stats.lastLatencyMs = 0;
  }
  updateBadge();

  if (prev !== stremioRunning) {
    broadcastToStremioTabs({ action: 'stremio-status', stremioRunning });
    broadcastToWatchParty({ action: 'stremio-status', stremioRunning });
    if (stremioRunning) {
      fetchStremioSettings();
      tryProfileSync();
    } else {
      stremioSettings = null;
    }
  }
}

async function fetchStremioSettings() {
  try {
    const res = await fetch(`${STREMIO_BASE}/settings`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      stremioSettings = {
        serverVersion: data.values?.serverVersion ?? null,
        cacheSize: data.values?.cacheSize ?? null,
        transcodeHardwareAccel: data.values?.transcodeHardwareAccel ?? null,
        transcodeMaxWidth: data.values?.transcodeMaxWidth ?? null,
        transcodeMaxBitRate: data.values?.transcodeMaxBitRate ?? null,
        transcodeProfile: data.values?.transcodeProfile ?? null,
        allTranscodeProfiles: data.values?.allTranscodeProfiles ?? null,
        remoteHttps: data.values?.remoteHttps ?? null,
      };
    }
  } catch { /* settings unavailable */ }
}

// ── Profile sync via Stremio API ──

async function tryProfileSync() {
  const { stremioProfile } = await chrome.storage.local.get('stremioProfile');
  if (stremioProfile?.authKey && stremioProfile?.addons?.length > 0) return;

  const { savedAuthKey } = await chrome.storage.local.get('savedAuthKey');
  const authKey = stremioProfile?.authKey || savedAuthKey;
  if (!authKey) return;

  try {
    const res = await fetch(`${STREMIO_API}/api/addonCollectionGet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'AddonCollectionGet', authKey, update: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const addons = data.result?.addons ?? [];
    if (addons.length === 0) return;

    const profile = {
      authKey,
      user: stremioProfile?.user ?? null,
      addons: addons.map(a => ({
        transportUrl: a.transportUrl,
        manifest: a.manifest,
        flags: a.flags,
      })),
      settings: stremioProfile?.settings ?? {
        audioLanguage: null, secondaryAudioLanguage: null,
        subtitlesLanguage: null, secondarySubtitlesLanguage: null,
        interfaceLanguage: null, streamingServerUrl: null,
      },
      readAt: Date.now(),
    };

    await chrome.storage.local.set({ stremioProfile: profile });
    broadcastToWatchParty({ action: 'profile-updated', data: profile });
  } catch { /* API unavailable */ }
}

function updateBadge() {
  const color = stremioRunning ? '#22c55e' : '#ef4444';
  const text = stremioRunning ? 'ON' : 'OFF';
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

// ── WebSocket relay connection ──

let detectedWsUrl = null;

async function getWsUrl() {
  if (detectedWsUrl) return detectedWsUrl;
  // Try dev server first — if it's running, use it
  try {
    const res = await fetch(WS_URL_DEV.replace('ws://', 'http://'), {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      detectedWsUrl = WS_URL_DEV;
      return WS_URL_DEV;
    }
  } catch { /* dev server not running */ }
  detectedWsUrl = WS_URL_PROD;
  return WS_URL_PROD;
}

async function connectWs() {
  if (ws) return;
  const url = await getWsUrl();

  try {
    ws = new WebSocket(url);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    wsConnected = true;
    reconnectAttempts = 0;
    updateBadge();
    broadcastToStremioTabs({ action: 'ws-connected', connected: true });
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch { /* malformed message */ }
  };

  ws.onclose = () => {
    ws = null;
    wsConnected = false;
    broadcastToStremioTabs({ action: 'ws-connected', connected: false });
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function disconnectWs() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  if (ws) {
    ws.onclose = null; // Prevent reconnect
    ws.close();
    ws = null;
    wsConnected = false;
  }
  roomState = null;
  userId = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
  const delay = base + Math.random() * base * 0.2; // Jitter to avoid thundering herd
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, delay);
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Server message handling ──

function handleServerMessage(msg) {
  if (!msg || !msg.type) return;
  const p = msg.payload;

  switch (msg.type) {
    case 'ready':
      if (!p?.user?.id) return;
      userId = p.user.id;
      // If we had a pending room join from storage, attempt it
      chrome.storage.local.get('pendingRoomJoin', ({ pendingRoomJoin }) => {
        if (pendingRoomJoin) {
          chrome.storage.local.remove('pendingRoomJoin');
          wsSend({ type: 'room.join', payload: { id: pendingRoomJoin } });
        }
      });
      // Run clock sync
      startClockSync();
      break;

    case 'sync':
      if (!p) return;
      roomState = p;
      broadcastToStremioTabs({
        action: 'room-sync',
        room: roomState,
        userId,
        clockOffset,
      });
      break;

    case 'room':
      if (!p?.id) return;
      roomState = p;
      chrome.storage.local.set({ currentRoom: roomState.id });
      broadcastToStremioTabs({
        action: 'room-joined',
        room: roomState,
        userId,
      });
      break;

    case 'message':
      if (!p) return;
      broadcastToStremioTabs({ action: 'chat-message', message: p });
      break;

    case 'user':
      if (!p?.user?.id) return;
      userId = p.user.id;
      break;

    case 'error':
      broadcastToStremioTabs({ action: 'error', error: p?.type });
      break;

    case 'typing':
      if (!p?.user) return;
      broadcastToStremioTabs({ action: 'typing', user: p.user, typing: p.typing });
      break;

    case 'reaction':
      if (!p?.user || !p?.emoji) return;
      broadcastToStremioTabs({ action: 'reaction', user: p.user, emoji: p.emoji });
      break;

    case 'autopause':
      if (!p?.name) return;
      broadcastToStremioTabs({ action: 'autopause', name: p.name });
      break;

    case 'readyCheck':
      broadcastToStremioTabs({ action: 'readyCheck', ...p });
      break;

    case 'countdown':
      broadcastToStremioTabs({ action: 'countdown', seconds: p.seconds });
      break;

    case 'bookmark':
      broadcastToStremioTabs({ action: 'bookmark', ...p });
      break;

    case 'clock.pong': {
      if (!p?.clientTime || !p?.serverTime) return;
      const now = Date.now();
      const rtt = now - p.clientTime;
      const offset = p.serverTime - p.clientTime - rtt / 2;
      clockSamples.push({ rtt, offset });
      if (clockSamples.length >= CLOCK_SAMPLES) {
        clockSamples.sort((a, b) => a.rtt - b.rtt);
        clockOffset = clockSamples[0].offset;
      }
      break;
    }
  }
}

// ── Clock synchronization (Cristian's algorithm) ──

function startClockSync() {
  clockSamples = [];
  for (let i = 0; i < CLOCK_SAMPLES; i++) {
    setTimeout(() => {
      wsSend({ type: 'clock.ping', payload: { clientTime: Date.now() } });
    }, i * 200);
  }
}

// ── Message handling from content scripts and popup ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'watchparty-ext') return false;

  // Ensure WS is connected on every wake-up (service worker may have been suspended)
  if (!ws || ws.readyState !== WebSocket.OPEN) connectWs();

  switch (message.action) {
    // --- Status queries ---
    case 'get-status':
      chrome.storage.local.get('stremioProfile', (result) => {
        sendResponse({
          stremioRunning,
          stremioSettings,
          profile: result.stremioProfile ?? null,
          stats,
          wsConnected,
          userId,
          room: roomState,
        });
      });
      return true;

    // --- Room management (from popup) ---
    case 'create-room':
      if (!wsConnected) connectWs();
      // Wait for connection, then create
      waitForWs(() => {
        if (message.username) {
          wsSend({ type: 'user.update', payload: { username: message.username } });
        }
        const payload = {
          meta: message.meta || { id: 'unknown', type: 'movie', name: 'WatchParty Session' },
          stream: message.stream || { url: 'https://example.com/placeholder' },
          public: message.public || false,
        };
        if (message.roomName) payload.name = message.roomName;
        wsSend({ type: 'room.new', payload });
      });
      sendResponse({ ok: true });
      return false;

    case 'join-room':
      if (!wsConnected) connectWs();
      waitForWs(() => {
        if (message.username) {
          wsSend({ type: 'user.update', payload: { username: message.username } });
        }
        wsSend({ type: 'room.join', payload: { id: message.roomId } });
      });
      sendResponse({ ok: true });
      return false;

    case 'leave-room':
      wsSend({ type: 'room.leave', payload: {} });
      roomState = null;
      chrome.storage.local.remove('currentRoom');
      broadcastToStremioTabs({ action: 'room-left' });
      sendResponse({ ok: true });
      return false;

    case 'transfer-ownership':
      wsSend({ type: 'room.updateOwnership', payload: { userId: message.targetUserId } });
      sendResponse({ ok: true });
      return false;

    // --- Sync events (from content script on Stremio Web) ---
    case 'player-sync':
      if (roomState && userId === roomState.owner) {
        wsSend({
          type: 'player.sync',
          payload: {
            paused: message.paused,
            buffering: message.buffering,
            time: message.time,
            speed: message.speed,
          },
        });
      }
      break;

    case 'request-sync':
      // Non-host requests current state — server will respond with sync
      if (roomState) {
        wsSend({ type: 'player.sync', payload: { paused: true, buffering: false, time: 0 } });
      }
      break;

    // --- Chat ---
    case 'send-chat':
      wsSend({ type: 'room.message', payload: { content: message.content } });
      break;

    // --- Typing ---
    case 'send-typing':
      wsSend({ type: 'room.typing', payload: { typing: message.typing } });
      break;

    // --- Reactions ---
    case 'send-reaction':
      wsSend({ type: 'room.reaction', payload: { emoji: message.emoji } });
      break;

    // --- Public toggle ---
    case 'toggle-public':
      wsSend({ type: 'room.updatePublic', payload: { public: message.public } });
      break;

    // --- Presence ---
    case 'send-presence':
      wsSend({ type: 'user.presence', payload: { status: message.status } });
      break;

    // --- Playback status ---
    case 'send-playback-status':
      wsSend({ type: 'user.playbackStatus', payload: { status: message.status } });
      break;

    // --- Room settings ---
    case 'update-room-settings':
      wsSend({ type: 'room.updateSettings', payload: message.settings });
      break;

    // --- Ready check ---
    case 'ready-check':
      wsSend({ type: 'room.readyCheck', payload: { action: message.readyAction } });
      break;

    // --- Bookmarks ---
    case 'send-bookmark':
      wsSend({ type: 'room.bookmark', payload: { time: message.time, label: message.label } });
      break;

    // --- Content link sharing ---
    case 'share-content-link':
      // Host shares what they're watching so peers can navigate to it
      if (roomState && userId === roomState.owner) {
        wsSend({
          type: 'room.updateStream',
          payload: {
            stream: { url: 'https://watchparty.mertd.me/sync' }, // placeholder
            meta: message.meta,
          },
        });
      }
      break;

    // --- Username update ---
    case 'update-username':
      wsSend({ type: 'user.update', payload: { username: message.username } });
      break;

    // --- CORS proxy for future WatchParty client (not used by extension) ---
    case 'proxy-fetch':
      proxyFetch(message.url, message.method, message.headers)
        .then(sendResponse)
        .catch(e => sendResponse({ error: e.message }));
      return true;

    case 'profile-updated':
      broadcastToWatchParty({ action: 'profile-updated', data: message.data });
      return false;

    case 'save-auth-key':
      if (message.authKey) {
        chrome.storage.local.set({ savedAuthKey: message.authKey });
        tryProfileSync();
      }
      return false;
  }

  return false;
});

// ── Utility: wait for WebSocket to be ready ──

function waitForWs(callback, timeout = 5000) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    callback();
    return;
  }
  const start = Date.now();
  const check = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      clearInterval(check);
      callback();
    } else if (Date.now() - start > timeout) {
      clearInterval(check);
      broadcastToStremioTabs({ action: 'error', error: 'connection' });
    }
  }, 100);
}

// ── Broadcast helpers ──

async function broadcastToStremioTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: STREMIO_WEB_URLS });
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'watchparty-ext',
          ...message,
        }).catch(() => {});
      }
    }
  } catch { /* no matching tabs */ }
}

async function broadcastToWatchParty(message) {
  try {
    const tabs = await chrome.tabs.query({ url: WATCHPARTY_URLS });
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'watchparty-ext',
          ...message,
        }).catch(() => {});
      }
    }
  } catch { /* no matching tabs */ }
}

// ── Proxy fetch (CORS bypass for Stremio localhost) ──

const PROXY_ALLOWED = /^https?:\/\/(localhost|127\.0\.0\.1):11470\//;

async function proxyFetch(url, method, headers) {
  if (!PROXY_ALLOWED.test(url)) {
    return { error: 'Proxy blocked: only Stremio localhost URLs allowed' };
  }
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: method || 'GET',
      headers: headers || {},
      signal: AbortSignal.timeout(30000),
    });
    const buffer = await res.arrayBuffer();
    const latency = Date.now() - start;

    stats.bytesProxied += buffer.byteLength;
    stats.requestsProxied++;

    const body = arrayBufferToBase64(buffer);
    const respHeaders = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });

    return { status: res.status, statusText: res.statusText, headers: respHeaders, body, size: buffer.byteLength, latency };
  } catch (e) {
    return { error: e.message || 'Proxy fetch failed' };
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 32768;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// ── Dev auto-reload (connects to dev-reload.js watcher) ──

// Dev auto-reload (EventSource not available in MV3 service workers, use fetch + ReadableStream)
function connectDevReload() {
  (async () => {
    try {
      const res = await fetch('http://localhost:5111/reload');
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.includes('data: reload')) {
          console.log('[WatchParty] Dev reload triggered');
          chrome.runtime.reload();
          return;
        }
      }
    } catch { /* dev server not running, silently ignore */ }
  })();
}

// ── Start ──
// Don't connect WS eagerly — service worker gets suspended before connection completes,
// causing ERR_NETWORK_IO_SUSPENDED. WS connects on first actual use (onMessage handler).

checkStremio();
fetchStremioSettings();
setInterval(checkStremio, POLL_INTERVAL_MS);
connectDevReload();
