const $ = (id) => document.getElementById(id);

let currentBackendMode = WPConstants.BACKEND.MODES.AUTO;
let currentActiveBackend = null;
let currentActiveBackendUrl = null;
let currentWsConnected = false;
let currentRenderedRoom = null;
let currentUserId = null;
let currentSessionId = null;
let currentLobbyMode = 'create';
let suppressedRoomId = null;
let pendingLeaveRoomId = null;
let membershipClearGeneration = 0;
let pendingLobbyAction = null;
let pendingLobbyRoomId = null;
let copyOperation = 0;
let copyingRoomId = null;
let stremioStatusGeneration = 0;

document.body.dataset.statusReady = 'false';

function getErrorMessage(errorLike, fallback) {
  if (!errorLike) return fallback;
  const code = typeof errorLike?.code === 'string' ? errorLike.code : '';
  if (code === 'ROOM_NOT_FOUND') return 'Room not found. Check the room ID or invite link and try again.';
  if (code === 'ROOM_KEY_REQUIRED') return 'This private room requires an access key.';
  if (code === 'INVALID_ROOM_KEY') return 'The access key is invalid. Paste the full invite link or a fresh key.';
  if (code === 'USERNAME_IN_USE') return 'That display name is already in use in this room. Choose another one.';
  if (code === 'VALIDATION_FAILED') return 'That request was rejected. Check the room details and try again.';
  if (code === 'NOT_OWNER') return 'Only the host can do that.';
  const message = typeof errorLike?.message === 'string' && errorLike.message.trim()
    ? errorLike.message.trim()
    : (typeof errorLike?.error === 'string' && errorLike.error.trim() ? errorLike.error.trim() : '');
  return message || fallback;
}

function getContentDetailUrl(room) {
  if (!room?.meta?.id || !room?.meta?.type) return null;
  if (['pending', 'unknown'].includes(room.meta.id)) return null;
  return `https://web.stremio.com/#/detail/${encodeURIComponent(room.meta.type)}/${encodeURIComponent(room.meta.id)}`;
}

function getDirectStreamUrl(room) {
  return WPUtils.getDirectJoinUrl(room);
}

function showActionError(message = '') {
  $('popup-error').textContent = message;
  $('popup-error').classList.toggle('hidden', !message);
}

function getBrowseUrl() {
  return WPConstants.BACKEND.getBrowseUrl(currentBackendMode, currentActiveBackend);
}

function resetRoomContentLinks() {
  $('content-link-hint')?.classList.add('hidden');
  $('content-name').textContent = '';
  $('content-link')?.classList.add('hidden');
  $('content-link').href = '#';
  $('content-stream-link')?.classList.add('hidden');
  $('content-stream-link').href = '#';
}

function markStatusReady() {
  document.body.dataset.statusReady = 'true';
}

function getExtensionState(keys, callback) {
  const work = WPRuntimeState.get(keys);
  if (typeof callback === 'function') work.then(callback, () => callback({}));
  return work;
}

function setExtensionState(values) {
  return WPRuntimeState.set(values);
}

function openWatchPartyTab() {
  showActionError();
  Promise.resolve(chrome.tabs.create({ url: getBrowseUrl() }))
    .catch(error => showActionError(getErrorMessage(error, 'Could not open the room browser. Try again.')));
}

function openStremioTab() {
  showActionError();
  chrome.runtime.sendMessage(
    { type: 'watchparty-ext', action: WPConstants.ACTION.APP_STREMIO_OPEN, url: 'https://web.stremio.com' },
    (response) => {
      if (chrome.runtime.lastError || response?.ok !== true) {
        Promise.resolve(chrome.tabs.create({ url: 'https://web.stremio.com' }))
          .catch(error => showActionError(getErrorMessage(error, 'Could not open Stremio. Try again.')));
      }
    }
  );
}

function openOptionsPage() {
  showActionError();
  chrome.runtime.openOptionsPage().catch(error => showActionError(getErrorMessage(error, 'Could not open Settings. Try again.')));
}

