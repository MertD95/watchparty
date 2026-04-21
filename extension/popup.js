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

function getErrorMessage(errorLike, fallback) {
  if (!errorLike) return fallback;
  const code = typeof errorLike?.code === 'string' ? errorLike.code : '';
  if (code === 'ROOM_NOT_FOUND') return 'Room not found. Check the room ID or invite link and try again.';
  if (code === 'ROOM_KEY_REQUIRED') return 'This private room requires a room key.';
  if (code === 'INVALID_ROOM_KEY') return 'The room key is invalid. Paste the full invite link or a fresh room key.';
  if (code === 'VALIDATION_FAILED') return 'That request was rejected. Check the room details and try again.';
  if (code === 'NOT_OWNER') return 'Only the host can do that.';
  const message = typeof errorLike?.message === 'string' && errorLike.message.trim()
    ? errorLike.message.trim()
    : (typeof errorLike?.error === 'string' && errorLike.error.trim() ? errorLike.error.trim() : '');
  return message || fallback;
}

function getContentDetailUrl(room) {
  if (!room?.meta?.id || !room?.meta?.type) return null;
  return `https://web.stremio.com/#/detail/${encodeURIComponent(room.meta.type)}/${encodeURIComponent(room.meta.id)}`;
}

function getDirectStreamUrl(room) {
  return WPDirectPlay.getDirectJoinUrl(room?.stream);
}

function getBrowseUrl() {
  return WPConstants.BACKEND.getBrowseUrl(currentBackendMode, currentActiveBackend);
}

function getExtensionState(keys, callback) {
  const work = WPRuntimeState.get(keys);
  if (typeof callback === 'function') work.then(callback);
  return work;
}

function setExtensionState(values) {
  return WPRuntimeState.set(values);
}

function openWatchPartyTab() {
  chrome.tabs.create({ url: getBrowseUrl() });
}

function openStremioTab() {
  chrome.runtime.sendMessage(
    { type: 'watchparty-ext', action: 'open-stremio', url: 'https://web.stremio.com' },
    (response) => {
      if (chrome.runtime.lastError || response?.ok === false) {
        chrome.tabs.create({ url: 'https://web.stremio.com' });
      }
    }
  );
}

function openOptionsPage() {
  chrome.runtime.openOptionsPage().catch(() => {});
}

function updateQuickActions() {
  const resumeBtn = $('btn-resume-room');
  if (!resumeBtn) return;
  resumeBtn.textContent = currentRenderedRoom?.id ? 'Go to Room in Stremio' : 'Open Stremio';
}

function resumeRoomInStremio() {
  if (!currentRenderedRoom?.id) {
    openStremioTab();
    return;
  }
  chrome.runtime.sendMessage(
    { type: 'watchparty-ext', action: 'resume-room' },
    (response) => {
      if (chrome.runtime.lastError || response?.ok === false) {
        openStremioTab();
      }
    }
  );
}

function resetLobbyActionButtons() {
  $('btn-create').disabled = false;
  $('btn-create').textContent = 'Create Room';
  $('btn-join').disabled = false;
  $('btn-join').textContent = 'Join Room';
}

function copyTextWithFeedback(textSource, target, idleText, successText) {
  WPUtils.copyTextDeferred(() => (
    typeof textSource === 'function'
      ? textSource()
      : textSource
  ))
    .then((copied) => {
      if (!copied) return;
      if (!target) return;
      target.textContent = successText;
      setTimeout(() => {
        target.textContent = idleText;
      }, 1500);
    })
    .catch(() => {});
}

function setStremioStatus(isRunning) {
  if (isRunning) {
    $('stremio-dot').className = 'dot on';
    $('stremio-status').textContent = 'Stremio is running';
  } else {
    $('stremio-dot').className = 'dot off';
    $('stremio-status').textContent = 'Stremio not detected';
  }
}

function updateStatusHint(hasStremioTab, stremioRunning, bootstrapPending) {
  const hint = $('status-hint');
  if (!hint) return;
  if (bootstrapPending) {
    hint.textContent = 'WatchParty is staged and waiting for Stremio Web. Finish setup there to create or join the room.';
    return;
  }
  if (!hasStremioTab) {
    hint.textContent = 'No Stremio Web tab is open. Create or join here and WatchParty will hand the room off when Stremio opens.';
    return;
  }
  if (!stremioRunning) {
    hint.textContent = 'Stremio Web is open. The local streaming server is optional for room setup and only needed for local playback features.';
    return;
  }
  hint.textContent = 'Stremio Web is ready. Create or join here and WatchParty will attach to the active session.';
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
    $('ws-status').textContent = backendInfo ? `Connected to ${backendInfo.label} server` : 'Connected to server';
  } else {
    $('ws-dot').className = 'dot off';
    $('ws-status').textContent = backendInfo ? `${backendInfo.label} server disconnected` : 'Server disconnected';
  }
}

