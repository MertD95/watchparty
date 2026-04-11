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

  // Room settings
  const isHost = room.owner === myUserId;
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
  chrome.storage.local.get('wpReactionSound', ({ wpReactionSound }) => {
    $('setting-reaction-sound').checked = wpReactionSound !== false;
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

  chrome.storage.local.set({ wpUsername: username });

  const isPublic = $('public-check')?.checked || false;
  const roomName = $('room-name-input')?.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || undefined;

  chrome.runtime.sendMessage({
    type: 'watchparty-ext',
    action: 'create-room',
    username,
    meta: { id: 'pending', type: 'movie', name: 'WatchParty Session' },
    stream: { url: 'https://watchparty.mertd.me/sync' },
    public: isPublic,
    roomName,
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
          $('create-error').textContent = 'Failed to create room. Check server connection.';
          $('create-error').classList.remove('hidden');
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

  $('join-error').classList.add('hidden');
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
          $('join-error').textContent = 'Room not found. Check the ID and try again.';
          $('join-error').classList.remove('hidden');
        }
      }
    );
  }, 1500);
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
  chrome.storage.local.set({ wpReactionSound: e.target.checked });
});

// Theme: accent color
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chrome.storage.local.set({ wpAccentColor: btn.dataset.color });
  });
});
// Load saved accent
chrome.storage.local.get('wpAccentColor', ({ wpAccentColor }) => {
  const color = wpAccentColor || '#6366f1';
  document.querySelector(`.color-btn[data-color="${color}"]`)?.classList.add('active');
});
// Compact chat
$('setting-compact').addEventListener('change', (e) => {
  chrome.storage.local.set({ wpCompactChat: e.target.checked });
});
chrome.storage.local.get('wpCompactChat', ({ wpCompactChat }) => {
  $('setting-compact').checked = !!wpCompactChat;
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
