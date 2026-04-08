const $ = (id) => document.getElementById(id);

// --- Init ---

chrome.runtime.sendMessage(
  { type: 'watchparty-ext', action: 'get-status' },
  (response) => {
    if (!response) return;

    // Version
    $('version').textContent = `v${chrome.runtime.getManifest().version}`;

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
    chrome.storage.local.get('wpUsername', ({ wpUsername }) => {
      if (wpUsername) $('username-input').value = wpUsername;
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
}

function showRoomView(room, myUserId) {
  $('view-lobby').classList.add('hidden');
  $('view-room').classList.remove('hidden');

  $('room-id-display').textContent = room.id;
  $('room-meta').textContent = room.meta?.name
    ? `${room.meta.name}${room.meta.year ? ` (${room.meta.year})` : ''}`
    : 'WatchParty Session';

  // Content link for peers
  if (room.meta?.id && room.meta?.type && room.owner !== myUserId) {
    $('content-link-hint').classList.remove('hidden');
    $('content-name').textContent = room.meta.name || room.meta.id;
    $('content-link').href = `https://web.stremio.com/#/detail/${encodeURIComponent(room.meta.type)}/${encodeURIComponent(room.meta.id)}`;
  } else {
    $('content-link-hint').classList.add('hidden');
  }

  // Users list
  const usersList = $('users-list');
  usersList.innerHTML = room.users.map(u => {
    const isOwner = u.id === room.owner;
    const isMe = u.id === myUserId;
    return `<div class="user-item">${isOwner ? '<span class="user-crown">👑</span> ' : ''}${escapeHtml(u.name)}${isMe ? ' (you)' : ''}</div>`;
  }).join('');
}

// --- Actions ---

$('btn-create').addEventListener('click', () => {
  const username = $('username-input').value.trim();
  if (!username) {
    $('username-input').focus();
    return;
  }

  chrome.storage.local.set({ wpUsername: username });

  const isPublic = $('public-check')?.checked || false;

  chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: 'create-room',
    username,
    // Meta will be updated once the content script detects what's playing
    meta: { id: 'pending', type: 'movie', name: 'WatchParty Session' },
    stream: { url: 'https://watchparty.mertd.me/sync' },
    public: isPublic,
  });

  // Close popup and wait for room-joined event
  // The content script will update the overlay; popup will show room on next open
  $('btn-create').disabled = true;
  $('btn-create').textContent = 'Creating...';

  // Poll for room state
  setTimeout(() => {
    chrome.runtime.sendMessage(
      { type: 'watchparty-ext', action: 'get-status' },
      (response) => {
        if (response?.room) {
          showRoomView(response.room, response.userId);
        } else {
          $('btn-create').disabled = false;
          $('btn-create').textContent = 'Create Room';
        }
      }
    );
  }, 1500);
});

$('btn-join').addEventListener('click', () => {
  const username = $('username-input').value.trim();
  const roomId = $('room-id-input').value.trim();
  if (!username) { $('username-input').focus(); return; }
  if (!roomId) { $('room-id-input').focus(); return; }

  chrome.storage.local.set({ wpUsername: username });

  chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: 'join-room',
    username,
    roomId,
  });

  $('btn-join').disabled = true;
  $('btn-join').textContent = 'Joining...';

  setTimeout(() => {
    chrome.runtime.sendMessage(
      { type: 'watchparty-ext', action: 'get-status' },
      (response) => {
        if (response?.room) {
          showRoomView(response.room, response.userId);
        } else {
          $('btn-join').disabled = false;
          $('btn-join').textContent = 'Join Room';
        }
      }
    );
  }, 1500);
});

$('btn-leave').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'watchparty-ext', action: 'leave-room' });
  showLobbyView();
});

// Copy room ID on click
document.addEventListener('click', (e) => {
  if (e.target.id === 'room-id-display') {
    navigator.clipboard.writeText(e.target.textContent).then(() => {
      const original = e.target.textContent;
      e.target.textContent = 'Copied!';
      setTimeout(() => { e.target.textContent = original; }, 1000);
    }).catch(() => {});
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
