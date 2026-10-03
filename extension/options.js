'use strict';

const $ = (id) => document.getElementById(id);

function buttonById(id) {
  const el = $(id);
  return el instanceof HTMLButtonElement ? el : null;
}

function setHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle('hidden', !!hidden);
}

let lastStatus = null;
let refreshTimer = null;
let backendMutationInFlight = false;
let recoveryMutationInFlight = false;
let launcherInFlight = false;
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

function setRecoveryFeedback(message = '', tone = '') {
  const el = $('recovery-feedback');
  if (!el) return;
  el.textContent = message;
  el.className = 'backend-feedback';
  if (tone) el.classList.add(tone);
}

function setDevLocalhostFeedback(message = '', tone = '') {
  const el = $('dev-localhost-feedback');
  if (!el) return;
  el.textContent = message;
  el.className = 'backend-feedback';
  if (tone) el.classList.add(tone);
}

function getExtensionState(keys) {
  return WPRuntimeState.get(keys);
}

function setExtensionState(values) {
  return WPRuntimeState.set(values);
}

function boundedClipboardResult(work, timeoutMs) {
  let timer;
  return Promise.race([
    work,
    new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]).catch(() => false).finally(() => clearTimeout(timer));
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return Promise.resolve(false);
  const copied = await boundedClipboardResult(Promise.resolve().then(() => chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: WPConstants.ACTION.CLIPBOARD_COPY,
    text: value,
  })).then((response) => response?.ok === true), 5000);
  if (copied) return true;
  return boundedClipboardResult(Promise.resolve().then(() => navigator.clipboard.writeText(value)).then(() => true), 1500);
}

