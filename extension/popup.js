const $ = (id) => document.getElementById(id);

let currentBackendMode = WPConstants.BACKEND.MODES.AUTO;
let currentActiveBackend = null;
let currentActiveBackendUrl = null;
let currentWsConnected = false;
let currentRenderedRoom = null;
let currentRenderedIsHost = false;
let roomKeyRenderSeq = 0;

const ROOM_KEY_RE = /^[A-Za-z0-9_-]{16,200}$/;

function getContentDetailUrl(room) {
  if (!room?.meta?.id || !room?.meta?.type) return null;
  return `https://web.stremio.com/#/detail/${encodeURIComponent(room.meta.type)}/${encodeURIComponent(room.meta.id)}`;
}

function getDirectStreamUrl(room) {
  return WPDirectPlay.getDirectJoinUrl(room?.stream);
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
      chrome.storage.local.get(storageKey, (fallback) => resolve(fallback?.[storageKey] || null));
    });
  });
}

async function buildInviteUrlWithKey(roomId) {
  const inviteUrl = buildInviteUrl(roomId);
  const roomKey = await getStoredRoomKey(roomId);
  return roomKey ? `${inviteUrl}#key=${roomKey}` : inviteUrl;
}

function storeRoomKey(roomId, roomKey) {
  if (!roomId || !roomKey) return Promise.resolve();
  const storageKey = WPConstants.STORAGE.roomKey(roomId);
  return chrome.storage.session.set({ [storageKey]: roomKey }).catch(() =>
    chrome.storage.local.set({ [storageKey]: roomKey })
  );
}

function isValidRoomKey(value) {
  return ROOM_KEY_RE.test((value || '').trim());
}

function setRoomKeyError(message) {
  $('room-key-error').textContent = message || '';
  $('room-key-error').classList.toggle('hidden', !message);
}

function setRoomKeyHelp(message) {
  $('room-key-help').textContent = message || '';
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
      backendNote.textContent = 'Auto mode is selected. Unpacked builds use localhost when available, otherwise live.';
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
  renderBackendControls();
  setWsStatus(currentWsConnected);
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
    [WPConstants.STORAGE.WS_CONNECTED]: false,
    [WPConstants.STORAGE.ACTIVE_BACKEND]: null,
    [WPConstants.STORAGE.ACTIVE_BACKEND_URL]: null,
  });
}

// --- Reactive room state watcher (replaces polling) ---
function waitForRoomState(onRoom, onTimeout) {
  let resolved = false;
  const timeoutId = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    chrome.storage.onChanged.removeListener(listener);
    onTimeout();
  }, 12000);

  function listener(changes) {
    if (resolved) return;
    if (changes[WPConstants.STORAGE.ROOM_STATE]?.newValue) {
      resolved = true;
      clearTimeout(timeoutId);
      chrome.storage.onChanged.removeListener(listener);
      chrome.storage.local.get(WPConstants.STORAGE.USER_ID, (result) => {
        onRoom(changes[WPConstants.STORAGE.ROOM_STATE].newValue, result[WPConstants.STORAGE.USER_ID]);
      });
    }
  }
  chrome.storage.onChanged.addListener(listener);
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
      showRoomView(response.room, response.userId);
    } else {
      showLobbyView();
    }
  }
);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes[WPConstants.STORAGE.WS_CONNECTED]) {
    currentWsConnected = !!changes[WPConstants.STORAGE.WS_CONNECTED].newValue;
  }
  if (changes[WPConstants.STORAGE.BACKEND_MODE]) {
    currentBackendMode = WPConstants.BACKEND.normalizeMode(changes[WPConstants.STORAGE.BACKEND_MODE].newValue);
  }
  if (changes[WPConstants.STORAGE.ACTIVE_BACKEND]) {
    currentActiveBackend = getKnownBackendKey(changes[WPConstants.STORAGE.ACTIVE_BACKEND].newValue);
  }
  if (changes[WPConstants.STORAGE.ACTIVE_BACKEND_URL]) {
    currentActiveBackendUrl = changes[WPConstants.STORAGE.ACTIVE_BACKEND_URL].newValue || null;
  }
  renderBackendControls();
  setWsStatus(currentWsConnected);
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
  currentRenderedIsHost = false;
  roomKeyRenderSeq++;
  $('room-key-row').classList.add('hidden');
  $('room-key-input').value = '';
  setRoomKeyError('');
  setRoomKeyHelp('');
  // Reset button states in case we came from a room
  $('btn-create').disabled = false;
  $('btn-create').textContent = 'Create Room';
  $('btn-join').disabled = false;
  $('btn-join').textContent = 'Join Room';
  // Clear any error messages
  $('join-error').classList.add('hidden');
  $('create-error').classList.add('hidden');
}

