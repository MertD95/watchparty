// WatchParty — Chrome Side Panel (full-featured alternative to injected overlay)
// Communicates with the content script via chrome.runtime messaging + chrome.storage.
// Features: room status, users, chat, bookmarks, ready check, leave room, sync indicator.

(() => {
  'use strict';

  // Shared utilities from utils.js (loaded via sidepanel.html script tag)
  const { getUserColor, escapeHtml } = WPUtils;

  let currentUserId = null;
  let currentRoomState = null;

  // --- State polling from storage ---
  function pollState() {
    chrome.storage.local.get(['wpRoomState', 'wpUserId', 'wpWsConnected'], (result) => {
      currentUserId = result.wpUserId;
      currentRoomState = result.wpRoomState;
      render(result.wpRoomState, result.wpUserId);
    });
  }

  // --- Render ---
  function render(roomState, userId) {
    const status = document.getElementById('status');
    const users = document.getElementById('users');
    const chatContainer = document.getElementById('chat-container');
    const roomCode = document.getElementById('room-code');
    const syncIndicator = document.getElementById('sync-indicator');

    if (!roomState || !roomState.id) {
      status.innerHTML = '<div class="empty-state">Not in a room.<br>Use the extension popup to create or join one.</div>';
      users.classList.add('hidden');
      chatContainer.classList.add('hidden');
      roomCode.classList.add('hidden');
      syncIndicator.classList.add('hidden');
      return;
    }

    const isHost = roomState.owner === userId;
    const hostLabel = isHost ? 'You are the host' : 'Synced to host';

    // Action buttons
    let actions = '';
    if (isHost) {
      actions += '<button class="action-btn" id="sp-ready-check">&#x270B; Ready?</button>';
    }
    actions += '<button class="action-btn" id="sp-bookmark">&#x1F4CC; Bookmark</button>';
    actions += '<button class="action-btn leave-btn" id="sp-leave">Leave</button>';
    const actionsRow = `<div class="action-row">${actions}</div>`;

    status.innerHTML = `<span class="status-line">${hostLabel}</span><span class="status-line muted">${roomState.users?.length || 0} in room</span>${actionsRow}`;

    // Bind action buttons
    document.getElementById('sp-ready-check')?.addEventListener('click', () => {
      sendAction({ action: 'ready-check', readyAction: 'initiate' });
      showToast('Ready check started');
    });
    document.getElementById('sp-bookmark')?.addEventListener('click', () => {
      sendAction({ action: 'send-bookmark', time: 0 }); // time=0 as fallback — content script has the actual time
      showToast('Bookmark sent');
    });
    document.getElementById('sp-leave')?.addEventListener('click', () => {
      sendAction({ action: 'leave-room' });
    });

    // Room code
    roomCode.textContent = roomState.id.slice(0, 8);
    roomCode.classList.remove('hidden');
    roomCode.onclick = () => {
      const url = `https://watchparty.mertd.me/r/${roomState.id}`;
      navigator.clipboard.writeText(url).catch(() => {});
      roomCode.textContent = 'Copied!';
      setTimeout(() => { roomCode.textContent = roomState.id.slice(0, 8); }, 1500);
    };

    // Sync indicator
    if (!isHost && roomState.player) {
      syncIndicator.classList.remove('hidden');
      // We don't have drift info in the side panel (WPSync runs in content script)
      // Show basic player state instead
      const playerState = roomState.player.paused ? 'Paused' : roomState.player.buffering ? 'Buffering...' : 'Playing';
      const mins = Math.floor((roomState.player.time || 0) / 60);
      const secs = Math.floor((roomState.player.time || 0) % 60).toString().padStart(2, '0');
      syncIndicator.innerHTML = `<span class="sync-ok">${playerState} at ${mins}:${secs}</span>`;
    } else {
      syncIndicator.classList.add('hidden');
    }

    // Users
    if (roomState.users?.length > 0) {
      users.classList.remove('hidden');
      users.innerHTML = roomState.users.map(u => {
        const color = getUserColor(u.id);
        const crown = u.id === roomState.owner ? '<span style="font-size:12px">&#x1F451;</span>' : '';
        const you = u.id === userId ? ' <span style="color:#888;font-size:11px">(you)</span>' : '';
        const awayClass = u.status === 'away' ? ' user-away' : '';
        let statusIcon = '';
        if (u.playbackStatus === 'buffering') statusIcon = '<span class="user-status" title="Buffering">&#x27F3;</span>';
        else if (u.playbackStatus === 'paused') statusIcon = '<span class="user-status" title="Paused">&#x275A;&#x275A;</span>';
        else if (u.playbackStatus === 'playing') statusIcon = '<span class="user-status" title="Playing" style="color:#22c55e">&#x25B6;</span>';
        return `<div class="user${awayClass}"><span class="user-dot" style="background:${color}"></span>${crown}${escapeHtml(u.name)}${you}${statusIcon}</div>`;
      }).join('');
    } else {
      users.classList.add('hidden');
    }

    chatContainer.classList.remove('hidden');
  }

  // --- Chat ---
  document.getElementById('chat-send').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  function sendChat() {
    const input = document.getElementById('chat-input');
    const content = input.value.trim();
    if (!content) return;
    sendAction({ action: 'send-chat', content });
    appendChat(currentUserId, 'You', content);
    input.value = '';
  }

  function appendChat(userId, name, content) {
    const container = document.getElementById('chat-messages');
    const color = getUserColor(userId);
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<span class="chat-name" style="color:${color}">${escapeHtml(name)}</span> <span class="chat-text">${escapeHtml(content)}</span>`;
    container.appendChild(div);
    while (container.childElementCount > 200) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
  }

  function appendBookmark(msg) {
    const container = document.getElementById('chat-messages');
    const mins = Math.floor((msg.time || 0) / 60);
    const secs = Math.floor((msg.time || 0) % 60).toString().padStart(2, '0');
    const div = document.createElement('div');
    div.className = 'bookmark-msg';
    div.innerHTML = `&#x1F4CC; <span class="chat-name" style="color:${getUserColor(msg.user)}">${escapeHtml(msg.userName || 'Unknown')}</span> bookmarked <button class="bookmark-time">${mins}:${secs}</button>`;
    div.querySelector('.bookmark-time')?.addEventListener('click', () => {
      sendAction({ action: 'send-bookmark', time: msg.time }); // Navigate to bookmark time
      showToast(`Seeking to ${mins}:${secs}`);
    });
    container.appendChild(div);
    while (container.childElementCount > 200) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
  }

  // --- Send action to content script via background relay ---
  function sendAction(detail) {
    chrome.runtime.sendMessage({ type: 'watchparty-ext', ...detail });
  }

  // --- Toast ---
  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2000);
  }

  // --- Listen for messages from content script ---
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'watchparty-ext') return;

    if (message.action === 'chat-message' && message.payload) {
      const msg = message.payload;
      const name = currentRoomState?.users?.find(u => u.id === msg.user)?.name || 'Unknown';
      if (msg.user !== currentUserId) {
        appendChat(msg.user, name, msg.content);
      }
    }

    if (message.action === 'bookmark' && message.payload) {
      appendBookmark(message.payload);
    }
  });

  // --- Storage change listener for real-time updates ---
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.wpRoomState || changes.wpUserId || changes.wpWsConnected) {
      if (changes.wpUserId) currentUserId = changes.wpUserId.newValue;
      if (changes.wpRoomState) currentRoomState = changes.wpRoomState.newValue;
      render(currentRoomState, currentUserId);
    }
  });

  // --- Init ---
  pollState();
})();
