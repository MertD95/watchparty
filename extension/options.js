'use strict';

const $ = (id) => document.getElementById(id);

let lastStatus = null;
let refreshTimer = null;
let backendMutationInFlight = false;
let didInit = false;

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setPill(id, text, tone = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'status-pill';
  if (tone) el.classList.add(tone);
}

function setBackendFeedback(message = '', tone = '') {
  const el = $('backend-feedback');
  if (!el) return;
  el.textContent = message;
  el.className = 'backend-feedback';
  if (tone) el.classList.add(tone);
}

function setBackendButtonsState(selectedMode, options = {}) {
  const pendingMode = options.pendingMode || null;
  const disabled = !!options.disabled;
  document.querySelectorAll('#backend-toggle .backend-btn').forEach((btn) => {
    const isActive = btn.dataset.mode === selectedMode;
    const isPending = btn.dataset.mode === pendingMode;
    btn.classList.toggle('active', isActive);
    btn.classList.toggle('pending', isPending);
    btn.disabled = disabled;
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function getRoomDisplayName(status) {
  const room = status?.room;
  if (!room) return '';
  return room.name || room.meta?.name || room.id?.slice(0, 8) || 'Current room';
}

function renderBackend(status) {
  const selectedMode = WPConstants.BACKEND.normalizeMode(status?.backendMode);
  setBackendButtonsState(selectedMode, { disabled: backendMutationInFlight });

  const displayBackendKey = WPConstants.BACKEND.resolveKey(selectedMode, status?.activeBackend);
  const info = WPConstants.BACKEND.getInfo(displayBackendKey);
  const nextUrl = status?.activeBackendUrl || info.wsUrl;
  if (selectedMode === WPConstants.BACKEND.MODES.AUTO) {
    $('backend-note').textContent = status?.activeBackend
      ? `Auto mode is selected. Current backend: ${info.label}${status.activeBackendUrl ? ` (${status.activeBackendUrl})` : ''}.`
      : 'Auto mode is selected. Installed builds use the live backend. Unpacked development builds may use localhost when it is available.';
    return;
  }
  $('backend-note').textContent = `${info.label} mode is selected. ${status?.wsConnected ? `Connected via ${nextUrl}.` : `Next connection will use ${nextUrl}.`}`;
}

function renderSession(status) {
  const room = status?.room || null;
  const roomPill = $('pill-room');
  const roomCard = $('session-card');
  const resumeBtn = $('btn-resume-room');

  if (!room) {
    roomPill.classList.add('hidden');
    roomCard.classList.add('hidden');
    resumeBtn.textContent = 'Go to Room in Stremio';
    resumeBtn.disabled = true;
    return;
  }

  const userCount = Array.isArray(room.users) ? room.users.length : 0;
  roomPill.classList.remove('hidden');
  setPill('pill-room', room.public === false ? 'Private room active' : 'Public room active', 'success');
  roomCard.classList.remove('hidden');
  setText('session-title', getRoomDisplayName(status));
  setText(
    'session-meta',
    `${room.public === false ? 'Invite required' : 'Listed publicly'} | ${userCount} watching`
  );
  resumeBtn.textContent = 'Go to Room in Stremio';
  resumeBtn.disabled = false;
}

function renderStatus(status) {
  lastStatus = status || null;
  const extensionVersion = chrome.runtime.getManifest().version;
  setText('diag-extension', extensionVersion);
  setText('diag-bg-version', status?.bgVersion || '-');
  setText('diag-ws', status?.wsConnected ? 'Connected' : 'Disconnected');
  setText('diag-backend-url', status?.activeBackendUrl || '-');
  setText('diag-stremio', status?.stremioRunning ? 'Detected' : 'Not detected');
  setText('diag-surface', status?.hasStremioTab ? 'Stremio tab available' : 'No Stremio tab');
  setText('diag-room-service', status?.bootstrapPending ? 'Pending until Stremio opens' : 'Idle');
  setText('diag-room-error', 'Stremio tabs own live room connections');

  setPill('pill-extension', status?.stremioRunning ? 'Extension ready' : 'Extension active', status?.stremioRunning ? 'success' : '');
  const backendKey = WPConstants.BACKEND.resolveKey(status?.backendMode, status?.activeBackend);
  setPill('pill-backend', `${WPConstants.BACKEND.getInfo(backendKey).label} backend`, status?.wsConnected ? 'success' : 'warn');

  if (!status) {
    $('hero-note').textContent = 'WatchParty could not read extension status just now. Try refreshing this page.';
  } else if (status.room) {
    $('hero-note').textContent = 'A room is already active. Go to it in Stremio to focus the tab and reopen the WatchParty sidebar.';
  } else if (status.bootstrapPending) {
    $('hero-note').textContent = 'WatchParty is staged and waiting for Stremio. Open it to finish creating or joining the room.';
  } else if (status.hasStremioTab) {
    $('hero-note').textContent = 'Stremio is already open. When a room is active, WatchParty can focus that tab and reopen the in-page sidebar.';
  } else {
    $('hero-note').textContent = 'No room is active right now. Use WatchParty to create or join one, then continue in Stremio.';
  }

  renderSession(status);
  renderBackend(status);
}

async function refreshStatus() {
  try {
    const status = await Promise.race([
      chrome.runtime.sendMessage({
        type: 'watchparty-ext',
        action: 'get-status',
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('status-timeout')), 2500)),
    ]);
    renderStatus(status);
  } catch {
    renderStatus(null);
  }
}

function openWatchParty() {
  const browseUrl = WPConstants.BACKEND.getBrowseUrl(lastStatus?.backendMode, lastStatus?.activeBackend);
  chrome.tabs.create({ url: browseUrl });
}

function openStremio() {
  chrome.runtime.sendMessage(
    { type: 'watchparty-ext', action: 'open-stremio', url: 'https://web.stremio.com' },
    (response) => {
      if (chrome.runtime.lastError || response?.ok === false) {
        chrome.tabs.create({ url: 'https://web.stremio.com' });
      }
    }
  );
}

async function resumeRoom() {
  await chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: 'resume-room',
  });
}

