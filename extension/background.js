// WatchParty for Stremio — Background Service Worker
// Manages: Stremio server detection, popup communication, profile sync, badge.
// NOTE: WebSocket connection lives in stremio-content.js (not here) to avoid MV3 suspension issues.

// Load shared constants (service workers don't get content_scripts injection)
importScripts('constants.js');

const BG_VERSION = '2025-04-12-fix-chat';
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
  } catch (e) {
    stremioRunning = false;
    stats.lastLatencyMs = 0;
    // Expected when Stremio is not running — only log at debug level
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
  } catch (e) { console.warn('[WP-BG] Failed to fetch Stremio settings:', e.message); }
}

// ── Profile sync via Stremio API ──

async function tryProfileSync() {
  const { [WPConstants.STORAGE.STREMIO_PROFILE]: stremioProfile } = await chrome.storage.local.get(WPConstants.STORAGE.STREMIO_PROFILE);
  if (stremioProfile?.authKey && stremioProfile?.addons?.length > 0) return;
  // Auth key stored in session storage (cleared on browser restart) for security
  const { [WPConstants.STORAGE.SAVED_AUTH_KEY]: savedAuthKey } = await chrome.storage.session.get(WPConstants.STORAGE.SAVED_AUTH_KEY);
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
    await chrome.storage.local.set({ [WPConstants.STORAGE.STREMIO_PROFILE]: profile });
    broadcastToWatchParty({ action: 'profile-updated', data: profile });
  } catch (e) { console.warn('[WP-BG] Profile sync failed:', e.message); }
}

function updateBadge() {
  const color = stremioRunning ? '#22c55e' : '#ef4444';
  const text = stremioRunning ? 'ON' : 'OFF';
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

// ── Message handling from popup and content scripts ──

function relayToPanel(action, payload) {
  chrome.runtime.sendMessage({ type: 'watchparty-ext', action, payload }).catch(() => {});
}

function storeAndForward(storageData, message, sendResponse) {
  chrome.storage.local.set(storageData, () => forwardToStremioTab(message));
  if (sendResponse) sendResponse({ ok: true });
}

const messageHandlers = {
  'get-status': (_m, _s, sendResponse) => {
    chrome.storage.local.get([
      WPConstants.STORAGE.STREMIO_PROFILE,
      WPConstants.STORAGE.ROOM_STATE,
      WPConstants.STORAGE.USER_ID,
      WPConstants.STORAGE.WS_CONNECTED,
      WPConstants.STORAGE.BACKEND_MODE,
      WPConstants.STORAGE.ACTIVE_BACKEND,
      WPConstants.STORAGE.ACTIVE_BACKEND_URL,
    ], (result) => {
      sendResponse({
        stremioRunning, stremioSettings,
        profile: result[WPConstants.STORAGE.STREMIO_PROFILE] ?? null,
        stats,
        wsConnected: result[WPConstants.STORAGE.WS_CONNECTED] ?? false,
        backendMode: result[WPConstants.STORAGE.BACKEND_MODE] ?? WPConstants.BACKEND.MODES.AUTO,
        activeBackend: result[WPConstants.STORAGE.ACTIVE_BACKEND] ?? null,
        activeBackendUrl: result[WPConstants.STORAGE.ACTIVE_BACKEND_URL] ?? null,
        userId: result[WPConstants.STORAGE.USER_ID] ?? null,
        room: result[WPConstants.STORAGE.ROOM_STATE] ?? null,
        bgVersion: BG_VERSION,
      });
    });
    return true; // async sendResponse
  },
  'ws-status-changed': (m) => {
    const connectionState = {
      [WPConstants.STORAGE.WS_CONNECTED]: !!m.connected,
    };
    if ('activeBackend' in m) connectionState[WPConstants.STORAGE.ACTIVE_BACKEND] = m.activeBackend || null;
    if ('activeBackendUrl' in m) connectionState[WPConstants.STORAGE.ACTIVE_BACKEND_URL] = m.activeBackendUrl || null;
    chrome.storage.local.set(connectionState).catch(() => {});
    updateBadge();
  },
  'chat-message': (m) => relayToPanel('chat-message', m.payload),
  'bookmark': (m) => relayToPanel('bookmark', m.payload),
  'create-room': (m, _s, sr) => {
    chrome.storage.local.remove(WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS, () => {
      storeAndForward({
        [WPConstants.STORAGE.PENDING_ROOM_CREATE]: {
          username: m.username, meta: m.meta, stream: m.stream, public: m.public, roomName: m.roomName,
        },
      }, m, sr);
    });
  },
  'join-room': (m, _s, sr) => {
    const updates = {
      [WPConstants.STORAGE.PENDING_ROOM_JOIN]: m.roomId,
      [WPConstants.STORAGE.USERNAME]: m.username,
    };
    if (m.preferDirectJoin) {
      updates[WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS] = {
        roomId: m.roomId,
        preferDirectJoin: true,
        requestedAt: Date.now(),
      };
      storeAndForward(updates, m, sr);
      return;
    }
    chrome.storage.local.remove(WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS, () => {
      storeAndForward(updates, m, sr);
    });
  },
  'leave-room': (m, _s, sr) => storeAndForward({ [WPConstants.STORAGE.PENDING_LEAVE_ROOM]: true }, m, sr),
  'toggle-public': (m, _s, sr) => storeAndForward({ [WPConstants.STORAGE.PENDING_ACTION]: { action: m.action, ...m } }, m, sr),
  'update-room-settings': (m, _s, sr) => storeAndForward({ [WPConstants.STORAGE.PENDING_ACTION]: { action: m.action, ...m } }, m, sr),
  'transfer-ownership': (m, _s, sr) => storeAndForward({ [WPConstants.STORAGE.PENDING_ACTION]: { action: m.action, ...m } }, m, sr),
  'update-username': (m, _s, sr) => { forwardToStremioTab(m); sr?.({ ok: true }); },
  'ready-check': (m, _s, sr) => { forwardToStremioTab(m); sr?.({ ok: true }); },
  'send-bookmark': (m, _s, sr) => { forwardToStremioTab(m); sr?.({ ok: true }); },
  'seek-bookmark': (m, _s, sr) => { forwardToStremioTab(m); sr?.({ ok: true }); },
  'send-chat': (m, _s, sr) => { forwardToStremioTab(m); sr?.({ ok: true }); },
  'send-typing': (m, _s, sr) => { forwardToStremioTab(m); sr?.({ ok: true }); },
  'send-reaction': (m, _s, sr) => { forwardToStremioTab(m); sr?.({ ok: true }); },
  'send-presence': (m, _s, sr) => { forwardToStremioTab(m); sr?.({ ok: true }); },
  'send-playback-status': (m, _s, sr) => { forwardToStremioTab(m); sr?.({ ok: true }); },
  'request-sync': (m, _s, sr) => { forwardToStremioTab(m); sr?.({ ok: true }); },
  'profile-updated': (m) => broadcastToWatchParty({ action: 'profile-updated', data: m.data }),
  'save-auth-key': (m) => {
    if (m.authKey) { chrome.storage.session.set({ [WPConstants.STORAGE.SAVED_AUTH_KEY]: m.authKey }); tryProfileSync(); }
  },
  'proxy-fetch': (m, _s, sendResponse) => {
    proxyFetch(m.url, m.method, m.headers).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true; // async sendResponse
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'watchparty-ext') return false;
  const handler = messageHandlers[message.action];
  if (handler) return handler(message, sender, sendResponse) || false;
  return false;
});