function showRoomView(room, myUserId) {
  $('view-lobby').classList.add('hidden');
  $('view-room').classList.remove('hidden');

  // Load sessionId for multi-tab identity matching
  chrome.storage.local.get(WPConstants.STORAGE.SESSION_ID, (result) => {
    const mySessionId = result[WPConstants.STORAGE.SESSION_ID];
    renderRoomDetails(room, myUserId, mySessionId);
  });
}

function renderRoomKeyDetails(room, isHost) {
  const row = $('room-key-row');
  const input = $('room-key-input');
  const updateButton = $('btn-update-room-key');
  const isPrivateRoom = room?.public === false;
  const renderSeq = ++roomKeyRenderSeq;

  currentRenderedRoom = room || null;
  currentRenderedIsHost = !!isHost;

  setRoomKeyError('');

  if (!isPrivateRoom) {
    row.classList.add('hidden');
    input.value = '';
    input.readOnly = true;
    input.disabled = true;
    updateButton.classList.add('hidden');
    setRoomKeyHelp('');
    return;
  }

  row.classList.remove('hidden');
  input.disabled = true;
  input.readOnly = true;
  updateButton.classList.toggle('hidden', !isHost);
  updateButton.disabled = !isHost;
  setRoomKeyHelp(isHost
    ? 'Loading room key...'
    : 'This private-room key is part of the invite link.');

  getStoredRoomKey(room.id).then((roomKey) => {
    if (renderSeq !== roomKeyRenderSeq) return;

    input.disabled = false;
    input.readOnly = !isHost;
    input.value = roomKey || '';
    input.placeholder = isHost
      ? 'Room key will appear here'
      : 'Room key unavailable on this device';
    updateButton.classList.toggle('hidden', !isHost);
    updateButton.disabled = !isHost;

    if (isHost) {
      const othersInRoom = Math.max(0, (room.users?.length || 0) - 1);
      setRoomKeyHelp(
        othersInRoom > 0
          ? 'Change the key when you are alone in the room to avoid breaking private-room peers.'
          : 'Changing the key updates future invite links for this private room.'
      );
    } else {
      setRoomKeyHelp('This key is visible because private rooms now join via the invite key.');
    }
  }).catch(() => {
    if (renderSeq !== roomKeyRenderSeq) return;
    input.disabled = !isHost;
    input.readOnly = !isHost;
    input.value = '';
    updateButton.classList.toggle('hidden', !isHost);
    updateButton.disabled = !isHost;
    setRoomKeyHelp(isHost
      ? 'Failed to load the room key. You can still paste a new one and update it.'
      : 'Room key unavailable on this device.');
  });
}

