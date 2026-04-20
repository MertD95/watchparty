// WatchParty for Stremio — Content Script (WatchParty pages)
// Signals extension presence, relays Stremio profile data, and proxies fetch requests.

// Signal extension is installed (synchronous, before app JS runs)
document.documentElement.setAttribute('data-watchparty-ext', '1');

// ── Allowed origins for postMessage validation ──
const ALLOWED_ORIGINS = new Set([
  'https://watchparty.mertd.me',
  'http://localhost:8080',
  'http://localhost:8090',
]);

// ── Relay messages between WatchParty page and background service worker ──

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (!ALLOWED_ORIGINS.has(event.origin)) return;

  if (event.data?.type === 'watchparty-ext-request' && event.data.action === 'get-status') {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'watchparty-ext',
        action: 'get-status',
      });
      window.postMessage({
        type: 'watchparty-ext-response',
        requestId: event.data.requestId,
        data: response,
      }, event.origin || location.origin);
    } catch {
      window.postMessage({
        type: 'watchparty-ext-response',
        requestId: event.data.requestId,
        data: { stremioRunning: false, profile: null },
      }, event.origin || location.origin);
    }
  }
});

// ── Relay cached profile on page load ──

async function sendCachedProfile() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: 'get-status',
    });
    window.postMessage({ type: 'watchparty-ext-profile', data: response }, location.origin);
  } catch { /* extension context invalidated */ }
}

function onReady() {
  document.dispatchEvent(new CustomEvent('watchparty-ext-ready', {
    detail: { version: chrome.runtime.getManifest().version },
  }));
  chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: 'surface-ready',
    surface: 'watchparty',
  }).catch(() => {});
  sendCachedProfile();
  // Pass any saved authKey to the extension so it can fetch addons via API
  // (without the user needing to visit web.strem.io)
  try {
    const raw = localStorage.getItem('stremio.authKey');
    if (raw) {
      const authKey = JSON.parse(raw);
      if (authKey) chrome.runtime.sendMessage({ type: 'watchparty-ext', action: 'save-auth-key', authKey });
    }
  } catch { /* no saved auth key */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onReady);
} else {
  onReady();
}

// ── Listen for updates pushed from background ──

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'watchparty-ext') return;
  if (message.action === 'probe-surface') {
    sendResponse({ surface: 'watchparty' });
    return true;
  }
  if (message.action === 'profile-updated') {
    window.postMessage({ type: 'watchparty-ext-profile', data: { profile: message.data } }, location.origin);
  } else if (message.action === 'stremio-status') {
    window.postMessage({ type: 'watchparty-ext-profile', data: { stremioRunning: message.stremioRunning } }, location.origin);
  }
  return false;
});

// ── Handle room join requests from the landing page ──

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!ALLOWED_ORIGINS.has(event.origin)) return;
  if (event.data?.type === 'watchparty-join-room' && event.data.roomId) {
    const updates = {
      [WPConstants.STORAGE.PENDING_ROOM_JOIN]: event.data.roomId,
    };
    const username = typeof event.data.username === 'string' ? event.data.username.trim() : '';
    if (username) updates[WPConstants.STORAGE.USERNAME] = username;
    chrome.storage.local.set(updates);
    if (event.data.preferDirectJoin) {
      chrome.storage.local.set({
        [WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS]: {
          roomId: event.data.roomId,
          preferDirectJoin: true,
          requestedAt: Date.now(),
        },
      });
    } else {
      chrome.storage.local.remove(WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS);
    }
    const roomKey = event.data.roomKey || event.data.cryptoKey;
    // Store room/E2E key in session storage (in-memory only, cleared on browser restart — more secure)
    if (roomKey) {
      const encodedRoomKey = WPConstants.ROOM_KEYS.encodeForLocal(roomKey);
      chrome.storage.session.set({ [WPConstants.STORAGE.roomKey(event.data.roomId)]: roomKey })
        .catch(() => undefined)
        .then(() => encodedRoomKey
          ? chrome.storage.local.set({ [WPConstants.STORAGE.roomKey(event.data.roomId)]: encodedRoomKey })
          : undefined);
    }
  }
  if (event.data?.type === 'watchparty-create-room' && event.data.username) {
    const username = typeof event.data.username === 'string' ? event.data.username.trim() : '';
    if (username) {
      chrome.storage.local.set({ [WPConstants.STORAGE.USERNAME]: username }).catch(() => {});
    }
    chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: 'create-room',
      username,
      meta: event.data.meta || { id: 'pending', type: 'movie', name: 'WatchParty Session' },
      stream: event.data.stream || { url: 'https://watchparty.mertd.me/sync' },
      public: event.data.public || false,
      roomName: event.data.roomName,
    });
  }
  if (event.data?.type === 'watchparty-resume-room') {
    chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: 'resume-room',
    }).catch(() => {});
  }
  if (event.data?.type === 'watchparty-open-options') {
    chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: 'open-options',
    }).catch(() => {});
  }
  if (event.data?.type === 'watchparty-open-stremio') {
    chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: 'open-stremio',
      url: typeof event.data.url === 'string' ? event.data.url : undefined,
    }).catch(() => {});
  }
});
