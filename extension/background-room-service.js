// WatchParty background room service
// Keeps room creation/join/leave working when no Stremio tab is open.
// This is intentionally room-only. Playback sync still lives in stremio-content.js.

const WPBackgroundRoomService = (() => {
  'use strict';

  const BACKEND = WPConstants.BACKEND;
  const STORAGE = WPConstants.STORAGE;
  const KEEPALIVE_INTERVAL_MS = 20000;
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;
  const LOCAL_READY_URL = `${BACKEND.LOCAL.httpUrl}/ready`;
  const isDevInstall = !('update_url' in chrome.runtime.getManifest());

  let ws = null;
  let ready = false;
  let active = false;
  let shuttingDown = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let keepAliveTimer = null;
  let resolvedBackend = null;
  let roomState = null;
  let sessionId = null;
  let connectPromise = null;
  let pendingCreatedRoomKey = null;
  let reconnectRoomId = null;
  let reconnectRoomKey = null;
  let pendingRejoin = false;

  function normalizeRoomServiceError(input, fallbackCode = 'ROOM_SERVICE_ERROR', fallbackMessage = 'WatchParty could not reach the room service.') {
    const code = typeof input?.code === 'string' && input.code ? input.code : fallbackCode;
    const message = typeof input?.message === 'string' && input.message.trim()
      ? input.message.trim()
      : fallbackMessage;
    return {
      code,
      message,
      at: Date.now(),
      source: 'background-room-service',
    };
  }

  async function setRoomServiceError(input, fallbackCode, fallbackMessage) {
    await chrome.storage.local.set({
      [STORAGE.ROOM_SERVICE_ERROR]: normalizeRoomServiceError(input, fallbackCode, fallbackMessage),
    });
  }

  async function clearRoomServiceError() {
    await chrome.storage.local.set({ [STORAGE.ROOM_SERVICE_ERROR]: null });
  }

  function arrayBufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function generatePrivateRoomKey() {
    return arrayBufferToBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  }

  async function loadRoomKey(roomId) {
    if (!roomId) return null;
    const storageKey = STORAGE.roomKey(roomId);
    try {
      const sessionResult = await chrome.storage.session.get(storageKey);
      if (sessionResult?.[storageKey]) return sessionResult[storageKey];
    } catch {
      // Ignore session storage lookup failures and fall back to local storage.
    }
    const localResult = await chrome.storage.local.get(storageKey);
    const decoded = WPConstants.ROOM_KEYS.decodeFromLocal(localResult?.[storageKey]);
    if (decoded.expired) await chrome.storage.local.remove(storageKey).catch(() => {});
    return decoded.value || null;
  }

  async function cacheRoomKey(roomId, roomKey) {
    if (!roomId || !roomKey) return;
    const storageKey = STORAGE.roomKey(roomId);
    const encodedRoomKey = WPConstants.ROOM_KEYS.encodeForLocal(roomKey);
    try {
      await chrome.storage.session.set({ [storageKey]: roomKey });
    } catch { /* session storage may be unavailable */ }
    if (encodedRoomKey) {
      await chrome.storage.local.set({ [storageKey]: encodedRoomKey });
    }
  }

  async function clearRoomKey(roomId) {
    if (!roomId) return;
    const storageKey = STORAGE.roomKey(roomId);
    try {
      await chrome.storage.session.remove(storageKey);
    } catch { /* session storage may be unavailable */ }
    await chrome.storage.local.remove(storageKey);
  }

  async function ensureSessionId() {
    if (sessionId) return sessionId;
    const result = await chrome.storage.local.get(STORAGE.SESSION_ID);
    sessionId = result[STORAGE.SESSION_ID] || crypto.randomUUID();
    if (!result[STORAGE.SESSION_ID]) {
      await chrome.storage.local.set({ [STORAGE.SESSION_ID]: sessionId });
    }
    return sessionId;
  }

  async function sendUserUpdate(usernameOverride) {
    await ensureSessionId();
    const result = await chrome.storage.local.get(STORAGE.USERNAME);
    const username = (usernameOverride || result[STORAGE.USERNAME] || '').trim() || 'Guest';
    if (usernameOverride) {
      await chrome.storage.local.set({ [STORAGE.USERNAME]: username });
    }
    send({
      type: WPProtocol.C2S.USER_UPDATE,
      payload: { username, sessionId },
    });
  }

  async function probeLocalBackend() {
    try {
      const res = await fetch(LOCAL_READY_URL, { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function resolveBackend() {
    const result = await chrome.storage.local.get(STORAGE.BACKEND_MODE);
    const mode = BACKEND.normalizeMode(result[STORAGE.BACKEND_MODE]);
    if (mode === BACKEND.MODES.LOCAL) return BACKEND.LOCAL;
    if (mode === BACKEND.MODES.LIVE) return BACKEND.LIVE;
    if (isDevInstall && await probeLocalBackend()) return BACKEND.LOCAL;
    return BACKEND.LIVE;
  }

  async function persistConnectionState(connected) {
    await chrome.storage.local.set({
      [STORAGE.WS_CONNECTED]: !!connected,
      [STORAGE.ACTIVE_BACKEND]: resolvedBackend?.key || null,
      [STORAGE.ACTIVE_BACKEND_URL]: resolvedBackend?.wsUrl || null,
      [STORAGE.ROOM_SERVICE_ACTIVE]: active,
    });
  }

  async function persistRoomState(nextRoom) {
    roomState = nextRoom || null;
    const updates = {
      [STORAGE.ROOM_STATE]: roomState,
      [STORAGE.CURRENT_ROOM]: roomState?.id || null,
      [STORAGE.ROOM_SERVICE_ACTIVE]: active,
    };
    await chrome.storage.local.set(updates);

    if (roomState?.id) {
      reconnectRoomId = roomState.id;
      if (roomState.public === false && pendingCreatedRoomKey) {
        await cacheRoomKey(roomState.id, pendingCreatedRoomKey);
        reconnectRoomKey = pendingCreatedRoomKey;
        pendingCreatedRoomKey = null;
      }
      if (roomState.public !== false) {
        reconnectRoomKey = null;
        pendingCreatedRoomKey = null;
      }
    }
  }

  async function clearPersistedRoomState(options = {}) {
    const { preserveRoomState = false, preserveCurrentRoom = false } = options;
    roomState = preserveRoomState ? roomState : null;
    const updates = {
      [STORAGE.ROOM_SERVICE_ACTIVE]: active,
      [STORAGE.WS_CONNECTED]: false,
    };
    if (!preserveRoomState) updates[STORAGE.ROOM_STATE] = null;
    if (!preserveCurrentRoom) updates[STORAGE.CURRENT_ROOM] = null;
    await chrome.storage.local.set(updates);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: WPProtocol.C2S.CLOCK_PING,
          payload: { clientTime: Date.now() },
        }));
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (!active || shuttingDown || reconnectTimer) return;
    const baseDelay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    reconnectAttempts++;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await ensureConnected();
      } catch {
        scheduleReconnect();
      }
    }, baseDelay);
  }

  async function maybeRejoinRoom() {
    if (!pendingRejoin || !reconnectRoomId) return;
    pendingRejoin = false;
    await sendUserUpdate();
    send({
      type: WPProtocol.C2S.ROOM_JOIN,
      payload: {
        id: reconnectRoomId,
        roomKey: reconnectRoomKey || undefined,
      },
    });
  }

  async function handleServerEvent(message) {
    if (typeof message?.seq === 'number') {
      // Room rejoin in the background only needs room membership today, so
      // replay sequencing is intentionally not used beyond retaining the last seq.
    }

    switch (message?.type) {
      case WPProtocol.S2C.READY:
        ready = true;
        reconnectAttempts = 0;
        await clearRoomServiceError();
        await chrome.storage.local.set({ [STORAGE.USER_ID]: message.payload?.user?.id || message.payload?.id || null });
        await persistConnectionState(true);
        await maybeRejoinRoom();
        break;

      case WPProtocol.S2C.USER:
        await chrome.storage.local.set({ [STORAGE.USER_ID]: message.payload?.user?.id || message.payload?.id || null });
        break;

      case WPProtocol.S2C.ROOM:
      case WPProtocol.S2C.SYNC:
        await clearRoomServiceError();
        await persistRoomState(message.payload || null);
        break;

      case WPProtocol.S2C.SETTINGS_UPDATE:
        if (roomState && message.payload?.settings) {
          roomState.settings = message.payload.settings;
          await persistRoomState(roomState);
        }
        break;

      case WPProtocol.S2C.ERROR:
        if (message.payload?.code === WPProtocol.ERROR_CODE.ROOM_NOT_FOUND) {
          reconnectRoomId = null;
          reconnectRoomKey = null;
          pendingRejoin = false;
        }
        await setRoomServiceError(message.payload, message.payload?.code, message.payload?.message);
        break;

      default:
        break;
    }
  }

  function send(message) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  async function ensureConnected() {
    active = true;
    shuttingDown = false;

    if (ws?.readyState === WebSocket.OPEN && ready) {
      await persistConnectionState(true);
      return;
    }

    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
      resolvedBackend = await resolveBackend();
      await ensureSessionId();
      await clearRoomServiceError();

      await new Promise((resolve, reject) => {
        try {
          ws = new WebSocket(resolvedBackend.wsUrl);
        } catch (error) {
          reject(error);
          return;
        }

        let settled = false;

        ws.onopen = async () => {
          startKeepAlive();
          await persistConnectionState(true);
        };

        ws.onmessage = async (event) => {
          let message = null;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }

          await handleServerEvent(message);
          if (!settled && message?.type === WPProtocol.S2C.READY) {
            settled = true;
            resolve();
          }
        };

        ws.onclose = async () => {
          stopKeepAlive();
          ws = null;
          ready = false;
          connectPromise = null;
          await persistConnectionState(false);
          if (!settled) {
            settled = true;
            await setRoomServiceError(
              null,
              'ROOM_SERVICE_DISCONNECTED',
              'WatchParty disconnected before the room service became ready.',
            );
            reject(new Error('Background room service disconnected before ready.'));
          }
          if (active && !shuttingDown) {
            pendingRejoin = !!reconnectRoomId;
            scheduleReconnect();
          }
        };

        ws.onerror = () => {
          // onclose handles reconnect and promise rejection.
        };
      });
    })();

    try {
      await connectPromise;
    } catch (error) {
      await setRoomServiceError(
        error,
        error?.code || 'ROOM_SERVICE_UNAVAILABLE',
        `WatchParty could not connect to the ${resolvedBackend?.label || 'selected'} room service.`,
      );
      throw error;
    } finally {
      if (ready) connectPromise = null;
    }
  }

  async function createRoom({ username, meta, stream, public: isPublic, roomName }) {
    active = true;
    reconnectRoomId = null;
    reconnectRoomKey = null;
    pendingRejoin = false;
    pendingCreatedRoomKey = isPublic === false ? generatePrivateRoomKey() : null;
    await clearRoomServiceError();
    await ensureConnected();
    await sendUserUpdate(username);

    const payload = {
      meta,
      stream,
      public: !!isPublic,
    };
    if (pendingCreatedRoomKey) payload.roomKey = pendingCreatedRoomKey;
    if (roomName) payload.name = roomName;
    send({ type: WPProtocol.C2S.ROOM_NEW, payload });
  }

  async function joinRoom({ username, roomId, roomKey }) {
    active = true;
    reconnectRoomId = roomId;
    reconnectRoomKey = roomKey || await loadRoomKey(roomId);
    pendingRejoin = false;
    await clearRoomServiceError();
    await ensureConnected();
    await sendUserUpdate(username);
    send({
      type: WPProtocol.C2S.ROOM_JOIN,
      payload: {
        id: roomId,
        roomKey: reconnectRoomKey || undefined,
      },
    });
  }

  async function updatePublic({ public: isPublic, roomKey }) {
    if (!roomState?.id) return;
    await ensureConnected();
    if (isPublic === false) {
      const nextRoomKey = roomKey || reconnectRoomKey || await loadRoomKey(roomState.id) || generatePrivateRoomKey();
      reconnectRoomKey = nextRoomKey;
      await cacheRoomKey(roomState.id, nextRoomKey);
      send({
        type: WPProtocol.C2S.ROOM_UPDATE_PUBLIC,
        payload: {
          public: false,
          roomKey: nextRoomKey,
        },
      });
      return;
    }

    reconnectRoomKey = null;
    await clearRoomKey(roomState.id);
    send({
      type: WPProtocol.C2S.ROOM_UPDATE_PUBLIC,
      payload: { public: true },
    });
  }

  async function updateSettings(settings) {
    if (!roomState?.id) return;
    await ensureConnected();
    send({
      type: WPProtocol.C2S.ROOM_UPDATE_SETTINGS,
      payload: settings,
    });
  }

  async function transferOwnership(targetUserId) {
    if (!roomState?.id || !targetUserId) return;
    await ensureConnected();
    send({
      type: WPProtocol.C2S.ROOM_UPDATE_OWNERSHIP,
      payload: { userId: targetUserId },
    });
  }

  async function updateUsername(username) {
    await ensureConnected();
    await sendUserUpdate(username);
  }

  async function stop(options = {}) {
    const { preserveRoomState = false, preserveCurrentRoom = false } = options;
    active = false;
    shuttingDown = true;
    pendingRejoin = false;
    clearReconnectTimer();
    stopKeepAlive();
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    ready = false;
    connectPromise = null;
    if (!preserveRoomState) {
      reconnectRoomId = null;
      reconnectRoomKey = null;
      pendingCreatedRoomKey = null;
    }
    await clearRoomServiceError();
    await clearPersistedRoomState({ preserveRoomState, preserveCurrentRoom });
  }

  async function leaveRoom() {
    if (ws?.readyState === WebSocket.OPEN && ready) {
      send({ type: WPProtocol.C2S.ROOM_LEAVE, payload: {} });
    }
    await stop();
  }

  async function handoffToTab() {
    if (!roomState?.id) return false;
    await chrome.storage.local.set({
      [STORAGE.PENDING_ROOM_JOIN]: roomState.id,
      [STORAGE.CURRENT_ROOM]: roomState.id,
      [STORAGE.ROOM_STATE]: roomState,
    });
    await stop({ preserveRoomState: true, preserveCurrentRoom: true });
    return true;
  }

  async function resumeIfNeeded() {
    if (ws || connectPromise) return false;

    const stored = await chrome.storage.local.get([
      STORAGE.CURRENT_ROOM,
      STORAGE.ROOM_STATE,
      STORAGE.ROOM_SERVICE_ACTIVE,
    ]);
    const storedRoom = stored[STORAGE.ROOM_STATE] || null;
    const storedRoomId = stored[STORAGE.CURRENT_ROOM] || storedRoom?.id || null;
    const shouldResume = !!storedRoomId && stored[STORAGE.ROOM_SERVICE_ACTIVE] === true;
    if (!shouldResume) return false;

    roomState = storedRoom;
    reconnectRoomId = storedRoomId;
    reconnectRoomKey = await loadRoomKey(storedRoomId);
    pendingRejoin = true;
    active = true;
    await ensureConnected();
    return true;
  }

  function isActive() {
    return active || !!ws || !!connectPromise;
  }

  function getRoomId() {
    return roomState?.id || reconnectRoomId || null;
  }

  return {
    createRoom,
    joinRoom,
    leaveRoom,
    updatePublic,
    updateSettings,
    transferOwnership,
    updateUsername,
    handoffToTab,
    resumeIfNeeded,
    isActive,
    getRoomId,
    stop,
  };
})();
