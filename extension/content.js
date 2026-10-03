// WatchParty page bridge: acceptance is controller dispatch, not room membership.
document.documentElement.setAttribute('data-watchparty-ext', '1');
document.documentElement.setAttribute('data-watchparty-action-results', '1');

const ALLOWED_ORIGINS = new Set([
  'https://watchparty.mertd.me',
  'http://localhost:8080', 'http://localhost:8090',
  'http://127.0.0.1:8080', 'http://127.0.0.1:8090',
]);
const WEBSITE_ACTIONS = new Set([
  'watchparty-join-room', 'watchparty-resume-room',
  'watchparty-open-options', 'watchparty-open-stremio',
]);
const actionRequests = new Map();
const BRIDGE_TIMEOUT_MS = 8000;
let bridgeUnavailable = false;

function postToPage(message) {
  window.postMessage(message, location.origin);
}

function bridgeError(error) {
  if (!chrome.runtime?.id || /extension context invalidated/i.test(String(error?.message || error))) {
    if (!bridgeUnavailable) {
      bridgeUnavailable = true;
      document.documentElement.removeAttribute('data-watchparty-ext');
      document.documentElement.removeAttribute('data-watchparty-action-results');
      postToPage({ type: 'watchparty-ext-unavailable', error: 'The extension changed or restarted. Refresh this page to reconnect.' });
    }
    return 'The extension changed or restarted. Refresh this page to reconnect.';
  }
  return typeof error?.message === 'string' ? error.message.slice(0, 500) : 'The extension could not complete the request. Please try again.';
}

async function sendRuntimeMessage(message) {
  let timer;
  try {
    if (bridgeUnavailable || !chrome.runtime?.id) throw new Error('Extension context invalidated');
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The extension did not respond. Check Stremio before retrying, or refresh this page.')), BRIDGE_TIMEOUT_MS);
    });
    return await Promise.race([
      Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'watchparty-ext', ...message })),
      timeout,
    ]);
  } catch (error) {
    throw new Error(bridgeError(error));
  } finally {
    clearTimeout(timer);
  }
}

function optionalPrivateKey(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/.test(value)) {
    throw new Error('This private invitation is invalid. Ask the host for a new invite link.');
  }
  return value;
}

function websiteRoomId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(value.trim())) {
    throw new Error('Enter a valid room ID or invite link.');
  }
  return value.trim();
}

