// WatchParty - Chrome Side Panel companion surface
// Keeps quick room context, chat, and bookmarks nearby without replacing the
// richer injected session sidebar inside Stremio itself.

(() => {
  'use strict';

  const { getUserColor, escapeHtml } = WPUtils;

  let currentUserId = null;
  let currentSessionId = null;
  let currentRoomState = null;
  let currentWsConnected = false;
  const typingUsers = new Map();
  const localPreferences = {
    accentColor: '#6366f1',
    compactChat: false,
  };
  let typingIdleTimer = null;
  let typingSent = false;

  function normalizeHexColor(value, fallback = '#6366f1') {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
  }

  function hexToRgb(hex) {
    const normalized = normalizeHexColor(hex);
    return {
      r: parseInt(normalized.slice(1, 3), 16),
      g: parseInt(normalized.slice(3, 5), 16),
      b: parseInt(normalized.slice(5, 7), 16),
    };
  }

  function rgbToHex(r, g, b) {
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
    return `#${[clamp(r), clamp(g), clamp(b)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }

  function mixColor(hex, amount, target) {
    const { r, g, b } = hexToRgb(hex);
    const targetChannel = target === 'white' ? 255 : 0;
    const blend = (channel) => channel + ((targetChannel - channel) * amount);
    return rgbToHex(blend(r), blend(g), blend(b));
  }

  function applyLocalPreferences() {
    const accent = normalizeHexColor(localPreferences.accentColor);
    const { r, g, b } = hexToRgb(accent);
    document.documentElement.style.setProperty('--wp-accent', accent);
    document.documentElement.style.setProperty('--wp-accent-hover', mixColor(accent, 0.12, 'black'));
    document.documentElement.style.setProperty('--wp-accent-light', mixColor(accent, 0.18, 'white'));
    document.documentElement.style.setProperty('--wp-accent-rgb', `${r}, ${g}, ${b}`);
    document.body.classList.toggle('compact-chat', !!localPreferences.compactChat);
  }

  function loadLocalPreferences(callback) {
    chrome.storage.local.get([
      WPConstants.STORAGE.ACCENT_COLOR,
      WPConstants.STORAGE.COMPACT_CHAT,
    ], (result) => {
      localPreferences.accentColor = normalizeHexColor(result[WPConstants.STORAGE.ACCENT_COLOR] || '#6366f1');
      localPreferences.compactChat = !!result[WPConstants.STORAGE.COMPACT_CHAT];
      applyLocalPreferences();
      callback?.();
    });
  }

  function getExtensionState(keys, callback) {
    const work = WPRuntimeState.get(keys);
    if (typeof callback === 'function') work.then(callback);
    return work;
  }

  function setHeroCopy(text) {
    const heroCopy = document.getElementById('hero-copy');
    if (heroCopy) heroCopy.textContent = text;
  }

  function getRoomDisplayName(roomState) {
    return roomState?.name || roomState?.meta?.name || roomState?.id?.slice(0, 8) || 'Active room';
  }

  function getDetailUrl(roomState) {
    if (!roomState?.meta?.id || !roomState?.meta?.type) return null;
    if (roomState.meta.id === 'pending' || roomState.meta.id === 'unknown') return null;
    return `https://web.stremio.com/#/detail/${encodeURIComponent(roomState.meta.type)}/${encodeURIComponent(roomState.meta.id)}`;
  }

  function getDirectStreamUrl(roomState) {
    return WPUtils.getDirectJoinUrl(roomState);
  }

  function isMe(uid) {
    const user = WPUtils.getMatchingRoomUser(currentRoomState, uid, null);
    return WPUtils.isCurrentSessionUser(user || { id: uid }, currentUserId, currentSessionId);
  }

  function amIHost() {
    return WPUtils.isCurrentSessionOwner(currentRoomState, currentUserId, currentSessionId);
  }

  function formatPlaybackClock(timeSeconds) {
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) return '';
    const totalSeconds = Math.floor(timeSeconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  function getPlaybackSummary(entry) {
    const label = formatPlaybackClock(entry?.playbackTime);
    if (!label) return { label: '', title: '' };
    let title = label;
    const hostTime = currentRoomState?.player?.time;
    if (Number.isFinite(hostTime)) {
      const drift = entry.playbackTime - hostTime;
      if (Math.abs(drift) >= 1) {
        title = `${label} (${Math.abs(drift).toFixed(0)}s ${drift < 0 ? 'behind' : 'ahead of'} host)`;
      }
    }
    return { label, title };
  }

  function openWatchParty() {
    getExtensionState([
      WPConstants.STORAGE.BACKEND_MODE,
      WPConstants.STORAGE.ACTIVE_BACKEND,
    ], (result) => {
      const browseUrl = WPConstants.BACKEND.getBrowseUrl(
        result[WPConstants.STORAGE.BACKEND_MODE],
        result[WPConstants.STORAGE.ACTIVE_BACKEND]
      );
      chrome.tabs.create({ url: browseUrl }).catch(() => {});
    });
  }

  function openOptions() {
    chrome.runtime.openOptionsPage().catch(() => {});
  }

  function bindStaticActions() {
    document.getElementById('sp-open-watchparty-header')?.addEventListener('click', openWatchParty);
    document.getElementById('sp-open-settings-header')?.addEventListener('click', openOptions);
  }

  function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2000);
  }

  function copyInvite(roomState) {
    WPUtils.copyTextDeferred(() => new Promise((resolve) => {
      getExtensionState([
        WPConstants.STORAGE.BACKEND_MODE,
        WPConstants.STORAGE.ACTIVE_BACKEND,
      ], (result) => {
        const inviteUrl = WPConstants.BACKEND.buildInviteUrl(
          roomState.id,
          result[WPConstants.STORAGE.BACKEND_MODE],
          result[WPConstants.STORAGE.ACTIVE_BACKEND]
        );
        WPRoomKeys.appendToInviteUrl(roomState.id, inviteUrl).then(resolve);
      });
    }))
      .then((copied) => showToast(copied ? 'Invite copied' : 'Copy failed'))
      .catch(() => showToast('Copy failed'));
  }

  function updateRoomCodeChip(roomState) {
    const roomCode = document.getElementById('room-code');
    if (!roomCode) return;
    if (!roomState?.id) {
      roomCode.classList.add('hidden');
      roomCode.textContent = '';
      roomCode.onclick = null;
      return;
    }
    roomCode.textContent = roomState.id.slice(0, 8);
    roomCode.classList.remove('hidden');
    roomCode.onclick = () => copyInvite(roomState);
  }

  function updateTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (!indicator) return;
    if (!currentRoomState?.users) {
      indicator.classList.add('hidden');
      indicator.textContent = '';
      return;
    }
    const names = [];
    for (const [uid, typingState] of typingUsers) {
      const entry = currentRoomState.users.find((user) => user.id === uid);
      const name = entry?.name || typingState?.name || '';
      if (!name || isMe(uid)) continue;
      names.push(name);
    }
    if (names.length === 0) {
      indicator.classList.add('hidden');
      indicator.textContent = '';
      return;
    }
    indicator.textContent = names.length === 1
      ? `${names[0]} is typing...`
      : `${names.join(', ')} are typing...`;
    indicator.classList.remove('hidden');
  }

  function handleTypingUpdate(userId, typing, userName) {
    if (!userId) return;
    if (typing) {
      const existing = typingUsers.get(userId);
      if (existing?.timeoutId) clearTimeout(existing.timeoutId);
      typingUsers.set(userId, {
        name: userName || existing?.name || '',
        timeoutId: setTimeout(() => {
        typingUsers.delete(userId);
        updateTypingIndicator();
        }, 3000),
      });
    } else {
      const existing = typingUsers.get(userId);
      if (existing?.timeoutId) clearTimeout(existing.timeoutId);
      typingUsers.delete(userId);
    }
    updateTypingIndicator();
  }

  function sendAction(detail) {
    chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      ...detail,
    }).catch(() => {});
  }

  function stopTypingSignal() {
    if (typingIdleTimer) {
      clearTimeout(typingIdleTimer);
      typingIdleTimer = null;
    }
    if (typingSent) {
      typingSent = false;
      sendAction({ action: WPConstants.ACTION.ROOM_TYPING_SEND, typing: false });
    }
  }

  function scheduleTypingStop() {
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    typingIdleTimer = setTimeout(() => {
      stopTypingSignal();
    }, 1200);
  }

  function onChatInput() {
    const input = document.getElementById('chat-input');
    const hasText = !!input?.value.trim();
    if (!hasText) {
      stopTypingSignal();
      return;
    }
    if (!typingSent) {
      typingSent = true;
      sendAction({ action: WPConstants.ACTION.ROOM_TYPING_SEND, typing: true });
    }
    scheduleTypingStop();
  }

  function appendChat(userId, name, content) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
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
    if (!container) return;
    const mins = Math.floor((msg.time || 0) / 60);
    const secs = Math.floor((msg.time || 0) % 60).toString().padStart(2, '0');
    const div = document.createElement('div');
    div.className = 'bookmark-msg';
    div.innerHTML = `Pinned by <span class="chat-name" style="color:${getUserColor(currentSessionId || msg.user)}">${escapeHtml(msg.userName || 'Unknown')}</span> at <button class="bookmark-time" type="button">${mins}:${secs}</button>`;
    div.querySelector('.bookmark-time')?.addEventListener('click', () => {
      sendAction({ action: WPConstants.ACTION.ROOM_BOOKMARK_SEEK, time: msg.time });
      showToast(`Seeking to ${mins}:${secs}`);
    });
    container.appendChild(div);
    while (container.childElementCount > 200) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
  }

  function sendChat() {
    const input = document.getElementById('chat-input');
    const content = input?.value.trim();
    if (!content) return;
    sendAction({ action: WPConstants.ACTION.ROOM_CHAT_SEND, content });
    appendChat(currentSessionId || currentUserId, 'You', content);
    input.value = '';
    stopTypingSignal();
  }

  function bindChat() {
    document.getElementById('chat-send')?.addEventListener('click', sendChat);
    document.getElementById('chat-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendChat();
      }
    });
    document.getElementById('chat-input')?.addEventListener('input', onChatInput);
    document.getElementById('chat-input')?.addEventListener('blur', stopTypingSignal);
  }

  function renderEmptyState() {
    const status = document.getElementById('status');
    const users = document.getElementById('users');
    const usersEmpty = document.getElementById('users-empty');
    const chatContainer = document.getElementById('chat-container');
    const chatEmpty = document.getElementById('chat-empty');
    const syncIndicator = document.getElementById('sync-indicator');
    const peopleCount = document.getElementById('people-count');
    const chatMessages = document.getElementById('chat-messages');

    setHeroCopy('Create or join on WatchParty, then use this panel for quick room context while Stremio keeps the main session UI.');
    updateRoomCodeChip(null);
    status.innerHTML = `
      <div class="empty-state">
        <div class="eyebrow">No Active Room</div>
        <h2 class="status-title">Create or join from WatchParty first.</h2>
        <p>The Chrome side panel now acts as a lightweight companion. Use it for quick chat, people, and bookmarks after the room is already live.</p>
        <div class="action-row">
          <button id="sp-open-watchparty-empty" class="action-btn primary" type="button">Open WatchParty</button>
          <button id="sp-open-settings-empty" class="action-btn" type="button">Extension Settings</button>
        </div>
      </div>
    `;
    document.getElementById('sp-open-watchparty-empty')?.addEventListener('click', openWatchParty);
    document.getElementById('sp-open-settings-empty')?.addEventListener('click', openOptions);

    users.classList.add('hidden');
    users.innerHTML = '';
    usersEmpty.classList.remove('hidden');
    peopleCount.classList.add('hidden');
    peopleCount.textContent = '';
    chatContainer.classList.add('hidden');
    chatEmpty.classList.remove('hidden');
    syncIndicator.classList.add('hidden');
    syncIndicator.textContent = '';
    if (chatMessages) chatMessages.innerHTML = '';
    typingUsers.clear();
    updateTypingIndicator();
  }

  function renderUsers(roomState) {
    const users = document.getElementById('users');
    const usersEmpty = document.getElementById('users-empty');
    const peopleCount = document.getElementById('people-count');
    const entries = Array.isArray(roomState?.users) ? roomState.users : [];
    if (entries.length === 0) {
      users.classList.add('hidden');
      users.innerHTML = '';
      usersEmpty.classList.remove('hidden');
      peopleCount.classList.add('hidden');
      peopleCount.textContent = '';
      return;
    }

    users.classList.remove('hidden');
    usersEmpty.classList.add('hidden');
    peopleCount.classList.remove('hidden');
    peopleCount.textContent = `${entries.length} watching`;

    const ownerUser = WPUtils.getCanonicalOwnerUser(roomState);
    users.innerHTML = entries.map((entry) => {
      const color = getUserColor(entry.sessionId || entry.id);
      const isCrown = (!!ownerUser && ownerUser.id === entry.id)
        || (!ownerUser && amIHost() && isMe(entry.id));
      const crown = isCrown ? 'Host' : 'Guest';
      const you = isMe(entry.id) ? 'You' : '';
      let playbackState = 'Waiting';
      if (entry.playbackStatus === 'buffering') playbackState = 'Buffering';
      else if (entry.playbackStatus === 'paused') playbackState = 'Paused';
      else if (entry.playbackStatus === 'playing') playbackState = 'Playing';
      const playback = getPlaybackSummary(entry);
      const subline = [crown, playbackState, you].filter(Boolean).map(escapeHtml).join(' | ');
      return `
        <div class="user${entry.status === 'away' ? ' user-away' : ''}">
          <span class="user-dot" style="background:${color}"></span>
          <div class="user-copy">
            <span class="user-name">${escapeHtml(entry.name)}</span>
            <span class="user-subline">${subline}</span>
          </div>
          ${playback.label ? `<span class="user-playhead" title="${escapeHtml(playback.title)}">${escapeHtml(playback.label)}</span>` : ''}
        </div>
      `;
    }).join('');
  }

  function renderStatus(roomState) {
    const status = document.getElementById('status');
    const syncIndicator = document.getElementById('sync-indicator');
    const chatContainer = document.getElementById('chat-container');
    const chatEmpty = document.getElementById('chat-empty');
    const roomTitle = getRoomDisplayName(roomState);
    const userCount = roomState.users?.length || 0;
    const isHost = amIHost();
    const detailUrl = getDetailUrl(roomState);
    const directStreamUrl = getDirectStreamUrl(roomState);
    const roleLabel = isHost ? 'You are the host' : 'Synced to host';
    const privacyLabel = roomState.public === false ? 'Private room' : 'Public room';
    const wsLabel = currentWsConnected ? 'Connected' : 'Background reconnecting';
    const sessionCopy = roomState.public
      ? 'This room is listed on WatchParty. Use the Stremio sidebar for the full live session controls.'
      : 'This room stays invite-only. Use this panel for quick chat and room context while Stremio stays focused.';

    setHeroCopy(isHost
      ? 'Use the Stremio sidebar for full host controls. Keep this panel nearby for quick chat, bookmarks, and invite copy.'
      : 'Stay synced from Stremio while this panel keeps quick room context, people, and chat close at hand.');
    updateRoomCodeChip(roomState);

    const linkHtml = [];
    if (detailUrl) {
      linkHtml.push(`<a class="session-link" href="${detailUrl}" target="_blank" rel="noreferrer">Open "${escapeHtml(roomTitle)}" in Stremio</a>`);
    }
    if (directStreamUrl) {
      linkHtml.push(`<a class="session-link" href="${directStreamUrl}" target="_blank" rel="noreferrer">Open host stream</a>`);
    }

    status.innerHTML = `
      <div class="status-copy">
        <div class="eyebrow">Room Companion</div>
        <h2 class="status-title">${escapeHtml(roomTitle)}</h2>
        <div class="pill-row">
          <span class="pill ${isHost ? 'success' : ''}">${escapeHtml(roleLabel)}</span>
          <span class="pill">${escapeHtml(privacyLabel)}</span>
          <span class="pill ${currentWsConnected ? 'success' : 'warn'}">${escapeHtml(wsLabel)}</span>
          <span class="pill">${userCount} watching</span>
        </div>
        <p class="status-note">${escapeHtml(sessionCopy)}</p>
        ${linkHtml.length > 0 ? `<div class="session-links">${linkHtml.join('')}</div>` : ''}
        <div class="action-row">
          <button class="action-btn" id="sp-copy-invite" type="button">Copy Invite</button>
          ${isHost ? '<button class="action-btn" id="sp-ready-check" type="button">Ready Check</button>' : ''}
          <button class="action-btn" id="sp-bookmark" type="button">Bookmark</button>
          <button class="action-btn leave-btn" id="sp-leave" type="button">Leave</button>
        </div>
      </div>
    `;

    document.getElementById('sp-copy-invite')?.addEventListener('click', () => copyInvite(roomState));
    document.getElementById('sp-ready-check')?.addEventListener('click', () => {
      sendAction({ action: WPConstants.ACTION.ROOM_READY_CHECK_UPDATE, readyAction: 'initiate' });
      showToast('Ready check started');
    });
    document.getElementById('sp-bookmark')?.addEventListener('click', () => {
      sendAction({ action: WPConstants.ACTION.ROOM_BOOKMARK_ADD });
      showToast('Bookmark sent');
    });
    document.getElementById('sp-leave')?.addEventListener('click', () => {
      sendAction({ action: WPConstants.ACTION.ROOM_LEAVE });
    });

    if (!isHost && roomState.player) {
      const playerTime = formatPlaybackClock(roomState.player.time || 0) || '0:00';
      const playerState = roomState.player.paused
        ? 'Paused'
        : roomState.player.buffering
          ? 'Buffering'
          : 'Playing';
      syncIndicator.textContent = `${playerState} at ${playerTime}`;
      syncIndicator.className = `panel-card sync-indicator ${roomState.player.buffering ? 'sync-drift' : 'sync-ok'}`;
      syncIndicator.classList.remove('hidden');
    } else {
      syncIndicator.classList.add('hidden');
      syncIndicator.textContent = '';
    }

    chatContainer.classList.remove('hidden');
    chatEmpty.classList.add('hidden');
  }

  function render(roomState) {
    if (!roomState || !roomState.id) {
      renderEmptyState();
      return;
    }
    renderStatus(roomState);
    renderUsers(roomState);
    updateTypingIndicator();
  }

  function applyCoordinatorUpdate(payload) {
    if (!payload || typeof payload !== 'object') return;
    if ('userId' in payload) currentUserId = payload.userId || null;
    if ('sessionId' in payload) currentSessionId = payload.sessionId || null;
    if ('room' in payload) currentRoomState = payload.room || null;
    if ('wsConnected' in payload) currentWsConnected = payload.wsConnected === true;
    render(currentRoomState);
  }

  function loadCoordinatorState() {
    chrome.runtime.sendMessage(
      { type: 'watchparty-ext', action: WPConstants.ACTION.STATUS_GET },
      (response) => {
        if (!response) return;
        applyCoordinatorUpdate({
          room: response.room || null,
          userId: response.userId || null,
          sessionId: response.sessionId || null,
          wsConnected: response.wsConnected === true,
        });
      }
    );
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'watchparty-ext') return false;

    if (message.action === WPConstants.ACTION.STATUS_UPDATED) {
      applyCoordinatorUpdate(message.payload);
    }

    if (message.action === WPConstants.ACTION.ROOM_CHAT_EVENT && message.payload) {
      const msg = message.payload;
      const sender = currentRoomState?.users?.find((entry) => entry.id === msg.user);
      const name = sender?.name || msg.userName || 'Unknown';
      if (!isMe(msg.user)) {
        appendChat(sender?.sessionId || msg.user, name, msg.content);
      }
    }

    if (message.action === WPConstants.ACTION.ROOM_BOOKMARK_EVENT && message.payload) {
      appendBookmark(message.payload);
    }

    if (message.action === WPConstants.ACTION.ROOM_TYPING_EVENT && message.payload) {
      handleTypingUpdate(message.payload.user, message.payload.typing, message.payload.userName);
    }

    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[WPConstants.STORAGE.ACCENT_COLOR]) {
      localPreferences.accentColor = normalizeHexColor(changes[WPConstants.STORAGE.ACCENT_COLOR].newValue || '#6366f1');
      applyLocalPreferences();
    }
    if (areaName === 'local' && changes[WPConstants.STORAGE.COMPACT_CHAT]) {
      localPreferences.compactChat = !!changes[WPConstants.STORAGE.COMPACT_CHAT].newValue;
      applyLocalPreferences();
    }
  });

  bindStaticActions();
  bindChat();
  loadLocalPreferences(loadCoordinatorState);
})();

