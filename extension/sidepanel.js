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
  let currentHasVideo = false;
  let roomActionGeneration = 0;
  const pendingRoomActions = new Map();
  const bookmarkButtons = new Set();
  let toastTimer = null;
  let coordinatorRevision = 0;
  let renderedRoomId = null;
  let renderedStatusKey = null;
  const renderedBookmarkKeys = new Set();
  const renderedMessageIds = new Set();
  const typingUsers = new Map();
  const localPreferences = {
    accentColor: '#6366f1',
    compactChat: false,
  };
  let typingIdleTimer = null;
  let typingSent = false;
  let pendingChat = null;
  let chatCooldownUntil = 0;
  let chatCooldownTimer = null;

  function updateChatAvailability() {
    const button = document.getElementById('chat-send');
    if (button instanceof HTMLButtonElement) button.disabled = !!pendingChat || !currentRoomState?.id || !currentWsConnected || Date.now() < chatCooldownUntil;
  }

  function finishChat(entry, accepted, error = '') {
    if (!entry || entry !== pendingChat) return;
    clearTimeout(entry.timer);
    pendingChat = null;
    const input = inputById('chat-input');
    if (accepted && currentRoomState?.id === entry.roomId && input && input.value === entry.draft) input.value = '';
    if (accepted) stopTypingSignal();
    if (error) showToast(error);
    updateChatAvailability();
  }

  function clearRoomChat() {
    finishChat(pendingChat, false);
    clearTimeout(chatCooldownTimer);
    chatCooldownUntil = 0;
    renderedMessageIds.clear();
    bookmarkButtons.clear();
    for (const entry of typingUsers.values()) clearTimeout(entry.timeoutId);
    typingUsers.clear();
    clearTimeout(typingIdleTimer);
    typingIdleTimer = null;
    typingSent = false;
    const input = inputById('chat-input');
    if (input) input.value = '';
  }

  function inputById(id) {
    const el = document.getElementById(id);
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
  }

  function pruneOldChildren(container, max = 200) {
    while (container.childElementCount > max && container.firstChild) {
      container.removeChild(container.firstChild);
    }
  }

  function isTrustedUserEvent(event) {
    return !event || event.isTrusted !== false;
  }

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
    WPRuntimeState.get([
      WPConstants.STORAGE.ACCENT_COLOR,
      WPConstants.STORAGE.COMPACT_CHAT,
    ]).then((result) => {
      localPreferences.accentColor = normalizeHexColor(result[WPConstants.STORAGE.ACCENT_COLOR] || '#6366f1');
      localPreferences.compactChat = !!result[WPConstants.STORAGE.COMPACT_CHAT];
      applyLocalPreferences();
      callback?.();
    }).catch(() => {
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

  async function openWatchParty() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'watchparty-ext', action: WPConstants.ACTION.APP_STREMIO_OPEN, url: 'https://web.stremio.com' });
      if (response?.ok !== true || response.handled === false || response.error) throw new Error('Could not open Stremio');
    } catch {
      try { await chrome.tabs.create({ url: 'https://web.stremio.com' }); }
      catch { showToast('Could not open Stremio. Try again.'); }
    }
  }

  function openOptions() {
    chrome.runtime.openOptionsPage().catch(() => showToast('Could not open settings. Try again.'));
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
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
  }

  function copyInvite(roomState) {
    const generation = roomActionGeneration;
    return WPUtils.copyTextDeferred(async () => {
      const result = await getExtensionState([
        WPConstants.STORAGE.BACKEND_MODE,
        WPConstants.STORAGE.ACTIVE_BACKEND,
      ]);
      const inviteUrl = WPConstants.BACKEND.buildInviteUrl(
        roomState.id,
        result[WPConstants.STORAGE.BACKEND_MODE],
        result[WPConstants.STORAGE.ACTIVE_BACKEND]
      );
      const fullInvite = await WPRoomKeys.appendToInviteUrl(roomState.id, inviteUrl);
      if (currentRoomState?.id !== roomState.id || roomActionGeneration !== generation) throw new Error('Room changed');
      return fullInvite;
    })
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

  /** @param {Event | null} [event] */
  async function sendAction(detail, event = null) {
    if (!WPActionContract.isAllowedSource(detail?.action, 'sidepanel')
        || (WPActionContract.requiresTrustedEvent(detail?.action) && !isTrustedUserEvent(event))) {
      return { ok: false, error: 'This action is not available.' };
    }
    let timeout;
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({ type: 'watchparty-ext', ...detail }),
        new Promise(resolve => { timeout = setTimeout(() => resolve({ ok: false, error: 'No response from Stremio. Try again.' }), 8000); }),
      ]);
      if (response?.ok !== true || response.handled === false || response.error) {
        return { ok: false, error: response?.error || 'The action was not accepted. Open Stremio and try again.' };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach Stremio. Try again.' };
    } finally {
      clearTimeout(timeout);
    }
  }

  function roomActionUnavailable(action) {
    if (!currentRoomState?.id) return 'Join a room first.';
    if (action === WPConstants.ACTION.ROOM_LEAVE) return '';
    if (!currentWsConnected) return 'Reconnect to the room first.';
    if (action === WPConstants.ACTION.ROOM_READY_CHECK_UPDATE && !amIHost()) return 'Only the host can start a ready check.';
    if (!currentHasVideo) return 'Open a video in Stremio first.';
    return '';
  }

  function updateRoomActionAvailability() {
    const controls = [
      ['sp-ready-check', WPConstants.ACTION.ROOM_READY_CHECK_UPDATE],
      ['sp-bookmark', WPConstants.ACTION.ROOM_BOOKMARK_ADD],
      ['sp-leave', WPConstants.ACTION.ROOM_LEAVE],
    ];
    for (const [id, action] of controls) {
      const button = document.getElementById(id);
      if (!(button instanceof HTMLButtonElement)) continue;
      const reason = roomActionUnavailable(action);
      button.disabled = !!reason || pendingRoomActions.has(action);
      button.title = reason;
      button.setAttribute('aria-busy', String(pendingRoomActions.has(action)));
    }
    for (const button of bookmarkButtons) {
      const action = WPConstants.ACTION.ROOM_BOOKMARK_SEEK;
      const reason = roomActionUnavailable(action);
      button.disabled = !!reason || pendingRoomActions.has(action);
      button.title = reason || 'Seek to this moment in Stremio';
    }
  }

  async function runRoomAction(detail, event, successMessage) {
    const action = detail.action;
    if (!isTrustedUserEvent(event) || pendingRoomActions.has(action)) return;
    const unavailable = roomActionUnavailable(action);
    if (unavailable) { showToast(unavailable); return; }
    const entry = { roomId: currentRoomState.id, generation: roomActionGeneration };
    pendingRoomActions.set(action, entry);
    updateRoomActionAvailability();
    const response = await sendAction({ ...detail, roomId: entry.roomId }, event);
    if (pendingRoomActions.get(action) !== entry) return;
    pendingRoomActions.delete(action);
    if (entry.roomId === currentRoomState?.id && entry.generation === roomActionGeneration) {
      showToast(response.ok ? successMessage : response.error);
    }
    updateRoomActionAvailability();
  }

  function stopTypingSignal() {
    if (typingIdleTimer) {
      clearTimeout(typingIdleTimer);
      typingIdleTimer = null;
    }
    if (typingSent) {
      typingSent = false;
      void sendAction({ action: WPConstants.ACTION.ROOM_TYPING_SEND, typing: false, roomId: currentRoomState?.id });
    }
  }

  function scheduleTypingStop() {
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    typingIdleTimer = setTimeout(() => {
      stopTypingSignal();
    }, 1200);
  }

  /** @param {Event | null} [event] */
  function onChatInput(event = null) {
    if (!isTrustedUserEvent(event)) return;
    if (!currentRoomState?.id || !currentWsConnected) return;
    const input = inputById('chat-input');
    const hasText = !!input?.value.trim();
    if (!hasText) {
      stopTypingSignal();
      return;
    }
    if (!typingSent) {
      typingSent = true;
      void sendAction({ action: WPConstants.ACTION.ROOM_TYPING_SEND, typing: true, roomId: currentRoomState?.id });
    }
    scheduleTypingStop();
  }

  function appendChat(userId, name, content) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const color = getUserColor(userId);
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const sender = document.createElement('span');
    sender.className = 'chat-name';
    sender.style.color = color;
    sender.textContent = name;
    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = content;
    div.append(sender, ' ', text);
    container.appendChild(div);
    pruneOldChildren(container);
    container.scrollTop = container.scrollHeight;
  }

  function appendBookmark(msg) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const key = getBookmarkKey(msg || {});
    if (renderedBookmarkKeys.has(key)) return;
    renderedBookmarkKeys.add(key);
    if (renderedBookmarkKeys.size > 300) {
      renderedBookmarkKeys.delete(renderedBookmarkKeys.values().next().value);
    }
    const mins = Math.floor((msg.time || 0) / 60);
    const secs = Math.floor((msg.time || 0) % 60).toString().padStart(2, '0');
    const div = document.createElement('div');
    const sender = WPUtils.getMatchingRoomUser(currentRoomState, msg.user, null);
    const colorKey = sender?.sessionId || msg.sessionId || msg.user;
    div.className = 'bookmark-msg';
    div.append('Pinned by ');
    const senderName = document.createElement('span');
    senderName.className = 'chat-name';
    senderName.style.color = getUserColor(colorKey);
    senderName.textContent = msg.userName || 'Unknown';
    const timeButton = document.createElement('button');
    timeButton.className = 'bookmark-time';
    timeButton.type = 'button';
    timeButton.textContent = `${mins}:${secs}`;
    bookmarkButtons.add(timeButton);
    div.append(senderName, ' at ', timeButton);
    timeButton.addEventListener('click', (event) => {
      void runRoomAction({ action: WPConstants.ACTION.ROOM_BOOKMARK_SEEK, time: msg.time }, event, `Seek requested: ${mins}:${secs}`);
    });
    container.appendChild(div);
    pruneOldChildren(container);
    container.scrollTop = container.scrollHeight;
    updateRoomActionAvailability();
  }

  function getBookmarkKey(msg) {
    const identity = msg.sessionId || msg.user || 'unknown';
    const time = Number.isFinite(msg.time) ? Math.floor(msg.time * 1000) : 0;
    return `${identity}:${time}`;
  }

  function renderBookmarkHistory(roomState) {
    const bookmarks = Array.isArray(roomState?.bookmarks) ? roomState.bookmarks : [];
    if (bookmarks.length === 0) return;
    for (const bookmark of [...bookmarks].sort((a, b) => (a.date || 0) - (b.date || 0))) {
      appendBookmark(bookmark);
    }
  }

  /** @param {Event | null} [event] */
  async function sendChat(event = null) {
    const input = inputById('chat-input');
    const content = input?.value.trim();
    if (!input || !content || !isTrustedUserEvent(event) || pendingChat || !currentRoomState?.id || !currentWsConnected || Date.now() < chatCooldownUntil) return;
    if (content.length > 300) { showToast('Messages can contain up to 300 characters.'); return; }
    if (!WPActionContract.isAllowedSource(WPConstants.ACTION.ROOM_CHAT_SEND, 'sidepanel')) return;
    const entry = { roomId: currentRoomState.id, clientMessageId: crypto.randomUUID(), draft: input.value, timer: /** @type {number | null} */ (null) };
    pendingChat = entry;
    updateChatAvailability();
    entry.timer = setTimeout(() => finishChat(entry, false, 'Delivery was not confirmed. Your draft is still here.'), 10000);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'watchparty-ext', action: WPConstants.ACTION.ROOM_CHAT_SEND,
        roomId: entry.roomId, clientMessageId: entry.clientMessageId, content,
      });
      // The bridge only confirms transport acceptance. Render and clear the
      // draft exclusively after this request's canonical server echo.
      if (!response || response.ok !== true || response.handled === false || response.error) {
        finishChat(entry, false, response?.error || 'Message was not sent. Your draft is still here.');
      }
    } catch {
      finishChat(entry, false, 'Message was not sent. Your draft is still here.');
    }
  }

  function bindChat() {
    document.getElementById('chat-send')?.addEventListener('click', (event) => sendChat(event));
    document.getElementById('chat-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendChat(event);
      }
    });
    document.getElementById('chat-input')?.addEventListener('input', (event) => onChatInput(event));
    document.getElementById('chat-input')?.addEventListener('blur', stopTypingSignal);
  }

  function renderEmptyState() {
    renderedStatusKey = null;
    if (renderedRoomId) clearRoomChat();
    renderedRoomId = null;
    renderedBookmarkKeys.clear();
    const status = document.getElementById('status');
    const users = document.getElementById('users');
    const usersEmpty = document.getElementById('users-empty');
    const chatContainer = document.getElementById('chat-container');
    const chatEmpty = document.getElementById('chat-empty');
    const syncIndicator = document.getElementById('sync-indicator');
    const peopleCount = document.getElementById('people-count');
    const chatMessages = document.getElementById('chat-messages');
    if (!status || !users || !usersEmpty || !chatContainer || !chatEmpty || !syncIndicator || !peopleCount) return;

    setHeroCopy('Chat with your room while you watch.');
    const openButton = document.getElementById('sp-open-watchparty-header');
    if (openButton) openButton.textContent = 'Open Stremio';
    document.getElementById('people-section')?.classList.add('hidden');
    document.getElementById('chat-section')?.classList.add('hidden');
    updateRoomCodeChip(null);
    status.innerHTML = `
      <div class="empty-state">
        <h2 class="status-title">You're not in a room yet.</h2>
        <p>Open Stremio and use its WatchParty sidebar to create a room or join friends. Your people and chat will appear here.</p>
      </div>
    `;

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
    if (!users || !usersEmpty || !peopleCount) return;
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
    WPDOM.clear(users);
    for (const entry of entries) {
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
      const subline = [crown, playbackState, you].filter(Boolean).join(' | ');
      const row = WPDOM.el('div', { className: `user${entry.status === 'away' ? ' user-away' : ''}` });
      row.appendChild(WPDOM.el('span', { className: 'user-dot', style: { background: WPDOM.safeColor(color) } }));
      row.appendChild(WPDOM.el('div', { className: 'user-copy' }, [
        WPDOM.el('span', { className: 'user-name', text: entry.name || 'Unknown' }),
        WPDOM.el('span', { className: 'user-subline', text: subline }),
      ]));
      if (playback.label) {
        row.appendChild(WPDOM.el('span', { className: 'user-playhead', title: playback.title, text: playback.label }));
      }
      users.appendChild(row);
    }
  }

  function renderStatus(roomState) {
    const status = document.getElementById('status');
    const syncIndicator = document.getElementById('sync-indicator');
    const chatContainer = document.getElementById('chat-container');
    const chatEmpty = document.getElementById('chat-empty');
    if (!status || !syncIndicator || !chatContainer || !chatEmpty) return;
    const roomTitle = getRoomDisplayName(roomState);
    const isHost = amIHost();
    const detailUrl = getDetailUrl(roomState);
    const directStreamUrl = getDirectStreamUrl(roomState);
    const roleLabel = isHost ? 'Host' : 'Guest';
    const privacyLabel = roomState.public === false ? 'Invite only' : 'Anyone can join';
    const wsLabel = currentWsConnected ? 'Connected' : 'Reconnecting…';
    const sessionCopy = `${privacyLabel} · ${roomState.listed === false ? 'Not listed' : 'Listed in room browser'}`;

    setHeroCopy('');
    const openButton = document.getElementById('sp-open-watchparty-header');
    if (openButton) openButton.textContent = 'Return to Stremio';
    document.getElementById('people-section')?.classList.remove('hidden');
    document.getElementById('chat-section')?.classList.remove('hidden');
    updateRoomCodeChip(roomState);

    const linkHtml = [];
    if (detailUrl) {
      linkHtml.push(`<a class="session-link" href="${escapeHtml(detailUrl)}" target="_blank" rel="noreferrer">Open title</a>`);
    }
    if (directStreamUrl) {
      linkHtml.push(`<a class="session-link" href="${escapeHtml(directStreamUrl)}" target="_blank" rel="noreferrer">Open host stream</a>`);
    }

    // Playback/presence updates can arrive many times per second. Keep live
    // buttons mounted unless their displayed room context actually changes.
    const statusKey = JSON.stringify([roomState.id, roomTitle, isHost, currentWsConnected, sessionCopy, detailUrl, directStreamUrl]);
    if (statusKey !== renderedStatusKey) {
      renderedStatusKey = statusKey;
      // Room updates should not close the user's menu or discard keyboard focus.
      const toolsPanel = document.getElementById('sp-room-tools');
      const toolsOpen = toolsPanel instanceof HTMLDetailsElement && toolsPanel.open;
      const focusedId = status.contains(document.activeElement) ? document.activeElement?.id : '';
      status.innerHTML = `
        <div class="status-copy">
          <div class="eyebrow">Room</div>
          <h2 class="status-title">${escapeHtml(roomTitle)}</h2>
          <div class="pill-row">
            <span class="pill ${isHost ? 'success' : ''}">${escapeHtml(roleLabel)}</span>
            <span class="pill ${currentWsConnected ? 'success' : 'warn'}">${escapeHtml(wsLabel)}</span>
          </div>
          <p class="status-note">${escapeHtml(sessionCopy)}</p>
          <div class="action-row">
            <button class="action-btn" id="sp-copy-invite" type="button">Copy Invite</button>
          </div>
          <details class="room-tools" id="sp-room-tools"${toolsOpen ? ' open' : ''}>
            <summary id="sp-room-tools-summary">Room actions</summary>
            ${linkHtml.length > 0 ? `<div class="session-links">${linkHtml.join('')}</div>` : ''}
            <div class="action-row">
              ${isHost ? '<button class="action-btn" id="sp-ready-check" type="button">Ready Check</button>' : ''}
              <button class="action-btn" id="sp-bookmark" type="button">Bookmark moment</button>
              <button class="action-btn leave-btn" id="sp-leave" type="button">Leave room</button>
            </div>
          </details>
        </div>
      `;
      if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });

      document.getElementById('sp-copy-invite')?.addEventListener('click', () => copyInvite(roomState));
      document.getElementById('sp-ready-check')?.addEventListener('click', (event) => runRoomAction(
        { action: WPConstants.ACTION.ROOM_READY_CHECK_UPDATE, readyAction: 'initiate' }, event, 'Ready check requested'));
      document.getElementById('sp-bookmark')?.addEventListener('click', (event) => runRoomAction(
        { action: WPConstants.ACTION.ROOM_BOOKMARK_ADD }, event, 'Bookmark requested'));
      document.getElementById('sp-leave')?.addEventListener('click', (event) => runRoomAction(
        { action: WPConstants.ACTION.ROOM_LEAVE }, event, 'Leave request accepted'));
    }
    updateRoomActionAvailability();

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
    if (renderedRoomId !== roomState.id) {
      clearRoomChat();
      renderedRoomId = roomState.id;
      renderedBookmarkKeys.clear();
      const chatMessages = document.getElementById('chat-messages');
      if (chatMessages) chatMessages.innerHTML = '';
    }
    renderStatus(roomState);
    renderUsers(roomState);
    renderBookmarkHistory(roomState);
    updateTypingIndicator();
  }

  function applyCoordinatorUpdate(payload) {
    if (!payload || typeof payload !== 'object') return;
    coordinatorRevision += 1;
    if (('room' in payload && payload.room?.id !== currentRoomState?.id)
        || ('wsConnected' in payload && payload.wsConnected !== currentWsConnected)) {
      roomActionGeneration += 1;
      pendingRoomActions.clear();
    }
    if ('room' in payload && payload.room?.id !== currentRoomState?.id) currentHasVideo = false;
    if ('userId' in payload) currentUserId = payload.userId || null;
    if ('sessionId' in payload) currentSessionId = payload.sessionId || null;
    if ('room' in payload) currentRoomState = payload.room || null;
    if ('wsConnected' in payload) currentWsConnected = payload.wsConnected === true;
    if ('adapterState' in payload) currentHasVideo = payload.adapterState?.hasVideo === true;
    if (!currentRoomState) currentHasVideo = false;
    render(currentRoomState);
    if (!currentWsConnected) finishChat(pendingChat, false, 'Disconnected. Your draft is still here.');
    updateChatAvailability();
  }

  function loadCoordinatorState() {
    const requestedRevision = coordinatorRevision;
    chrome.runtime.sendMessage(
      { type: 'watchparty-ext', action: WPConstants.ACTION.STATUS_GET },
      (response) => {
        if (!response || coordinatorRevision !== requestedRevision) return;
        applyCoordinatorUpdate({
          room: response.room || null,
          userId: response.userId || null,
          sessionId: response.sessionId || null,
          wsConnected: response.wsConnected === true,
          adapterState: response.adapterState || null,
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
      if (!currentRoomState?.id || msg.roomId !== currentRoomState.id || typeof msg.content !== 'string') return false;
      // Replays and cross-tab relays are idempotent, including our own messages
      // sent from the main overlay or another companion window.
      if (!msg.id || renderedMessageIds.has(msg.id)) return false;
      renderedMessageIds.add(msg.id);
      if (renderedMessageIds.size > 300) renderedMessageIds.delete(renderedMessageIds.values().next().value);
      const sender = WPUtils.getMatchingRoomUser(currentRoomState, msg.user, msg.sessionId);
      const name = sender?.name || msg.userName || 'Unknown';
      const own = WPUtils.isCurrentSessionUser(sender || { id: msg.user, sessionId: msg.sessionId }, currentUserId, currentSessionId);
      appendChat(sender?.sessionId || msg.sessionId || msg.user, own ? 'You' : name, msg.content);
      if (own) {
        chatCooldownUntil = Date.now() + 3000;
        clearTimeout(chatCooldownTimer);
        chatCooldownTimer = setTimeout(updateChatAvailability, 3000);
        if (pendingChat?.roomId === msg.roomId && pendingChat.clientMessageId === msg.clientMessageId) finishChat(pendingChat, true);
        updateChatAvailability();
      }
    }

    if (message.action === WPConstants.ACTION.ROOM_ERROR_EVENT && message.payload) {
      const error = message.payload;
      if (pendingChat && error.roomId === pendingChat.roomId && error.clientMessageId === pendingChat.clientMessageId) {
        finishChat(pendingChat, false, error.message || 'Message was not sent. Your draft is still here.');
      } else if (currentRoomState?.id && error.roomId === currentRoomState.id && !error.clientMessageId
          && [WPConstants.ACTION.ROOM_READY_CHECK_UPDATE, WPConstants.ACTION.ROOM_BOOKMARK_ADD,
            WPConstants.ACTION.ROOM_BOOKMARK_SEEK].includes(error.command)) {
        showToast(error.message || 'The room action was rejected. Try again.');
      }
    }

    if (message.action === WPConstants.ACTION.ROOM_BOOKMARK_EVENT && message.payload) {
      if (!currentRoomState?.id || (message.payload.roomId && message.payload.roomId !== currentRoomState.id)) return false;
      appendBookmark(message.payload);
    }

    if (message.action === WPConstants.ACTION.ROOM_TYPING_EVENT && message.payload) {
      if (!currentRoomState?.id || (message.payload.roomId && message.payload.roomId !== currentRoomState.id)) return false;
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