function updateQuickActions() {
  const resumeBtn = $('btn-resume-room');
  if (!resumeBtn) return;
  resumeBtn.textContent = currentRenderedRoom?.id ? 'Return to room in Stremio' : 'Open Stremio';
  const hasRoom = !!currentRenderedRoom?.id;
  $('btn-leave').disabled = !hasRoom || pendingLeaveRoomId === currentRenderedRoom?.id;
  $('btn-leave').textContent = pendingLeaveRoomId === currentRenderedRoom?.id && hasRoom ? 'Leaving…' : 'Leave room';
  $('btn-share').disabled = !hasRoom || copyingRoomId === currentRenderedRoom?.id;
  $('room-id-display').disabled = !hasRoom || copyingRoomId === currentRenderedRoom?.id;
}

function resumeRoomInStremio() {
  showActionError();
  if (!currentRenderedRoom?.id) {
    openStremioTab();
    return;
  }
  chrome.runtime.sendMessage(
    { type: 'watchparty-ext', action: WPConstants.ACTION.ROOM_RESUME, roomId: currentRenderedRoom.id },
    (response) => {
      if (chrome.runtime.lastError || response?.ok !== true) {
        showActionError(getErrorMessage(chrome.runtime.lastError || response, 'Could not return to this room. Open Stremio and try again.'));
      }
    }
  );
}

function resetLobbyActionButtons() {
  pendingLobbyAction?.();
  pendingLobbyAction = null;
  pendingLobbyRoomId = null;
  $('btn-create').disabled = false;
  $('btn-create').textContent = 'Create Room';
  $('btn-join').disabled = false;
  $('btn-join').textContent = 'Join Room';
}

function copyTextWithFeedback(roomId, target, idleText, successText) {
  if (copyingRoomId === roomId) return Promise.resolve();
  const operation = ++copyOperation;
  const isCurrent = () => operation === copyOperation && currentRenderedRoom?.id === roomId;
  const wasPrivate = currentRenderedRoom?.public === false;
  let copyError = '';
  showActionError();
  copyingRoomId = roomId;
  updateQuickActions();
  return WPUtils.copyTextDeferred(async () => {
    try {
      if (!isCurrent() || (currentRenderedRoom?.public === false) !== wasPrivate) throw new Error('The room changed. Copy its new invite instead.');
      const url = await buildInviteUrlWithKey(roomId);
      if (!isCurrent() || (currentRenderedRoom?.public === false) !== wasPrivate) throw new Error('The room changed. Copy its new invite instead.');
      return url;
    } catch (error) {
      copyError = getErrorMessage(error, 'Could not prepare the invite link.');
      throw error;
    }
  })
    .then((copied) => {
      if (!isCurrent()) return;
      if (!copied) {
        showActionError(copyError || 'Could not copy the invite. Try again or use Copy Invite in Stremio.');
        return;
      }
      target.textContent = successText;
      setTimeout(() => {
        if (isCurrent()) target.textContent = idleText;
      }, 1500);
    })
    .catch(error => {
      if (isCurrent()) showActionError(getErrorMessage(error, 'Could not copy the invite. Try again.'));
    })
    .finally(() => {
      if (operation === copyOperation) copyingRoomId = null;
      updateQuickActions();
    });
}

function setStremioStatus(hasStremioTab) {
  if (hasStremioTab) {
    $('stremio-dot').className = 'dot on';
    $('stremio-status').textContent = 'Stremio open';
  } else {
    $('stremio-dot').className = 'dot';
    $('stremio-status').textContent = 'Stremio closed';
  }
}

function refreshStremioTabStatus() {
  const generation = ++stremioStatusGeneration;
  chrome.runtime.sendMessage({ type: 'watchparty-ext', action: WPConstants.ACTION.STATUS_GET }, response => {
    if (chrome.runtime.lastError || generation !== stremioStatusGeneration || !response) return;
    setStremioStatus(response.hasStremioTab === true);
    updateStatusHint(response.hasStremioTab === true, response.stremioRunning === true, response.bootstrapPending === true);
  });
}

function updateStatusHint(hasStremioTab, stremioRunning, bootstrapPending) {
  const hint = $('status-hint');
  if (!hint) return;
  if (bootstrapPending) {
    hint.textContent = 'Open Stremio to finish joining your room.';
    return;
  }
  if (!hasStremioTab) {
    hint.textContent = '';
    return;
  }
  if (!stremioRunning) {
    hint.textContent = '';
    return;
  }
  hint.textContent = '';
}

