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

  // --- Extension context guard (WS survives extension reloads, but chrome APIs don't) ---
  function extOk() { return !!chrome.runtime?.id; }

  // --- Persist state to storage for popup queries ---
  function persistState() {
    if (!extOk()) return;
    chrome.storage.local.set({
      [WPConstants.STORAGE.ROOM_STATE]: roomState,
      [WPConstants.STORAGE.USER_ID]: userId,
      [WPConstants.STORAGE.WS_CONNECTED]: WPWS.isConnected(),
    }).catch(() => {});
  }

  function notifyBackground(data) {
    if (!extOk()) return;
    try {
      chrome.runtime.sendMessage({ type: 'watchparty-ext', ...data }).catch(() => {});
    } catch { /* context invalidated */ }
  }

  // --- WS callbacks ---
  WPWS.onConnect(() => {
    notifyBackground({ action: 'ws-status-changed', connected: true });
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
    notifyBackground({ action: 'ws-status-changed', connected: false });
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
    chrome.storage.local.get([WPConstants.STORAGE.PENDING_ROOM_CREATE, WPConstants.STORAGE.PENDING_ROOM_JOIN, WPConstants.STORAGE.CURRENT_ROOM, WPConstants.STORAGE.USERNAME], (stored) => {
      if (stored[WPConstants.STORAGE.PENDING_ROOM_CREATE]) {
        chrome.storage.local.remove(WPConstants.STORAGE.PENDING_ROOM_CREATE);
        // Leave current room first if still connected (prevents rejoining old room)
        if (inRoom) {
          WPWS.send({ type: WPProtocol.C2S.ROOM_LEAVE, payload: {} });
          inRoom = false; roomState = null; isHost = false;
        }
        chrome.storage.local.remove(WPConstants.STORAGE.CURRENT_ROOM);
        const rc = stored[WPConstants.STORAGE.PENDING_ROOM_CREATE];
        if (rc.username) WPWS.send({ type: WPProtocol.C2S.USER_UPDATE, payload: { username: rc.username, sessionId } });
        const payload = { meta: rc.meta, stream: rc.stream, public: rc.public || false };
        if (rc.roomName) payload.name = rc.roomName;
        WPWS.send({ type: WPProtocol.C2S.ROOM_NEW, payload });
      } else {
        const roomToJoin = stored[WPConstants.STORAGE.PENDING_ROOM_JOIN] || stored[WPConstants.STORAGE.CURRENT_ROOM];
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
        }
      }
    });
  }

  /** Load E2E crypto key from storage for a room (session → local fallback) */
  function loadCryptoKeyForRoom(roomId) {
    if (WPCrypto.isEnabled()) return Promise.resolve();
    const key = WPConstants.STORAGE.roomKey(roomId);
    return new Promise((resolve) => {
      chrome.storage.session.get(key, async (result) => {
        if (chrome.runtime.lastError || !result[key]) {
          chrome.storage.local.get(key, async (local) => {
            if (local[key]) try { await WPCrypto.importKey(local[key]); } catch { /* invalid key */ }
            resolve();
          });
          return;
        }
        try { await WPCrypto.importKey(result[key]); } catch { /* invalid key */ }
        resolve();
      });
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
    const ownerUser = roomState.users.find(u => u.id === uid);
    return ownerUser?.sessionId === sessionId;
  }

  async function onRoomJoined() {
    inRoom = true;
    isHost = isMe(roomState.owner);
    if (video) attachSync();
    refreshOverlay();
    // E2E encryption is opt-in: only enabled when a key is provided via invite URL.
    // Auto-generating keys breaks multi-tab (other tabs can't reliably read the key from session storage).
    WPOverlay.bindRoomCodeCopy(roomState);
    WPOverlay.playNotifSound();
    if (isHost) {
      shareContentLink();
    } else {
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
    WPOverlay.openSidebar();
  }

  function onRoomSync() {
    const wasHost = isHost;
    isHost = isMe(roomState.owner);
    inRoom = true;
    if (roomState?.id && extOk()) chrome.storage.local.set({ [WPConstants.STORAGE.CURRENT_ROOM]: roomState.id });
    WPSync.setHost(isHost);
    refreshOverlay();
    if (!isHost && roomState.player) {
      const newTime = roomState.player.time || 0;
      if (Math.abs(newTime - prevPlayerTime) > 5) {
        const mins = Math.floor(newTime / 60);
        const secs = Math.floor(newTime % 60).toString().padStart(2, '0');
        WPOverlay.showToast(`Host seeked to ${mins}:${secs}`);
      }
      WPSync.applyRemote(roomState.player);
      const drift = WPSync.getLastDrift();
      WPOverlay.updateSyncIndicator(isHost, drift);
      if (!isHost) WPOverlay.showCatchUpButton(drift);
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
        pendingEncryptedMessages.push(message);
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
  function shareContentLink() {
    const info = getCurrentContentInfo();
    if (!info) return;
    const meta = { id: info.id, type: info.type, name: getContentTitle() || info.id };
    if ((!meta.name || meta.name === meta.id) && meta.id?.startsWith('tt')) {
      fetch(`https://v3-cinemeta.strem.io/meta/${meta.type}/${meta.id}.json`, { signal: AbortSignal.timeout(3000) })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.meta?.name) meta.name = data.meta.name;
          WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_STREAM, payload: { stream: { url: 'https://watchparty.mertd.me/sync' }, meta } });
        })
        .catch(() => {
          WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_STREAM, payload: { stream: { url: 'https://watchparty.mertd.me/sync' }, meta } });
        });
    } else {
      WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_STREAM, payload: { stream: { url: 'https://watchparty.mertd.me/sync' }, meta } });
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
            attachSync();
            if (isHost) shareContentLink();
          }
          refreshOverlay();
        } else if (!v && video) {
          WPSync.detach();
          video = null;
          refreshOverlay();
        }
      }, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const v = document.querySelector('video');
    if (v) { video = v; if (inRoom) attachSync(); }
  }

  // --- Sync wiring ---
  function attachSync() {
    if (!video || WPSync.isAttached()) return;
    WPSync.attach(video, {
      isHost,
      onSync(state) {
        if (roomState && isMe(roomState.owner)) {
          WPWS.send({ type: WPProtocol.C2S.PLAYER_SYNC, payload: { paused: state.paused, buffering: state.buffering, time: state.time, speed: state.speed } });
        }
      },
    });
  }

  // --- Stremio page info ---
  function getCurrentContentInfo() {
    const hash = window.location.hash;
    const m = hash.match(/#\/(?:detail|metadetails)\/(\w+)\/(tt\d+)/);
    if (m) return { type: m[1], id: m[2], url: window.location.href };
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
      if (extOk()) {
        chrome.storage.local.remove(WPConstants.STORAGE.CURRENT_ROOM);
        if (leavingRoomId) chrome.storage.session.remove(WPConstants.STORAGE.roomKey(leavingRoomId)).catch(() => {});
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
    'send-bookmark': (m) => WPWS.send({ type: WPProtocol.C2S.ROOM_BOOKMARK, payload: { time: m.time, label: m.label } }),
    'send-chat': async (m) => {
      lastUserAction = 'send-chat';
      const content = WPCrypto.isEnabled() ? await WPCrypto.encrypt(m.content) : m.content;
      WPWS.send({ type: WPProtocol.C2S.ROOM_MESSAGE, payload: { content } });
    },
    'send-typing': (m) => { lastUserAction = 'send-typing'; WPWS.send({ type: WPProtocol.C2S.ROOM_TYPING, payload: { typing: m.typing } }); },
    'send-reaction': (m) => WPWS.send({ type: WPProtocol.C2S.ROOM_REACTION, payload: { emoji: m.emoji } }),
    'send-presence': (m) => WPWS.send({ type: WPProtocol.C2S.USER_PRESENCE, payload: { status: m.status } }),
    'send-playback-status': (m) => WPWS.send({ type: WPProtocol.C2S.USER_PLAYBACK_STATUS, payload: { status: m.status } }),
    'request-sync': () => WPWS.send({ type: WPProtocol.C2S.PLAYER_SYNC, payload: roomState?.player || WPProtocol.DEFAULT_PLAYER }),
  };

  function handleAction(message) {
    const handler = actionHandlers[message.action];
    if (handler) handler(message);
  }

  // --- Presence ---
  let presenceTimeout = null;
  document.addEventListener('visibilitychange', () => {
    if (!inRoom) return;
    clearTimeout(presenceTimeout);
    if (document.visibilityState === 'hidden') {
      presenceTimeout = setTimeout(() => {
        WPWS.send({ type: WPProtocol.C2S.USER_PRESENCE, payload: { status: 'away' } });
      }, 10000);
    } else {
      WPWS.send({ type: WPProtocol.C2S.USER_PRESENCE, payload: { status: 'active' } });
    }
  });

  // --- Playback status reporting ---
  let lastPlaybackStatus = '';
  const playbackInterval = setInterval(() => {
    if (!inRoom) return;
    if (!chrome.runtime?.id) { clearInterval(playbackInterval); return; }
    const vid = document.querySelector('video');
    if (!vid) return;
    const status = vid.paused ? 'paused' : vid.readyState < 3 ? 'buffering' : 'playing';
    if (status !== lastPlaybackStatus) {
      lastPlaybackStatus = status;
      WPWS.send({ type: WPProtocol.C2S.USER_PLAYBACK_STATUS, payload: { status } });
    }
  }, 3000);

  // --- Host stream update on SPA navigation ---
  let lastSharedContentId = null;
  window.addEventListener('hashchange', () => {
    if (inRoom && isHost) {
      const info = getCurrentContentInfo();
      if (info && info.id !== lastSharedContentId) {
        lastSharedContentId = info.id;
        shareContentLink();
      }
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
    });
  }

  // --- Cleanup ---
  window.addEventListener('beforeunload', () => {
    clearInterval(playbackInterval);
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
    WPProfile.start();

    // Generate or load persistent session ID (shared across all tabs via chrome.storage).
    // This lets the server identify all tabs as the same user — Twitch-style multi-tab.
    chrome.storage.local.get(WPConstants.STORAGE.SESSION_ID, (result) => {
      const storedSessionId = result[WPConstants.STORAGE.SESSION_ID];
      if (storedSessionId) {
        sessionId = storedSessionId;
      } else {
        sessionId = crypto.randomUUID();
        chrome.storage.local.set({ [WPConstants.STORAGE.SESSION_ID]: sessionId });
      }
      // Every tab connects its own WS independently (like Twitch).
      // The server deduplicates by sessionId — multiple connections, one user.
      WPWS.connect();
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