function buildInviteUrl(roomId) {
  return WPConstants.BACKEND.buildInviteUrl(roomId, currentBackendMode, currentActiveBackend);
}

function getStoredRoomKey(roomId) {
  if (!roomId) return Promise.resolve(null);
  const storageKey = WPConstants.STORAGE.roomKey(roomId);
  return new Promise((resolve) => {
    chrome.storage.session.get(storageKey, (result) => {
      if (!chrome.runtime?.id) return resolve(null);
      if (!chrome.runtime.lastError && result?.[storageKey]) return resolve(result[storageKey]);
      chrome.storage.local.get(storageKey, (fallback) => {
        const decoded = WPConstants.ROOM_KEYS.decodeFromLocal(fallback?.[storageKey]);
        if (decoded.expired) chrome.storage.local.remove(storageKey).catch(() => { });
        resolve(decoded.value || null);
      });
    });
  });
}

async function buildInviteUrlWithKey(roomId) {
  const inviteUrl = buildInviteUrl(roomId);
  const roomKey = await getStoredRoomKey(roomId);
  return roomKey ? `${inviteUrl}#key=${roomKey}` : inviteUrl;
}

function parseRoomJoinInput(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return { roomId: '', roomKey: null };
  const directRoomIdMatch = value.match(/^([a-z0-9-]{8,})(?:#key=([A-Za-z0-9_-]+))?$/i);
  if (directRoomIdMatch) {
    return {
      roomId: directRoomIdMatch[1],
      roomKey: directRoomIdMatch[2] || null,
    };
  }
  try {
    const parsed = new URL(value);
    const roomMatch = parsed.pathname.match(/^\/r\/([a-z0-9-]+)$/i);
    if (!roomMatch) return { roomId: value, roomKey: null };
    const keyMatch = parsed.hash.match(/(?:^#|[&#])key=([A-Za-z0-9_-]+)/);
    return {
      roomId: roomMatch[1],
      roomKey: keyMatch ? keyMatch[1] : null,
    };
  } catch {
    return { roomId: value, roomKey: null };
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
  createPanel.classList.toggle('hidden', !isCreate);
  joinPanel.classList.toggle('hidden', isCreate);
}

function updateLobbyPrivacyState() {
  const isPublic = !!$('public-check')?.checked;
  const label = $('privacy-mode-label');
  const help = $('privacy-mode-help');
  if (label) label.textContent = isPublic ? 'Public room' : 'Private room';
  if (help) {
    help.textContent = isPublic
      ? 'Anyone on WatchParty can join instantly.'
      : 'Invite required to join.';
  }
}

function renderBackendControls() {
  const selectedMode = WPConstants.BACKEND.normalizeMode(currentBackendMode);
  document.querySelectorAll('#backend-toggle .backend-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === selectedMode);
  });

  const browseLink = $('browse-rooms-link');
  if (browseLink) browseLink.href = WPConstants.BACKEND.getBrowseUrl(selectedMode, currentActiveBackend);

  const displayBackendKey = getDisplayBackendKey();
  const backendNote = $('backend-note');
  if (!backendNote) return;

  if (selectedMode === WPConstants.BACKEND.MODES.AUTO) {
    if (displayBackendKey) {
      const info = WPConstants.BACKEND.getInfo(displayBackendKey);
      backendNote.textContent = `Auto mode is selected. Current backend: ${info.label}${currentActiveBackendUrl ? ` (${currentActiveBackendUrl})` : ''}.`;
    } else {
      backendNote.textContent = 'Auto mode is selected. Installed builds use the live backend. Unpacked development builds may use localhost when it is available.';
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
  updateStatusHint(!!response.hasStremioTab, !!response.stremioRunning, !!response.bootstrapPending);
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
    if (suppressedRoomId && nextRoom.id === suppressedRoomId) return;
    suppressedRoomId = null;
    showRoomView(nextRoom, currentUserId);
    return;
  }
  showLobbyView();
}

function setBackendMode(mode) {
  const normalizedMode = WPConstants.BACKEND.normalizeMode(mode);
  if (currentBackendMode === normalizedMode) return;
  currentBackendMode = normalizedMode;
  currentActiveBackend = null;
  currentActiveBackendUrl = null;
  currentWsConnected = false;
  renderBackendControls();
  setWsStatus(false);
  chrome.storage.local.set({
    [WPConstants.STORAGE.BACKEND_MODE]: normalizedMode,
  });
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
function waitForRoomState({ onRoom, onError, onTimeout }) {
  let resolved = false;
  const timeoutId = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    chrome.runtime.onMessage.removeListener(listener);
    onTimeout();
  }, 20000);

  function finish(callback) {
    if (resolved) return;
    resolved = true;
    clearTimeout(timeoutId);
    chrome.runtime.onMessage.removeListener(listener);
    callback?.();
  }

  function listener(message) {
    if (resolved) return;
    if (message.type !== 'watchparty-ext' || message.action !== 'status-updated') return;
    const nextRoom = message.payload?.room || null;
    if (!nextRoom) return;
    finish(() => onRoom(nextRoom, message.payload?.userId || null));
  }

  chrome.runtime.onMessage.addListener(listener);
  return () => {
    if (resolved) return;
    resolved = true;
    clearTimeout(timeoutId);
    chrome.runtime.onMessage.removeListener(listener);
  };
}

function setCreateError(message) {
  $('btn-create').disabled = false;
  $('btn-create').textContent = 'Create Room';
  $('create-error').textContent = message;
  $('create-error').classList.remove('hidden');
}

function setJoinError(message) {
  $('btn-join').disabled = false;
  $('btn-join').textContent = 'Join Room';
  $('join-error').textContent = message;
  $('join-error').classList.remove('hidden');
}

function handleSendMessageFailure(response, fallbackMessage, stopWaiting, showError) {
  if (chrome.runtime.lastError) {
    stopWaiting?.();
    showError(getErrorMessage(chrome.runtime.lastError, fallbackMessage));
    return true;
  }
  if (response?.ok === false) {
    stopWaiting?.();
    showError(getErrorMessage(response, fallbackMessage));
    return true;
  }
  return false;
}

// --- Init ---

chrome.runtime.sendMessage(
  { type: 'watchparty-ext', action: 'get-status' },
  (response) => {
    if (!response) return;

    // Version
    $('version').textContent = `v${chrome.runtime.getManifest().version} [${response.bgVersion || 'OLD'}]`;

    // Stremio status
    setStremioStatus(response.stremioRunning);

    applyStatusResponse(response);

    // Load saved username
    chrome.storage.local.get(WPConstants.STORAGE.USERNAME, (result) => {
      if (result[WPConstants.STORAGE.USERNAME]) $('username-input').value = result[WPConstants.STORAGE.USERNAME];
    });

    // Show room view if already in a room
    if (response.room) {
      currentUserId = response.userId || null;
      showRoomView(response.room, response.userId);
    } else {
      showLobbyView();
    }
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
  if (message.action === 'status-updated') {
    applyCoordinatorUpdate(message.payload);
  }
  return false;
});

document.querySelectorAll('#backend-toggle .backend-btn').forEach((btn) => {
  btn.addEventListener('click', () => setBackendMode(btn.dataset.mode));
});
renderBackendControls();
setWsStatus(false);

// --- Views ---

function showLobbyView() {
  $('view-lobby').classList.remove('hidden');
  $('view-room').classList.add('hidden');
  currentRenderedRoom = null;
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

  if (myUserId) currentUserId = myUserId;
  loadIdentity((resolvedUserId, resolvedSessionId) => {
    renderRoomDetails(room, resolvedUserId, resolvedSessionId);
  });
}

  function renderRoomDetails(room, myUserId, mySessionId) {
    // Match identity by userId OR sessionId (multi-tab: client IDs differ but sessionId is shared)
    function isMe(uid) {
      const user = WPUtils.getMatchingRoomUser(room, uid, null);
      return WPUtils.isCurrentSessionUser(user || { id: uid }, myUserId, mySessionId);
    }

  // Resolve host status: owner ID may be orphaned after WS reconnect/dedup.
  // If the owner ID isn't in the users list, check if we're the only matching session.
  function amIHost() {
    return WPUtils.isCurrentSessionOwner(room, myUserId, mySessionId);
  }

  $('room-id-display').textContent = room.id;
  $('room-meta').textContent = room.meta?.name
    ? `${room.meta.name}${room.meta.year ? ` (${room.meta.year})` : ''}`
    : 'WatchParty Session';

  const isHost = amIHost();
  currentRenderedRoom = room || null;
  $('room-privacy-badge').textContent = room.public ? 'Public' : 'Invite required';
  $('room-role-badge').textContent = isHost ? 'Host' : 'Synced';
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
  suppressedRoomId = null;
  setLobbyMode('create');
  const username = $('username-input').value.trim();
  if (!username) {
    $('username-input').focus();
    return;
  }
  $('create-error').classList.add('hidden');

  chrome.storage.local.set({ [WPConstants.STORAGE.USERNAME]: username });

  const isPublic = $('public-check')?.checked || false;
  let roomName = $('room-name-input')?.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || undefined;
  // Validate room name length after sanitization (server requires 3-30 chars)
  if (roomName && roomName.length < 3) {
    $('create-error').textContent = 'Room name must be at least 3 characters (letters, numbers, hyphens)';
    $('create-error').classList.remove('hidden');
    return;
  }

  // Arm the watcher before sending create-room so a warm WS can't win the race.
  const stopWaiting = waitForRoomState({
    onRoom: (room, userId) => showRoomView(room, userId),
    onError: (error) => setCreateError(getErrorMessage(error, 'Failed to create room. Open Stremio and try again.')),
    onTimeout: () => setCreateError('Failed to create room. Open Stremio and try again.'),
  });

  chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: 'create-room',
    username,
    meta: { id: 'pending', type: 'movie', name: 'WatchParty Session' },
    stream: { url: 'https://watchparty.mertd.me/sync' },
    public: isPublic,
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
      $('btn-create').textContent = 'Opening Stremio...';
      openStremioTab();
    }
  });

  $('btn-create').disabled = true;
  $('btn-create').textContent = 'Creating...';
});