function getKnownBackendKey(value) {
  return WPConstants.BACKEND.isKnownKey(value) ? value : null;
}

function getDisplayBackendKey() {
  if (currentActiveBackend) return currentActiveBackend;
  if (currentBackendMode === WPConstants.BACKEND.MODES.LOCAL || currentBackendMode === WPConstants.BACKEND.MODES.LIVE) {
    return currentBackendMode;
  }
  return null;
}

function setWsStatus(isConnected) {
  const displayBackendKey = getDisplayBackendKey();
  const backendInfo = displayBackendKey ? WPConstants.BACKEND.getInfo(displayBackendKey) : null;
  if (isConnected) {
    $('ws-dot').className = 'dot on';
    $('ws-status').textContent = 'Connected';
  } else {
    $('ws-dot').className = currentRenderedRoom ? 'dot off' : 'dot';
    $('ws-status').textContent = currentRenderedRoom ? 'Reconnecting…' : 'Not connected';
  }
  $('ws-status').title = backendInfo ? `${backendInfo.label} server` : 'WatchParty server';
}

function buildInviteUrl(roomId) {
  return WPConstants.BACKEND.buildInviteUrl(roomId, currentBackendMode, currentActiveBackend);
}

async function buildInviteUrlWithKey(roomId) {
  const inviteUrl = buildInviteUrl(roomId);
  if (currentRenderedRoom?.id !== roomId) throw new Error('The room changed. Copy its new invite instead.');
  if (currentRenderedRoom.public !== false) return inviteUrl;
  const privateUrl = await WPRoomKeys.appendToInviteUrl(roomId, inviteUrl);
  const keys = new URLSearchParams(new URL(privateUrl).hash.slice(1));
  if (!keys.get('accessKey') || !keys.get('e2eKey')) {
    throw new Error('This browser is missing the private invite keys. Rejoin using the full invite link before sharing.');
  }
  return privateUrl;
}

