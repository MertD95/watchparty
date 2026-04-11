// WatchParty for Stremio — Background Service Worker
// Manages: Stremio server detection, popup communication, profile sync, badge.
// NOTE: WebSocket connection lives in stremio-content.js (not here) to avoid MV3 suspension issues.

const STREMIO_BASE = 'http://localhost:11470';
const STREMIO_API = 'https://api.strem.io';
const POLL_INTERVAL_MS = 5000;
const STREMIO_WEB_URLS = ['https://web.stremio.com/*', 'https://web.strem.io/*', 'https://app.strem.io/*'];
const WATCHPARTY_URLS = ['https://watchparty.mertd.me/*', 'http://localhost:8080/*', 'http://localhost:8090/*'];

// --- State ---
let stremioRunning = false;
let stremioSettings = null;
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
      addons: addons.map(a => ({ transportUrl: a.transportUrl, manifest: a.manifest, flags: a.flags })),
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

// ── Message handling from popup and content scripts ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'watchparty-ext') return false;

  switch (message.action) {
    // --- Status queries (from popup) ---
    case 'get-status':
      chrome.storage.local.get(['stremioProfile', 'wpRoomState', 'wpUserId', 'wpWsConnected'], (result) => {
        sendResponse({
          stremioRunning,
          stremioSettings,
          profile: result.stremioProfile ?? null,
          stats,
          wsConnected: result.wpWsConnected ?? false,
          userId: result.wpUserId ?? null,
          room: result.wpRoomState ?? null,
        });
      });
      return true;

    // --- WS status update (from content script) ---
    case 'ws-status-changed':
      updateBadge();
      return false;

    // --- Room commands (from popup → relay to content script or store for later) ---
    case 'create-room':
      // Store intent so content script picks it up even if tab isn't open yet
      // Wait for storage write to complete before forwarding to content script
      chrome.storage.local.set({
        pendingRoomCreate: {
          username: message.username,
          meta: message.meta,
          stream: message.stream,
          public: message.public,
          roomName: message.roomName,
        },
      }, () => forwardToStremioTab(message));
      sendResponse({ ok: true });
      return false;

    case 'join-room':
      chrome.storage.local.set(
        { pendingRoomJoin: message.roomId, wpUsername: message.username },
        () => forwardToStremioTab(message)
      );
      sendResponse({ ok: true });
      return false;

    case 'leave-room':
    case 'toggle-public':
    case 'update-room-settings':
    case 'transfer-ownership':
    case 'update-username':
    case 'ready-check':
    case 'send-bookmark':
    case 'send-chat':
    case 'send-typing':
    case 'send-reaction':
    case 'send-presence':
    case 'send-playback-status':
    case 'request-sync':
      forwardToStremioTab(message);
      sendResponse({ ok: true });
      return false;

    // --- Profile relay ---
    case 'profile-updated':
      broadcastToWatchParty({ action: 'profile-updated', data: message.data });
      return false;

    case 'save-auth-key':
      if (message.authKey) {
        chrome.storage.local.set({ savedAuthKey: message.authKey });
        tryProfileSync();
      }
      return false;

    // --- CORS proxy ---
    case 'proxy-fetch':
      proxyFetch(message.url, message.method, message.headers)
        .then(sendResponse)
        .catch(e => sendResponse({ error: e.message }));
      return true;
  }

  return false;
});

// ── Forward popup commands to the active Stremio content script ──

async function forwardToStremioTab(message) {
  try {
    const tabs = await chrome.tabs.query({ url: STREMIO_WEB_URLS });
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'watchparty-ext', ...message }).catch(() => {});
      }
    }
  } catch { /* no Stremio tabs */ }
}

// ── Broadcast helpers ──

async function broadcastToStremioTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: STREMIO_WEB_URLS });
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'watchparty-ext', ...message }).catch(() => {});
      }
    }
  } catch { /* no matching tabs */ }
}

async function broadcastToWatchParty(message) {
  try {
    const tabs = await chrome.tabs.query({ url: WATCHPARTY_URLS });
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'watchparty-ext', ...message }).catch(() => {});
      }
    }
  } catch { /* no matching tabs */ }
}

// ── CORS proxy (for Stremio localhost) ──

const PROXY_ALLOWED = /^https?:\/\/(localhost|127\.0\.0\.1):11470\//;

async function proxyFetch(url, method, headers) {
  if (!PROXY_ALLOWED.test(url)) {
    return { error: 'Proxy blocked: only Stremio localhost URLs allowed' };
  }
  const start = Date.now();
  try {
    const res = await fetch(url, { method: method || 'GET', headers: headers || {}, signal: AbortSignal.timeout(30000) });
    const buffer = await res.arrayBuffer();
    stats.bytesProxied += buffer.byteLength;
    stats.requestsProxied++;
    const body = arrayBufferToBase64(buffer);
    const respHeaders = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });
    return { status: res.status, statusText: res.statusText, headers: respHeaders, body, size: buffer.byteLength, latency: Date.now() - start };
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

// ── Dev auto-reload ──

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
          chrome.runtime.reload();
          return;
        }
      }
    } catch { /* dev server not running */ }
  })();
}

// ── Start ──

checkStremio();
fetchStremioSettings();
setInterval(checkStremio, POLL_INTERVAL_MS);
connectDevReload();