function renderRoomDetails(room, myUserId, mySessionId) {
  // Match identity by userId OR sessionId (multi-tab: client IDs differ but sessionId is shared)
  function isMe(uid) {
    if (uid === myUserId) return true;
    if (!mySessionId || !room.users) return false;
    const u = room.users.find(u => u.id === uid);
    return u?.sessionId === mySessionId;
  }

  // Resolve host status: owner ID may be orphaned after WS reconnect/dedup.
  // If the owner ID isn't in the users list, check if we're the only matching session.
  function amIHost() {
    if (isMe(room.owner)) return true;
    // Owner ID is stale (not in users list) — check if any user with our session exists
    const ownerInList = room.users?.some(u => u.id === room.owner);
    if (!ownerInList && room.users?.some(u => isMe(u.id))) return true;
    return false;
  }

  $('room-id-display').textContent = room.id;
  $('room-meta').textContent = room.meta?.name
    ? `${room.meta.name}${room.meta.year ? ` (${room.meta.year})` : ''}`
    : 'WatchParty Session';

  const isHost = amIHost();
  renderRoomKeyDetails(room, isHost);
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

  // Users list
  const usersList = $('users-list');
  const ownerInList = room.users?.some(u => u.id === room.owner);
  usersList.innerHTML = room.users.map(u => {
    // Crown: either the actual owner, or if owner is orphaned, the host (us)
    const isOwner = u.id === room.owner || (!ownerInList && isHost && isMe(u.id));
    const isMyUser = isMe(u.id);
    return `<div class="user-item">${isOwner ? '<span class="user-crown">👑</span> ' : ''}${escapeHtml(u.name)}${isMyUser ? ' (you)' : ''}</div>`;
  }).join('');
  const publicRow = $('setting-public-row');
  const autopauseRow = $('setting-autopause-row');
  if (isHost) {
    publicRow.classList.remove('hidden');
    autopauseRow.classList.remove('hidden');
    $('setting-public').checked = room.public || false;
    $('setting-autopause').checked = room.settings?.autoPauseOnDisconnect || false;
  } else {
    publicRow.classList.add('hidden');
    autopauseRow.classList.add('hidden');
  }

  // Load reaction preferences
  chrome.storage.local.get([WPConstants.STORAGE.REACTION_SOUND, WPConstants.STORAGE.FLOATING_REACTIONS], (result) => {
    $('setting-reaction-sound').checked = result[WPConstants.STORAGE.REACTION_SOUND] !== false;
    $('setting-floating-reactions').checked = result[WPConstants.STORAGE.FLOATING_REACTIONS] !== false;
  });
}

// --- Actions ---

$('btn-create').addEventListener('click', () => {
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
  waitForRoomState(
    (room, userId) => showRoomView(room, userId),
    () => {
      $('btn-create').disabled = false;
      $('btn-create').textContent = 'Create Room';
      $('create-error').textContent = 'Failed to create room. Make sure web.stremio.com is open.';
      $('create-error').classList.remove('hidden');
    }
  );

  chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: 'create-room',
    username,
    meta: { id: 'pending', type: 'movie', name: 'WatchParty Session' },
    stream: { url: 'https://watchparty.mertd.me/sync' },
    public: isPublic,
    roomName,
  });

  $('btn-create').disabled = true;
  $('btn-create').textContent = 'Creating...';
});

$('btn-join').addEventListener('click', () => {
  const username = $('username-input').value.trim();
  const parsedJoin = parseRoomJoinInput($('room-id-input').value);
  const roomId = parsedJoin.roomId;
  if (!username) { $('username-input').focus(); return; }
  if (!roomId) { $('room-id-input').focus(); return; }

  $('join-error').classList.add('hidden');
  chrome.storage.local.set({ [WPConstants.STORAGE.USERNAME]: username });

  // Arm the watcher before sending join-room so fast local updates aren't missed.
  waitForRoomState(
    (room, userId) => showRoomView(room, userId),
    () => {
      $('btn-join').disabled = false;
      $('btn-join').textContent = 'Join Room';
      $('join-error').textContent = 'Room not found. Make sure web.stremio.com is open.';
      $('join-error').classList.remove('hidden');
    }
  );

  chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: 'join-room',
    username,
    roomId,
    roomKey: parsedJoin.roomKey || undefined,
  });

  $('btn-join').disabled = true;
  $('btn-join').textContent = 'Joining...';
});

$('btn-leave').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'watchparty-ext', action: 'leave-room' });
  showLobbyView();
});

// --- Settings ---
// Write directly to PENDING_ACTION storage — content script picks it up via onChanged.
// This bypasses the background relay (chrome.tabs.sendMessage) which fails without tabs permission.
function sendPendingAction(action) {
  chrome.storage.local.set({ [WPConstants.STORAGE.PENDING_ACTION]: action });
}

