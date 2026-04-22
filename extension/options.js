'use strict';

const $ = (id) => document.getElementById(id);

let lastStatus = null;
let lastServerDiagnostics = null;
let refreshTimer = null;
let backendMutationInFlight = false;
let recoveryMutationInFlight = false;
let didInit = false;
const RECOVERY_RESET_LOCAL_KEYS = [
  WPConstants.STORAGE.USERNAME,
  WPConstants.STORAGE.SESSION_ID,
  WPConstants.STORAGE.STREMIO_PROFILE,
];
const RECOVERY_RESET_SESSION_KEYS = [
  ...WPConstants.STORAGE_CONTRACT.SESSION_RUNTIME,
  ...WPConstants.STORAGE_CONTRACT.BOOTSTRAP_SESSION,
  ...WPConstants.STORAGE_CONTRACT.SENSITIVE_SESSION,
];

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

function setRecoveryFeedback(message = '', tone = '') {
  const el = $('recovery-feedback');
  if (!el) return;
  el.textContent = message;
  el.className = 'backend-feedback';
  if (tone) el.classList.add(tone);
}

function getExtensionState(keys) {
  return WPRuntimeState.get(keys);
}

function removeExtensionState(keys) {
  return WPRuntimeState.remove(keys);
}

function collectRoomKeyStorageKeys() {
  return WPRoomKeys.collectStorageKeys();
}

function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return Promise.resolve(false);
  return chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: WPConstants.ACTION.CLIPBOARD_COPY,
    text: value,
  }).then((response) => response?.ok === true).catch(async () => {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  });
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
  const currentRoomId = typeof status?.currentRoomId === 'string' && status.currentRoomId.trim()
    ? status.currentRoomId.trim()
    : '';
  const bootstrapPending = status?.bootstrapPending === true;
  const hasResumeTarget = !!room || !!currentRoomId || bootstrapPending;
  const roomPill = $('pill-room');
  const roomCard = $('session-card');
  const resumeBtn = $('btn-resume-room');

  if (!hasResumeTarget) {
    roomPill.classList.add('hidden');
    roomCard.classList.add('hidden');
    resumeBtn.textContent = 'Go to Room in Stremio';
    resumeBtn.disabled = true;
    return;
  }

  resumeBtn.textContent = 'Go to Room in Stremio';
  resumeBtn.disabled = false;

  if (!room) {
    roomPill.classList.remove('hidden');
    setPill(
      'pill-room',
      bootstrapPending ? 'Room handoff pending' : 'Room available to resume',
      'warn'
    );
    roomCard.classList.remove('hidden');
    setText(
      'session-title',
      bootstrapPending
        ? 'Finish room setup in Stremio'
        : `Resume room ${currentRoomId.slice(0, 8)}`
    );
    setText(
      'session-meta',
      bootstrapPending
        ? 'WatchParty has a staged create or join waiting for Stremio.'
        : 'WatchParty still has a resumable room target even though no live room snapshot is available.'
    );
    return;
  }

  const userCount = Array.isArray(room.users) ? room.users.length : 0;
  roomPill.classList.remove('hidden');
  setPill('pill-room', room.public === false ? 'Invite key room active' : 'Open-join room active', 'success');
  roomCard.classList.remove('hidden');
  setText('session-title', getRoomDisplayName(status));
  setText(
    'session-meta',
    `${room.public === false ? 'Invite key required' : 'Open join'} | ${room.listed === false ? 'Hidden from WatchParty' : 'Listed on WatchParty'} | ${userCount} watching`
  );
}

function renderIssueList(id, issues, emptyText) {
  const el = $(id);
  if (!el) return;
  if (!Array.isArray(issues) || issues.length === 0) {
    el.innerHTML = `<li class="diag-list-empty">${emptyText}</li>`;
    return;
  }
  el.innerHTML = issues.slice(0, 4).map((issue) => {
    const scope = issue.roomId ? `Room ${issue.roomId.slice(0, 8)}` : (issue.clientId ? `Client ${issue.clientId.slice(0, 8)}` : 'Global');
    return `<li><strong>[${issue.severity || 'info'}]</strong> ${issue.code || 'unknown'}<br>${scope} — ${issue.message || ''}</li>`;
  }).join('');
}

