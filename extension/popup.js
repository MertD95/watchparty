const $ = (id) => document.getElementById(id);

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
    if (response.stremioRunning) {
      $('stremio-dot').className = 'dot on';
      $('stremio-status').textContent = 'Stremio is running';
    } else {
      $('stremio-dot').className = 'dot off';
      $('stremio-status').textContent = 'Stremio not detected';
    }

    // WebSocket status
    if (response.wsConnected) {
      $('ws-dot').className = 'dot on';
      $('ws-status').textContent = 'Connected to server';
    } else {
      $('ws-dot').className = 'dot off';
      $('ws-status').textContent = 'Server disconnected';
    }

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

// --- Views ---

function showLobbyView() {
  $('view-lobby').classList.remove('hidden');
  $('view-room').classList.add('hidden');
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

  // Content link for peers
  if (room.meta?.id && room.meta?.type && !isHost) {
    $('content-link-hint').classList.remove('hidden');
    $('content-name').textContent = room.meta.name || room.meta.id;
    $('content-link').href = `https://web.stremio.com/#/detail/${encodeURIComponent(room.meta.type)}/${encodeURIComponent(room.meta.id)}`;
  } else {
    $('content-link-hint').classList.add('hidden');
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

  // Load reaction sound preference
  chrome.storage.local.get(WPConstants.STORAGE.REACTION_SOUND, (result) => {
    $('setting-reaction-sound').checked = result[WPConstants.STORAGE.REACTION_SOUND] !== false;
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

  // Listen for room state change reactively instead of polling
  waitForRoomState(
    (room, userId) => showRoomView(room, userId),
    () => {
      $('btn-create').disabled = false;
      $('btn-create').textContent = 'Create Room';
      $('create-error').textContent = 'Failed to create room. Make sure web.stremio.com is open.';
      $('create-error').classList.remove('hidden');
    }
  );
});

$('btn-join').addEventListener('click', () => {
  const username = $('username-input').value.trim();
  const roomId = $('room-id-input').value.trim();
  if (!username) { $('username-input').focus(); return; }
  if (!roomId) { $('room-id-input').focus(); return; }

  $('join-error').classList.add('hidden');
  chrome.storage.local.set({ [WPConstants.STORAGE.USERNAME]: username });

  chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: 'join-room',
    username,
    roomId,
  });

  $('btn-join').disabled = true;
  $('btn-join').textContent = 'Joining...';

  waitForRoomState(
    (room, userId) => showRoomView(room, userId),
    () => {
      $('btn-join').disabled = false;
      $('btn-join').textContent = 'Join Room';
      $('join-error').textContent = 'Room not found. Make sure web.stremio.com is open.';
      $('join-error').classList.remove('hidden');
    }
  );
});

$('btn-leave').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'watchparty-ext', action: 'leave-room' });
  showLobbyView();
});

// --- Settings ---
$('setting-public').addEventListener('change', (e) => {
  chrome.runtime.sendMessage({
    type: 'watchparty-ext', action: 'toggle-public', public: e.target.checked,
  });
});

$('setting-autopause').addEventListener('change', (e) => {
  chrome.runtime.sendMessage({
    type: 'watchparty-ext', action: 'update-room-settings',
    settings: { autoPauseOnDisconnect: e.target.checked },
  });
});

$('setting-reaction-sound').addEventListener('change', (e) => {
  chrome.storage.local.set({ [WPConstants.STORAGE.REACTION_SOUND]: e.target.checked });
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
  navigator.clipboard.writeText(`https://watchparty.mertd.me/r/${roomId}`).then(() => {
    $('btn-share').textContent = '✅ Link Copied!';
    setTimeout(() => { $('btn-share').textContent = '📋 Copy Invite Link'; }, 1500);
  }).catch(() => {});
});

// Copy room ID on click (also copies invite link)
document.addEventListener('click', (e) => {
  if (e.target.id === 'room-id-display') {
    const roomId = e.target.textContent;
    navigator.clipboard.writeText(`https://watchparty.mertd.me/r/${roomId}`).then(() => {
      const original = e.target.textContent;
      e.target.textContent = 'Link copied!';
      setTimeout(() => { e.target.textContent = original; }, 1500);
    }).catch(() => {});
  }
});

// escapeHtml provided by WPUtils (loaded via popup.html)
function escapeHtml(str) { return WPUtils.escapeHtml(str); }