// ── Forward popup commands to the active Stremio content script ──

async function forwardToStremioTab(message) {
  try {
    const tabs = await chrome.tabs.query({ url: STREMIO_WEB_URLS });
    // Debug logging removed for production — uncomment for troubleshooting:
    // console.log(`[WP-BG] forwardToStremioTab: action=${message.action}, tabs found=${tabs.length}`);
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'watchparty-ext', ...message })
          .catch((e) => console.warn(`[WP-BG] sendMessage to tab ${tab.id} failed:`, e.message));
      }
    }
  } catch (e) { console.warn('[WP-BG] forwardToStremioTab failed:', e.message); }
}

// ── Broadcast helpers ──

async function broadcastToTabs(urlPatterns, message) {
  try {
    const tabs = await chrome.tabs.query({ url: urlPatterns });
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'watchparty-ext', ...message }).catch(() => {});
      }
    }
  } catch (e) { console.warn('[WP-BG] broadcastToTabs failed:', e.message); }
}

function broadcastToStremioTabs(message) { return broadcastToTabs(STREMIO_WEB_URLS, message); }
function broadcastToWatchParty(message) { return broadcastToTabs(WATCHPARTY_URLS, message); }

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
  let lastReloadTime = 0;
  const RELOAD_COOLDOWN_MS = 2000; // Prevent Chrome's "reloaded too frequently" throttle
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
          const now = Date.now();
          if (now - lastReloadTime < RELOAD_COOLDOWN_MS) continue; // Skip rapid reloads
          lastReloadTime = now;
          chrome.runtime.reload();
          return;
        }
      }
    } catch { /* dev server not running */ }
  })();
}

// ── Side Panel (Chrome 114+, optional alternative to injected overlay) ──

if (chrome.sidePanel) {
  // Enable side panel only on Stremio Web tabs
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

  // When user navigates to Stremio, enable the side panel for that tab
  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (!tab.url) return;
    const isStremio = STREMIO_WEB_URLS.some(pattern => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*'));
      return regex.test(tab.url);
    });
    chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel.html',
      enabled: isStremio,
    }).catch(() => {});
  });
}

// ── Extension update: re-inject content scripts into open Stremio tabs ──
// After auto-update, old content scripts are orphaned (chrome.runtime is dead).
// Re-injecting restores the sidebar without requiring a manual page refresh.

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'update') return;
  // console.log('[WP-BG] Extension updated — re-injecting content scripts');
  try {
    const tabs = await chrome.tabs.query({ url: STREMIO_WEB_URLS });
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'constants.js', 'wp-protocol.js', 'utils.js', 'stremio-sync.js',
          'stremio-ws.js', 'stremio-crypto.js', 'stremio-overlay-theme.js',
          'stremio-overlay-modals.js', 'stremio-overlay.js', 'stremio-profile.js',
          'stremio-content.js',
        ],
      }).catch(() => {}); // Tab may have navigated away or be restricted
      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['stremio-overlay.css'],
      }).catch(() => {});
    }
  } catch (e) { console.warn('[WP-BG] Re-injection failed:', e.message); }
});

// ── Start ──

checkStremio();
fetchStremioSettings();
setInterval(checkStremio, POLL_INTERVAL_MS);
// Dev-only: auto-reload on file changes (no update_url = unpacked/dev extension)
if (!('update_url' in chrome.runtime.getManifest())) connectDevReload();