function setBackendButtonsState(selectedMode, options = {}) {
  const pendingMode = options.pendingMode || null;
  const disabled = !!options.disabled;
  document.querySelectorAll('#backend-toggle .backend-btn').forEach((btn) => {
    if (!(btn instanceof HTMLButtonElement)) return;
    const localUnavailable = btn.dataset.mode === WPConstants.BACKEND.MODES.LOCAL
      && !WPConstants.BACKEND.canUseLocal();
    btn.hidden = localUnavailable;
    const isActive = btn.dataset.mode === selectedMode;
    const isPending = btn.dataset.mode === pendingMode;
    btn.classList.toggle('active', isActive);
    btn.classList.toggle('pending', isPending);
    btn.disabled = disabled || localUnavailable;
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
  const backendNote = $('backend-note');
  if (!backendNote) return;
  const localAvailable = WPConstants.BACKEND.canUseLocal();
  setHidden($('backend-toggle'), !localAvailable);
  setHidden($('backend-mode-help'), !localAvailable);
  if (!localAvailable) {
    backendNote.textContent = 'WatchParty uses the production server automatically. No connection setting is needed.';
    return;
  }
  if (selectedMode === WPConstants.BACKEND.MODES.AUTO) {
    backendNote.textContent = status?.activeBackend
      ? `Automatic selection is using the ${info.key === WPConstants.BACKEND.MODES.LOCAL ? 'local development' : 'production'} server.`
      : 'Automatic selection is on. No changes are needed for normal use.';
    return;
  }
  backendNote.textContent = info.key === WPConstants.BACKEND.MODES.LOCAL
    ? 'Using your local development server. Choose Automatic when you are done testing.'
    : 'Using the production server.';
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
  const resumeBtn = buttonById('btn-resume-room');
  if (!roomPill || !roomCard || !resumeBtn) return;
  setHidden(resumeBtn, !hasResumeTarget);
  setHidden($('btn-open-stremio'), hasResumeTarget);

  if (!hasResumeTarget) {
    setHidden(roomPill, true);
    setHidden(roomCard, true);
    resumeBtn.textContent = 'Return to room';
    resumeBtn.disabled = true;
    return;
  }

  resumeBtn.textContent = bootstrapPending && !room ? 'Continue in Stremio' : 'Return to room';
  resumeBtn.disabled = launcherInFlight;

  if (!room) {
    setHidden(roomPill, false);
    setPill(
      'pill-room',
      bootstrapPending ? 'Setup pending' : 'Room saved',
      'warn'
    );
    setHidden(roomCard, false);
    setText(
      'session-title',
      bootstrapPending
        ? 'Finish room setup in Stremio'
        : `Resume room ${currentRoomId.slice(0, 8)}`
    );
    setText(
      'session-meta',
      bootstrapPending
        ? 'Continue in Stremio to create or join your room.'
        : 'Return to Stremio to reconnect to this room.'
    );
    return;
  }

  const userCount = Array.isArray(room.users) ? room.users.length : 0;
  setHidden(roomPill, false);
  setPill('pill-room', 'In a room', 'success');
  setHidden(roomCard, false);
  setText('session-title', getRoomDisplayName(status));
  setText(
    'session-meta',
    `${room.public === false ? 'Invite key required' : 'Anyone can join'} · ${userCount} watching`
  );
}

function renderIssueList(id, issues, emptyText) {
  const el = $(id);
  if (!el) return;
  el.replaceChildren();
  if (!Array.isArray(issues) || issues.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'diag-list-empty';
    empty.textContent = emptyText;
    el.appendChild(empty);
    return;
  }
  for (const issue of issues.slice(0, 4)) {
    const scope = issue.roomId ? `Room ${issue.roomId.slice(0, 8)}` : (issue.clientId ? `Client ${issue.clientId.slice(0, 8)}` : 'Global');
    const item = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = `[${issue.severity || 'info'}]`;
    item.appendChild(strong);
    item.append(` ${issue.code || 'unknown'}`);
    item.appendChild(document.createElement('br'));
    item.append(`${scope} - ${issue.message || ''}`);
    el.appendChild(item);
  }
}

function renderLocalLandingAccess(status) {
  const block = $('dev-localhost-block');
  const button = $('btn-toggle-local-landing');
  const note = $('dev-localhost-note');
  if (!block || !button || !note) return;

  const access = status?.localLandingAccess || null;
  const available = status?.isDevInstall === true && access?.available === true;
  if (!available) {
    block.classList.add('hidden');
    return;
  }

  block.classList.remove('hidden');
  const enabled = access?.enabled === true;
  const granted = access?.granted === true;
  button.textContent = granted ? 'Disable local access' : 'Enable local access';
  note.textContent = enabled
    ? 'Enabled for localhost and 127.0.0.1 in this development install.'
    : 'Off. Installed extensions do not need local website access.';
}

function formatDiagnosticTimestamp(value) {
  if (!value) return 'Server diagnostics unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Server diagnostics unavailable';
  return `Server snapshot ${date.toLocaleString()}`;
}

function describeHealth(extensionIssues, serverIssues) {
  const total = extensionIssues + serverIssues;
  if (total === 0) return 'No warnings reported';
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
  const health = status ? describeHealth(extensionIssues, serverIssues) : 'Unavailable';
  const contentHandoff = describeContentHandoff(status);

  setText('diag-extension', `v${extensionVersion}`);
  setText('diag-bg-version', `Runtime build v${status?.bgVersion || extensionVersion}`);
  setText('diag-ws', status ? (status.wsConnected ? 'Connected' : 'Disconnected') : 'Unavailable');
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
    !status ? 'Could not read the extension status'
      : !status.serverDiagnostics ? 'Extension checks only. Server checks are unavailable.'
        : extensionIssues + serverIssues === 0 ? 'Extension and server checks completed'
          : `${extensionIssues} extension / ${serverIssues} server issue${extensionIssues + serverIssues === 1 ? '' : 's'}`
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
      ? `${status.room.public === false ? 'Invite key required' : 'Open join'} | ${status.room.listed === false ? 'Hidden from public lists' : 'Listed publicly'} | ${roomUserCount} watching`
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
  renderIssueList('diag-server-issue-list', status?.serverDiagnostics?.invariants,
    status?.serverDiagnostics ? 'No server warnings reported.' : 'Server checks are not available for this connection.');

  setPill('pill-extension', status ? 'Extension ready' : 'Status unavailable', status ? 'success' : 'warn');
  const roomExpected = !!(status?.room || status?.currentRoomId || status?.bootstrapPending);
  setPill('pill-backend', !status ? 'Connection unknown' : status.wsConnected ? 'Connected' : roomExpected ? 'Not connected' : 'No room connected',
    status?.wsConnected ? 'success' : roomExpected ? 'warn' : '');

  if (!status) {
    setText('hero-note', 'Could not read the extension status. Open Technical details below to refresh.');
  } else if (status.room) {
    setText('hero-note', 'Your room is ready to open in Stremio.');
  } else if (status.bootstrapPending) {
    setText('hero-note', 'One more step: continue your room setup in Stremio.');
  } else if (status.currentRoomId) {
    setText('hero-note', 'You have a saved room. Return to Stremio to reconnect.');
  } else if (status.hasStremioTab) {
    setText('hero-note', 'Stremio is open. Use its WatchParty sidebar to create or join a room.');
  } else {
    setText('hero-note', 'Open Stremio, then use the WatchParty sidebar to create or join a room.');
  }

  renderSession(status);
  renderBackend(status);
  renderLocalLandingAccess(status);
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
    if (status) {
      const backendInfo = WPConstants.BACKEND.getInfo(WPConstants.BACKEND.resolveKey(
        status.backendMode,
        status.activeBackend,
      ));
      if (backendInfo.key === WPConstants.BACKEND.MODES.LOCAL) {
        try {
          const diagnosticsResponse = await Promise.race([
            chrome.runtime.sendMessage({
              type: 'watchparty-ext',
              action: WPConstants.ACTION.SERVER_DIAGNOSTICS_GET,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('diagnostics-timeout')), 2500)),
          ]);
          status.serverDiagnostics = diagnosticsResponse?.serverDiagnostics ?? null;
        } catch {
          status.serverDiagnostics = null;
        }
      } else {
        status.serverDiagnostics = null;
      }
    }
    renderStatus(status);
  } catch {
    renderStatus(null);
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
  const button = buttonById(buttonId);
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
  } catch (error) {
    setRecoveryFeedback((error instanceof Error ? error.message : '') || messages.errorMessage || 'Recovery action failed.', 'warn');
  } finally {
    recoveryMutationInFlight = false;
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
  refreshStatus().catch(() => {});
}

async function requestRecovery(kind) {
  const result = await chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: WPConstants.ACTION.SESSION_RECOVERY_REQUEST,
    kind,
  });
  if (result?.ok !== true) throw new Error(result?.error || 'Recovery did not complete. Refresh your Stremio tabs and try again.');
  return result.count || 0;
}