function parseRoomJoinInput(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return { roomId: '', accessKey: null, e2eKey: null };
  const directRoomIdMatch = value.match(/^([a-z0-9-]{8,})(?:#(.+))?$/i);
  if (directRoomIdMatch) {
    const params = new URLSearchParams(directRoomIdMatch[2] || '');
    return {
      roomId: directRoomIdMatch[1],
      accessKey: params.get('accessKey') || null,
      e2eKey: params.get('e2eKey') || null,
    };
  }
  try {
    const parsed = new URL(value);
    const roomMatch = parsed.pathname.match(/^\/r\/([a-z0-9-]+)$/i);
    if (!roomMatch) return { roomId: value, accessKey: null, e2eKey: null };
    const params = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    return {
      roomId: roomMatch[1],
      accessKey: params.get('accessKey') || null,
      e2eKey: params.get('e2eKey') || null,
    };
  } catch {
    return { roomId: value, accessKey: null, e2eKey: null };
  }
}

function setLobbyMode(mode) {
  currentLobbyMode = mode === 'join' ? 'join' : 'create';
  const createTab = $('lobby-tab-create');
  const joinTab = $('lobby-tab-join');
  const createPanel = $('create-panel');
  const joinPanel = $('join-panel');
  if (!createTab || !joinTab || !createPanel || !joinPanel) return;

  const isCreate = currentLobbyMode === 'create';
  createTab.classList.toggle('active', isCreate);
  joinTab.classList.toggle('active', !isCreate);
  createTab.setAttribute('aria-selected', isCreate ? 'true' : 'false');
  joinTab.setAttribute('aria-selected', isCreate ? 'false' : 'true');
  createTab.tabIndex = isCreate ? 0 : -1;
  joinTab.tabIndex = isCreate ? -1 : 0;
  createPanel.classList.toggle('hidden', !isCreate);
  joinPanel.classList.toggle('hidden', isCreate);
}

function updateLobbyPrivacyState() {
  const isPublic = !!$('public-check')?.checked;
  const isListed = $('listed-check')?.checked !== false;
  const label = $('privacy-mode-label');
  const help = $('privacy-mode-help');
  const listingLabel = $('listing-mode-label');
  const listingHelp = $('listing-mode-help');
  if (label) label.textContent = isPublic ? 'Anyone can join' : 'Invite only';
  if (help) {
    help.textContent = isPublic
      ? 'No invite key needed.'
      : 'Friends need your full invite link.';
  }
  if (listingLabel) listingLabel.textContent = isListed ? 'Show in room browser' : 'Hidden from room browser';
  if (listingHelp) {
    listingHelp.textContent = isListed
      ? 'Others can find the room. Invite rules still apply.'
      : 'Only people with your link can find the room.';
  }
}

function renderBackendControls() {
  const selectedMode = WPConstants.BACKEND.normalizeMode(currentBackendMode);
  $('connection-card').hidden = !WPConstants.BACKEND.canUseLocal();
  document.querySelectorAll('#backend-toggle .backend-btn').forEach((btn) => {
    const localUnavailable = btn.dataset.mode === WPConstants.BACKEND.MODES.LOCAL
      && !WPConstants.BACKEND.canUseLocal();
    btn.hidden = localUnavailable;
    btn.disabled = localUnavailable;
    btn.classList.toggle('active', btn.dataset.mode === selectedMode);
    btn.setAttribute('aria-pressed', btn.dataset.mode === selectedMode ? 'true' : 'false');
  });

  const browseLink = $('browse-rooms-link');
  if (browseLink) browseLink.href = WPConstants.BACKEND.getBrowseUrl(selectedMode, currentActiveBackend);

  const displayBackendKey = getDisplayBackendKey();
  const backendNote = $('backend-note');
  if (!backendNote) return;

  if (selectedMode === WPConstants.BACKEND.MODES.AUTO) {
    if (displayBackendKey) {
      const info = WPConstants.BACKEND.getInfo(displayBackendKey);
      backendNote.textContent = `Automatic (recommended). Using the ${info.label.toLowerCase()} server.`;
    } else {
      backendNote.textContent = 'Automatic is recommended. Development builds can use a local server when available.';
    }
    return;
  }

  const info = WPConstants.BACKEND.getInfo(selectedMode);
  const targetUrl = currentActiveBackendUrl || info.wsUrl;
  backendNote.textContent = `${info.label} mode is selected. ${currentWsConnected ? `Connected via ${targetUrl}.` : `Next connection will use ${targetUrl}.`}`;
}

function applyStatusResponse(response) {
  currentBackendMode = WPConstants.BACKEND.normalizeMode(response.backendMode);
  currentActiveBackend = getKnownBackendKey(response.activeBackend);
  currentActiveBackendUrl = response.activeBackendUrl || null;
  currentWsConnected = !!response.wsConnected;
  currentUserId = response.userId || currentUserId || null;
  currentSessionId = response.sessionId || currentSessionId || null;
  if (stremioStatusGeneration === 0) {
    setStremioStatus(!!response.hasStremioTab);
    updateStatusHint(!!response.hasStremioTab, !!response.stremioRunning, !!response.bootstrapPending);
  }
  renderBackendControls();
  setWsStatus(currentWsConnected);
}

function applyCoordinatorUpdate(payload) {
  if (!payload || typeof payload !== 'object') return;
  if ('userId' in payload) currentUserId = payload.userId || null;
  if ('sessionId' in payload) currentSessionId = payload.sessionId || null;
  if ('activeBackend' in payload) currentActiveBackend = getKnownBackendKey(payload.activeBackend);
  if ('activeBackendUrl' in payload) currentActiveBackendUrl = payload.activeBackendUrl || null;
  if ('wsConnected' in payload) currentWsConnected = payload.wsConnected === true;
  renderBackendControls();
  setWsStatus(currentWsConnected);
  if (!('room' in payload)) return;
  const nextRoom = payload.room || null;
  if (nextRoom) {
    if (pendingLobbyRoomId && nextRoom.id !== pendingLobbyRoomId) return;
    if (suppressedRoomId && nextRoom.id === suppressedRoomId) return;
    suppressedRoomId = null;
    showRoomView(nextRoom, currentUserId);
    return;
  }
  // An authoritative empty membership completes the previous leave. A future
  // join from Stremio may legitimately return to that same room ID.
  membershipClearGeneration += 1;
  suppressedRoomId = null;
  pendingLeaveRoomId = null;
  if (!$('view-room').classList.contains('hidden')) {
    showLobbyView();
  }
}

function setBackendMode(mode) {
  if (!WPConstants.BACKEND.canUseLocal()) return;
  const normalizedMode = WPConstants.BACKEND.normalizeMode(mode);
  if (currentBackendMode === normalizedMode) return;
  currentBackendMode = normalizedMode;
  currentActiveBackend = null;
  currentActiveBackendUrl = null;
  currentWsConnected = false;
  renderBackendControls();
  setWsStatus(false);
  setExtensionState({
    [WPConstants.STORAGE.BACKEND_MODE]: normalizedMode,
  }).catch(() => {});
  setExtensionState({
    [WPConstants.STORAGE.WS_CONNECTED]: false,
    [WPConstants.STORAGE.ACTIVE_BACKEND]: null,
    [WPConstants.STORAGE.ACTIVE_BACKEND_URL]: null,
  }).catch(() => {});
}

function loadIdentity(callback) {
  getExtensionState([
    WPConstants.STORAGE.USER_ID,
    WPConstants.STORAGE.SESSION_ID,
  ], (result) => {
    currentUserId = result[WPConstants.STORAGE.USER_ID] || currentUserId || null;
    currentSessionId = result[WPConstants.STORAGE.SESSION_ID] || currentSessionId || null;
    callback(currentUserId, currentSessionId);
  });
}

// --- Reactive room state watcher (replaces polling) ---
function waitForRoomState({ onRoom, onError, onTimeout, expectedRoomId, command }) {
  let resolved = false;
  const storageListener = (changes) => {
    if (resolved) return;
    const nextError = changes?.[WPConstants.STORAGE.LAST_ROOM_ERROR]?.newValue;
    if (!nextError) return;
    if (nextError.command && command && nextError.command !== command) return;
    if (nextError.roomId && expectedRoomId && nextError.roomId !== expectedRoomId) return;
    finish(() => onError?.(nextError));
  };
  const timeoutId = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    chrome.runtime.onMessage.removeListener(listener);
    chrome.storage.onChanged.removeListener(storageListener);
    onTimeout();
  }, 20000);

  function finish(callback) {
    if (resolved) return;
    resolved = true;
    clearTimeout(timeoutId);
    chrome.runtime.onMessage.removeListener(listener);
    chrome.storage.onChanged.removeListener(storageListener);
    callback?.();
  }

  function listener(message) {
    if (resolved) return;
    if (message.type !== 'watchparty-ext') return;
    if (message.action === WPConstants.ACTION.ROOM_ERROR_EVENT && message.payload) {
      if (message.payload.command && command && message.payload.command !== command) return;
      if (message.payload.roomId && expectedRoomId && message.payload.roomId !== expectedRoomId) return;
      finish(() => onError?.(message.payload));
      return;
    }
    if (message.action !== WPConstants.ACTION.STATUS_UPDATED) return;
    const nextRoom = message.payload?.room || null;
    if (!nextRoom) return;
    if (expectedRoomId && nextRoom.id !== expectedRoomId) return;
    finish(() => onRoom(nextRoom, message.payload?.userId || null));
  }

  chrome.runtime.onMessage.addListener(listener);
  chrome.storage.onChanged.addListener(storageListener);
  return () => {
    if (resolved) return;
    resolved = true;
    clearTimeout(timeoutId);
    chrome.runtime.onMessage.removeListener(listener);
    chrome.storage.onChanged.removeListener(storageListener);
  };
}

