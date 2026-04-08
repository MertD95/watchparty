// WatchParty for Stremio — Content Script (WatchParty pages)
// Signals extension presence, relays Stremio profile data, and proxies fetch requests.

// Signal extension is installed (synchronous, before app JS runs)
document.documentElement.setAttribute('data-watchparty-ext', '1');

// ── Inject the fetch/XHR interceptor into the page context ──
// Content scripts run in an isolated world — to override page's fetch/XHR,
// we inject a script tag that runs in the page's main world.
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
script.onload = () => script.remove();
(document.documentElement || document.head || document.body).appendChild(script);

// ── Relay fetch requests from injected.js → background service worker ──

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;

  if (event.data?.type === 'watchparty-ext-fetch-request') {
    const { requestId, url, method, headers } = event.data;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'watchparty-ext',
        action: 'proxy-fetch',
        url,
        method,
        headers,
      });
      // Decode base64 in content script and transfer ArrayBuffer to page (zero-copy)
      if (response.body) {
        const binary = atob(response.body);
        const buffer = new ArrayBuffer(binary.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
        const msg = {
          type: 'watchparty-ext-fetch-response',
          requestId,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          buffer, // ArrayBuffer, will be transferred (zero-copy)
        };
        window.postMessage(msg, '*', [buffer]);
      } else {
        window.postMessage({
          type: 'watchparty-ext-fetch-response',
          requestId,
          ...response,
        }, '*');
      }
    } catch (e) {
      window.postMessage({
        type: 'watchparty-ext-fetch-response',
        requestId,
        error: e.message || 'Extension proxy failed',
      }, '*');
    }
  }

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
      }, '*');
    } catch {
      window.postMessage({
        type: 'watchparty-ext-response',
        requestId: event.data.requestId,
        data: { stremioRunning: false, profile: null },
      }, '*');
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
    window.postMessage({ type: 'watchparty-ext-profile', data: response }, '*');
  } catch { /* extension context invalidated */ }
}

function onReady() {
  document.dispatchEvent(new CustomEvent('watchparty-ext-ready', {
    detail: { version: chrome.runtime.getManifest().version },
  }));
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

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'watchparty-ext') return;
  if (message.action === 'profile-updated') {
    window.postMessage({ type: 'watchparty-ext-profile', data: { profile: message.data } }, '*');
  } else if (message.action === 'stremio-status') {
    window.postMessage({ type: 'watchparty-ext-profile', data: { stremioRunning: message.stremioRunning } }, '*');
  }
});

// ── Handle room join requests from the landing page ──

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type === 'watchparty-join-room' && event.data.roomId) {
    // Store pending room join for the extension to pick up when Stremio Web loads
    chrome.storage.local.set({ pendingRoomJoin: event.data.roomId });
  }
});
