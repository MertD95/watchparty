// WatchParty for Stremio — Content Script Orchestrator
// Wires together: WPWS (WebSocket), WPSync (sync engine), WPOverlay (UI), WPProfile (profile reader).
// Owns: Room state, video detection, action dispatch, presence, playback status.
//
// Module load order (manifest.json):
//   stremio-sync.js → stremio-ws.js → stremio-overlay.js → stremio-profile.js → stremio-content.js

(() => {
  'use strict';

  // --- Room + video state ---
  let video = null;
  let inRoom = false;
  let isHost = false;
  let userId = null;
  let roomState = null;
  let prevPlayerTime = 0;
  let chatMessages = [];
  let observer = null;
  let typingUsers = new Map();
  let lastUserAction = null;

  let sessionId = null; // Persistent session ID — same across all tabs

  // --- Active video tab election (Spotify-style: only ONE tab syncs at a time) ---
  // When multiple tabs have video, only the most recent one sends sync/playback/stream messages.
  // Other tabs remain passive (chat/reactions still work).
  let isActiveVideoTab = false;
  let lastKnownContentMeta = null;
  let lastSharedContentKey = null;
  let pendingJoinOptions = null;
  let shareContentLinkInFlight = false;

  const PLACEHOLDER_ROOM_NAME = 'WatchParty Session';
  const PLACEHOLDER_STREAM_URL = 'https://watchparty.mertd.me/sync';

  function claimActiveTab() {
    if (!extOk() || !userId) return;
    isActiveVideoTab = true;
    chrome.storage.local.set({ [WPConstants.STORAGE.ACTIVE_VIDEO_TAB]: userId });
  }

  function releaseActiveTab() {
    if (!extOk()) return;
    isActiveVideoTab = false;
    // Only clear if we currently own it
    chrome.storage.local.get(WPConstants.STORAGE.ACTIVE_VIDEO_TAB, (result) => {
      if (result[WPConstants.STORAGE.ACTIVE_VIDEO_TAB] === userId) {
        chrome.storage.local.remove(WPConstants.STORAGE.ACTIVE_VIDEO_TAB);
      }
    });
  }

  // --- Extension context guard (WS survives extension reloads, but chrome APIs don't) ---
  function extOk() { return !!chrome.runtime?.id; }

  function isPlaceholderMeta(meta) {
    return !meta || meta.id === 'pending' || meta.id === 'unknown' || meta.name === PLACEHOLDER_ROOM_NAME;
  }

  function isPlaceholderStream(stream) {
    return !stream?.url || stream.url === PLACEHOLDER_STREAM_URL;
  }

  function normalizePendingJoinOptions(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.roomId !== 'string' || !value.roomId || value.preferDirectJoin !== true) return null;
    return { roomId: value.roomId, preferDirectJoin: true };
  }

  function syncPendingJoinOptions(value, roomId) {
    const next = normalizePendingJoinOptions(value);
    if (!next) {
      pendingJoinOptions = null;
      return null;
    }
    if (roomId && next.roomId !== roomId) {
      pendingJoinOptions = null;
      if (extOk()) chrome.storage.local.remove(WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS).catch(() => { });
      return null;
    }
    pendingJoinOptions = next;
    return next;
  }

  function clearPendingJoinOptions(roomId) {
    if (roomId && pendingJoinOptions?.roomId && pendingJoinOptions.roomId !== roomId) return;
    pendingJoinOptions = null;
    if (extOk()) chrome.storage.local.remove(WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS).catch(() => { });
  }

  function buildSharedStreamKey(stream) {
    const behaviorHints = stream?.behaviorHints || {};
    const proxyHeaderKeys = behaviorHints.proxyHeaders
      ? Object.keys(behaviorHints.proxyHeaders).sort().join('|')
      : '';
    return [
      stream?.url || '',
      stream?.resolvedUrl || '',
      stream?.infoHash || '',
      Number.isInteger(stream?.fileIdx) ? String(stream.fileIdx) : '',
      stream?.ytId || '',
      stream?.externalUrl || '',
      stream?.filename || '',
      stream?.bingeGroup || behaviorHints.bingeGroup || '',
      stream?.streamTransportUrl || '',
      stream?.metaTransportUrl || '',
      stream?.addonTransportUrl || '',
      behaviorHints.notWebReady ? 'not-web-ready' : '',
      proxyHeaderKeys,
      Array.isArray(stream?.sources) ? stream.sources.join('|') : '',
    ].join('::');
  }

  function maybeHandlePendingDirectJoin(room) {
    if (!room?.id || isHost || pendingJoinOptions?.roomId !== room.id || pendingJoinOptions?.preferDirectJoin !== true) {
      return { handled: false, navigated: false, failed: false, alreadyOpen: false };
    }

    clearPendingJoinOptions(room.id);
    const directJoin = WPDirectPlay.classifyStream(room.stream);
    if (!directJoin.hasDirectJoin || !directJoin.url) {
      const prefix = directJoin.directJoinType === 'debrid-url' ? 'Warning' : 'DirectPlay failed';
      WPOverlay.showToast(`${prefix}: ${directJoin.failureReason || 'Host stream is not portable yet.'}`, 4200);
      return { handled: true, navigated: false, failed: true, alreadyOpen: false };
    }

    try {
      const targetUrl = new URL(directJoin.url);
      const sameOrigin = targetUrl.origin === window.location.origin;
      const sameHash = sameOrigin && targetUrl.hash === window.location.hash;
      if (sameHash) {
        return { handled: true, navigated: false, failed: false, alreadyOpen: true };
      }

      const message = directJoin.directJoinType === 'debrid-url'
        ? 'Opening host stream directly. Playback may depend on your account access.'
        : 'Opening host stream directly...';
      WPOverlay.showToast(message, 2200);
      if (sameOrigin) {
        window.location.hash = targetUrl.hash.slice(1);
      } else {
        window.location.href = targetUrl.toString();
      }
      return { handled: true, navigated: true, failed: false, alreadyOpen: false };
    } catch {
      WPOverlay.showToast('DirectPlay failed: invalid host stream URL.', 3000);
      return { handled: true, navigated: false, failed: true, alreadyOpen: false };
    }
  }

  // --- Persist state to storage for popup queries ---
  function persistState() {
    if (!extOk()) return;
    chrome.storage.local.set({
      [WPConstants.STORAGE.ROOM_STATE]: roomState,
      [WPConstants.STORAGE.USER_ID]: userId,
      [WPConstants.STORAGE.WS_CONNECTED]: WPWS.isConnected(),
      [WPConstants.STORAGE.ACTIVE_BACKEND]: WPWS.getActiveBackend(),
      [WPConstants.STORAGE.ACTIVE_BACKEND_URL]: WPWS.getActiveWsUrl(),
    }).catch(() => { });
  }

  function persistConnectionState() {
    if (!extOk()) return;
    chrome.storage.local.set({
      [WPConstants.STORAGE.WS_CONNECTED]: WPWS.isConnected(),
      [WPConstants.STORAGE.ACTIVE_BACKEND]: WPWS.getActiveBackend(),
      [WPConstants.STORAGE.ACTIVE_BACKEND_URL]: WPWS.getActiveWsUrl(),
    }).catch(() => { });
  }

  function notifyBackground(data) {
    if (!extOk()) return;
    try {
      chrome.runtime.sendMessage({ type: 'watchparty-ext', ...data }).catch(() => { });
    } catch { /* context invalidated */ }
  }

  // --- WS callbacks ---
  WPWS.onConnect(() => {
    persistConnectionState();
    notifyBackground({
      action: 'ws-status-changed',
      connected: true,
      activeBackend: WPWS.getActiveBackend(),
      activeBackendUrl: WPWS.getActiveWsUrl(),
    });
    WPSync.resetCorrection();
    // If we were in a room, rejoin (with replay if we have a sequence number)
    if (roomState?.id) {
      // Load E2E crypto key before rejoining (prevents garbled messages on new tabs)
      loadCryptoKeyForRoom(roomState.id).then(() => {
        // Send username + sessionId so server knows who we are
        chrome.storage.local.get(WPConstants.STORAGE.USERNAME, (result) => {
          if (result[WPConstants.STORAGE.USERNAME]) {
            WPWS.send({ type: WPProtocol.C2S.USER_UPDATE, payload: { username: result[WPConstants.STORAGE.USERNAME], sessionId } });
          }
          const seq = WPWS.getLastSeq();
          if (seq > 0) {
            WPWS.send({ type: WPProtocol.C2S.ROOM_REJOIN, payload: { id: roomState.id, lastSeq: seq } });
          } else {
            WPWS.send({ type: WPProtocol.C2S.ROOM_JOIN, payload: { id: roomState.id } });
          }
        });
      });
    }
  });

  WPWS.onDisconnect(() => {
    persistConnectionState();
    notifyBackground({
      action: 'ws-status-changed',
      connected: false,
      activeBackend: WPWS.getActiveBackend(),
      activeBackendUrl: WPWS.getActiveWsUrl(),
    });
  });

  function processWsEvent(msg) {
    if (!msg || !msg.type) return;
    const p = msg.payload;

    switch (msg.type) {
      case WPProtocol.S2C.READY:
        if (!p?.user?.id) return;
        userId = p.user.id;
        if (p.protocol && p.protocol > WPProtocol.PROTOCOL_VERSION) {
          WPOverlay.showToast('Server updated — please update the WatchParty extension', 5000);
        }
        processPendingActions();
        WPWS.startClockSync();
        persistState();
        refreshOverlay();
        break;

      case WPProtocol.S2C.SYNC:
        if (!p) return;
        prevPlayerTime = roomState?.player?.time || 0;
        roomState = p;
        persistState();
        onRoomSync();
        break;

      case WPProtocol.S2C.ROOM:
        if (!p?.id) return;
        roomState = p;
        if (extOk()) chrome.storage.local.set({ [WPConstants.STORAGE.CURRENT_ROOM]: roomState.id });
        persistState();
        onRoomJoined();
        break;

      case WPProtocol.S2C.MESSAGE:
        if (!p) return;
        onChatMessage(p);
        break;

      case WPProtocol.S2C.CHAT_HISTORY:
        if (!p?.messages) return;
        // Load persisted chat history (on join/rejoin)
        for (const msg of p.messages) {
          onChatMessage(msg);
        }
        break;

      case WPProtocol.S2C.USER:
        if (!p?.user?.id) return;
        userId = p.user.id;
        persistState();
        break;

      case WPProtocol.S2C.ERROR:
        if (p?.code === WPProtocol.ERROR_CODE.ROOM_NOT_FOUND) {
          const wasInRoom = inRoom;
          clearPendingJoinOptions();
          inRoom = false; roomState = null;
          WPSync.detach();
          if (extOk()) chrome.storage.local.remove([WPConstants.STORAGE.CURRENT_ROOM, WPConstants.STORAGE.PENDING_ROOM_JOIN]);
          refreshOverlay();
          persistState();
          if (wasInRoom || p?.code === WPProtocol.ERROR_CODE.ROOM_NOT_FOUND) {
            WPOverlay.showToast('Room no longer exists', 3000);
          }
        }
        // Show error feedback for non-room errors
        if (p?.code !== WPProtocol.ERROR_CODE.ROOM_NOT_FOUND && p?.message) {
          if (p.code === WPProtocol.ERROR_CODE.COOLDOWN && lastUserAction === 'send-chat') {
            WPOverlay.showToast('Slow down! Wait a moment before sending again.', 2000);
          } else if (p.code === WPProtocol.ERROR_CODE.NOT_OWNER) {
            WPOverlay.showToast('Only the host can do that.', 2000);
          } else if (p.code !== WPProtocol.ERROR_CODE.COOLDOWN && p.code !== WPProtocol.ERROR_CODE.VALIDATION_FAILED) {
            WPOverlay.showToast(p.message, 2000);
          }
        }
        break;

      case WPProtocol.S2C.TYPING:
        if (!p?.user) return;
        onTyping(p.user, p.typing);
        break;

      case WPProtocol.S2C.REACTION:
        if (!p?.user || !p?.emoji) return;
        WPOverlay.showReaction(p.user, p.emoji, roomState);
        break;

      case WPProtocol.S2C.AUTOPAUSE:
        if (!p?.name) return;
        WPOverlay.showToast(`Paused \u2014 ${p.name} disconnected`);
        break;

      case WPProtocol.S2C.READY_CHECK:
        WPOverlay.showReadyCheck(p.action, p.confirmed, p.total, userId);
        break;

      case WPProtocol.S2C.COUNTDOWN:
        WPOverlay.showCountdown(p.seconds);
        break;

      case WPProtocol.S2C.BOOKMARK:
        WPOverlay.appendBookmark(p);
        notifyBackground({ action: 'bookmark', payload: p });
        break;

      // --- Delta events (lightweight, avoid full room broadcasts) ---

      case WPProtocol.S2C.PLAYER_SYNC:
        if (!p?.player || !roomState) return;
        prevPlayerTime = roomState.player?.time || 0;
        roomState.player = p.player;
        onRoomSync();
        break;

      case WPProtocol.S2C.PRESENCE_UPDATE:
        if (!p?.userId || !roomState?.users) return;
        const presUser = roomState.users.find(u => u.id === p.userId);
        if (presUser) presUser.status = p.status;
        refreshOverlay();
        break;

      case WPProtocol.S2C.PLAYBACK_STATUS_UPDATE:
        if (!p?.userId || !roomState?.users) return;
        const pbUser = roomState.users.find(u => u.id === p.userId);
        if (pbUser) pbUser.playbackStatus = p.status;
        refreshOverlay();
        break;

      case WPProtocol.S2C.SETTINGS_UPDATE:
        if (!p?.settings || !roomState) return;
        roomState.settings = p.settings;
        refreshOverlay();
        break;
    }
  }

  // Wire up: active tab processes WS events and broadcasts to passive tabs
  WPWS.onMessage((msg) => {
    processWsEvent(msg);
  });

  // --- Process pending create/join actions from storage ---
  function processPendingActions() {
    if (!WPWS.isReady() || !extOk()) return;
    // sessionId MUST be loaded before sending any room messages — otherwise server can't dedup
    if (!sessionId) return;
    chrome.storage.local.get([
      WPConstants.STORAGE.PENDING_ROOM_CREATE,
      WPConstants.STORAGE.PENDING_ROOM_JOIN,
      WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS,
      WPConstants.STORAGE.CURRENT_ROOM,
      WPConstants.STORAGE.USERNAME,
    ], (stored) => {
      if (stored[WPConstants.STORAGE.PENDING_ROOM_CREATE]) {
        clearPendingJoinOptions();
        chrome.storage.local.remove(WPConstants.STORAGE.PENDING_ROOM_CREATE);
        // Leave current room first if still connected (prevents rejoining old room)
        if (inRoom) {
          WPWS.send({ type: WPProtocol.C2S.ROOM_LEAVE, payload: {} });
          inRoom = false; roomState = null; isHost = false;
        }
        chrome.storage.local.remove(WPConstants.STORAGE.CURRENT_ROOM);
        const rc = stored[WPConstants.STORAGE.PENDING_ROOM_CREATE];
        if (rc.username) WPWS.send({ type: WPProtocol.C2S.USER_UPDATE, payload: { username: rc.username, sessionId } });
        const context = getCurrentContentContext();
        const meta = (isPlaceholderMeta(rc.meta) && context.meta) ? context.meta : rc.meta;
        const stream = (isPlaceholderStream(rc.stream) && context.launchUrl) ? { url: context.launchUrl } : rc.stream;
        const payload = { meta, stream, public: rc.public || false };
        if (rc.roomName) payload.name = rc.roomName;
        WPWS.send({ type: WPProtocol.C2S.ROOM_NEW, payload });
      } else {
        const roomToJoin = stored[WPConstants.STORAGE.PENDING_ROOM_JOIN] || stored[WPConstants.STORAGE.CURRENT_ROOM];
        const joinOptions = syncPendingJoinOptions(stored[WPConstants.STORAGE.PENDING_ROOM_JOIN_OPTIONS], roomToJoin);
        if (stored[WPConstants.STORAGE.PENDING_ROOM_JOIN]) chrome.storage.local.remove(WPConstants.STORAGE.PENDING_ROOM_JOIN);
        if (roomToJoin) {
          // Import E2E encryption key BEFORE joining (prevents race where first encrypted message arrives before key is ready)
          const keyStorageKey = WPConstants.STORAGE.roomKey(roomToJoin);
          // Try session storage first (secure, in-memory), fall back to local storage
          chrome.storage.session.get(keyStorageKey, async (keyResult) => {
            if (chrome.runtime.lastError || !keyResult[keyStorageKey]) {
              // Fallback: check local storage (older browsers or key stored before session migration)
              return chrome.storage.local.get(keyStorageKey, async (localResult) => {
                await importKeyAndJoin(localResult[keyStorageKey], roomToJoin, stored);
              });
            }
            await importKeyAndJoin(keyResult[keyStorageKey], roomToJoin, stored);
          });
        } else if (!joinOptions) {
          clearPendingJoinOptions();
        }
      }
    });
  }

  /** Load E2E crypto key from storage for a room (session → local fallback) */
  function loadCryptoKeyForRoom(roomId) {
    if (WPCrypto.isEnabled() || !extOk()) return Promise.resolve();
    const key = WPConstants.STORAGE.roomKey(roomId);
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get(key, async (result) => {
          if (chrome.runtime.lastError || !result?.[key]) {
            try {
              chrome.storage.local.get(key, async (local) => {
                if (local[key]) try { await WPCrypto.importKey(local[key]); } catch { /* invalid key */ }
                resolve();
              });
            } catch { resolve(); } // Extension context invalidated
            return;
          }
          try { await WPCrypto.importKey(result[key]); } catch { /* invalid key */ }
          resolve();
        });
      } catch { resolve(); } // Extension context invalidated
    });
  }

  async function importKeyAndJoin(cryptoKeyStr, roomToJoin, stored) {
    if (cryptoKeyStr && !WPCrypto.isEnabled()) {
      try { await WPCrypto.importKey(cryptoKeyStr); } catch { /* invalid key */ }
    }
    if (!extOk() || !WPWS.isReady()) return;
    if (stored[WPConstants.STORAGE.USERNAME]) WPWS.send({ type: WPProtocol.C2S.USER_UPDATE, payload: { username: stored[WPConstants.STORAGE.USERNAME], sessionId } });
    WPWS.send({ type: WPProtocol.C2S.ROOM_JOIN, payload: { id: roomToJoin } });
  }

  // --- Room event handlers ---

  function isMe(uid) {
    if (uid === userId) return true;
    if (!sessionId || !roomState?.users) return false;
    const user = roomState.users.find(u => u.id === uid);
    if (user) return user.sessionId === sessionId;
    // uid not in users list (orphaned owner after reconnect/dedup) —
    // check if WE are in the users list (if so, and owner is orphaned, we're likely the owner)
    return false;
  }

  /** Am I the room host? Handles orphaned owner IDs after WS reconnect. */
  function amIHost() {
    if (!roomState) return false;
    if (isMe(roomState.owner)) return true;
    // Owner ID not in users list (stale) — if we're in the room, we're the host
    const ownerInList = roomState.users?.some(u => u.id === roomState.owner);
    if (!ownerInList && roomState.users?.some(u => u.id === userId || (sessionId && u.sessionId === sessionId))) return true;
    return false;
  }

  async function onRoomJoined() {
    inRoom = true;
    isHost = amIHost();
    if (video) { claimActiveTab(); attachSync(); }
    refreshOverlay();
    const directJoinResult = !isHost ? maybeHandlePendingDirectJoin(roomState) : null;
    // E2E encryption is opt-in: only enabled when a key is provided via invite URL.
    // Auto-generating keys breaks multi-tab (other tabs can't reliably read the key from session storage).
    WPOverlay.bindRoomCodeCopy(roomState);
    WPOverlay.playNotifSound();
    if (isHost) {
      // Only the active video tab shares content link
      if (isActiveVideoTab) shareContentLink();
    } else if (directJoinResult?.handled && !directJoinResult.failed) {
      WPOverlay.openSidebar();
      return;
    } else {
      // Auto-navigate to host's content — but only if this tab doesn't already have video
      // (prevents a tab mid-playback from being redirected)
      if (!video) {
        const meta = roomState.meta;
        if (meta?.id && meta.id !== 'pending' && meta.id !== 'unknown' && meta.type) {
          const currentInfo = getCurrentContentInfo();
          if (!currentInfo || currentInfo.id !== meta.id) {
            const detailUrl = `#/detail/${encodeURIComponent(meta.type)}/${encodeURIComponent(meta.id)}`;
            WPOverlay.showToast(`Navigating to: ${meta.name || meta.id}`);
            setTimeout(() => { window.location.hash = detailUrl.slice(1); }, 500);
          }
        }
      }
    }
    WPOverlay.openSidebar();
  }

  function onRoomSync() {
    const wasHost = isHost;
    isHost = amIHost();
    inRoom = true;
    if (roomState?.id && extOk()) chrome.storage.local.set({ [WPConstants.STORAGE.CURRENT_ROOM]: roomState.id });
    WPSync.setHost(isHost);
    refreshOverlay();
    const directJoinResult = !isHost ? maybeHandlePendingDirectJoin(roomState) : null;
    if (directJoinResult?.navigated) return;
    if (!isHost && roomState.player) {
      if (video) {
        const newTime = roomState.player.time || 0;
        if (Math.abs(newTime - prevPlayerTime) > 5) {
          const mins = Math.floor(newTime / 60);
          const secs = Math.floor(newTime % 60).toString().padStart(2, '0');
          WPOverlay.showToast(`Host seeked to ${mins}:${secs}`);
        }
        WPSync.applyRemote(roomState.player);
        const drift = WPSync.getLastDrift();
        WPOverlay.updateSyncIndicator(isHost, drift);
        WPOverlay.showCatchUpButton(drift);
      }
    }
    if (!wasHost && isHost) WPOverlay.playNotifSound();
  }

  // Buffer for encrypted messages that arrive before key is loaded
  const pendingEncryptedMessages = [];

  async function onChatMessage(message) {
    // Decrypt E2E-encrypted messages
    if (WPCrypto.isEncrypted(message.content)) {
      const decrypted = await WPCrypto.decrypt(message.content);
      if (decrypted === '[encrypted message]') {
        // Key not loaded yet — buffer for retry when key arrives
        if (pendingEncryptedMessages.length < 50) pendingEncryptedMessages.push(message);
        return; // Don't display garbled text
      }
      message = { ...message, content: decrypted };
    }
    chatMessages.push(message);
    if (chatMessages.length > 200) chatMessages.shift();
    WPOverlay.appendChatMessage(message, roomState, userId);
    if (!isMe(message.user)) WPOverlay.incrementUnread();
    // Relay to side panel (it can't access content script globals)
    notifyBackground({ action: 'chat-message', payload: message });
  }

  // When crypto key becomes available, re-process buffered encrypted messages
  WPCrypto.onKeyLoaded(() => {
    while (pendingEncryptedMessages.length > 0) {
      onChatMessage(pendingEncryptedMessages.shift());
    }
  });

  function onTyping(user, typing) {
    if (typing) {
      const existing = typingUsers.get(user);
      if (existing) clearTimeout(existing);
      typingUsers.set(user, setTimeout(() => {
        typingUsers.delete(user);
        WPOverlay.updateTypingIndicator(typingUsers, userId, roomState);
      }, 3000));
    } else {
      const t = typingUsers.get(user);
      if (t) clearTimeout(t);
      typingUsers.delete(user);
    }
    WPOverlay.updateTypingIndicator(typingUsers, userId, roomState);
  }

  // --- Content link sharing ---
  async function shareContentLink() {
    if (shareContentLinkInFlight) return;
    shareContentLinkInFlight = true;
    try {
      const context = getCurrentContentContext();
      if (!context.meta && !context.launchUrl) return;

      const stream = context.launchUrl
        ? await WPDirectPlay.normalizeSharedStream({ url: context.launchUrl })
        : { url: PLACEHOLDER_STREAM_URL };
      if (!inRoom || !isHost || !isActiveVideoTab) return;

      if (!context.meta) {
        const streamOnlyKey = `stream:::${buildSharedStreamKey(stream)}`;
        if (lastSharedContentKey === streamOnlyKey) return;
        lastSharedContentKey = streamOnlyKey;
        WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_STREAM, payload: { stream } });
        return;
      }

      const meta = { ...context.meta };
      const shareKey = `${meta.type}:${meta.id}:${meta.name || ''}:${buildSharedStreamKey(stream)}`;
      if (lastSharedContentKey === shareKey) return;

      if ((!meta.name || meta.name === meta.id) && meta.id?.startsWith('tt')) {
        lastSharedContentKey = shareKey;
        fetch(`https://v3-cinemeta.strem.io/meta/${meta.type}/${meta.id}.json`, { signal: AbortSignal.timeout(3000) })
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data?.meta?.name) meta.name = data.meta.name;
            lastSharedContentKey = `${meta.type}:${meta.id}:${meta.name || ''}:${buildSharedStreamKey(stream)}`;
            WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_STREAM, payload: { stream, meta } });
          })
          .catch(() => {
            WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_STREAM, payload: { stream, meta } });
          });
      } else {
        lastSharedContentKey = shareKey;
        WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_STREAM, payload: { stream, meta } });
      }
    } finally {
      shareContentLinkInFlight = false;
    }
  }

  // --- Video element detection ---
  function startVideoObserver() {
    if (observer) return;
    let videoCheckTimer = null;
    observer = new MutationObserver(() => {
      if (videoCheckTimer) return;
      videoCheckTimer = setTimeout(() => {
        videoCheckTimer = null;
        const v = document.querySelector('video');
        if (v && v !== video) {
          video = v;
          if (inRoom) {
            claimActiveTab(); // This tab now owns sync
            attachSync();
            if (isHost && isActiveVideoTab) shareContentLink();
          }
          refreshOverlay();
        } else if (!v && video) {
          WPSync.detach();
          video = null;
          releaseActiveTab();
          refreshOverlay();
        }
      }, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const v = document.querySelector('video');
    if (v) { video = v; if (inRoom) { claimActiveTab(); attachSync(); } }
  }

  // --- Sync wiring ---
  function attachSync() {
    if (!video || WPSync.isAttached()) return;
    WPSync.attach(video, {
      isHost,
      onSync(state) {
        if (roomState && amIHost() && isActiveVideoTab) {
          WPWS.send({ type: WPProtocol.C2S.PLAYER_SYNC, payload: { paused: state.paused, buffering: state.buffering, time: state.time, speed: state.speed } });
        }
      },
    });
  }

  // --- Stremio page info ---
  function parseDetailHash(hash) {
    const m = (hash || '').match(/^#\/(?:detail|metadetails)\/([^/?#]+)\/([^/?#]+)/);
    if (!m) return null;
    return {
      type: decodeURIComponent(m[1]),
      id: decodeURIComponent(m[2]),
    };
  }

  function parsePlayerHash(hash) {
    const m = (hash || '').match(/^#\/player\/([^/?#]+)(?:\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+))?/);
    if (!m) return null;
    return {
      stream: decodeURIComponent(m[1]),
      streamTransportUrl: m[2] ? decodeURIComponent(m[2]) : null,
      metaTransportUrl: m[3] ? decodeURIComponent(m[3]) : null,
      type: m[4] ? decodeURIComponent(m[4]) : null,
      id: m[5] ? decodeURIComponent(m[5]) : null,
      videoId: m[6] ? decodeURIComponent(m[6]) : null,
    };
  }

  function getCurrentLaunchUrl(hash = window.location.hash) {
    if (!/^#\/(?:detail|metadetails|player)\//.test(hash || '')) return null;
    return `${window.location.origin}/${hash}`;
  }

  function updateKnownContentMeta() {
    const info = parseDetailHash(window.location.hash);
    const playerInfo = parsePlayerHash(window.location.hash);
    const nextInfo = info || (playerInfo?.type && playerInfo.id
      ? { type: playerInfo.type, id: playerInfo.id }
      : null);
    if (!nextInfo) return lastKnownContentMeta;
    lastKnownContentMeta = {
      id: nextInfo.id,
      type: nextInfo.type,
      name: getContentTitle() || lastKnownContentMeta?.name || nextInfo.id,
    };
    return lastKnownContentMeta;
  }

  function getCurrentContentContext() {
    const hash = window.location.hash || '';
    const launchUrl = getCurrentLaunchUrl(hash);
    const detailInfo = parseDetailHash(hash);
    const playerInfo = parsePlayerHash(hash);
    const title = getContentTitle();

    if (detailInfo) {
      lastKnownContentMeta = {
        id: detailInfo.id,
        type: detailInfo.type,
        name: title || lastKnownContentMeta?.name || detailInfo.id,
      };
      return { meta: { ...lastKnownContentMeta }, launchUrl };
    }

    if (playerInfo) {
      if (playerInfo.type && playerInfo.id) {
        lastKnownContentMeta = {
          id: playerInfo.id,
          type: playerInfo.type,
          name: title || lastKnownContentMeta?.name || playerInfo.id,
        };
      }
      if (lastKnownContentMeta) {
        return {
          meta: {
            ...lastKnownContentMeta,
            name: title || lastKnownContentMeta.name || lastKnownContentMeta.id,
          },
          launchUrl,
        };
      }
      return {
        meta: null,
        launchUrl,
      };
    }

    return { meta: null, launchUrl: null };
  }

  function getCurrentContentInfo() {
    const info = parseDetailHash(window.location.hash)
      || (() => {
        const playerInfo = parsePlayerHash(window.location.hash);
        return playerInfo?.type && playerInfo.id
          ? { type: playerInfo.type, id: playerInfo.id }
          : null;
      })();
    if (info) return { ...info, url: getCurrentLaunchUrl() || window.location.href };
    return null;
  }

  function getContentTitle() {
    const navHeading = document.querySelector('nav h2');
    if (navHeading?.textContent?.trim()) return navHeading.textContent.trim();
    const logoImg = document.querySelector('[class*="logo-container"] img');
    if (logoImg?.alt?.trim()) return logoImg.alt.trim();
    return null;
  }

  // --- Overlay state refresh ---
  function refreshOverlay() {
    WPOverlay.updateState({ inRoom, isHost, userId, sessionId, roomState, hasVideo: !!video });
    if (inRoom && !isHost) {
      WPOverlay.updateSyncIndicator(isHost, WPSync.getLastDrift());
    }
  }

  function getActiveVideoElement() {
    return video || document.querySelector('video');
  }

  function resolveBookmarkTime(explicitTime) {
    if (Number.isFinite(explicitTime)) return Math.max(0, explicitTime);
    const activeVideo = getActiveVideoElement();
    return Number.isFinite(activeVideo?.currentTime) ? Math.max(0, activeVideo.currentTime) : 0;
  }

  function seekToBookmarkTime(targetTime) {
    const activeVideo = getActiveVideoElement();
    if (!activeVideo || !Number.isFinite(targetTime)) {
      WPOverlay.showToast('No video available for bookmark seek', 1500);
      return;
    }
    activeVideo.currentTime = Math.max(0, targetTime);
  }

  // --- Action dispatch (from overlay events + background/popup messages) ---
  document.addEventListener('wp-action', (e) => handleAction(e.detail));
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'watchparty-ext') return;
    handleAction(message);
  });

  // Action handler map — replaces monolithic switch for testability and clarity
  const actionHandlers = {
    'create-room': () => { if (WPWS.isReady()) processPendingActions(); else WPWS.connect(); },
    'join-room': () => { if (WPWS.isReady()) processPendingActions(); else WPWS.connect(); },
    'leave-room': () => {
      clearTimeout(presenceTimeout);
      WPWS.send({ type: WPProtocol.C2S.ROOM_LEAVE, payload: {} });
      const leavingRoomId = roomState?.id;
      inRoom = false; roomState = null; isHost = false;
      releaseActiveTab();
      if (extOk()) {
        chrome.storage.local.remove(WPConstants.STORAGE.CURRENT_ROOM);
        if (leavingRoomId) chrome.storage.session.remove(WPConstants.STORAGE.roomKey(leavingRoomId)).catch(() => { });
      }
      WPSync.detach();
      WPCrypto.clear();
      document.getElementById('wp-catchup-btn')?.remove();
      refreshOverlay();
      persistState();
    },
    'toggle-public': (m) => WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_PUBLIC, payload: { public: m.public } }),
    'update-room-settings': (m) => WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_SETTINGS, payload: m.settings }),
    'transfer-ownership': (m) => WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_OWNERSHIP, payload: { userId: m.targetUserId } }),
    'update-username': (m) => WPWS.send({ type: WPProtocol.C2S.USER_UPDATE, payload: { username: m.username, sessionId } }),
    'ready-check': (m) => WPWS.send({ type: WPProtocol.C2S.ROOM_READY_CHECK, payload: { action: m.readyAction } }),
    'send-bookmark': (m) => WPWS.send({ type: WPProtocol.C2S.ROOM_BOOKMARK, payload: { time: resolveBookmarkTime(m.time), label: m.label } }),
    'seek-bookmark': (m) => seekToBookmarkTime(m.time),
    'send-chat': async (m) => {
      lastUserAction = 'send-chat';
      const content = WPCrypto.isEnabled() ? await WPCrypto.encrypt(m.content) : m.content;
      WPWS.send({ type: WPProtocol.C2S.ROOM_MESSAGE, payload: { content } });
    },
    'send-typing': (m) => { lastUserAction = 'send-typing'; WPWS.send({ type: WPProtocol.C2S.ROOM_TYPING, payload: { typing: m.typing } }); },
    'send-reaction': (m) => WPWS.send({ type: WPProtocol.C2S.ROOM_REACTION, payload: { emoji: m.emoji } }),
    'send-presence': (m) => WPWS.send({ type: WPProtocol.C2S.USER_PRESENCE, payload: { status: m.status } }),
    'send-playback-status': (m) => WPWS.send({ type: WPProtocol.C2S.USER_PLAYBACK_STATUS, payload: { status: m.status } }),
    'request-sync': () => { if (isActiveVideoTab) WPWS.send({ type: WPProtocol.C2S.PLAYER_SYNC, payload: roomState?.player || WPProtocol.DEFAULT_PLAYER }); },
  };

  function handleAction(message) {
    const handler = actionHandlers[message.action];
    if (handler) handler(message);
  }

  // --- Presence (only from tab with video to avoid multi-tab conflicts) ---
  let presenceTimeout = null;
  document.addEventListener('visibilitychange', () => {
    if (!inRoom) return;
    // Only the active video tab reports presence — prevents away/active flicker
    if (!isActiveVideoTab) return;
    clearTimeout(presenceTimeout);
    if (document.visibilityState === 'hidden') {
      presenceTimeout = setTimeout(() => {
        WPWS.send({ type: WPProtocol.C2S.USER_PRESENCE, payload: { status: 'away' } });
      }, 10000);
    } else {
      WPWS.send({ type: WPProtocol.C2S.USER_PRESENCE, payload: { status: 'active' } });
    }
  });

  // --- Playback status reporting (only from tab with active video) ---
  let lastPlaybackStatus = '';
  const playbackInterval = setInterval(() => {
    if (!inRoom || !video || !isActiveVideoTab) return; // Only the active video tab reports
    if (!chrome.runtime?.id) { clearInterval(playbackInterval); return; }
    const status = video.paused ? 'paused' : video.readyState < 3 ? 'buffering' : 'playing';
    if (status !== lastPlaybackStatus) {
      lastPlaybackStatus = status;
      WPWS.send({ type: WPProtocol.C2S.USER_PLAYBACK_STATUS, payload: { status } });
    }
  }, 3000);

  const hostShareInterval = setInterval(() => {
    updateKnownContentMeta();
    if (inRoom && isHost && isActiveVideoTab) {
      shareContentLink();
    }
  }, 4000);

  // --- Host stream update on SPA navigation (only from tab with video) ---
  window.addEventListener('hashchange', () => {
    updateKnownContentMeta();
    // Only the active video tab should update stream meta.
    if (inRoom && isHost && isActiveVideoTab) {
      shareContentLink();
    }
  });

  // --- Storage change listener for pending actions ---
  if (extOk()) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes[WPConstants.STORAGE.PENDING_ROOM_CREATE] || changes[WPConstants.STORAGE.PENDING_ROOM_JOIN]) {
        if (WPWS.isReady()) { processPendingActions(); }
        else { WPWS.connect(); }
      }
      if (changes[WPConstants.STORAGE.PENDING_LEAVE_ROOM]?.newValue) {
        chrome.storage.local.remove(WPConstants.STORAGE.PENDING_LEAVE_ROOM);
        if (inRoom) handleAction({ action: 'leave-room' });
      }
      if (changes[WPConstants.STORAGE.PENDING_ACTION]?.newValue) {
        chrome.storage.local.remove(WPConstants.STORAGE.PENDING_ACTION);
        handleAction(changes[WPConstants.STORAGE.PENDING_ACTION].newValue);
      }
      if (changes[WPConstants.STORAGE.BACKEND_MODE]) {
        const nextMode = WPConstants.BACKEND.normalizeMode(changes[WPConstants.STORAGE.BACKEND_MODE].newValue);
        if (WPWS.setBackendMode(nextMode)) {
          WPWS.disconnect({ resetReplay: true });
          persistConnectionState();
          WPWS.connect();
        }
      }
      // Active video tab election — another tab claimed active status
      if (changes[WPConstants.STORAGE.ACTIVE_VIDEO_TAB]) {
        const newActiveId = changes[WPConstants.STORAGE.ACTIVE_VIDEO_TAB].newValue;
        isActiveVideoTab = (newActiveId === userId);
      }
    });
  }

  // --- Cleanup ---
  window.addEventListener('beforeunload', () => {
    clearInterval(playbackInterval);
    clearInterval(hostShareInterval);
    releaseActiveTab();
    WPProfile.stop();
  });

  function init() {
    WPOverlay.create();
    WPOverlay.initKeyboardShortcuts();
    WPOverlay.bindTypingIndicator(
      () => { if (inRoom) WPWS.send({ type: WPProtocol.C2S.ROOM_TYPING, payload: { typing: true } }); },
      () => { WPWS.send({ type: WPProtocol.C2S.ROOM_TYPING, payload: { typing: false } }); }
    );
    startVideoObserver();
    updateKnownContentMeta();
    WPProfile.start();

    // Generate or load persistent session ID (shared across all tabs via chrome.storage).
    // This lets the server identify all tabs as the same user — Twitch-style multi-tab.
    chrome.storage.local.get([WPConstants.STORAGE.SESSION_ID, WPConstants.STORAGE.BACKEND_MODE], (result) => {
      const storedSessionId = result[WPConstants.STORAGE.SESSION_ID];
      if (storedSessionId) {
        sessionId = storedSessionId;
      } else {
        sessionId = crypto.randomUUID();
        chrome.storage.local.set({ [WPConstants.STORAGE.SESSION_ID]: sessionId });
      }
      WPWS.setBackendMode(result[WPConstants.STORAGE.BACKEND_MODE]);
      persistConnectionState();
      // Every tab connects its own WS independently (like Twitch).
      // The server deduplicates by sessionId — multiple connections, one user.
      WPWS.connect();
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