$('btn-join').addEventListener('click', () => {
  suppressedRoomId = null;
  setLobbyMode('join');
  const username = $('username-input').value.trim();
  const parsedJoin = parseRoomJoinInput($('room-id-input').value);
  const roomId = parsedJoin.roomId;
  if (!username) { $('username-input').focus(); return; }
  if (!roomId) { $('room-id-input').focus(); return; }

  $('join-error').classList.add('hidden');
  chrome.storage.local.set({ [WPConstants.STORAGE.USERNAME]: username });

  // Arm the watcher before sending join-room so fast local updates aren't missed.
  const stopWaiting = waitForRoomState({
    onRoom: (room, userId) => showRoomView(room, userId),
    onError: (error) => setJoinError(getErrorMessage(error, 'Room join timed out. Open Stremio and try again.')),
    onTimeout: () => setJoinError('Room join timed out. Open Stremio and try again.'),
  });

  chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: 'join-room',
    username,
    roomId,
    roomKey: parsedJoin.roomKey || undefined,
  }, (response) => {
    if (handleSendMessageFailure(
      response,
      'Room join timed out. Open Stremio and try again.',
      stopWaiting,
      setJoinError,
    )) return;
    if (response?.staged === true && response?.needsStremio === true) {
      stopWaiting();
      $('btn-join').textContent = 'Opening Stremio...';
      openStremioTab();
    }
  });

  $('btn-join').disabled = true;
  $('btn-join').textContent = 'Joining...';
});

