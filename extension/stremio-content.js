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

  // --- Extension context guard (WS survives extension reloads, but chrome APIs don't) ---
  function extOk() { return !!chrome.runtime?.id; }

  // --- Persist state to storage for popup queries ---
  function persistState() {
    if (!extOk()) return;
    chrome.storage.local.set({
      wpRoomState: roomState,
      wpUserId: userId,
      wpWsConnected: WPWS.isConnected(),
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
    // If we were in a room, rejoin with replay of missed messages
    if (roomState?.id) {
      const seq = WPWS.getLastSeq();
      if (seq > 0) {
        WPWS.send({ type: 'room.rejoin', payload: { id: roomState.id, lastSeq: seq } });
      }
    }
  });

  WPWS.onDisconnect(() => {
    notifyBackground({ action: 'ws-status-changed', connected: false });
  });

  WPWS.onMessage((msg) => {
    if (!msg || !msg.type) return;
    const p = msg.payload;

    switch (msg.type) {
      case 'ready':
        if (!p?.user?.id) return;
        userId = p.user.id;
        // Protocol version check — warn if server is newer than what this extension expects
        if (p.protocol && p.protocol > 2) {
          WPOverlay.showToast('Server updated — please update the WatchParty extension', 5000);
          console.warn(`[WatchParty] Server protocol v${p.protocol}, extension expects v2. Some features may not work.`);
        }
        processPendingActions();
        WPWS.startClockSync();
        persistState();
        refreshOverlay();
        break;

      case 'sync':
        if (!p) return;
        prevPlayerTime = roomState?.player?.time || 0;
        roomState = p;
        persistState();
        onRoomSync();
        break;

      case 'room':
        if (!p?.id) return;
        roomState = p;
        if (extOk()) chrome.storage.local.set({ currentRoom: roomState.id });
        persistState();
        onRoomJoined();
        break;

      case 'message':
        if (!p) return;
        onChatMessage(p);
        break;

      case 'user':
        if (!p?.user?.id) return;
        userId = p.user.id;
        persistState();
        break;

      case 'error':
        if (p?.type === 'room') {
          inRoom = false; roomState = null;
          WPSync.detach();
          if (extOk()) chrome.storage.local.remove(['currentRoom', 'pendingRoomJoin']);
          refreshOverlay();
          persistState();
        }
        // Show error feedback for non-room errors (cooldown, owner, validation, etc.)
        if (p?.type !== 'room' && p?.message) {
          WPOverlay.showToast(p.message, 2000);
        }
        break;

      case 'typing':
        if (!p?.user) return;
        onTyping(p.user, p.typing);
        break;

      case 'reaction':
        if (!p?.user || !p?.emoji) return;
        WPOverlay.showReaction(p.user, p.emoji, roomState);
        break;

      case 'autopause':
        if (!p?.name) return;
        WPOverlay.showToast(`Paused \u2014 ${p.name} disconnected`);
        break;

      case 'readyCheck':
        WPOverlay.showReadyCheck(p.action, p.confirmed, p.total, userId);
        break;

      case 'countdown':
        WPOverlay.showCountdown(p.seconds);
        break;

      case 'bookmark':
        WPOverlay.appendBookmark(p);
        notifyBackground({ action: 'bookmark', payload: p });
        break;

      // --- Delta events (lightweight, avoid full room broadcasts) ---

      case 'playerSync':
        if (!p?.player || !roomState) return;
        prevPlayerTime = roomState.player?.time || 0;
        roomState.player = p.player;
        onRoomSync();
        break;

      case 'presenceUpdate':
        if (!p?.userId || !roomState?.users) return;
        const presUser = roomState.users.find(u => u.id === p.userId);
        if (presUser) presUser.status = p.status;
        refreshOverlay();
        break;

      case 'playbackStatusUpdate':
        if (!p?.userId || !roomState?.users) return;
        const pbUser = roomState.users.find(u => u.id === p.userId);
        if (pbUser) pbUser.playbackStatus = p.status;
        refreshOverlay();
        break;

      case 'settingsUpdate':
        if (!p?.settings || !roomState) return;
        roomState.settings = p.settings;
        refreshOverlay();
        break;
    }
  });

  // --- Process pending create/join actions from storage ---
  function processPendingActions() {
    if (!WPWS.isReady() || !extOk()) return;
    chrome.storage.local.get(['pendingRoomCreate', 'pendingRoomJoin', 'currentRoom', 'wpUsername'], (stored) => {
      if (stored.pendingRoomCreate) {
        chrome.storage.local.remove('pendingRoomCreate');
        const rc = stored.pendingRoomCreate;
        if (rc.username) WPWS.send({ type: 'user.update', payload: { username: rc.username } });
        const payload = { meta: rc.meta, stream: rc.stream, public: rc.public || false };
        if (rc.roomName) payload.name = rc.roomName;
        WPWS.send({ type: 'room.new', payload });
      } else {
        const roomToJoin = stored.pendingRoomJoin || stored.currentRoom;
        if (stored.pendingRoomJoin) chrome.storage.local.remove('pendingRoomJoin');
        if (roomToJoin) {
          // Import E2E encryption key BEFORE joining (prevents race where first encrypted message arrives before key is ready)
          const keyStorageKey = `wpRoomKey:${roomToJoin}`;
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

  async function importKeyAndJoin(cryptoKeyStr, roomToJoin, stored) {
    if (cryptoKeyStr && !WPCrypto.isEnabled()) {
      try { await WPCrypto.importKey(cryptoKeyStr); } catch { /* invalid key */ }
    }
    if (!extOk() || !WPWS.isReady()) return;
    if (stored.wpUsername) WPWS.send({ type: 'user.update', payload: { username: stored.wpUsername } });
    WPWS.send({ type: 'room.join', payload: { id: roomToJoin } });
  }

  // --- Room event handlers ---

  async function onRoomJoined() {
    inRoom = true;
    isHost = roomState.owner === userId;
    if (video) attachSync();
    refreshOverlay();
    // Generate E2E encryption key for new rooms (host only)
    if (isHost && !WPCrypto.isEnabled()) {
      await WPCrypto.generateKey();
      // Store key so it can be included in invite URLs
      const keyStr = await WPCrypto.exportKey();
      if (keyStr && extOk()) chrome.storage.session.set({ [`wpRoomKey:${roomState.id}`]: keyStr }).catch(() => {});
    }
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
    isHost = roomState.owner === userId;
    inRoom = true;
    if (roomState?.id && extOk()) chrome.storage.local.set({ currentRoom: roomState.id });
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

  async function onChatMessage(message) {
    // Decrypt E2E-encrypted messages if crypto is enabled
    if (WPCrypto.isEnabled() && WPCrypto.isEncrypted(message.content)) {
      message = { ...message, content: await WPCrypto.decrypt(message.content) };
    }
    chatMessages.push(message);
    if (chatMessages.length > 200) chatMessages.shift();
    WPOverlay.appendChatMessage(message, roomState, userId);
    if (message.user !== userId) WPOverlay.incrementUnread();
    // Relay to side panel (it can't access content script globals)
    notifyBackground({ action: 'chat-message', payload: message });
  }

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
          WPWS.send({ type: 'room.updateStream', payload: { stream: { url: 'https://watchparty.mertd.me/sync' }, meta } });
        })
        .catch(() => {
          WPWS.send({ type: 'room.updateStream', payload: { stream: { url: 'https://watchparty.mertd.me/sync' }, meta } });
        });
    } else {
      WPWS.send({ type: 'room.updateStream', payload: { stream: { url: 'https://watchparty.mertd.me/sync' }, meta } });
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
        if (roomState && userId === roomState.owner) {
          WPWS.send({ type: 'player.sync', payload: { paused: state.paused, buffering: state.buffering, time: state.time, speed: state.speed } });
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
    WPOverlay.updateState({ inRoom, isHost, userId, roomState, hasVideo: !!video });
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
      WPWS.send({ type: 'room.leave', payload: {} });
      const leavingRoomId = roomState?.id;
      inRoom = false; roomState = null; isHost = false;
      if (extOk()) {
        chrome.storage.local.remove('currentRoom');
        // Clean up E2E crypto key for this room
        if (leavingRoomId) chrome.storage.session.remove(`wpRoomKey:${leavingRoomId}`).catch(() => {});
      }
      WPSync.detach();
      WPCrypto.clear();
      document.getElementById('wp-catchup-btn')?.remove();
      refreshOverlay();
      persistState();
    },
    'toggle-public': (m) => WPWS.send({ type: 'room.updatePublic', payload: { public: m.public } }),
    'update-room-settings': (m) => WPWS.send({ type: 'room.updateSettings', payload: m.settings }),
    'transfer-ownership': (m) => WPWS.send({ type: 'room.updateOwnership', payload: { userId: m.targetUserId } }),
    'update-username': (m) => WPWS.send({ type: 'user.update', payload: { username: m.username } }),
    'ready-check': (m) => WPWS.send({ type: 'room.readyCheck', payload: { action: m.readyAction } }),
    'send-bookmark': (m) => WPWS.send({ type: 'room.bookmark', payload: { time: m.time, label: m.label } }),
    'send-chat': async (m) => {
      const content = WPCrypto.isEnabled() ? await WPCrypto.encrypt(m.content) : m.content;
      WPWS.send({ type: 'room.message', payload: { content } });
    },
    'send-typing': (m) => WPWS.send({ type: 'room.typing', payload: { typing: m.typing } }),
    'send-reaction': (m) => WPWS.send({ type: 'room.reaction', payload: { emoji: m.emoji } }),
    'send-presence': (m) => WPWS.send({ type: 'user.presence', payload: { status: m.status } }),
    'send-playback-status': (m) => WPWS.send({ type: 'user.playbackStatus', payload: { status: m.status } }),
    'request-sync': () => WPWS.send({ type: 'player.sync', payload: roomState?.player || { paused: true, time: 0, buffering: false } }),
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
        WPWS.send({ type: 'user.presence', payload: { status: 'away' } });
      }, 10000);
    } else {
      WPWS.send({ type: 'user.presence', payload: { status: 'active' } });
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
      WPWS.send({ type: 'user.playbackStatus', payload: { status } });
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
      if (changes.pendingRoomCreate || changes.pendingRoomJoin) {
        if (WPWS.isReady()) { processPendingActions(); }
        else { WPWS.connect(); }
      }
    });
  }

  // --- Cleanup ---
  window.addEventListener('beforeunload', () => {
    clearInterval(playbackInterval);
    WPProfile.stop();
  });

  // --- Initialize ---
  function init() {
    WPOverlay.create();
    WPOverlay.initKeyboardShortcuts();
    WPOverlay.bindTypingIndicator(
      () => { if (inRoom) WPWS.send({ type: 'room.typing', payload: { typing: true } }); },
      () => { WPWS.send({ type: 'room.typing', payload: { typing: false } }); }
    );
    startVideoObserver();
    WPProfile.start();
    WPWS.connect();

    chrome.storage.local.get('pendingRoomJoin', ({ pendingRoomJoin }) => {
      if (pendingRoomJoin) {
        // WS ready handler will pick this up and join automatically
      }
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
