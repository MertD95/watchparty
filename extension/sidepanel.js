// WatchParty - Chrome Side Panel (full-featured alternative to injected overlay)
// Communicates with the content script via chrome.runtime messaging + chrome.storage.
// Features: room status, users, chat, bookmarks, ready check, leave room, sync indicator.

(() => {
  'use strict';

  // Shared utilities from utils.js (loaded via sidepanel.html script tag)
  const { getUserColor, escapeHtml } = WPUtils;

  let currentUserId = null;
  let currentSessionId = null;
  let currentRoomState = null;

  /** Check if a user ID belongs to the current user (multi-tab: matches by sessionId) */
  function isMe(uid) {
    if (uid === currentUserId) return true;
    if (!currentSessionId || !currentRoomState?.users) return false;
    const user = currentRoomState.users.find((entry) => entry.id === uid);
    return user?.sessionId === currentSessionId;
  }

  /** Am I the host? Handles orphaned owner IDs after WS reconnect. */
  function amIHost() {
    if (!currentRoomState) return false;
    if (isMe(currentRoomState.owner)) return true;
    const ownerInList = currentRoomState.users?.some((entry) => entry.id === currentRoomState.owner);
    if (!ownerInList && currentRoomState.users?.some((entry) => isMe(entry.id))) return true;
    return false;
  }

  // --- State polling from storage ---
  function pollState() {
    chrome.storage.local.get(
      [
        WPConstants.STORAGE.ROOM_STATE,
        WPConstants.STORAGE.USER_ID,
        WPConstants.STORAGE.SESSION_ID,
        WPConstants.STORAGE.WS_CONNECTED,
      ],
      (result) => {
        currentUserId = result[WPConstants.STORAGE.USER_ID];
        currentSessionId = result[WPConstants.STORAGE.SESSION_ID];
        currentRoomState = result[WPConstants.STORAGE.ROOM_STATE];
        render(currentRoomState, currentUserId);
      }
    );
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

    const isHost = amIHost();
    const hostLabel = isHost ? 'You are the host' : 'Synced to host';

    let actions = '';
    if (isHost) {
      actions += '<button class="action-btn" id="sp-ready-check">&#x270B; Ready?</button>';
    }
    actions += '<button class="action-btn" id="sp-bookmark">&#x1F4CC; Bookmark</button>';
    actions += '<button class="action-btn leave-btn" id="sp-leave">Leave</button>';
    const actionsRow = `<div class="action-row">${actions}</div>`;

    status.innerHTML = `<span class="status-line">${hostLabel}</span><span class="status-line muted">${roomState.users?.length || 0} in room</span>${actionsRow}`;

    document.getElementById('sp-ready-check')?.addEventListener('click', () => {
      sendAction({ action: 'ready-check', readyAction: 'initiate' });
      showToast('Ready check started');
    });
    document.getElementById('sp-bookmark')?.addEventListener('click', () => {
      // Let the content script read the active video time from the page.
      sendAction({ action: 'send-bookmark' });
      showToast('Bookmark sent');
    });
    document.getElementById('sp-leave')?.addEventListener('click', () => {
      sendAction({ action: 'leave-room' });
    });

    roomCode.textContent = roomState.id.slice(0, 8);
    roomCode.classList.remove('hidden');
    roomCode.onclick = () => {
      chrome.storage.local.get([WPConstants.STORAGE.BACKEND_MODE, WPConstants.STORAGE.ACTIVE_BACKEND], (result) => {
        const url = WPConstants.BACKEND.buildInviteUrl(
          roomState.id,
          result[WPConstants.STORAGE.BACKEND_MODE],
          result[WPConstants.STORAGE.ACTIVE_BACKEND]
        );
        navigator.clipboard.writeText(url).catch(() => { });
        roomCode.textContent = 'Copied!';
        setTimeout(() => { roomCode.textContent = roomState.id.slice(0, 8); }, 1500);
      });
    };

    if (!isHost && roomState.player) {
      syncIndicator.classList.remove('hidden');
      const playerState = roomState.player.paused ? 'Paused' : roomState.player.buffering ? 'Buffering...' : 'Playing';
      const mins = Math.floor((roomState.player.time || 0) / 60);
      const secs = Math.floor((roomState.player.time || 0) % 60).toString().padStart(2, '0');
      syncIndicator.innerHTML = `<span class="sync-ok">${playerState} at ${mins}:${secs}</span>`;
    } else {
      syncIndicator.classList.add('hidden');
    }

    if (roomState.users?.length > 0) {
      users.classList.remove('hidden');
      users.innerHTML = roomState.users.map((entry) => {
        const color = getUserColor(entry.sessionId || entry.id);
        const ownerInList = roomState.users.some((user) => user.id === roomState.owner);
        const isCrown = entry.id === roomState.owner || (!ownerInList && isHost && isMe(entry.id));
        const crown = isCrown ? '<span style="font-size:12px">&#x1F451;</span>' : '';
        const you = isMe(entry.id) ? ' <span style="color:#888;font-size:11px">(you)</span>' : '';
        const awayClass = entry.status === 'away' ? ' user-away' : '';
        let statusIcon = '';
        if (entry.playbackStatus === 'buffering') statusIcon = '<span class="user-status" title="Buffering">&#x27F3;</span>';
        else if (entry.playbackStatus === 'paused') statusIcon = '<span class="user-status" title="Paused">&#x275A;&#x275A;</span>';
        else if (entry.playbackStatus === 'playing') statusIcon = '<span class="user-status" title="Playing" style="color:#22c55e">&#x25B6;</span>';
        return `<div class="user${awayClass}"><span class="user-dot" style="background:${color}"></span>${crown}${escapeHtml(entry.name)}${you}${statusIcon}</div>`;
      }).join('');
    } else {
      users.classList.add('hidden');
    }

    chatContainer.classList.remove('hidden');
  }

  // --- Chat ---
  document.getElementById('chat-send').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendChat();
  });

  function sendChat() {
    const input = document.getElementById('chat-input');
    const content = input.value.trim();
    if (!content) return;
    sendAction({ action: 'send-chat', content });
    appendChat(currentSessionId || currentUserId, 'You', content);
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
    div.innerHTML = `&#x1F4CC; <span class="chat-name" style="color:${getUserColor(currentSessionId || msg.user)}">${escapeHtml(msg.userName || 'Unknown')}</span> bookmarked <button class="bookmark-time">${mins}:${secs}</button>`;
    div.querySelector('.bookmark-time')?.addEventListener('click', () => {
      sendAction({ action: 'seek-bookmark', time: msg.time });
      showToast(`Seeking to ${mins}:${secs}`);
    });
    container.appendChild(div);
    while (container.childElementCount > 200) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
  }

  // --- Send action to content script via background relay ---
  function sendAction(detail) {
    chrome.storage.local.set({
      [WPConstants.STORAGE.PENDING_ACTION]: {
        ...detail,
        nonce: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
      },
    });
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
      const sender = currentRoomState?.users?.find((entry) => entry.id === msg.user);
      const name = sender?.name || msg.userName || 'Unknown';
      if (!isMe(msg.user)) {
        appendChat(sender?.sessionId || msg.user, name, msg.content);
      }
    }

    if (message.action === 'bookmark' && message.payload) {
      appendBookmark(message.payload);
    }
  });

  // --- Storage change listener for real-time updates ---
  chrome.storage.onChanged.addListener((changes) => {
    if (
      changes[WPConstants.STORAGE.ROOM_STATE] ||
      changes[WPConstants.STORAGE.USER_ID] ||
      changes[WPConstants.STORAGE.SESSION_ID] ||
      changes[WPConstants.STORAGE.WS_CONNECTED]
    ) {
      if (changes[WPConstants.STORAGE.USER_ID]) currentUserId = changes[WPConstants.STORAGE.USER_ID].newValue;
      if (changes[WPConstants.STORAGE.SESSION_ID]) currentSessionId = changes[WPConstants.STORAGE.SESSION_ID].newValue;
      if (changes[WPConstants.STORAGE.ROOM_STATE]) currentRoomState = changes[WPConstants.STORAGE.ROOM_STATE].newValue;
      render(currentRoomState, currentUserId);
    }
  });

  // --- Init ---
  pollState();
})();
