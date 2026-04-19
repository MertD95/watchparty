// WatchParty for Stremio — Background Service Worker
// Manages: Stremio server detection, popup communication, profile sync, badge.
// NOTE: WebSocket connection lives in stremio-content.js (not here) to avoid MV3 suspension issues.

// Load shared constants (service workers don't get content_scripts injection)
importScripts('constants.js');
importScripts('wp-protocol.js');
importScripts('background-room-service.js');

const BG_VERSION = '2025-04-12-fix-chat';
const STREMIO_BASE = 'http://localhost:11470';
const STREMIO_API = 'https://api.strem.io';
const POLL_INTERVAL_MS = 5000;
const STREMIO_WEB_URLS = ['https://web.stremio.com/*', 'https://web.strem.io/*', 'https://app.strem.io/*'];
const WATCHPARTY_URLS = ['https://watchparty.mertd.me/*', 'http://localhost:8080/*', 'http://localhost:8090/*'];
const STREMIO_WEB_ORIGINS = new Set(['https://web.stremio.com', 'https://web.strem.io', 'https://app.strem.io']);
const WATCHPARTY_ORIGINS = new Set(['https://watchparty.mertd.me', 'http://localhost:8080', 'http://localhost:8090']);

// --- State ---
let stremioRunning = false;
let stremioSettings = null;
const stats = { bytesProxied: 0, requestsProxied: 0, lastLatencyMs: 0 };
const knownStremioTabIds = new Set();
const knownWatchPartyTabIds = new Set();

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

function respondAsync(sendResponse, work) {
  Promise.resolve()
    .then(work)
    .then((result) => sendResponse?.(result ?? { ok: true }))
    .catch((error) => {
      const message = error?.message || String(error);
      console.warn('[WP-BG] async handler failed:', message);
      sendResponse?.({ ok: false, error: message });
    });
  return true;
}

function urlMatchesOrigins(url, origins) {
  try {
    return origins.has(new URL(url).origin);
  } catch {
    return false;
  }
}

async function getTabsByOrigins(origins) {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => !!tab.url && urlMatchesOrigins(tab.url, origins));
  } catch {
    return [];
  }
}

function rememberSurfaceTab(surface, tabId) {
  if (tabId == null) return;
  if (surface === 'stremio') {
    knownStremioTabIds.add(tabId);
    knownWatchPartyTabIds.delete(tabId);
    return;
  }
  if (surface === 'watchparty') {
    knownWatchPartyTabIds.add(tabId);
    knownStremioTabIds.delete(tabId);
  }
}

function forgetSurfaceTab(tabId) {
  if (tabId == null) return;
  knownStremioTabIds.delete(tabId);
  knownWatchPartyTabIds.delete(tabId);
}

async function resolveKnownTabs(tabIds) {
  const resolved = [];
  for (const tabId of Array.from(tabIds)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      resolved.push(tab);
    } catch {
      tabIds.delete(tabId);
    }
  }
  return resolved;
}

async function probeKnownExtensionSurfaces() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'watchparty-ext',
          action: 'probe-surface',
        });
        if (response?.surface) rememberSurfaceTab(response.surface, tab.id);
      } catch {
        // Ignore tabs without a WatchParty content script.
      }
    }));
  } catch {
    // Ignore probe failures and fall back to the known tab set.
  }
}

async function getStremioTabs() {
  if (knownStremioTabIds.size === 0) await probeKnownExtensionSurfaces();
  return resolveKnownTabs(knownStremioTabIds);
}

async function getWatchPartyTabs() {
  if (knownWatchPartyTabIds.size === 0) await probeKnownExtensionSurfaces();
  return resolveKnownTabs(knownWatchPartyTabIds);
}

async function hasStremioTabs() {
  return (await getStremioTabs()).length > 0;
}

async function handoffBackgroundRoomToTab() {
  if (!WPBackgroundRoomService.isActive()) return false;
  const tabs = await getStremioTabs();
  if (tabs.length === 0) return false;
  return WPBackgroundRoomService.handoffToTab();
}