function setCreateError(message) {
  resetLobbyActionButtons();
  $('create-error').textContent = message;
  $('create-error').classList.remove('hidden');
}

function setJoinError(message) {
  resetLobbyActionButtons();
  $('join-error').textContent = message;
  $('join-error').classList.remove('hidden');
}

function handleSendMessageFailure(response, fallbackMessage, stopWaiting, showError) {
  if (chrome.runtime.lastError) {
    stopWaiting?.();
    showError(getErrorMessage(chrome.runtime.lastError, fallbackMessage));
    return true;
  }
  if (response?.ok !== true) {
    stopWaiting?.();
    showError(getErrorMessage(response, fallbackMessage));
    return true;
  }
  return false;
}

// --- Init ---

chrome.runtime.sendMessage(
  { type: 'watchparty-ext', action: WPConstants.ACTION.STATUS_GET },
  (response) => {
    if (chrome.runtime.lastError || !response) {
      $('stremio-status').textContent = 'Status unavailable';
      showActionError('Could not read WatchParty status. Close and reopen this popup.');
      markStatusReady();
      return;
    }

    // Version
    $('version').textContent = `v${chrome.runtime.getManifest().version}`;
    $('version').title = `Background version: ${response.bgVersion || 'unknown'}`;

    applyStatusResponse(response);

    // Load saved username
    getExtensionState(WPConstants.STORAGE.USERNAME).then((result) => {
      if (result[WPConstants.STORAGE.USERNAME]) $('username-input').value = result[WPConstants.STORAGE.USERNAME];
    }).catch(() => {});

    // Show room view if already in a room
    if (response.room) {
      currentUserId = response.userId || null;
      showRoomView(response.room, response.userId);
    } else {
      showLobbyView();
    }
    markStatusReady();
  }
);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes[WPConstants.STORAGE.SESSION_ID]) {
      currentSessionId = changes[WPConstants.STORAGE.SESSION_ID].newValue || null;
    }
    if (changes[WPConstants.STORAGE.BACKEND_MODE]) {
      currentBackendMode = WPConstants.BACKEND.normalizeMode(changes[WPConstants.STORAGE.BACKEND_MODE].newValue);
      renderBackendControls();
      setWsStatus(currentWsConnected);
    }
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'watchparty-ext') return false;
  if (message.action === WPConstants.ACTION.STATUS_UPDATED) {
    applyCoordinatorUpdate(message.payload);
  }
  return false;
});