function bindBackendButtons() {
  document.querySelectorAll('#backend-toggle .backend-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = WPConstants.BACKEND.normalizeMode(btn.dataset.mode);
      if (backendMutationInFlight) return;
      const currentMode = WPConstants.BACKEND.normalizeMode(lastStatus?.backendMode);
      if (mode === currentMode) {
        setBackendFeedback(`Already using ${WPConstants.BACKEND.getInfo(WPConstants.BACKEND.resolveKey(mode, lastStatus?.activeBackend)).label} mode.`, 'warn');
        return;
      }

      backendMutationInFlight = true;
      setBackendButtonsState(currentMode, { pendingMode: mode, disabled: true });
      setBackendFeedback(`Switching to ${WPConstants.BACKEND.getInfo(WPConstants.BACKEND.resolveKey(mode, lastStatus?.activeBackend)).label} mode…`);
      try {
        await chrome.storage.local.set({ [WPConstants.STORAGE.BACKEND_MODE]: mode });
        lastStatus = { ...(lastStatus || {}), backendMode: mode };
        renderBackend(lastStatus);
        await refreshStatus();
        setBackendFeedback(`Using ${WPConstants.BACKEND.getInfo(WPConstants.BACKEND.resolveKey(mode, lastStatus?.activeBackend)).label} mode.`, 'success');
      } catch {
        setBackendFeedback('Could not update backend mode right now.', 'warn');
      } finally {
        backendMutationInFlight = false;
        renderBackend(lastStatus);
      }
    });
  });
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.hidden) refreshStatus().catch(() => {});
  }, 5000);
}

function init() {
  if (didInit) return;
  didInit = true;
  bindBackendButtons();
  $('btn-open-watchparty').addEventListener('click', openWatchParty);
  $('btn-open-stremio').addEventListener('click', openStremio);
  $('btn-resume-room').addEventListener('click', () => { resumeRoom().catch(() => {}); });
  $('btn-refresh').addEventListener('click', async () => {
    const button = $('btn-refresh');
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Refreshing...';
    try {
      await Promise.all([
        refreshStatus(),
        new Promise((resolve) => setTimeout(resolve, 180)),
      ]);
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (
      changes[WPConstants.STORAGE.BACKEND_MODE]
      || changes[WPConstants.STORAGE.ACTIVE_BACKEND]
      || changes[WPConstants.STORAGE.ACTIVE_BACKEND_URL]
      || changes[WPConstants.STORAGE.WS_CONNECTED]
      || changes[WPConstants.STORAGE.ROOM_STATE]
      || changes[WPConstants.STORAGE.CURRENT_ROOM]
      || changes[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]
    ) {
      refreshStatus().catch(() => {});
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshStatus().catch(() => {});
  });

  renderStatus(null);
  startAutoRefresh();
  refreshStatus().catch(() => {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
}
window.addEventListener('load', init, { once: true });
setTimeout(init, 0);