async function storeAndForward(storageData, message) {
  await chrome.storage.local.set(storageData);
  await forwardToStremioTab(message);
  return { ok: true, openedStremio: false };
}

async function removeStorageKeys(keys) {
  await chrome.storage.local.remove(keys);
}

async function cacheRoomKey(roomId, roomKey) {
  if (!roomId || !roomKey) return;
  const storageKey = WPConstants.STORAGE.roomKey(roomId);
  const encodedRoomKey = WPConstants.ROOM_KEYS.encodeForLocal(roomKey);
  try {
    await chrome.storage.session.set({ [storageKey]: roomKey });
  } catch { /* session storage may be unavailable */ }
  if (encodedRoomKey) {
    await chrome.storage.local.set({ [storageKey]: encodedRoomKey });
  }
}

async function focusTab(tab) {
  if (!tab?.id) return null;
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch { /* tab may have closed */ }
  if (typeof tab.windowId === 'number') {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch { /* window may have closed */ }
  }
  return tab;
}

async function openSidebarOnTab(tab, panel) {
  if (!tab?.id) return false;
  await focusTab(tab);
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'watchparty-ext',
      action: 'open-sidebar',
      panel,
    });
    return true;
  } catch {
    forgetSurfaceTab(tab.id);
    return false;
  }
}

async function resolveBrowseUrl() {
  const result = await chrome.storage.local.get([
    WPConstants.STORAGE.BACKEND_MODE,
    WPConstants.STORAGE.ACTIVE_BACKEND,
  ]);
  return WPConstants.BACKEND.getBrowseUrl(
    result[WPConstants.STORAGE.BACKEND_MODE],
    result[WPConstants.STORAGE.ACTIVE_BACKEND]
  );
}

async function openOrFocusWatchParty() {
  const tabs = await getWatchPartyTabs();
  if (tabs.length > 0) {
    await focusTab(tabs[0]);
    return { opened: false, tab: tabs[0] };
  }
  const created = await chrome.tabs.create({ url: await resolveBrowseUrl() });
  rememberSurfaceTab('watchparty', created?.id ?? null);
  return { opened: true, tab: created };
}

async function resumeRoomInStremio() {
  const stremioTabs = await getStremioTabs();
  const result = await chrome.storage.local.get([
    WPConstants.STORAGE.ROOM_STATE,
    WPConstants.STORAGE.ROOM_SERVICE_ACTIVE,
  ]);
  const room = result[WPConstants.STORAGE.ROOM_STATE] ?? null;
  const roomServiceActive = result[WPConstants.STORAGE.ROOM_SERVICE_ACTIVE] === true;
  const hasActiveRoom = !!room && (roomServiceActive || stremioTabs.length > 0);
  if (!hasActiveRoom) return { ok: false, openedStremio: false };

  if (stremioTabs.length > 0) {
    await openSidebarOnTab(stremioTabs[0]);
    return { ok: true, openedStremio: false };
  }

  await chrome.tabs.create({ url: 'https://web.stremio.com' });
  return { ok: true, openedStremio: true };
}