// The manual popup can stay open while tabs are launched, navigated or closed.
// Read tab presence through the coordinator; do not infer it from local-service
// availability or a cached room, and never let a late lookup replace room UI.
for (const event of ['onCreated', 'onUpdated', 'onRemoved']) {
  chrome.tabs?.[event]?.addListener(refreshStremioTabStatus);
}

document.querySelectorAll('#backend-toggle .backend-btn').forEach((btn) => {
  btn.addEventListener('click', () => setBackendMode(btn.dataset.mode));
});
resetRoomContentLinks();
renderBackendControls();
setWsStatus(false);

// --- Views ---

function showLobbyView() {
  $('view-lobby').classList.remove('hidden');
  $('view-room').classList.add('hidden');
  $('room-actions').classList.add('hidden');
  $('setup-card').classList.remove('hidden');
  currentRenderedRoom = null;
  setWsStatus(currentWsConnected);
  resetRoomContentLinks();
  resetLobbyActionButtons();
  // Clear any error messages
  $('join-error').classList.add('hidden');
  $('create-error').classList.add('hidden');
  updateLobbyPrivacyState();
  updateQuickActions();
}

function showRoomView(room, myUserId) {
  if (room?.id && suppressedRoomId && room.id === suppressedRoomId) return;
  $('view-lobby').classList.add('hidden');
  $('view-room').classList.remove('hidden');
  $('room-actions').classList.remove('hidden');
  $('setup-card').classList.add('hidden');
  currentRenderedRoom = room;
  resetLobbyActionButtons();
  updateQuickActions();
  setWsStatus(currentWsConnected);

  if (myUserId) currentUserId = myUserId;
  loadIdentity((resolvedUserId, resolvedSessionId) => {
    if (currentRenderedRoom !== room) return;
    renderRoomDetails(room, resolvedUserId, resolvedSessionId);
  });
}

  function renderRoomDetails(room, myUserId, mySessionId) {
  // Resolve host status: owner ID may be orphaned after WS reconnect/dedup.
  // If the owner ID isn't in the users list, check if we're the only matching session.
  function amIHost() {
    return WPUtils.isCurrentSessionOwner(room, myUserId, mySessionId);
  }

  $('room-id-display').textContent = room.id;
  $('room-meta').textContent = room.meta?.name
    ? `${room.meta.name}${room.meta.year ? ` (${room.meta.year})` : ''}`
    : 'WatchParty room';

  const isHost = amIHost();
  currentRenderedRoom = room || null;
  $('room-privacy-badge').textContent = room.public ? 'Open to anyone' : 'Invite only';
  $('room-role-badge').textContent = isHost ? 'Host' : 'Guest';
  $('room-count-badge').textContent = `${room.users?.length || 0} watching`;
  updateQuickActions();
  const detailUrl = getContentDetailUrl(room);
  const directStreamUrl = getDirectStreamUrl(room);

  // Content link for peers
  if (!isHost && (detailUrl || directStreamUrl)) {
    $('content-link-hint').classList.remove('hidden');
    $('content-name').textContent = room.meta?.name || room.meta?.id || 'Host stream';
    if (detailUrl) {
      $('content-link').classList.remove('hidden');
      $('content-link').href = detailUrl;
    } else {
      $('content-link').classList.add('hidden');
      $('content-link').href = '#';
    }
    if (directStreamUrl) {
      $('content-stream-link').classList.remove('hidden');
      $('content-stream-link').href = directStreamUrl;
    } else {
      $('content-stream-link').classList.add('hidden');
      $('content-stream-link').href = '#';
    }
  } else {
    $('content-link-hint').classList.add('hidden');
    $('content-link').classList.add('hidden');
    $('content-link').href = '#';
    $('content-stream-link').classList.add('hidden');
    $('content-stream-link').href = '#';
  }


}