async function clearBootstrapHandoff() {
  return requestRecovery('clear-room');
}

async function clearPrivateKeys() {
  return requestRecovery('forget-keys');
}

async function resetWatchPartyState() {
  return requestRecovery('reset');
}

function bindRecoveryButtons() {
  $('btn-clear-bootstrap')?.addEventListener('click', () => {
    if (recoveryMutationInFlight || !window.confirm('Leave your current room in all Stremio tabs and clear any pending join? Your name and saved invite keys will be kept.')) return;
    runRecoveryAction('btn-clear-bootstrap', clearBootstrapHandoff, {
      pendingLabel: 'Clearing...',
      pendingMessage: 'Clearing the saved room...',
      successMessage: 'Left the room and cleared pending joins in all Stremio tabs. Open an invite or create a room to start again.',
      errorMessage: 'Could not clear the saved room.',
    }).catch(() => {});
  });

  $('btn-clear-room-keys')?.addEventListener('click', () => {
    if (recoveryMutationInFlight || !window.confirm('Forget all saved private room keys? You will need the original invite links to rejoin those rooms.')) return;
    runRecoveryAction('btn-clear-room-keys', clearPrivateKeys, {
      pendingLabel: 'Clearing...',
      pendingMessage: 'Removing saved room keys...',
      successWithCount: (count) => count > 0
        ? `Cleared ${count} cached private invite key${count === 1 ? '' : 's'}.`
        : 'No cached private invite keys were stored.',
      errorMessage: 'Could not clear cached private invite keys.',
    }).catch(() => {});
  });

  $('btn-reset-runtime')?.addEventListener('click', () => {
    if (recoveryMutationInFlight || !window.confirm('Reset WatchParty in this browser? This clears your saved name, session, room state and private room keys. Appearance and connection preferences will be kept.')) return;
    runRecoveryAction('btn-reset-runtime', resetWatchPartyState, {
      pendingLabel: 'Resetting...',
      pendingMessage: 'Resetting WatchParty...',
      successMessage: 'WatchParty reset. Your appearance and connection preferences were kept.',
      errorMessage: 'Could not reset WatchParty state.',
    }).catch(() => {});
  });

  $('btn-copy-diagnostics')?.addEventListener('click', async () => {
    if (recoveryMutationInFlight) return;
    const button = buttonById('btn-copy-diagnostics');
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

async function toggleLocalLandingAccess() {
  const access = lastStatus?.localLandingAccess;
  const origins = Array.isArray(access?.origins) ? access.origins : [];
  if (!lastStatus?.isDevInstall || origins.length === 0) return;

  const button = buttonById('btn-toggle-local-landing');
  const enable = access?.granted !== true;

  if (button) {
    button.disabled = true;
    button.textContent = enable ? 'Enabling...' : 'Disabling...';
  }

  setDevLocalhostFeedback(
    enable ? 'Requesting localhost landing access...' : 'Removing localhost landing access...',
    'warn'
  );

  try {
    if (enable) {
      const granted = await chrome.permissions.request({ origins });
      if (!granted) {
        setDevLocalhostFeedback('Localhost landing access was not granted.', 'warn');
        return;
      }
    } else {
      await chrome.permissions.remove({ origins });
    }

    const response = await chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: WPConstants.ACTION.LOCAL_LANDING_ACCESS_SYNC,
    });
    if (response?.ok === false) {
      setDevLocalhostFeedback('Could not update localhost landing access right now.', 'warn');
      return;
    }

    await refreshStatus();
    setDevLocalhostFeedback(
      enable
        ? 'Enabled localhost landing access for this development install.'
        : 'Disabled localhost landing access for this development install.',
      'success'
    );
  } catch {
    setDevLocalhostFeedback('Could not update localhost landing access right now.', 'warn');
  } finally {
    if (button) {
      button.disabled = false;
    }
    renderLocalLandingAccess(lastStatus);
  }
}

async function runLauncher(work, { roomId = null } = {}) {
  if (launcherInFlight) return;
  launcherInFlight = true;
  const ids = ['btn-open-watchparty', 'btn-open-stremio', 'btn-resume-room'];
  ids.forEach(id => { const button = buttonById(id); if (button) button.disabled = true; });
  setText('launcher-feedback', 'Opening…');
  let timer;
  const isCurrent = () => !roomId || (lastStatus?.room?.id || lastStatus?.currentRoomId || null) === roomId;
  try {
    const response = await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No reply from the extension. Check Stremio before retrying.')), 8000); }),
    ]);
    if (response?.ok !== true || response.handled === false) throw new Error(response?.error || 'Could not open this page. Please try again.');
    if (isCurrent()) setText('launcher-feedback', 'Opened.');
  } catch (error) {
    if (isCurrent()) setText('launcher-feedback', error instanceof Error ? error.message : 'Could not open this page. Please try again.');
  } finally {
    clearTimeout(timer);
    launcherInFlight = false;
    ids.forEach(id => { const button = buttonById(id); if (button) button.disabled = false; });
    renderSession(lastStatus);
    if (!isCurrent()) setText('launcher-feedback', 'The room changed. Use the current room controls.');
  }
}