const messageHandlers = {
  'get-status': (_m, _s, sendResponse) => respondAsync(sendResponse, async () => {
    const hasStremioTab = await hasStremioTabs();
    if (hasStremioTab) {
      await handoffBackgroundRoomToTab().catch(() => {});
    } else {
      await WPBackgroundRoomService.resumeIfNeeded().catch(() => {});
    }
    const result = await chrome.storage.local.get([
      WPConstants.STORAGE.STREMIO_PROFILE,
      WPConstants.STORAGE.ROOM_STATE,
      WPConstants.STORAGE.USER_ID,
      WPConstants.STORAGE.USERNAME,
      WPConstants.STORAGE.WS_CONNECTED,
      WPConstants.STORAGE.BACKEND_MODE,
      WPConstants.STORAGE.ACTIVE_BACKEND,
      WPConstants.STORAGE.ACTIVE_BACKEND_URL,
      WPConstants.STORAGE.ROOM_SERVICE_ACTIVE,
      WPConstants.STORAGE.ROOM_SERVICE_ERROR,
    ]);
    const roomServiceActive = result[WPConstants.STORAGE.ROOM_SERVICE_ACTIVE] ?? false;
    const trustedPersistedRoom = hasStremioTab || roomServiceActive;
    return {
      stremioRunning, stremioSettings,
      profile: result[WPConstants.STORAGE.STREMIO_PROFILE] ?? null,
      stats,
      wsConnected: result[WPConstants.STORAGE.WS_CONNECTED] ?? false,
      backendMode: result[WPConstants.STORAGE.BACKEND_MODE] ?? WPConstants.BACKEND.MODES.AUTO,
      activeBackend: result[WPConstants.STORAGE.ACTIVE_BACKEND] ?? null,
      activeBackendUrl: result[WPConstants.STORAGE.ACTIVE_BACKEND_URL] ?? null,
      userId: result[WPConstants.STORAGE.USER_ID] ?? null,
      username: result[WPConstants.STORAGE.USERNAME] ?? null,
      room: trustedPersistedRoom ? (result[WPConstants.STORAGE.ROOM_STATE] ?? null) : null,
      hasStremioTab,
      roomServiceActive,
      roomServiceError: result[WPConstants.STORAGE.ROOM_SERVICE_ERROR] ?? null,
      bgVersion: BG_VERSION,
    };
  }),
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
  'typing': (m) => relayToPanel('typing', m.payload),
  'bookmark': (m) => relayToPanel('bookmark', m.payload),
  'create-room': (m, _s, sr) => respondAsync(sr, async () => {
    if (m.username) {
      await chrome.storage.local.set({ [WPConstants.STORAGE.USERNAME]: m.username });
    }
    if (await hasStremioTabs()) {
      if (WPBackgroundRoomService.isActive()) await WPBackgroundRoomService.stop();
      await removeStorageKeys([
        WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS,
        WPConstants.STORAGE.PENDING_LEAVE_ROOM,
        WPConstants.STORAGE.ROOM_SERVICE_ACTIVE,
        WPConstants.STORAGE.ROOM_SERVICE_ERROR,
      ]);
      return storeAndForward({
        [WPConstants.STORAGE.PENDING_ROOM_CREATE]: {
          username: m.username, meta: m.meta, stream: m.stream, public: m.public, roomName: m.roomName,
        },
      }, m);
    }
    await removeStorageKeys([
      WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS,
      WPConstants.STORAGE.PENDING_LEAVE_ROOM,
      WPConstants.STORAGE.ROOM_SERVICE_ERROR,
    ]);
    await WPBackgroundRoomService.createRoom(m);
    return { ok: true, openedStremio: false };
  }),
  'join-room': (m, _s, sr) => respondAsync(sr, async () => {
    if (await hasStremioTabs()) {
      if (WPBackgroundRoomService.isActive()) await WPBackgroundRoomService.stop();
      const updates = {
        [WPConstants.STORAGE.PENDING_ROOM_JOIN]: m.roomId,
        [WPConstants.STORAGE.USERNAME]: m.username,
      };
      if (m.roomKey) {
        await cacheRoomKey(m.roomId, m.roomKey);
      }
      if (m.preferDirectJoin) {
        updates[WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS] = {
          roomId: m.roomId,
          preferDirectJoin: true,
          requestedAt: Date.now(),
        };
        await removeStorageKeys([
          WPConstants.STORAGE.PENDING_LEAVE_ROOM,
          WPConstants.STORAGE.ROOM_SERVICE_ACTIVE,
          WPConstants.STORAGE.ROOM_SERVICE_ERROR,
        ]);
        return storeAndForward(updates, m);
      }
      await removeStorageKeys([
        WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS,
        WPConstants.STORAGE.PENDING_LEAVE_ROOM,
        WPConstants.STORAGE.ROOM_SERVICE_ACTIVE,
        WPConstants.STORAGE.ROOM_SERVICE_ERROR,
      ]);
      return storeAndForward(updates, m);
    }
    const updates = {
      [WPConstants.STORAGE.USERNAME]: m.username,
    };
    if (m.roomKey) {
      await cacheRoomKey(m.roomId, m.roomKey);
    }
    await removeStorageKeys([
      WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS,
      WPConstants.STORAGE.PENDING_LEAVE_ROOM,
      WPConstants.STORAGE.ROOM_SERVICE_ERROR,
    ]);
    if (m.preferDirectJoin) {
      updates[WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS] = {
        roomId: m.roomId,
        preferDirectJoin: true,
        requestedAt: Date.now(),
      };
    }
    await chrome.storage.local.set(updates);
    await WPBackgroundRoomService.joinRoom(m);
    return { ok: true, openedStremio: false };
  }),
  'leave-room': (m, _s, sr) => respondAsync(sr, async () => {
    if (!await hasStremioTabs() || WPBackgroundRoomService.isActive()) {
      await WPBackgroundRoomService.leaveRoom();
      await removeStorageKeys([
        WPConstants.STORAGE.CURRENT_ROOM,
        WPConstants.STORAGE.ROOM_STATE,
        WPConstants.STORAGE.PENDING_ROOM_JOIN,
        WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS,
        WPConstants.STORAGE.ROOM_SERVICE_ACTIVE,
      ]);
      return { ok: true };
    }
    await removeStorageKeys([
      WPConstants.STORAGE.CURRENT_ROOM,
      WPConstants.STORAGE.ROOM_STATE,
      WPConstants.STORAGE.PENDING_ROOM_JOIN,
      WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS,
    ]);
    return storeAndForward({
      [WPConstants.STORAGE.PENDING_LEAVE_ROOM]: { requestedAt: Date.now() },
    }, m);
  }),
  'toggle-public': (m, _s, sr) => respondAsync(sr, async () => {
    if (!await hasStremioTabs() && WPBackgroundRoomService.isActive()) {
      await WPBackgroundRoomService.updatePublic(m);
      return { ok: true };
    }
    return storeAndForward({ [WPConstants.STORAGE.PENDING_ACTION]: { action: m.action, ...m } }, m);
  }),
  'update-room-settings': (m, _s, sr) => respondAsync(sr, async () => {
    if (!await hasStremioTabs() && WPBackgroundRoomService.isActive()) {
      await WPBackgroundRoomService.updateSettings(m.settings);
      return { ok: true };
    }
    return storeAndForward({ [WPConstants.STORAGE.PENDING_ACTION]: { action: m.action, ...m } }, m);
  }),
  'transfer-ownership': (m, _s, sr) => respondAsync(sr, async () => {
    if (!await hasStremioTabs() && WPBackgroundRoomService.isActive()) {
      await WPBackgroundRoomService.transferOwnership(m.targetUserId);
      return { ok: true };
    }
    return storeAndForward({ [WPConstants.STORAGE.PENDING_ACTION]: { action: m.action, ...m } }, m);
  }),
  'update-username': (m, _s, sr) => respondAsync(sr, async () => {
    if (!await hasStremioTabs() && WPBackgroundRoomService.isActive()) {
      await WPBackgroundRoomService.updateUsername(m.username);
      return { ok: true };
    }
    await forwardToStremioTab(m);
    return { ok: true };
  }),
  'ready-check': (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTab(m); return { ok: true }; }),
  'send-bookmark': (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTab(m); return { ok: true }; }),
  'seek-bookmark': (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTab(m); return { ok: true }; }),
  'send-chat': (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTab(m); return { ok: true }; }),
  'send-typing': (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTab(m); return { ok: true }; }),
  'send-reaction': (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTab(m); return { ok: true }; }),
  'send-presence': (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTab(m); return { ok: true }; }),
  'send-playback-status': (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTab(m); return { ok: true }; }),
  'request-sync': (m, _s, sr) => respondAsync(sr, async () => { await forwardToStremioTab(m); return { ok: true }; }),
  'profile-updated': (m) => broadcastToWatchParty({ action: 'profile-updated', data: m.data }),
  'surface-ready': (m, sender) => {
    rememberSurfaceTab(sender?.tab ? (m.surface || null) : null, sender?.tab?.id ?? null);
    if (m.surface === 'stremio' && WPBackgroundRoomService.isActive()) {
      WPBackgroundRoomService.handoffToTab().catch(() => {});
    }
  },
  'resume-room': (_m, _s, sendResponse) => respondAsync(sendResponse, () => resumeRoomInStremio()),
  'open-options': (_m, _s, sendResponse) => respondAsync(sendResponse, async () => {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }),
  'save-auth-key': (m) => {
    if (m.authKey) { chrome.storage.session.set({ [WPConstants.STORAGE.SAVED_AUTH_KEY]: m.authKey }); tryProfileSync(); }
  },
  'proxy-fetch': (m, _s, sendResponse) => respondAsync(sendResponse, () => proxyFetch(m.url, m.method, m.headers)),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'watchparty-ext') return false;
  const handler = messageHandlers[message.action];
  if (handler) return handler(message, sender, sendResponse) || false;
  return false;
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  forgetSurfaceTab(tabId);
});