function optionalEncryptionKey(value) {
  const key = optionalPrivateKey(value);
  if (key && !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('This encryption key is invalid. Paste the full invite link from the host.');
  return key;
}

function buildWebsiteAction(data, origin) {
  const action = data.type;
  if (action === 'watchparty-resume-room') {
    return { action: WPConstants.ACTION.ROOM_RESUME, ...(data.roomId !== undefined ? { roomId: websiteRoomId(data.roomId) } : {}) };
  }
  if (action === 'watchparty-open-options') return { action: WPConstants.ACTION.APP_OPTIONS_OPEN };
  if (action === 'watchparty-open-stremio') {
    let url;
    if (data.url !== undefined) {
      try {
        if (typeof data.url !== 'string' || data.url.length > 8192) throw new Error();
        const parsed = new URL(data.url);
        if (!['https://web.stremio.com', 'https://web.strem.io', 'https://app.strem.io'].includes(parsed.origin)
          || parsed.username || parsed.password) throw new Error();
        url = parsed.href;
      } catch { throw new Error('This Stremio link is invalid. Open Stremio Web and try again.'); }
    }
    return { action: WPConstants.ACTION.APP_STREMIO_OPEN, url };
  }
  if (data.username != null && typeof data.username !== 'string') throw new Error('Enter a valid display name.');
  const username = (data.username || '').trim();
  if (username.length > 25) throw new Error('Use a display name between 1 and 25 characters.');
  const common = {
    username, accessKey: optionalPrivateKey(data.accessKey), e2eKey: optionalEncryptionKey(data.e2eKey),
    backendMode: origin === 'https://watchparty.mertd.me' ? WPConstants.BACKEND.MODES.LIVE : WPConstants.BACKEND.MODES.LOCAL,
  };
  return { ...common, action: WPConstants.ACTION.ROOM_JOIN, roomId: websiteRoomId(data.roomId), preferDirectJoin: data.preferDirectJoin === true };
}

async function runWebsiteAction(data, origin) {
  try {
    const response = await sendRuntimeMessage(buildWebsiteAction(data, origin));
    // Do not expose arbitrary runtime fields: keys, credentials, or tab URLs.
    if (!response || response.ok !== true || response.handled === false) {
      return { ok: false, handled: false, error: typeof response?.error === 'string'
        ? response.error.slice(0, 500) : 'The extension could not complete the request. Check Stremio and try again.' };
    }
    return { ok: true, handled: true, staged: response.staged === true, needsStremio: response.needsStremio === true };
  } catch (error) {
    return { ok: false, handled: false, error: bridgeError(error) };
  }
}

window.addEventListener('message', async (event) => {
  if (event.source !== window || event.origin !== location.origin || !ALLOWED_ORIGINS.has(event.origin)) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'watchparty-ext-request' && data.action === WPConstants.ACTION.STATUS_GET) {
    try {
      const response = await sendRuntimeMessage({ action: WPConstants.ACTION.STATUS_GET });
      postToPage({ type: 'watchparty-ext-response', requestId: data.requestId, data: response });
    } catch (error) {
      postToPage({ type: 'watchparty-ext-response', requestId: data.requestId, data: { ok: false, error: bridgeError(error) } });
    }
    return;
  }
  if (!WEBSITE_ACTIONS.has(data.type)) return;
  // Every mutation requires correlation. Reuse its result while cached,
  // including uncertain timed-out deliveries: do not auto-retry them.
  const requestId = typeof data.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.requestId) ? data.requestId : null;
  if (!requestId) return;
  let pending = actionRequests.get(requestId);
  if (pending && pending.action !== data.type) {
    postToPage({ type: 'watchparty-ext-action-result', requestId, action: data.type, ok: false, handled: false, error: 'This request ID was already used. Please try again.' });
    return;
  }
  if (!pending) {
    pending = { action: data.type, result: runWebsiteAction(data, event.origin) };
    if (actionRequests.size >= 64) actionRequests.delete(actionRequests.keys().next().value);
    actionRequests.set(requestId, pending);
  }
  const result = await pending.result;
  postToPage({ type: 'watchparty-ext-action-result', requestId, action: data.type, ...result });
});

async function sendCachedProfile() {
  try {
    const response = await sendRuntimeMessage({ action: WPConstants.ACTION.STATUS_GET });
    if (response) postToPage({ type: 'watchparty-ext-profile', data: response });
  } catch { /* Availability failures have already been reported by the bridge. */ }
}

function onReady() {
  try {
    if (!chrome.runtime?.id) throw new Error('Extension context invalidated');
    document.dispatchEvent(new CustomEvent('watchparty-ext-ready', {
      detail: { version: chrome.runtime.getManifest().version, actionResults: true },
    }));
    void sendRuntimeMessage({ action: WPConstants.ACTION.SURFACE_READY, surface: 'watchparty' }).catch(() => {});
    void sendCachedProfile();
  } catch (error) { bridgeError(error); }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
else onReady();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'watchparty-ext') return false;
  if (message.action === WPConstants.ACTION.PROBE_SURFACE) {
    sendResponse({ surface: 'watchparty' });
    return true;
  }
  if (message.action === WPConstants.ACTION.PROFILE_UPDATED) {
    void sendCachedProfile();
  } else if (message.action === WPConstants.ACTION.STREMIO_STATUS_UPDATED) {
    postToPage({ type: 'watchparty-ext-profile', data: { stremioRunning: message.stremioRunning } });
  } else if (message.action === WPConstants.ACTION.STATUS_UPDATED) {
    postToPage({ type: 'watchparty-ext-status', data: message.payload || {} });
  }
  return false;
});