// --- Actions ---

$('btn-create').addEventListener('click', () => {
  if (pendingLobbyAction) return;
  showActionError();
  suppressedRoomId = null;
  setLobbyMode('create');
  const username = $('username-input').value.trim();
  if (!username) {
    setCreateError('Enter your name first.');
    $('username-input').focus();
    return;
  }
  $('create-error').classList.add('hidden');

  setExtensionState({ [WPConstants.STORAGE.USERNAME]: username }).catch(() => {});

  const isPublic = $('public-check')?.checked || false;
  const isListed = $('listed-check')?.checked !== false;
  let roomName = $('room-name-input')?.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || undefined;
  // Validate room name length after sanitization (server requires 3-30 chars)
  if (roomName && roomName.length < 3) {
    $('create-error').textContent = 'Room name must be at least 3 characters (letters, numbers, hyphens)';
    $('create-error').classList.remove('hidden');
    return;
  }

  // Arm the watcher before sending create-room so a warm WS can't win the race.
  const stopWaiting = waitForRoomState({
    command: WPConstants.ACTION.ROOM_CREATE,
    onRoom: (room, userId) => showRoomView(room, userId),
    onError: (error) => setCreateError(getErrorMessage(error, 'Failed to create room. Open Stremio and try again.')),
    onTimeout: () => setCreateError('Failed to create room. Open Stremio and try again.'),
  });
  pendingLobbyAction = stopWaiting;
  $('btn-create').disabled = true;
  $('btn-join').disabled = true;
  $('btn-create').textContent = 'Creating...';

  chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: WPConstants.ACTION.ROOM_CREATE,
    username,
    meta: { id: 'pending', type: 'movie', name: 'WatchParty Session' },
    stream: { url: 'https://watchparty.mertd.me/sync' },
    public: isPublic,
    listed: isListed,
    roomName,
  }, (response) => {
    if (handleSendMessageFailure(
      response,
      'Failed to create room. Open Stremio and try again.',
      stopWaiting,
      setCreateError,
    )) return;
    if (response?.staged === true && response?.needsStremio === true) {
      stopWaiting();
      resetLobbyActionButtons();
      $('btn-create').textContent = 'Opening Stremio...';
      openStremioTab();
    }
  });

});