$('btn-update-room-key').addEventListener('click', async () => {
  const room = currentRenderedRoom;
  if (!room || room.public !== false) return;
  if (!currentRenderedIsHost) {
    setRoomKeyError('Only the host can change the room key.');
    return;
  }

  const nextKey = $('room-key-input').value.trim();
  if (!isValidRoomKey(nextKey)) {
    setRoomKeyError('Use 16-200 letters, numbers, underscores, or hyphens.');
    $('room-key-input').focus();
    return;
  }

  const othersInRoom = Math.max(0, (room.users?.length || 0) - 1);
  if (othersInRoom > 0) {
    setRoomKeyError('Change the key when you are alone in the room to avoid breaking private-room peers.');
    return;
  }

  const existingKey = await getStoredRoomKey(room.id);
  if (existingKey === nextKey) {
    setRoomKeyError('');
    setRoomKeyHelp('That key is already active for this private room.');
    return;
  }

  $('btn-update-room-key').disabled = true;
  $('btn-update-room-key').textContent = 'Updating...';
  setRoomKeyError('');

  try {
    await storeRoomKey(room.id, nextKey);
    sendPendingAction({ action: 'toggle-public', public: false, roomKey: nextKey });
    setRoomKeyHelp('Room key updated. New invite links will use this key.');
  } catch {
    setRoomKeyError('Failed to update the room key on this device.');
  } finally {
    $('btn-update-room-key').disabled = false;
    $('btn-update-room-key').textContent = 'Update Key';
  }
});

$('room-key-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !$('btn-update-room-key').classList.contains('hidden')) {
    event.preventDefault();
    $('btn-update-room-key').click();
  }
});

$('setting-public').addEventListener('change', (e) => {
  sendPendingAction({ action: 'toggle-public', public: e.target.checked });
});

$('setting-autopause').addEventListener('change', (e) => {
  sendPendingAction({ action: 'update-room-settings', settings: { autoPauseOnDisconnect: e.target.checked } });
});

$('setting-reaction-sound').addEventListener('change', (e) => {
  chrome.storage.local.set({ [WPConstants.STORAGE.REACTION_SOUND]: e.target.checked });
});
$('setting-floating-reactions').addEventListener('change', (e) => {
  chrome.storage.local.set({ [WPConstants.STORAGE.FLOATING_REACTIONS]: e.target.checked });
});

// Theme: accent color
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chrome.storage.local.set({ [WPConstants.STORAGE.ACCENT_COLOR]: btn.dataset.color });
  });
});
// Load saved accent
chrome.storage.local.get(WPConstants.STORAGE.ACCENT_COLOR, (result) => {
  const color = result[WPConstants.STORAGE.ACCENT_COLOR] || '#6366f1';
  document.querySelector(`.color-btn[data-color="${color}"]`)?.classList.add('active');
});
// Compact chat
$('setting-compact').addEventListener('change', (e) => {
  chrome.storage.local.set({ [WPConstants.STORAGE.COMPACT_CHAT]: e.target.checked });
});
chrome.storage.local.get(WPConstants.STORAGE.COMPACT_CHAT, (result) => {
  $('setting-compact').checked = !!result[WPConstants.STORAGE.COMPACT_CHAT];
});

// Share invite link
$('btn-share').addEventListener('click', () => {
  const roomId = $('room-id-display').textContent;
  if (!roomId) return;
  const originalLabel = $('btn-share').textContent;
  buildInviteUrlWithKey(roomId).then((inviteUrl) => {
    navigator.clipboard.writeText(inviteUrl).then(() => {
      $('btn-share').textContent = 'Link Copied!';
      setTimeout(() => { $('btn-share').textContent = originalLabel; }, 1500);
    }).catch(() => { });
  }).catch(() => { });
});

// Copy room ID on click (also copies invite link)
document.addEventListener('click', (e) => {
  if (e.target.id === 'room-id-display') {
    const roomId = e.target.textContent;
    buildInviteUrlWithKey(roomId).then((inviteUrl) => {
      navigator.clipboard.writeText(inviteUrl).then(() => {
      const original = e.target.textContent;
      e.target.textContent = 'Link copied!';
      setTimeout(() => { e.target.textContent = original; }, 1500);
      }).catch(() => { });
    }).catch(() => { });
  }
});

// escapeHtml provided by WPUtils (loaded via popup.html)
function escapeHtml(str) { return WPUtils.escapeHtml(str); }
