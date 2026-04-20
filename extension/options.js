'use strict';

const $ = (id) => document.getElementById(id);

let lastStatus = null;
let refreshTimer = null;

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

function getRoomDisplayName(status) {
  const room = status?.room;
  if (!room) return '';
  return room.name || room.meta?.name || room.id?.slice(0, 8) || 'Current room';
}

function renderBackend(status) {
  const selectedMode = WPConstants.BACKEND.normalizeMode(status?.backendMode);
  document.querySelectorAll('#backend-toggle .backend-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === selectedMode);
  });

  const displayBackendKey = WPConstants.BACKEND.resolveBackendKey(selectedMode, status?.activeBackend);
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
  setText('diag-room-service', status?.roomServiceActive ? 'Active in background' : 'Idle');
  setText('diag-room-error', status?.roomServiceError?.message || 'None');

  setPill('pill-extension', status?.stremioRunning ? 'Extension ready' : 'Extension active', status?.stremioRunning ? 'success' : '');
  const backendKey = WPConstants.BACKEND.resolveBackendKey(status?.backendMode, status?.activeBackend);
  setPill('pill-backend', `${WPConstants.BACKEND.getInfo(backendKey).label} backend`, status?.wsConnected ? 'success' : 'warn');

  if (!status) {
    $('hero-note').textContent = 'WatchParty could not read extension status just now. Try refreshing this page.';
  } else if (status.room) {
    $('hero-note').textContent = 'A room is already active. Go to it in Stremio to focus the tab and reopen the WatchParty sidebar.';
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
    const status = await chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: 'get-status',
    });
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
      await chrome.storage.local.set({ [WPConstants.STORAGE.BACKEND_MODE]: mode });
      await refreshStatus();
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
  bindBackendButtons();
  $('btn-open-watchparty').addEventListener('click', openWatchParty);
  $('btn-open-stremio').addEventListener('click', openStremio);
  $('btn-resume-room').addEventListener('click', () => { resumeRoom().catch(() => {}); });
  $('btn-refresh').addEventListener('click', () => { refreshStatus().catch(() => {}); });

  chrome.storage.onChanged.addListener((changes) => {
    if (
      changes[WPConstants.STORAGE.BACKEND_MODE]
      || changes[WPConstants.STORAGE.ACTIVE_BACKEND]
      || changes[WPConstants.STORAGE.ACTIVE_BACKEND_URL]
      || changes[WPConstants.STORAGE.WS_CONNECTED]
      || changes[WPConstants.STORAGE.ROOM_STATE]
      || changes[WPConstants.STORAGE.ROOM_SERVICE_ACTIVE]
      || changes[WPConstants.STORAGE.ROOM_SERVICE_ERROR]
    ) {
      refreshStatus().catch(() => {});
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshStatus().catch(() => {});
  });

  startAutoRefresh();
  refreshStatus().catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