function formatDiagnosticTimestamp(value) {
  if (!value) return 'Server diagnostics unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Server diagnostics unavailable';
  return `Server snapshot ${date.toLocaleString()}`;
}

function describeHealth(extensionIssues, serverIssues) {
  const total = extensionIssues + serverIssues;
  if (total === 0) return 'Healthy';
  if (extensionIssues > 0 && serverIssues > 0) return 'Needs attention';
  return total === 1 ? '1 warning' : `${total} warnings`;
}

function describeContentHandoff(status) {
  const room = status?.room || null;
  const availability = status?.adapterState?.availability || '';
  if (!room) return 'No active room';
  switch (availability) {
    case WPConstants.ADAPTER_AVAILABILITY.DIRECT_JOIN_READY:
      return 'Direct Join ready';
    case WPConstants.ADAPTER_AVAILABILITY.MANUAL_JOIN_ONLY:
      return 'Manual stream selection required';
    case WPConstants.ADAPTER_AVAILABILITY.DETAIL_ONLY:
      return 'Title known, waiting for player';
    case WPConstants.ADAPTER_AVAILABILITY.PLAYER_PENDING:
      return 'Player detected, still resolving';
    default:
      return 'No Stremio content context yet';
  }
}

function renderStatus(status) {
  lastStatus = status || null;
  lastServerDiagnostics = status?.serverDiagnostics || null;
  const extensionVersion = chrome.runtime.getManifest().version;
  const backendKey = WPConstants.BACKEND.resolveKey(status?.backendMode, status?.activeBackend);
  const backendInfo = WPConstants.BACKEND.getInfo(backendKey);
  const controllerPhase = status?.controllerRuntime?.phase || '-';
  const coordinatorMode = status?.coordinatorMode || '-';
  const adapterRoute = status?.adapterState?.route || '-';
  const adapterAvailability = status?.adapterState?.availability || '-';
  const extensionIssues = Array.isArray(status?.invariants) ? status.invariants.length : 0;
  const serverIssues = status?.serverDiagnostics?.summary?.issues ?? 0;
  const room = status?.room || null;
  const roomUserCount = Array.isArray(status?.room?.users) ? status.room.users.length : 0;
  const roomTarget = status?.room
    ? getRoomDisplayName(status)
    : (status?.bootstrapPending ? 'Staged handoff' : (status?.currentRoomId ? `Resume ${status.currentRoomId.slice(0, 8)}` : 'No active room'));
  const health = describeHealth(extensionIssues, serverIssues);
  const contentHandoff = describeContentHandoff(status);

  setText('diag-extension', `v${extensionVersion}`);
  setText('diag-bg-version', `Runtime build v${status?.bgVersion || extensionVersion}`);
  setText('diag-ws', status?.wsConnected ? 'Connected' : 'Disconnected');
  setText('diag-backend-mode', `${backendInfo.label} backend${status?.backendMode === WPConstants.BACKEND.MODES.AUTO ? ' via Auto' : ''}`);
  setText('diag-backend-url', status?.activeBackendUrl || 'Waiting for backend selection');
  setText('diag-stremio', status?.stremioRunning ? 'Detected locally' : 'Not detected locally');
  setText('diag-surface', status?.hasStremioTab ? 'Stremio tab available' : 'No Stremio tab');
  setText('diag-room-target', roomTarget);
  setText(
    'diag-room-service',
    status?.bootstrapPending
      ? 'Bootstrap handoff pending'
      : `${coordinatorMode}${status?.currentRoomId && !status?.room ? ` | ${status.currentRoomId.slice(0, 8)}` : ''}`
  );
  setText('diag-issue-summary', health);
  setText(
    'diag-server-generated',
    extensionIssues + serverIssues === 0
      ? 'No runtime consistency issues detected'
      : `${extensionIssues} extension / ${serverIssues} backend issue${extensionIssues + serverIssues === 1 ? '' : 's'}`
  );
  setText('diag-coordinator-mode', roomTarget);
  setText('diag-advanced-coordinator-mode', coordinatorMode);
  setText('diag-controller-phase', controllerPhase);
  setText('diag-adapter-route', adapterRoute);
  setText('diag-adapter-availability', contentHandoff);
  setText('diag-advanced-adapter-availability', adapterAvailability);
  setText(
    'diag-room-state',
    status?.room
      ? `${status.room.public === false ? 'Invite key required' : 'Open join'} | ${status.room.listed === false ? 'Hidden from WatchParty' : 'Listed on WatchParty'} | ${roomUserCount} watching`
      : 'No live room snapshot'
  );
  setText(
    'diag-room-error',
    room
      ? `${status?.stremioRunning ? 'Stremio ready' : 'Waiting for Stremio'} | ${contentHandoff}`
      : `${status?.stremioRunning ? 'Stremio ready' : 'Waiting for Stremio'} | Open or focus the room in Stremio to resume live controls`
  );
  setText(
    'diag-ext-issues',
    extensionIssues === 0 ? 'No extension invariant issues' : `${extensionIssues} extension issue${extensionIssues === 1 ? '' : 's'}`
  );
  setText(
    'diag-server-issues',
    status?.serverDiagnostics
      ? (serverIssues === 0 ? 'No backend invariant issues' : `${serverIssues} backend issue${serverIssues === 1 ? '' : 's'}`)
      : 'Backend diagnostics unavailable'
  );
  renderIssueList('diag-ext-issue-list', status?.invariants, 'No extension invariant issues.');
  renderIssueList('diag-server-issue-list', status?.serverDiagnostics?.invariants, 'No backend invariant issues.');

  setPill('pill-extension', status?.stremioRunning ? 'Extension ready' : 'Extension active', status?.stremioRunning ? 'success' : '');
  setPill('pill-backend', `${backendInfo.label} backend`, status?.wsConnected ? 'success' : 'warn');

  if (!status) {
    $('hero-note').textContent = 'Could not read extension status. Refresh and try again.';
  } else if (status.room) {
    $('hero-note').textContent = 'A room is active. Open it in Stremio.';
  } else if (status.bootstrapPending) {
    $('hero-note').textContent = 'WatchParty is staged. Finish in Stremio.';
  } else if (status.hasStremioTab) {
    $('hero-note').textContent = 'Stremio is already open and ready.';
  } else {
    $('hero-note').textContent = 'No room is active. Create or join on WatchParty, then continue in Stremio.';
  }

  renderSession(status);
  renderBackend(status);
}