chrome.action?.onClicked?.addListener(async (tab) => {
  try {
    if (tab?.id != null && tab.url && urlMatchesOrigins(tab.url, STREMIO_WEB_ORIGINS)) {
      rememberSurfaceTab('stremio', tab.id);
      if (await openSidebarOnTab(tab)) return;
      await focusTab(tab);
      return;
    }

    const resumed = await resumeRoomInStremio();
    if (resumed.ok) return;

    await openOrFocusWatchParty();
  } catch (error) {
    console.warn('[WP-BG] action click failed:', error?.message || String(error));
  }
});

// ── Forward popup commands to the active Stremio content script ──

async function forwardToStremioTab(message) {
  try {
    const tabs = await getStremioTabs();
    // Debug logging removed for production — uncomment for troubleshooting:
    // console.log(`[WP-BG] forwardToStremioTab: action=${message.action}, tabs found=${tabs.length}`);
    const deliveries = [];
    for (const tab of tabs) {
      if (tab.id != null) {
        deliveries.push(
          chrome.tabs.sendMessage(tab.id, { type: 'watchparty-ext', ...message })
            .catch((e) => {
              forgetSurfaceTab(tab.id);
              console.warn(`[WP-BG] sendMessage to tab ${tab.id} failed:`, e.message);
            })
        );
      }
    }
    await Promise.allSettled(deliveries);
  } catch (e) { console.warn('[WP-BG] forwardToStremioTab failed:', e.message); }
}

