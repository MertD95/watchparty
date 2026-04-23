// WatchParty for Stremio - Content Script (WatchParty pages)
// Signals extension presence, relays extension status, and forwards landing-page actions.

// Signal extension is installed (synchronous, before app JS runs)
document.documentElement.setAttribute('data-watchparty-ext', '1');

// Allowed origins for postMessage validation
const ALLOWED_ORIGINS = new Set([
  'https://watchparty.mertd.me',
  'http://localhost:8080',
  'http://localhost:8090',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8090',
]);

function sendRuntimeMessage(message) {
  return chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    ...message,
  }).catch(() => {});
}

// Relay messages between WatchParty page and background service worker
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (!ALLOWED_ORIGINS.has(event.origin)) return;

  if (event.data?.type === 'watchparty-ext-request' && event.data.action === WPConstants.ACTION.STATUS_GET) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'watchparty-ext',
        action: WPConstants.ACTION.STATUS_GET,
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

async function sendCachedProfile() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: WPConstants.ACTION.STATUS_GET,
    });
    window.postMessage({ type: 'watchparty-ext-profile', data: response }, location.origin);
  } catch { /* extension context invalidated */ }
}

function onReady() {
  document.dispatchEvent(new CustomEvent('watchparty-ext-ready', {
    detail: { version: chrome.runtime.getManifest().version },
  }));
  sendRuntimeMessage({
    action: WPConstants.ACTION.SURFACE_READY,
    surface: 'watchparty',
  });
  sendCachedProfile();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onReady);
} else {
  onReady();
}

// Listen for updates pushed from background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'watchparty-ext') return;
  if (message.action === WPConstants.ACTION.PROBE_SURFACE) {
    sendResponse({ surface: 'watchparty' });
    return true;
  }
  if (message.action === WPConstants.ACTION.PROFILE_UPDATED) {
    window.postMessage({ type: 'watchparty-ext-profile', data: { profile: message.data } }, location.origin);
  } else if (message.action === WPConstants.ACTION.STREMIO_STATUS_UPDATED) {
    window.postMessage({ type: 'watchparty-ext-profile', data: { stremioRunning: message.stremioRunning } }, location.origin);
  }
  return false;
});

// Handle room join requests from the landing page.
// Keep website create/join on the same background path as popup/options so the
// extension has one authority for room bootstrap and fallback staging.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!ALLOWED_ORIGINS.has(event.origin)) return;

  if (event.data?.type === 'watchparty-join-room' && event.data.roomId) {
    const username = typeof event.data.username === 'string' ? event.data.username.trim() : '';
    const roomKey = event.data.roomKey || event.data.cryptoKey;
    sendRuntimeMessage({
      action: WPConstants.ACTION.ROOM_JOIN,
      roomId: event.data.roomId,
      username,
      roomKey,
      preferDirectJoin: event.data.preferDirectJoin === true,
    });
  }

  if (event.data?.type === 'watchparty-create-room' && event.data.username) {
    const username = typeof event.data.username === 'string' ? event.data.username.trim() : '';
    sendRuntimeMessage({
      action: WPConstants.ACTION.ROOM_CREATE,
      username,
      meta: event.data.meta || { id: 'pending', type: 'movie', name: 'WatchParty Session' },
      stream: event.data.stream || { url: 'https://watchparty.mertd.me/sync' },
      public: event.data.public || false,
      listed: event.data.listed !== false,
      roomName: event.data.roomName,
    });
  }

  if (event.data?.type === 'watchparty-resume-room') {
    sendRuntimeMessage({ action: WPConstants.ACTION.ROOM_RESUME });
  }

  if (event.data?.type === 'watchparty-open-options') {
    sendRuntimeMessage({ action: WPConstants.ACTION.APP_OPTIONS_OPEN });
  }

  if (event.data?.type === 'watchparty-open-stremio') {
    sendRuntimeMessage({
      action: WPConstants.ACTION.APP_STREMIO_OPEN,
      url: typeof event.data.url === 'string' ? event.data.url : undefined,
    });
  }
});