function openWatchParty() {
  const browseUrl = WPConstants.BACKEND.getBrowseUrl(lastStatus?.backendMode, lastStatus?.activeBackend);
  return runLauncher(async () => {
    const tab = await chrome.tabs.create({ url: browseUrl });
    return { ok: !!tab?.id };
  });
}

function openStremio() {
  return runLauncher(() => chrome.runtime.sendMessage(
    { type: 'watchparty-ext', action: WPConstants.ACTION.APP_STREMIO_OPEN, url: 'https://web.stremio.com' }
  ));
}

function resumeRoom() {
  const roomId = lastStatus?.room?.id || lastStatus?.currentRoomId || null;
  return runLauncher(() => chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: WPConstants.ACTION.ROOM_RESUME,
    ...(roomId ? { roomId } : {}),
  }), { roomId });
}

function bindBackendButtons() {
  document.querySelectorAll('#backend-toggle .backend-btn').forEach((btn) => {
    if (!(btn instanceof HTMLButtonElement)) return;
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
      setBackendFeedback(`Switching to ${WPConstants.BACKEND.getInfo(WPConstants.BACKEND.resolveKey(mode, lastStatus?.activeBackend)).label} mode...`);
      try {
        await setExtensionState({ [WPConstants.STORAGE.BACKEND_MODE]: mode });
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
  $('btn-toggle-local-landing')?.addEventListener('click', () => { toggleLocalLandingAccess().catch(() => {}); });
  $('btn-open-watchparty')?.addEventListener('click', openWatchParty);
  $('btn-open-stremio')?.addEventListener('click', openStremio);
  $('btn-resume-room')?.addEventListener('click', () => { resumeRoom().catch(() => {}); });
  $('btn-refresh')?.addEventListener('click', async () => {
    const button = buttonById('btn-refresh');
    if (!button) return;
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

  getExtensionState([WPConstants.STORAGE.BACKEND_MODE]).then((result) => {
    // Reading a saved preference must not replace a newer live room snapshot.
    if (!lastStatus) renderBackend({
      backendMode: WPConstants.BACKEND.normalizeMode(result?.[WPConstants.STORAGE.BACKEND_MODE]),
    });
  }).catch(() => {});
  startAutoRefresh();
  refreshStatus().catch(() => {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
}
window.addEventListener('load', init, { once: true });
setTimeout(init, 0);