// ── Broadcast helpers ──

async function broadcastToTabs(urlPatterns, message) {
  try {
    const tabs = urlPatterns === STREMIO_WEB_URLS
      ? await getStremioTabs()
      : await getWatchPartyTabs();
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'watchparty-ext', ...message }).catch(() => {
          forgetSurfaceTab(tab.id);
        });
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
    const isStremio = urlMatchesOrigins(tab.url, STREMIO_WEB_ORIGINS);
    const isWatchParty = urlMatchesOrigins(tab.url, WATCHPARTY_ORIGINS);
    if (isStremio) {
      rememberSurfaceTab('stremio', tabId);
      if (WPBackgroundRoomService.isActive()) {
        WPBackgroundRoomService.handoffToTab().catch(() => {});
      }
    } else if (isWatchParty) {
      rememberSurfaceTab('watchparty', tabId);
    } else {
      forgetSurfaceTab(tabId);
    }
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
    const tabs = await getStremioTabs();
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
getStremioTabs().then((tabs) => {
  if (tabs.length > 0) {
    handoffBackgroundRoomToTab().catch(() => {});
  } else {
    WPBackgroundRoomService.resumeIfNeeded().catch(() => {});
  }
}).catch(() => {});
// Dev-only: auto-reload on file changes (no update_url = unpacked/dev extension)
if (!('update_url' in chrome.runtime.getManifest())) connectDevReload();