$('btn-leave').addEventListener('click', () => {
  suppressedRoomId = currentRenderedRoom?.id || null;
  chrome.runtime.sendMessage({ type: 'watchparty-ext', action: 'leave-room' });
  showLobbyView();
});

$('lobby-tab-create').addEventListener('click', () => setLobbyMode('create'));
$('lobby-tab-join').addEventListener('click', () => setLobbyMode('join'));
$('public-check').addEventListener('change', updateLobbyPrivacyState);
$('btn-open-watchparty').addEventListener('click', openWatchPartyTab);
$('btn-open-stremio').addEventListener('click', openStremioTab);
$('btn-open-settings').addEventListener('click', openOptionsPage);
$('btn-resume-room').addEventListener('click', resumeRoomInStremio);
setLobbyMode(currentLobbyMode);
updateLobbyPrivacyState();
updateQuickActions();

// Share invite link
$('btn-share').addEventListener('click', () => {
  const roomId = $('room-id-display').textContent;
  if (!roomId) return;
  copyTextWithFeedback(
    () => buildInviteUrlWithKey(roomId),
    $('btn-share'),
    'Copy Invite',
    'Link Copied!'
  );
});

// Copy room ID on click (also copies invite link)
document.addEventListener('click', (e) => {
  if (e.target.id === 'room-id-display') {
    const roomId = e.target.textContent;
    const original = e.target.textContent;
    copyTextWithFeedback(
      () => buildInviteUrlWithKey(roomId),
      e.target,
      original,
      'Link copied!'
    );
  }
});