$('btn-join').addEventListener('click', () => {
  if (pendingLobbyAction) return;
  showActionError();
  suppressedRoomId = null;
  setLobbyMode('join');
  const username = $('username-input').value.trim();
  const parsedJoin = parseRoomJoinInput($('room-id-input').value);
  const roomId = parsedJoin.roomId;
  if (!username) { setJoinError('Enter your name first.'); $('username-input').focus(); return; }
  if (!roomId || !/^[a-z0-9-]{1,100}$/i.test(roomId)) { setJoinError('Paste a valid invite link or room ID.'); $('room-id-input').focus(); return; }

  $('join-error').classList.add('hidden');
  setExtensionState({ [WPConstants.STORAGE.USERNAME]: username }).catch(() => {});

  // Arm the watcher before sending join-room so fast local updates aren't missed.
  const stopWaiting = waitForRoomState({
    expectedRoomId: roomId,
    command: WPConstants.ACTION.ROOM_JOIN,
    onRoom: (room, userId) => showRoomView(room, userId),
    onError: (error) => setJoinError(getErrorMessage(error, 'Room join timed out. Open Stremio and try again.')),
    onTimeout: () => setJoinError('Room join timed out. Open Stremio and try again.'),
  });
  pendingLobbyAction = stopWaiting;
  pendingLobbyRoomId = roomId;
  $('btn-create').disabled = true;
  $('btn-join').disabled = true;
  $('btn-join').textContent = 'Joining...';

  chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: WPConstants.ACTION.ROOM_JOIN,
    username,
    roomId,
    accessKey: parsedJoin.accessKey || undefined,
    e2eKey: parsedJoin.e2eKey || undefined,
  }, (response) => {
    if (handleSendMessageFailure(
      response,
      'Room join timed out. Open Stremio and try again.',
      stopWaiting,
      setJoinError,
    )) return;
    if (response?.staged === true && response?.needsStremio === true) {
      stopWaiting();
      resetLobbyActionButtons();
      $('btn-join').textContent = 'Opening Stremio...';
      openStremioTab();
    }
  });

});

$('btn-leave').addEventListener('click', () => {
  const roomId = currentRenderedRoom?.id;
  if (!roomId || pendingLeaveRoomId === roomId) return;
  showActionError();
  pendingLeaveRoomId = roomId;
  const clearGeneration = membershipClearGeneration;
  updateQuickActions();
  chrome.runtime.sendMessage({ type: 'watchparty-ext', action: WPConstants.ACTION.ROOM_LEAVE, roomId }, response => {
    if (membershipClearGeneration !== clearGeneration) return;
    if (pendingLeaveRoomId === roomId) pendingLeaveRoomId = null;
    if (currentRenderedRoom?.id !== roomId) return;
    updateQuickActions();
    if (chrome.runtime.lastError || response?.ok !== true) {
      showActionError(getErrorMessage(chrome.runtime.lastError || response, 'Could not leave the room. Try again.'));
      return;
    }
    suppressedRoomId = roomId;
    showLobbyView();
  });
});

$('lobby-tab-create').addEventListener('click', () => setLobbyMode('create'));
$('lobby-tab-join').addEventListener('click', () => setLobbyMode('join'));
for (const id of ['lobby-tab-create', 'lobby-tab-join']) {
  $(id).addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextMode = event.key === 'Home' ? 'create' : event.key === 'End' ? 'join'
      : currentLobbyMode === 'create' ? 'join' : 'create';
    setLobbyMode(nextMode);
    $(`lobby-tab-${nextMode}`).focus();
  });
}
$('public-check').addEventListener('change', updateLobbyPrivacyState);
$('listed-check').addEventListener('change', updateLobbyPrivacyState);
$('btn-open-watchparty').addEventListener('click', openWatchPartyTab);
$('btn-open-settings').addEventListener('click', openOptionsPage);
$('btn-resume-room').addEventListener('click', resumeRoomInStremio);
setLobbyMode(currentLobbyMode);
updateLobbyPrivacyState();
updateQuickActions();

// Share invite link
$('btn-share').addEventListener('click', () => {
  const roomId = currentRenderedRoom?.id;
  if (!roomId) return;
  copyTextWithFeedback(
    roomId,
    $('btn-share'),
    'Copy Invite',
    'Link Copied!'
  );
});

// Copy room ID on click (also copies invite link)
document.addEventListener('click', (e) => {
  if (e.target.id === 'room-id-display') {
    const roomId = currentRenderedRoom?.id;
    if (!roomId) return;
    copyTextWithFeedback(
      roomId,
      e.target,
      roomId,
      'Link copied!'
    );
  }
});