async function refreshStatus() {
  try {
    const status = await Promise.race([
      chrome.runtime.sendMessage({
        type: 'watchparty-ext',
        action: WPConstants.ACTION.STATUS_GET,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('status-timeout')), 2500)),
    ]);
    const serverDiagnostics = await fetchServerDiagnostics(status).catch(() => null);
    renderStatus({
      ...status,
      serverDiagnostics,
    });
  } catch {
    renderStatus(null);
  }
}

async function fetchServerDiagnostics(status) {
  const backendKey = WPConstants.BACKEND.resolveKey(status?.backendMode, status?.activeBackend);
  const httpUrl = status?.activeBackendHttpUrl || WPConstants.BACKEND.getInfo(backendKey).httpUrl;
  if (!httpUrl) return null;
  if (status?.wsConnected !== true && backendKey !== WPConstants.BACKEND.MODES.LOCAL) return null;
  try {
    const res = await Promise.race([
      fetch(`${httpUrl}/diagnostics`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('diagnostics-timeout')), 2500)),
    ]);
    if (!res?.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function formatInvariantList(title, issues) {
  if (!Array.isArray(issues) || issues.length === 0) return `${title}: none`;
  const lines = [`${title}: ${issues.length}`];
  for (const issue of issues.slice(0, 8)) {
    lines.push(`- [${issue.severity || 'info'}] ${issue.code || 'unknown'}: ${issue.message || ''}`.trim());
  }
  if (issues.length > 8) lines.push(`- ... ${issues.length - 8} more`);
  return lines.join('\n');
}

function buildDiagnosticsText(status) {
  const room = status?.room || null;
  const lines = [
    `WatchParty Diagnostics`,
    `Generated: ${new Date().toISOString()}`,
    `Extension version: ${chrome.runtime.getManifest().version}`,
    `Background build: ${status?.bgVersion || '-'}`,
    `Backend mode: ${WPConstants.BACKEND.normalizeMode(status?.backendMode)}`,
    `Active backend: ${status?.activeBackend || '-'}`,
    `Backend URL: ${status?.activeBackendUrl || '-'}`,
    `Backend HTTP URL: ${status?.activeBackendHttpUrl || '-'}`,
    `WebSocket connected: ${status?.wsConnected ? 'yes' : 'no'}`,
    `Stremio detected: ${status?.stremioRunning ? 'yes' : 'no'}`,
    `Stremio tab available: ${status?.hasStremioTab ? 'yes' : 'no'}`,
    `Bootstrap pending: ${status?.bootstrapPending ? 'yes' : 'no'}`,
    `Coordinator mode: ${status?.coordinatorMode || '-'}`,
    `Controller phase: ${status?.controllerRuntime?.phase || '-'}`,
    `Adapter route: ${status?.adapterState?.route || '-'}`,
    `Adapter availability: ${status?.adapterState?.availability || '-'}`,
    `Room active: ${room ? 'yes' : 'no'}`,
  ];
  if (room) {
    lines.push(
      `Room id: ${room.id}`,
      `Room name: ${getRoomDisplayName(status)}`,
      `Room access: ${room.public === false ? 'invite key required' : 'open join'}`,
      `Room listing: ${room.listed === false ? 'hidden from WatchParty' : 'listed on WatchParty'}`,
      `Room users: ${Array.isArray(room.users) ? room.users.length : 0}`
    );
  }
  lines.push('');
  lines.push(formatInvariantList('Extension invariants', status?.invariants));
  lines.push('');
  lines.push(formatInvariantList('Server invariants', status?.serverDiagnostics?.invariants));
  return lines.join('\n');
}

async function runRecoveryAction(buttonId, work, messages) {
  if (recoveryMutationInFlight) return;
  const button = $(buttonId);
  const originalLabel = button?.textContent || '';
  recoveryMutationInFlight = true;
  if (button) {
    button.disabled = true;
    button.textContent = messages.pendingLabel || originalLabel;
  }
  setRecoveryFeedback(messages.pendingMessage || 'Applying recovery action...', 'warn');
  try {
    const count = await work();
    setRecoveryFeedback(
      typeof count === 'number' && messages.successWithCount
        ? messages.successWithCount(count)
        : (messages.successMessage || 'Recovery action complete.'),
      'success'
    );
  } catch {
    setRecoveryFeedback(messages.errorMessage || 'Recovery action failed.', 'warn');
  } finally {
    recoveryMutationInFlight = false;
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
  refreshStatus().catch(() => {});
}

async function clearBootstrapHandoff() {
  await removeExtensionState([
    WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT,
    WPConstants.STORAGE.DEFERRED_LEAVE_ROOM,
    WPConstants.STORAGE.CURRENT_ROOM,
    WPConstants.STORAGE.ROOM_STATE,
    WPConstants.STORAGE.USER_ID,
    WPConstants.STORAGE.WS_CONNECTED,
    WPConstants.STORAGE.ACTIVE_BACKEND,
    WPConstants.STORAGE.ACTIVE_BACKEND_URL,
    WPConstants.STORAGE.ACTIVE_VIDEO_TAB,
  ]);
  return 1;
}

async function clearRoomKeys() {
  const { localKeys, sessionKeys } = await collectRoomKeyStorageKeys();
  await Promise.all([
    localKeys.length > 0 ? chrome.storage.local.remove(localKeys).catch(() => {}) : Promise.resolve(),
    sessionKeys.length > 0 ? chrome.storage.session.remove(sessionKeys).catch(() => {}) : Promise.resolve(),
  ]);
  return new Set([...localKeys, ...sessionKeys]).size;
}

async function resetWatchPartyState() {
  const { localKeys, sessionKeys } = await collectRoomKeyStorageKeys();
  await removeExtensionState([...RECOVERY_RESET_LOCAL_KEYS, ...RECOVERY_RESET_SESSION_KEYS, ...localKeys]);
  if (sessionKeys.length > 0) {
    await chrome.storage.session.remove(sessionKeys).catch(() => {});
  }
  return RECOVERY_RESET_LOCAL_KEYS.length + RECOVERY_RESET_SESSION_KEYS.length + new Set([...localKeys, ...sessionKeys]).size;
}

function bindRecoveryButtons() {
  $('btn-clear-bootstrap')?.addEventListener('click', () => {
    runRecoveryAction('btn-clear-bootstrap', clearBootstrapHandoff, {
      pendingLabel: 'Clearing...',
      pendingMessage: 'Clearing staged handoff and room runtime state...',
      successMessage: 'Cleared staged handoff and runtime room state.',
      errorMessage: 'Could not clear staged handoff state.',
    }).catch(() => {});
  });

  $('btn-clear-room-keys')?.addEventListener('click', () => {
    runRecoveryAction('btn-clear-room-keys', clearRoomKeys, {
      pendingLabel: 'Clearing...',
      pendingMessage: 'Removing cached room keys from local and session storage...',
      successWithCount: (count) => count > 0
        ? `Cleared ${count} cached room key${count === 1 ? '' : 's'}.`
        : 'No cached room keys were stored.',
      errorMessage: 'Could not clear cached room keys.',
    }).catch(() => {});
  });

  $('btn-reset-runtime')?.addEventListener('click', () => {
    runRecoveryAction('btn-reset-runtime', resetWatchPartyState, {
      pendingLabel: 'Resetting...',
      pendingMessage: 'Resetting WatchParty session identity, runtime state, auth, and invite caches...',
      successMessage: 'Reset WatchParty local and session state while keeping backend mode and appearance preferences.',
      errorMessage: 'Could not reset WatchParty state.',
    }).catch(() => {});
  });

  $('btn-copy-diagnostics')?.addEventListener('click', async () => {
    if (recoveryMutationInFlight) return;
    const button = $('btn-copy-diagnostics');
    const originalLabel = button?.textContent || '';
    if (button) {
      button.disabled = true;
      button.textContent = 'Copying...';
    }
    setRecoveryFeedback('Collecting extension diagnostics...', 'warn');
    try {
      if (!lastStatus) await refreshStatus();
      const copied = await copyTextToClipboard(buildDiagnosticsText(lastStatus));
      setRecoveryFeedback(copied ? 'Diagnostics copied to the clipboard.' : 'Could not copy diagnostics right now.', copied ? 'success' : 'warn');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }
  });
}

function openWatchParty() {
  const browseUrl = WPConstants.BACKEND.getBrowseUrl(lastStatus?.backendMode, lastStatus?.activeBackend);
  chrome.tabs.create({ url: browseUrl });
}

function openStremio() {
  chrome.runtime.sendMessage(
    { type: 'watchparty-ext', action: WPConstants.ACTION.APP_STREMIO_OPEN, url: 'https://web.stremio.com' },
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
    action: WPConstants.ACTION.ROOM_RESUME,
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
  bindRecoveryButtons();
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

  chrome.storage.onChanged.addListener((changes, areaName) => {
    const localKeysChanged = areaName === 'local' && (
      changes[WPConstants.STORAGE.BACKEND_MODE]
      || changes[WPConstants.STORAGE.USERNAME]
      || changes[WPConstants.STORAGE.SESSION_ID]
    );
    const sessionKeysChanged = areaName === 'session' && (
      changes[WPConstants.STORAGE.ACTIVE_BACKEND]
      || changes[WPConstants.STORAGE.ACTIVE_BACKEND_URL]
      || changes[WPConstants.STORAGE.WS_CONNECTED]
      || changes[WPConstants.STORAGE.ROOM_STATE]
      || changes[WPConstants.STORAGE.CURRENT_ROOM]
      || changes[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]
      || changes[WPConstants.STORAGE.DEFERRED_LEAVE_ROOM]
      || changes[WPConstants.STORAGE.ACTIVE_VIDEO_TAB]
    );
    if (localKeysChanged || sessionKeysChanged) {
      refreshStatus().catch(() => {});
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshStatus().catch(() => {});
  });

  chrome.storage.local.get([WPConstants.STORAGE.BACKEND_MODE], (result) => {
    renderStatus({
      backendMode: WPConstants.BACKEND.normalizeMode(result?.[WPConstants.STORAGE.BACKEND_MODE]),
    });
  });
  startAutoRefresh();
  refreshStatus().catch(() => {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
}
window.addEventListener('load', init, { once: true });
setTimeout(init, 0);
