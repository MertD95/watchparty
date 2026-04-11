// WatchParty for Stremio — Content Script for Stremio Web
// Owns: WebSocket connection, room state, sync engine, overlay UI, profile reading.
// Modules: stremio-sync.js (WPSync), stremio-overlay.js (WPOverlay), stremio-profile.js (WPProfile)
//
// Architecture: The WS connection lives HERE (not in the background service worker) because
// MV3 service workers suspend after ~30s, permanently killing WS event handlers.
// Content scripts stay alive as long as the tab is open — no suspension issues.

(() => {
  'use strict';

  // --- Constants ---
  const WS_URL_PROD = 'wss://ws.mertd.me';
  const WS_URL_DEV = 'ws://localhost:8181';
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;
  const CLOCK_SAMPLES = 6;

  // --- State ---
  let video = null;
  let inRoom = false;
  let isHost = false;
  let userId = null;
  let roomState = null;
  let chatMessages = [];
  let observer = null;
  let typingUsers = new Map();

  // WS state (previously in background.js)
  let ws = null;
  let wsConnected = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let clockOffset = 0;
  let clockSamples = [];
  let detectedWsUrl = null;

  // CORS bypass handled by declarativeNetRequest rules (rules.json) —
  // no fetch/XHR interception needed. Direct requests to localhost:11470 work natively.

  // --- WebSocket connection (moved from background.js) ---

  async function getWsUrl() {
    if (detectedWsUrl) return detectedWsUrl;
    try {
      const res = await fetch(WS_URL_DEV.replace('ws://', 'http://'), { signal: AbortSignal.timeout(1000) });
      if (res.ok) { detectedWsUrl = WS_URL_DEV; return WS_URL_DEV; }
    } catch { /* dev server not running */ }
    detectedWsUrl = WS_URL_PROD;
    return WS_URL_PROD;
  }

  async function connectWs() {
    if (ws) return;
    const url = await getWsUrl();
    try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }

    ws.onopen = () => {
      wsConnected = true;
      reconnectAttempts = 0;
      notifyBackground({ action: 'ws-status-changed', connected: true });
      // Server-side keepalive ping every 25s (not for service worker — just to prevent server timeout)
      clearInterval(ws._keepAlive);
      ws._keepAlive = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) wsSend({ type: 'clock.ping', payload: { clientTime: Date.now() } });
      }, 25000);
    };

    ws.onmessage = (event) => {
      try { handleServerMessage(JSON.parse(event.data)); } catch { /* malformed */ }
    };

    ws.onclose = () => {
      clearInterval(ws?._keepAlive);
      ws = null;
      wsConnected = false;
      notifyBackground({ action: 'ws-status-changed', connected: false });
      scheduleReconnect();
    };

    ws.onerror = () => { /* onclose fires after */ };
  }

  function disconnectWs() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempts = 0;
    if (ws) {
      clearInterval(ws._keepAlive);
      ws.onclose = null;
      ws.close();
      ws = null;
      wsConnected = false;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    const delay = base + Math.random() * base * 0.2;
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWs(); }, delay);
  }

  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // --- Clock sync (Cristian's algorithm) ---
  function startClockSync() {
    clockSamples = [];
    for (let i = 0; i < CLOCK_SAMPLES; i++) {
      setTimeout(() => wsSend({ type: 'clock.ping', payload: { clientTime: Date.now() } }), i * 200);
    }
  }

  // --- Persist state to storage for popup queries ---
  function persistState() {
    chrome.storage.local.set({
      wpRoomState: roomState,
      wpUserId: userId,
      wpWsConnected: wsConnected,
    }).catch(() => {});
  }

  // Notify background of status changes (for badge, popup relay)
  function notifyBackground(data) {
    try {
      chrome.runtime.sendMessage({ type: 'watchparty-ext', ...data }).catch(() => {});
    } catch { /* context invalidated */ }
  }

  // --- Server message handling (merged from background.js + old handleMessage) ---
  function handleServerMessage(msg) {
    if (!msg || !msg.type) return;
    const p = msg.payload;

    switch (msg.type) {
      case 'ready':
        if (!p?.user?.id) return;
        userId = p.user.id;
        // Handle pending actions: create room, join room, or rejoin after reconnect
        chrome.storage.local.get(['pendingRoomCreate', 'pendingRoomJoin', 'currentRoom', 'wpUsername'], (stored) => {
          if (stored.pendingRoomCreate) {
            chrome.storage.local.remove('pendingRoomCreate');
            const rc = stored.pendingRoomCreate;
            if (rc.username) wsSend({ type: 'user.update', payload: { username: rc.username } });
            const payload = { meta: rc.meta, stream: rc.stream, public: rc.public || false };
            if (rc.roomName) payload.name = rc.roomName;
            wsSend({ type: 'room.new', payload });
          } else {
            const roomToJoin = stored.pendingRoomJoin || stored.currentRoom;
            if (stored.pendingRoomJoin) chrome.storage.local.remove('pendingRoomJoin');
            if (roomToJoin) {
              if (stored.wpUsername) wsSend({ type: 'user.update', payload: { username: stored.wpUsername } });
              wsSend({ type: 'room.join', payload: { id: roomToJoin } });
            }
          }
        });
        startClockSync();
        persistState();
        break;

      case 'sync':
        if (!p) return;
        roomState = p;
        persistState();
        onRoomSync();
        break;

      case 'room':
        if (!p?.id) return;
        roomState = p;
        chrome.storage.local.set({ currentRoom: roomState.id });
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
          chrome.storage.local.remove('currentRoom');
          refreshOverlay();
          persistState();
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
        break;

      case 'clock.pong': {
        if (!p?.clientTime || !p?.serverTime) return;
        const now = Date.now();
        const rtt = now - p.clientTime;
        const offset = p.serverTime - p.clientTime - rtt / 2;
        clockSamples.push({ rtt, offset });
        if (clockSamples.length >= CLOCK_SAMPLES) {
          clockSamples.sort((a, b) => a.rtt - b.rtt);
          clockOffset = clockSamples[0].offset;
        }
        break;
      }
    }
  }

  // --- Event handlers (UI updates) ---

  function onRoomJoined() {
    inRoom = true;
    userId = userId;
    isHost = roomState.owner === userId;
    if (video) attachSync();
    refreshOverlay();
    WPOverlay.bindRoomCodeCopy(roomState);
    WPOverlay.playNotifSound();
    if (isHost) {
      shareContentLink();
    } else {
      // Auto-navigate peer to the movie the host is watching
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
    const prevTime = roomState?.player?.time || 0;
    const wasHost = isHost;
    isHost = roomState.owner === userId;
    inRoom = true;
    // Ensure currentRoom is set (room.join sends sync, not room event)
    if (roomState?.id) chrome.storage.local.set({ currentRoom: roomState.id });
    WPSync.setHost(isHost);
    refreshOverlay();
    if (!isHost && roomState.player) {
      const newTime = roomState.player.time || 0;
      if (Math.abs(newTime - prevTime) > 5) {
        const mins = Math.floor(newTime / 60);
        const secs = Math.floor(newTime % 60).toString().padStart(2, '0');
        WPOverlay.showToast(`Host seeked to ${mins}:${secs}`);
      }
      WPSync.applyRemote(roomState.player);
      const drift = WPSync.getLastDrift();
      WPOverlay.updateSyncIndicator(isHost, drift);
      if (!isHost) WPOverlay.showCatchUpButton(drift);
    }
    WPOverlay.updatePresenceBar(roomState.users);
    if (!wasHost && isHost) WPOverlay.playNotifSound();
  }

  function onChatMessage(message) {
    chatMessages.push(message);
    if (chatMessages.length > 200) chatMessages.shift();
    WPOverlay.appendChatMessage(message, roomState, userId);
    if (message.user !== userId) {
      WPOverlay.incrementUnread();
      const sender = roomState?.users?.find(u => u.id === message.user);
      WPOverlay.showChatBubble(sender?.name || 'Unknown', message.content, message.user);
    }
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

  // --- Content link sharing (host tells server what they're watching) ---
  function shareContentLink() {
    const info = getCurrentContentInfo();
    if (!info) return;
    const meta = { id: info.id, type: info.type, name: getContentTitle() || info.id };
    // If no name, fetch from Cinemeta
    if ((!meta.name || meta.name === meta.id) && meta.id?.startsWith('tt')) {
      fetch(`https://v3-cinemeta.strem.io/meta/${meta.type}/${meta.id}.json`, { signal: AbortSignal.timeout(3000) })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.meta?.name) meta.name = data.meta.name;
          wsSend({ type: 'room.updateStream', payload: { stream: { url: 'https://watchparty.mertd.me/sync' }, meta } });
        })
        .catch(() => {
          wsSend({ type: 'room.updateStream', payload: { stream: { url: 'https://watchparty.mertd.me/sync' }, meta } });
        });
    } else {
      wsSend({ type: 'room.updateStream', payload: { stream: { url: 'https://watchparty.mertd.me/sync' }, meta } });
    }
  }

  // --- Video element detection ---
  function startVideoObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      const v = document.querySelector('video');
      if (v && v !== video) {
        video = v;
        if (inRoom) attachSync();
        refreshOverlay();
      } else if (!v && video) {
        WPSync.detach();
        video = null;
        refreshOverlay();
      }
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
          wsSend({ type: 'player.sync', payload: { paused: state.paused, buffering: state.buffering, time: state.time, speed: state.speed } });
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

  // --- Handle messages from background/popup (relay commands) ---
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'watchparty-ext') return;
    switch (message.action) {
      case 'create-room':
        if (message.username) wsSend({ type: 'user.update', payload: { username: message.username } });
        const createPayload = {
          meta: message.meta || { id: 'unknown', type: 'movie', name: 'WatchParty Session' },
          stream: message.stream || { url: 'https://example.com/placeholder' },
          public: message.public || false,
        };
        if (message.roomName) createPayload.name = message.roomName;
        wsSend({ type: 'room.new', payload: createPayload });
        break;
      case 'join-room':
        if (message.username) wsSend({ type: 'user.update', payload: { username: message.username } });
        wsSend({ type: 'room.join', payload: { id: message.roomId } });
        break;
      case 'leave-room':
        wsSend({ type: 'room.leave', payload: {} });
        inRoom = false; roomState = null; isHost = false;
        chrome.storage.local.remove('currentRoom');
        WPSync.detach();
        refreshOverlay();
        persistState();
        break;
      case 'toggle-public':
        wsSend({ type: 'room.updatePublic', payload: { public: message.public } });
        break;
      case 'update-room-settings':
        wsSend({ type: 'room.updateSettings', payload: message.settings });
        break;
      case 'transfer-ownership':
        wsSend({ type: 'room.updateOwnership', payload: { userId: message.targetUserId } });
        break;
      case 'update-username':
        wsSend({ type: 'user.update', payload: { username: message.username } });
        break;
      case 'ready-check':
        wsSend({ type: 'room.readyCheck', payload: { action: message.readyAction } });
        break;
      case 'send-bookmark':
        wsSend({ type: 'room.bookmark', payload: { time: message.time, label: message.label } });
        break;
      case 'send-chat':
        wsSend({ type: 'room.message', payload: { content: message.content } });
        break;
      case 'send-typing':
        wsSend({ type: 'room.typing', payload: { typing: message.typing } });
        break;
      case 'send-reaction':
        wsSend({ type: 'room.reaction', payload: { emoji: message.emoji } });
        break;
      case 'send-presence':
        wsSend({ type: 'user.presence', payload: { status: message.status } });
        break;
      case 'send-playback-status':
        wsSend({ type: 'user.playbackStatus', payload: { status: message.status } });
        break;
      case 'get-ws-status':
        // Background or popup querying WS status
        break;
    }
  });

  // --- Presence + visibility recovery ---
  let presenceTimeout = null;
  document.addEventListener('visibilitychange', () => {
    if (!inRoom) return;
    clearTimeout(presenceTimeout);
    if (document.visibilityState === 'hidden') {
      presenceTimeout = setTimeout(() => {
        wsSend({ type: 'user.presence', payload: { status: 'away' } });
      }, 10000);
    } else {
      wsSend({ type: 'user.presence', payload: { status: 'active' } });
    }
  });

  // --- Playback status: report video state every 3s ---
  let lastPlaybackStatus = '';
  const playbackInterval = setInterval(() => {
    if (!inRoom) return;
    if (!chrome.runtime?.id) { clearInterval(playbackInterval); return; }
    const vid = document.querySelector('video');
    if (!vid) return;
    const status = vid.paused ? 'paused' : vid.readyState < 3 ? 'buffering' : 'playing';
    if (status !== lastPlaybackStatus) {
      lastPlaybackStatus = status;
      wsSend({ type: 'user.playbackStatus', payload: { status } });
    }
  }, 3000);

  // Cleanup on page unload — don't close WS cleanly on navigation
  // (server will detect the stale connection; the new page will reconnect and rejoin)
  window.addEventListener('beforeunload', () => {
    clearInterval(playbackInterval);
    WPProfile.stop();
  });

  // --- Initialize ---
  function init() {
    WPOverlay.create();
    WPOverlay.initKeyboardShortcuts();
    WPOverlay.bindTypingIndicator(
      () => { if (inRoom) wsSend({ type: 'room.typing', payload: { typing: true } }); },
      () => { wsSend({ type: 'room.typing', payload: { typing: false } }); }
    );
    startVideoObserver();
    WPProfile.start();

    // Connect WS immediately — content script doesn't suspend
    connectWs();

    // Handle pending room join from landing page
    chrome.storage.local.get('pendingRoomJoin', ({ pendingRoomJoin }) => {
      if (pendingRoomJoin) {
        // The WS ready handler will pick this up and join automatically
        // (pendingRoomJoin stays in storage until ready handler processes it)
      }
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
