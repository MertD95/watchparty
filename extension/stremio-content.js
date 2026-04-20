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
  let pendingRoomCreateCommand = null;
  let pendingRoomJoinCommand = null;
  let pendingJoinOptions = null;
  let pendingCreatedRoomKey = null;
  let deferredLeaveIntent = null;
  let lastJoinAttemptRoomId = null;
  let shareContentLinkInFlight = false;
  let reconnectNoticeTimer = null;
  let reconnectNoticeShown = false;
  let surfaceTabId = null;
  let activeVideoLeaseInterval = null;
  const activeVideoLeaseId = crypto.randomUUID();
  const cinemetaTitleCache = new Map();
  const SESSION_RUNTIME_KEYS = new Set([
    ...WPConstants.STORAGE_CONTRACT.SESSION_RUNTIME,
    ...WPConstants.STORAGE_CONTRACT.BOOTSTRAP_SESSION,
  ]);

  const PLACEHOLDER_ROOM_NAME = 'WatchParty Session';
  const PLACEHOLDER_STREAM_URL = 'https://watchparty.mertd.me/sync';

  function clearReconnectNotice(options = {}) {
    if (reconnectNoticeTimer) {
      clearTimeout(reconnectNoticeTimer);
      reconnectNoticeTimer = null;
    }
    if (options.preserveShown !== true) reconnectNoticeShown = false;
  }

  function scheduleReconnectNotice() {
    if (reconnectNoticeTimer || !inRoom) return;
    reconnectNoticeTimer = setTimeout(() => {
      reconnectNoticeTimer = null;
      if (!inRoom || WPWS.isConnected()) return;
      reconnectNoticeShown = true;
      WPOverlay.showToast('WatchParty disconnected. Trying to reconnect — the room may show as reconnecting until you are back online.', 5000);
      refreshOverlay();
    }, 2500);
  }

  function claimActiveTab() {
    if (!extOk()) return;
    isActiveVideoTab = true;
    const lease = WPConstants.VIDEO_TAB_LEASE.build({
      leaseId: activeVideoLeaseId,
      tabId: surfaceTabId,
      sessionId,
    });
    if (!lease) return;
    setExtensionState({ [WPConstants.STORAGE.ACTIVE_VIDEO_TAB]: lease }).catch(() => {});
  }

  function releaseActiveTab() {
    if (!extOk()) return;
    isActiveVideoTab = false;
    // Only clear if we currently own it
    getExtensionState(WPConstants.STORAGE.ACTIVE_VIDEO_TAB).then((result) => {
      if (WPConstants.VIDEO_TAB_LEASE.isOwner(result[WPConstants.STORAGE.ACTIVE_VIDEO_TAB], activeVideoLeaseId)) {
        removeExtensionState(WPConstants.STORAGE.ACTIVE_VIDEO_TAB).catch(() => {});
      }
    });
  }

  function refreshActiveVideoLease(options = {}) {
    if (!extOk() || !video || !inRoom) return Promise.resolve(false);
    const force = options.force === true;
    return getExtensionState(WPConstants.STORAGE.ACTIVE_VIDEO_TAB).then((result) => {
      const currentLease = result[WPConstants.STORAGE.ACTIVE_VIDEO_TAB];
      const ownsLease = WPConstants.VIDEO_TAB_LEASE.isOwner(currentLease, activeVideoLeaseId);
      const leaseIsExpired = WPConstants.VIDEO_TAB_LEASE.isExpired(currentLease);
      const shouldClaim = force || ownsLease || leaseIsExpired || !currentLease;
      if (!shouldClaim) {
        isActiveVideoTab = false;
        return false;
      }
      if (!force && ownsLease && !WPConstants.VIDEO_TAB_LEASE.shouldRenew(currentLease)) return true;
      claimActiveTab();
      return true;
    }).catch(() => false);
  }

  function startActiveVideoLeaseHeartbeat() {
    if (activeVideoLeaseInterval) return;
    activeVideoLeaseInterval = setInterval(() => {
      if (!extOk()) {
        clearInterval(activeVideoLeaseInterval);
        activeVideoLeaseInterval = null;
        return;
      }
      refreshActiveVideoLease().then((claimed) => {
        if (!claimed || !video || !inRoom) return;
        if (!WPSync.isAttached()) attachSync();
      }).catch(() => {});
    }, WPConstants.VIDEO_TAB_LEASE.RENEW_INTERVAL_MS);
  }

  // --- Extension context guard (WS survives extension reloads, but chrome APIs don't) ---
  function extOk() { return !!chrome.runtime?.id; }

  function normalizeStorageKeyList(keys) {
    return Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
  }

  function getExtensionState(keys) {
    const keyList = normalizeStorageKeyList(keys);
    if (!extOk() || keyList.length === 0) return Promise.resolve({});

    const sessionKeys = keyList.filter((key) => SESSION_RUNTIME_KEYS.has(key));
    const localKeys = keyList.filter((key) => !SESSION_RUNTIME_KEYS.has(key));

    return Promise.all([
      sessionKeys.length > 0 ? chrome.storage.session.get(sessionKeys).catch(() => ({})) : Promise.resolve({}),
      localKeys.length > 0 ? chrome.storage.local.get(localKeys).catch(() => ({})) : Promise.resolve({}),
      sessionKeys.length > 0 ? chrome.storage.local.get(sessionKeys).catch(() => ({})) : Promise.resolve({}),
    ]).then(([sessionValues, localValues, fallbackValues]) => {
      const migratedValues = {};
      for (const key of sessionKeys) {
        if (sessionValues[key] !== undefined || fallbackValues[key] === undefined) continue;
        migratedValues[key] = fallbackValues[key];
      }

      if (Object.keys(migratedValues).length > 0) {
        chrome.storage.session.set(migratedValues).catch(() => {});
        chrome.storage.local.remove(Object.keys(migratedValues)).catch(() => {});
      }

      return { ...localValues, ...fallbackValues, ...sessionValues };
    });
  }

  function setExtensionState(values) {
    if (!extOk() || !values || typeof values !== 'object') return Promise.resolve();
    const sessionValues = {};
    const localValues = {};
    for (const [key, value] of Object.entries(values)) {
      if (SESSION_RUNTIME_KEYS.has(key)) sessionValues[key] = value;
      else localValues[key] = value;
    }
    return Promise.all([
      Object.keys(localValues).length > 0 ? chrome.storage.local.set(localValues).catch(() => {}) : Promise.resolve(),
      Object.keys(sessionValues).length > 0 ? chrome.storage.session.set(sessionValues).catch(() => {}) : Promise.resolve(),
    ]).then(() => {
      if (Object.keys(sessionValues).length > 0) {
        chrome.storage.local.remove(Object.keys(sessionValues)).catch(() => {});
      }
    });
  }

  function removeExtensionState(keys) {
    const keyList = normalizeStorageKeyList(keys);
    if (!extOk() || keyList.length === 0) return Promise.resolve();
    const sessionKeys = keyList.filter((key) => SESSION_RUNTIME_KEYS.has(key));
    return Promise.all([
      chrome.storage.local.remove(keyList).catch(() => {}),
      sessionKeys.length > 0 ? chrome.storage.session.remove(sessionKeys).catch(() => {}) : Promise.resolve(),
    ]).then(() => undefined);
  }

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

  function normalizeBootstrapRoomIntent(value) {
    return WPConstants.BOOTSTRAP_ROOM_INTENT.normalize(value);
  }

  function syncPendingJoinOptions(value, roomId) {
    const next = normalizePendingJoinOptions(value);
    if (!next) {
      pendingJoinOptions = null;
      return null;
    }
    if (roomId && next.roomId !== roomId) {
      pendingJoinOptions = null;
      return null;
    }
    pendingJoinOptions = next;
    return next;
  }

  function clearPendingJoinOptions(roomId) {
    if (roomId && pendingJoinOptions?.roomId && pendingJoinOptions.roomId !== roomId) return;
    pendingJoinOptions = null;
  }

  function clearBootstrapRoomIntent() {
    if (!extOk()) return Promise.resolve();
    return removeExtensionState(WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT).catch(() => { });
  }

  function stagePendingRoomCreateCommand(command) {
    pendingRoomCreateCommand = command ? { ...command } : null;
    pendingRoomJoinCommand = null;
  }

  function stagePendingRoomJoinCommand(command) {
    pendingRoomJoinCommand = command ? { ...command } : null;
    pendingRoomCreateCommand = null;
  }

  function cacheRoomKeyForRoom(roomId, roomKey) {
    if (!roomId || !roomKey || !extOk()) return Promise.resolve();
    const storageKey = WPConstants.STORAGE.roomKey(roomId);
    const encodedRoomKey = WPConstants.ROOM_KEYS.encodeForLocal(roomKey);
    return chrome.storage.session.set({ [storageKey]: roomKey })
      .catch(() => undefined)
      .then(() => encodedRoomKey
        ? chrome.storage.local.set({ [storageKey]: encodedRoomKey }).catch(() => { })
        : undefined);
  }

  function clearRoomKeyForRoom(roomId) {
    if (!roomId || !extOk()) return Promise.resolve();
    const storageKey = WPConstants.STORAGE.roomKey(roomId);
    return chrome.storage.session.remove(storageKey)
      .catch(() => undefined)
      .then(() => chrome.storage.local.remove(storageKey).catch(() => { }));
  }

  function loadStoredRoomKey(roomId) {
    if (!roomId || !extOk()) return Promise.resolve(null);
    const storageKey = WPConstants.STORAGE.roomKey(roomId);
    return new Promise((resolve) => {
      chrome.storage.session.get(storageKey, (result) => {
        if (!chrome.runtime?.id) return resolve(null);
        if (!chrome.runtime.lastError && result?.[storageKey]) return resolve(result[storageKey]);
        chrome.storage.local.get(storageKey, (fallback) => {
          const decoded = WPConstants.ROOM_KEYS.decodeFromLocal(fallback?.[storageKey]);
          if (decoded.expired) chrome.storage.local.remove(storageKey).catch(() => { });
          resolve(decoded.value || null);
        });
      });
    });
  }

  async function generatePrivateRoomKey() {
    if (typeof WPCrypto === 'undefined') return null;
    WPCrypto.clear();
    await WPCrypto.generateKey();
    return WPCrypto.exportKey();
  }

  function normalizeRoomKeyInput(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return /^[A-Za-z0-9_-]{16,200}$/.test(trimmed) ? trimmed : null;
  }

  function normalizeDeferredLeaveIntent(value) {
    if (!value || typeof value !== 'object') return null;
    const roomId = typeof value.roomId === 'string' ? value.roomId.trim() : '';
    if (!roomId) return null;
    const requestedAt = Number(value.requestedAt);
    return {
      roomId,
      requestedAt: Number.isFinite(requestedAt) && requestedAt > 0 ? requestedAt : Date.now(),
    };
  }

  function syncDeferredLeaveIntent(value) {
    deferredLeaveIntent = normalizeDeferredLeaveIntent(value);
    return deferredLeaveIntent;
  }

  function rememberDeferredLeaveIntent(roomId) {
    const normalizedRoomId = typeof roomId === 'string' ? roomId.trim() : '';
    if (!normalizedRoomId) return null;
    const nextIntent = {
      roomId: normalizedRoomId,
      requestedAt: Date.now(),
    };
    deferredLeaveIntent = nextIntent;
    if (extOk()) {
      setExtensionState({ [WPConstants.STORAGE.DEFERRED_LEAVE_ROOM]: nextIntent }).catch(() => { });
    }
    return nextIntent;
  }

  function clearDeferredLeaveIntent(roomId) {
    if (roomId && deferredLeaveIntent?.roomId && deferredLeaveIntent.roomId !== roomId) return;
    deferredLeaveIntent = null;
    if (!extOk()) return;
    removeExtensionState(WPConstants.STORAGE.DEFERRED_LEAVE_ROOM).catch(() => { });
  }

  function applyLocalLeaveState(leavingRoomId) {
    clearReconnectNotice();
    clearPendingJoinOptions();
    inRoom = false;
    roomState = null;
    isHost = false;
    releaseActiveTab();
    WPSync.detach();
    WPCrypto.clear();
    document.getElementById('wp-catchup-btn')?.remove();
    refreshOverlay();
    persistState();
    if (!extOk()) return;
    removeExtensionState([
      WPConstants.STORAGE.CURRENT_ROOM,
      WPConstants.STORAGE.ROOM_STATE,
      WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT,
    ]).catch(() => { });
    if (leavingRoomId) {
      chrome.storage.session.remove(WPConstants.STORAGE.roomKey(leavingRoomId)).catch(() => { });
    }
  }

  function finalizeLeaveIntent(options = {}) {
    const leavingRoomId = options.roomId || roomState?.id || deferredLeaveIntent?.roomId;
    if (!leavingRoomId) return;
    if (options.sendLeave && inRoom && WPWS.isReady()) {
      clearDeferredLeaveIntent(leavingRoomId);
      WPWS.send({ type: WPProtocol.C2S.ROOM_LEAVE, payload: {} });
    } else {
      rememberDeferredLeaveIntent(leavingRoomId);
      if (!WPWS.isConnected()) {
        WPWS.connect();
      }
    }
    applyLocalLeaveState(leavingRoomId);
  }

  async function drainDeferredLeaveIntent() {
    if (!deferredLeaveIntent?.roomId || !WPWS.isReady()) return false;
    const roomId = deferredLeaveIntent.roomId;
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get(WPConstants.STORAGE.USERNAME, (result) => resolve(result || {}));
    }).catch(() => ({}));
    const username = stored?.[WPConstants.STORAGE.USERNAME];
    if (username) {
      WPWS.send({ type: WPProtocol.C2S.USER_UPDATE, payload: { username, sessionId } });
    }
    const roomKey = await loadStoredRoomKey(roomId);
    lastJoinAttemptRoomId = roomId;
    WPWS.send({
      type: WPProtocol.C2S.ROOM_JOIN,
      payload: { id: roomId, roomKey: roomKey || undefined },
    });
    return true;
  }

  function shouldDrainDeferredLeave(payload) {
    return !!payload?.id
      && !!deferredLeaveIntent?.roomId
      && deferredLeaveIntent.roomId === payload.id;
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

  function shouldShareHostContent() {
    return inRoom && isActiveVideoTab && amIHost();
  }

  function requestLatestHostSync() {
    if (!inRoom || isHost || !isActiveVideoTab || !WPWS.isReady()) return;
    WPWS.send({ type: WPProtocol.C2S.PLAYER_SYNC, payload: roomState?.player || WPProtocol.DEFAULT_PLAYER });
  }

  function syncPeerVideoToRoom(options = {}) {
    if (isHost || !video || !roomState?.player) return;
    WPSync.applyRemote(roomState.player);
    if (options.requestFresh === true) requestLatestHostSync();
    const drift = WPSync.getLastDrift();
    WPOverlay.updateSyncIndicator(isHost, drift);
    WPOverlay.showCatchUpButton(drift);
  }

  function schedulePeerVideoResync(videoEl) {
    if (isHost || !videoEl) return;
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'playing'];
    let fallbackTimer = null;
    let done = false;

    const cleanup = () => {
      for (const eventName of events) {
        videoEl.removeEventListener(eventName, handleReady);
      }
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const handleReady = () => {
      if (done) return;
      done = true;
      cleanup();
      if (video !== videoEl || !inRoom || isHost) return;
      syncPeerVideoToRoom({ requestFresh: true });
    };

    if (videoEl.readyState >= 3) {
      handleReady();
      return;
    }

    for (const eventName of events) {
      videoEl.addEventListener(eventName, handleReady, { once: true });
    }
    fallbackTimer = setTimeout(handleReady, 2500);
    syncPeerVideoToRoom({ requestFresh: true });
  }

  function maybeRepairSharedPlayerRoute() {
    if (!shouldShareHostContent()) return;
    const hash = window.location.hash || '';
    if (!hash.startsWith('#/player/')) return;
    const currentLaunchUrl = getCurrentLaunchUrl(hash);
    if (!currentLaunchUrl || roomState?.stream?.url === currentLaunchUrl) return;
    shareContentLink();
  }

  async function fetchCinemetaTitle(type, id) {
    if (!type || !id || !id.startsWith('tt')) return null;
    const cacheKey = `${type}:${id}`;
    if (cinemetaTitleCache.has(cacheKey)) return cinemetaTitleCache.get(cacheKey);
    try {
      const response = await fetch(`https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = response.ok ? await response.json() : null;
      const title = typeof data?.meta?.name === 'string' && data.meta.name.trim()
        ? data.meta.name.trim()
        : null;
      cinemetaTitleCache.set(cacheKey, title);
      return title;
    } catch {
      cinemetaTitleCache.set(cacheKey, null);
      return null;
    }
  }

  async function withTimeout(task, timeoutMs) {
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(task),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function enrichContentMeta(meta, launchUrl) {
    if (!meta) return null;
    const nextMeta = { ...meta };
    const nameNeedsHelp = !nextMeta.name || nextMeta.name === nextMeta.id || nextMeta.name === PLACEHOLDER_ROOM_NAME;
    if (nameNeedsHelp && launchUrl) {
      try {
        const titleHint = await withTimeout(
          () => WPDirectPlay.getPlayerTitleHint?.(launchUrl),
          1500,
        );
        if (titleHint) nextMeta.name = titleHint;
      } catch {}
    }
    if ((!nextMeta.name || nextMeta.name === nextMeta.id || nextMeta.name === PLACEHOLDER_ROOM_NAME) && nextMeta.id?.startsWith('tt')) {
      const cinemetaTitle = await fetchCinemetaTitle(nextMeta.type, nextMeta.id);
      if (cinemetaTitle) nextMeta.name = cinemetaTitle;
    }
    return nextMeta;
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
    setExtensionState({
      [WPConstants.STORAGE.ROOM_STATE]: roomState,
      [WPConstants.STORAGE.USER_ID]: userId,
      [WPConstants.STORAGE.WS_CONNECTED]: WPWS.isConnected(),
      [WPConstants.STORAGE.ACTIVE_BACKEND]: WPWS.getActiveBackend(),
      [WPConstants.STORAGE.ACTIVE_BACKEND_URL]: WPWS.getActiveWsUrl(),
    }).catch(() => { });
  }

  function persistConnectionState() {
    if (!extOk()) return;
    setExtensionState({
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

  function cloneRoomSnapshot(room) {
    if (!room) return null;
    return {
      ...room,
      meta: room.meta ? { ...room.meta } : room.meta,
      stream: room.stream ? { ...room.stream } : room.stream,
      player: room.player ? { ...room.player } : room.player,
      settings: room.settings ? { ...room.settings } : room.settings,
      readyCheck: room.readyCheck ? { ...room.readyCheck, confirmed: Array.isArray(room.readyCheck.confirmed) ? [...room.readyCheck.confirmed] : [] } : room.readyCheck,
      users: Array.isArray(room.users) ? room.users.map((user) => ({ ...user })) : [],
      bookmarks: Array.isArray(room.bookmarks) ? room.bookmarks.map((bookmark) => ({ ...bookmark })) : [],
      messages: Array.isArray(room.messages) ? room.messages.map((message) => ({ ...message })) : [],
    };
  }

  function commitRoomState(nextRoom, options = {}) {
    if (!nextRoom?.id) return false;
    roomState = nextRoom;
    lastJoinAttemptRoomId = null;
    if (pendingCreatedRoomKey && roomState.id) {
      cacheRoomKeyForRoom(roomState.id, pendingCreatedRoomKey);
      pendingCreatedRoomKey = null;
    }
    if (extOk()) {
      setExtensionState({ [WPConstants.STORAGE.CURRENT_ROOM]: roomState.id }).catch(() => {});
    }
    persistState();
    if (options.lifecycle === 'joined') {
      onRoomJoined();
    } else if (options.lifecycle === 'sync') {
      onRoomSync();
    } else if (options.refreshOverlay !== false) {
      refreshOverlay();
    }
    return true;
  }

  function adoptRoomSnapshot(nextRoom, options = {}) {
    if (!nextRoom?.id) return false;
    prevPlayerTime = roomState?.player?.time || 0;
    return commitRoomState(nextRoom, { lifecycle: options.lifecycle || 'sync' });
  }

  function applyRoomStateDelta(mutator, options = {}) {
    if (!roomState) return false;
    const nextRoom = cloneRoomSnapshot(roomState);
    if (!nextRoom) return false;
    mutator(nextRoom);
    return commitRoomState(nextRoom, options);
  }

  // --- WS callbacks ---
  WPWS.onConnect(() => {
    const shouldAnnounceReconnect = reconnectNoticeShown;
    clearReconnectNotice();
    persistConnectionState();
    notifyBackground({
      action: 'ws-status-changed',
      connected: true,
      activeBackend: WPWS.getActiveBackend(),
      activeBackendUrl: WPWS.getActiveWsUrl(),
    });
    WPSync.resetCorrection();
    refreshOverlay();
    if (shouldAnnounceReconnect && inRoom) {
      WPOverlay.showToast('WatchParty reconnected', 1800);
    }
    getExtensionState([
      WPConstants.STORAGE.DEFERRED_LEAVE_ROOM,
      WPConstants.STORAGE.USERNAME,
      WPConstants.STORAGE.CURRENT_ROOM,
    ]).then((stored) => {
      syncDeferredLeaveIntent(stored[WPConstants.STORAGE.DEFERRED_LEAVE_ROOM]);
      if (deferredLeaveIntent?.roomId) {
        drainDeferredLeaveIntent().catch(() => { });
        return;
      }
      // If we were in a room, rejoin (with replay if we have a sequence number)
      if (!roomState?.id) return;
      // Load E2E crypto key before rejoining (prevents garbled messages on new tabs)
      loadCryptoKeyForRoom(roomState.id).then(() => {
        if (stored[WPConstants.STORAGE.USERNAME]) {
          WPWS.send({ type: WPProtocol.C2S.USER_UPDATE, payload: { username: stored[WPConstants.STORAGE.USERNAME], sessionId } });
        }
        loadStoredRoomKey(roomState.id).then((roomKey) => {
          const seq = WPWS.getLastSeq();
          lastJoinAttemptRoomId = roomState.id;
          if (seq > 0) {
            WPWS.send({ type: WPProtocol.C2S.ROOM_REJOIN, payload: { id: roomState.id, lastSeq: seq, roomKey: roomKey || undefined } });
          } else {
            WPWS.send({ type: WPProtocol.C2S.ROOM_JOIN, payload: { id: roomState.id, roomKey: roomKey || undefined } });
          }
        });
      });
    });
  });

  WPWS.onDisconnect(() => {
    scheduleReconnectNotice();
    persistConnectionState();
    notifyBackground({
      action: 'ws-status-changed',
      connected: false,
      activeBackend: WPWS.getActiveBackend(),
      activeBackendUrl: WPWS.getActiveWsUrl(),
    });
    refreshOverlay();
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
        if (shouldDrainDeferredLeave(p)) {
          lastJoinAttemptRoomId = null;
          clearDeferredLeaveIntent(p.id);
          WPWS.send({ type: WPProtocol.C2S.ROOM_LEAVE, payload: {} });
          applyLocalLeaveState(p.id);
          return;
        }
        adoptRoomSnapshot(p, { lifecycle: 'sync' });
        break;

      case WPProtocol.S2C.ROOM:
        if (!p?.id) return;
        if (shouldDrainDeferredLeave(p)) {
          lastJoinAttemptRoomId = null;
          clearDeferredLeaveIntent(p.id);
          WPWS.send({ type: WPProtocol.C2S.ROOM_LEAVE, payload: {} });
          applyLocalLeaveState(p.id);
          return;
        }
        adoptRoomSnapshot(p, { lifecycle: 'joined' });
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
        if (deferredLeaveIntent?.roomId && lastJoinAttemptRoomId === deferredLeaveIntent.roomId) {
          clearDeferredLeaveIntent(deferredLeaveIntent.roomId);
        }
        if (p?.code === WPProtocol.ERROR_CODE.ROOM_NOT_FOUND) {
          const wasInRoom = inRoom;
          clearPendingJoinOptions();
          inRoom = false; roomState = null;
          WPSync.detach();
        if (extOk()) removeExtensionState([WPConstants.STORAGE.CURRENT_ROOM, WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]).catch(() => {});
          refreshOverlay();
          persistState();
          if (wasInRoom || p?.code === WPProtocol.ERROR_CODE.ROOM_NOT_FOUND) {
            WPOverlay.showToast('Room no longer exists', 3000);
          }
        }
        if (p?.code === WPProtocol.ERROR_CODE.INVALID_ROOM_KEY && lastJoinAttemptRoomId) {
          clearRoomKeyForRoom(lastJoinAttemptRoomId);
        }
        // Show error feedback for non-room errors
        if (p?.code !== WPProtocol.ERROR_CODE.ROOM_NOT_FOUND && p?.message) {
          if (p.code === WPProtocol.ERROR_CODE.COOLDOWN && lastUserAction === 'send-chat') {
            WPOverlay.showToast('Slow down! Wait a moment before sending again.', 2000);
          } else if (p.code === WPProtocol.ERROR_CODE.NOT_OWNER) {
            WPOverlay.showToast('Only the host can do that.', 2000);
          } else if (p.code === WPProtocol.ERROR_CODE.ROOM_KEY_REQUIRED) {
            WPOverlay.showToast('This private room requires a room key.', 2500);
          } else if (p.code === WPProtocol.ERROR_CODE.INVALID_ROOM_KEY) {
            WPOverlay.showToast('Room key is invalid. Check the invite link or try again.', 3000);
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
        applyRoomStateDelta((nextRoom) => {
          nextRoom.player = p.player;
        }, { lifecycle: 'sync' });
        break;

      case WPProtocol.S2C.PRESENCE_UPDATE:
        if (!p?.userId || !roomState?.users) return;
        applyRoomStateDelta((nextRoom) => {
          const user = nextRoom.users.find((entry) => entry.id === p.userId);
          if (user) user.status = p.status;
        });
        break;

      case WPProtocol.S2C.PLAYBACK_STATUS_UPDATE:
        if (!p?.userId || !roomState?.users) return;
        applyRoomStateDelta((nextRoom) => {
          const user = nextRoom.users.find((entry) => entry.id === p.userId);
          if (!user) return;
          user.playbackStatus = p.status;
          if (Number.isFinite(p.time)) user.playbackTime = p.time;
        });
        break;

      case WPProtocol.S2C.SETTINGS_UPDATE:
        if (!p?.settings || !roomState) return;
        applyRoomStateDelta((nextRoom) => {
          nextRoom.settings = p.settings;
        });
        break;
    }
  }

  // Wire up: active tab processes WS events and broadcasts to passive tabs
  WPWS.onMessage((msg) => {
    processWsEvent(msg);
  });

  // --- Process pending create/join actions from storage ---
  async function createRoomFromCommand(command) {
    clearPendingJoinOptions();
    if (inRoom) {
      WPWS.send({ type: WPProtocol.C2S.ROOM_LEAVE, payload: {} });
      inRoom = false; roomState = null; isHost = false;
    }
    removeExtensionState(WPConstants.STORAGE.CURRENT_ROOM).catch(() => {});
    if (command?.username) {
      WPWS.send({ type: WPProtocol.C2S.USER_UPDATE, payload: { username: command.username, sessionId } });
    }
    const context = getCurrentContentContext();
    const seedMeta = (isPlaceholderMeta(command?.meta) && context.meta) ? context.meta : command?.meta;
    const meta = await enrichContentMeta(seedMeta, context.launchUrl);
    const stream = (isPlaceholderStream(command?.stream) && context.launchUrl) ? { url: context.launchUrl } : command?.stream;
    const payload = { meta, stream, public: command?.public || false };
    if (payload.public === false) {
      pendingCreatedRoomKey = command?.roomKey || await generatePrivateRoomKey();
      if (!pendingCreatedRoomKey) {
        WPOverlay.showToast('Failed to generate a private room key.', 2500);
        return;
      }
      payload.roomKey = pendingCreatedRoomKey;
    } else {
      pendingCreatedRoomKey = null;
      WPCrypto.clear();
    }
    if (command?.roomName) payload.name = command.roomName;
    WPWS.send({ type: WPProtocol.C2S.ROOM_NEW, payload });
  }

  async function joinRoomFromCommand(command, stored = {}) {
    const roomToJoin = command?.roomId;
    if (!roomToJoin || !extOk() || !WPWS.isReady()) return;
    const joinOptions = command?.preferDirectJoin === true
      ? { roomId: roomToJoin, preferDirectJoin: true }
      : null;
    syncPendingJoinOptions(joinOptions, roomToJoin);

    const cryptoKeyStr = command?.roomKey || await loadStoredRoomKey(roomToJoin);
    if (cryptoKeyStr && !WPCrypto.isEnabled()) {
      try { await WPCrypto.importKey(cryptoKeyStr); } catch { /* invalid key */ }
    }
    const username = command?.username || stored[WPConstants.STORAGE.USERNAME];
    if (username) {
      WPWS.send({ type: WPProtocol.C2S.USER_UPDATE, payload: { username, sessionId } });
    }
    lastJoinAttemptRoomId = roomToJoin;
    WPWS.send({ type: WPProtocol.C2S.ROOM_JOIN, payload: { id: roomToJoin, roomKey: cryptoKeyStr || undefined } });
  }

  function processPendingActions() {
    if (!WPWS.isReady() || !extOk()) return;
    // sessionId MUST be loaded before sending any room messages — otherwise server can't dedup
    if (!sessionId) return;
    getExtensionState([
      WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT,
      WPConstants.STORAGE.DEFERRED_LEAVE_ROOM,
      WPConstants.STORAGE.CURRENT_ROOM,
      WPConstants.STORAGE.USERNAME,
    ]).then(async (stored) => {
      syncDeferredLeaveIntent(stored[WPConstants.STORAGE.DEFERRED_LEAVE_ROOM]);
      if (deferredLeaveIntent?.roomId) {
        await drainDeferredLeaveIntent().catch(() => { });
        return;
      }

      if (pendingRoomCreateCommand) {
        const command = pendingRoomCreateCommand;
        pendingRoomCreateCommand = null;
        await createRoomFromCommand(command);
        return;
      }

      if (pendingRoomJoinCommand) {
        const command = pendingRoomJoinCommand;
        pendingRoomJoinCommand = null;
        await joinRoomFromCommand(command, {
          [WPConstants.STORAGE.USERNAME]: command?.username,
        });
        return;
      }

      const bootstrapIntent = normalizeBootstrapRoomIntent(stored[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]);
      if (!bootstrapIntent && stored[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT] !== undefined) {
        await clearBootstrapRoomIntent();
      }
      if (bootstrapIntent) {
        await clearBootstrapRoomIntent();
        if (bootstrapIntent.action === 'create-room') {
          await createRoomFromCommand(bootstrapIntent);
          return;
        }
        if (bootstrapIntent.action === 'join-room') {
          await joinRoomFromCommand(bootstrapIntent, stored);
          return;
        }
      }

      const roomToJoin = stored[WPConstants.STORAGE.CURRENT_ROOM] || null;
      if (roomToJoin) {
        await joinRoomFromCommand({
          roomId: roomToJoin,
          username: stored[WPConstants.STORAGE.USERNAME],
          roomKey: await loadStoredRoomKey(roomToJoin),
        }, stored);
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
                const decoded = WPConstants.ROOM_KEYS.decodeFromLocal(local[key]);
                if (decoded.expired) chrome.storage.local.remove(key).catch(() => { });
                if (decoded.value) try { await WPCrypto.importKey(decoded.value); } catch { /* invalid key */ }
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

  // --- Room event handlers ---

  function isMe(uid) {
    if (uid === userId) return true;
    const user = WPUtils.getMatchingRoomUser(roomState, uid, null);
    if (sessionId && user) return user.sessionId === sessionId;
    // uid not in users list (orphaned owner after reconnect/dedup) —
    // check if WE are in the users list (if so, and owner is orphaned, we're likely the owner)
    return false;
  }

  /** Am I the room host? Handles orphaned owner IDs after WS reconnect. */
  function amIHost() {
    return WPUtils.isCurrentSessionOwner(roomState, userId, sessionId);
  }

  async function onRoomJoined() {
    inRoom = true;
    isHost = amIHost();
    if (video) {
      refreshActiveVideoLease({ force: true }).catch(() => {});
      attachSync();
    }
    refreshOverlay();
    const directJoinResult = !isHost ? maybeHandlePendingDirectJoin(roomState) : null;
    // E2E encryption is opt-in: only enabled when a key is provided via invite URL.
    // Auto-generating keys breaks multi-tab (other tabs can't reliably read the key from session storage).
    WPOverlay.bindRoomCodeCopy(roomState);
    WPOverlay.playNotifSound();
    if (shouldShareHostContent()) {
      // Only the active video tab shares content link
      shareContentLink();
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
    WPSync.setHost(isHost);
    if (video && shouldShareHostContent()) {
      attachSync();
      maybeRepairSharedPlayerRoute();
    }
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
        syncPeerVideoToRoom();
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
    const userName = roomState?.users?.find((entry) => entry.id === user)?.name || null;
    notifyBackground({ action: 'typing', payload: { user, typing, userName } });
  }

  // --- Content link sharing ---
  async function shareContentLink() {
    if (shareContentLinkInFlight) return;
    shareContentLinkInFlight = true;
    try {
      const context = getCurrentContentContext();
      if (!context.meta && !context.launchUrl) return;

      const stream = context.launchUrl
        ? { url: context.launchUrl }
        : { url: PLACEHOLDER_STREAM_URL };
      if (!shouldShareHostContent()) return;

      if (!context.meta) {
        const streamOnlyKey = `stream:::${buildSharedStreamKey(stream)}`;
        if (lastSharedContentKey === streamOnlyKey) return;
        lastSharedContentKey = streamOnlyKey;
        WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_STREAM, payload: { stream } });
        return;
      }

      const meta = await enrichContentMeta(context.meta, context.launchUrl);
      const shareKey = `${meta.type}:${meta.id}:${meta.name || ''}:${buildSharedStreamKey(stream)}`;
      if (lastSharedContentKey === shareKey) return;
      lastSharedContentKey = shareKey;
      WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_STREAM, payload: { stream, meta } });
    } finally {
      shareContentLinkInFlight = false;
    }
  }

  function getVideoElementScore(videoEl) {
    if (!videoEl?.isConnected) return Number.NEGATIVE_INFINITY;
    const rect = videoEl.getBoundingClientRect?.() || { width: 0, height: 0 };
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(videoEl) : null;
    const visible = area > 0
      && style?.display !== 'none'
      && style?.visibility !== 'hidden'
      && style?.opacity !== '0';
    return (visible ? 1000000 : 0)
      + area
      + (videoEl.readyState > 0 ? 10000 : 0)
      + (videoEl.currentSrc ? 1000 : 0)
      + (!videoEl.paused ? 100 : 0);
  }

  function findBestVideoElement() {
    const candidates = Array.from(document.querySelectorAll('video'));
    if (candidates.length === 0) return null;
    return candidates.reduce((best, candidate) =>
      getVideoElementScore(candidate) > getVideoElementScore(best) ? candidate : best
    );
  }

  // --- Video element detection ---
  function startVideoObserver() {
    if (observer) return;
    let videoCheckTimer = null;
    observer = new MutationObserver(() => {
      if (videoCheckTimer) return;
      videoCheckTimer = setTimeout(() => {
        videoCheckTimer = null;
        const v = findBestVideoElement();
        if (v && v !== video) {
          if (WPSync.isAttached()) WPSync.detach();
          video = v;
          if (inRoom) {
            refreshActiveVideoLease({ force: true }).catch(() => {}); // This tab now owns sync
            attachSync();
            if (!isHost) schedulePeerVideoResync(v);
            if (shouldShareHostContent()) shareContentLink();
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
    const v = findBestVideoElement();
    if (v) {
      video = v;
      if (inRoom) {
        refreshActiveVideoLease({ force: true }).catch(() => {});
        attachSync();
        if (!isHost) schedulePeerVideoResync(v);
      }
    }
  }

  // --- Sync wiring ---
  function attachSync() {
    if (!video || WPSync.isAttached()) return;
    WPSync.attach(video, {
      isHost,
      onSync(state) {
        if (roomState && shouldShareHostContent()) {
          maybeRepairSharedPlayerRoute();
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
    const navHeading = document.querySelector('nav h2, main h1, h1[data-testid="title"]');
    if (navHeading?.textContent?.trim()) return navHeading.textContent.trim();
    const logoTitleEl = document.querySelector('[class*="logo"][title], [class*="logo-container"] img[title], img[class*="logo"][title]');
    if (logoTitleEl?.getAttribute?.('title')?.trim()) return logoTitleEl.getAttribute('title').trim();
    const logoImg = document.querySelector('[class*="logo-container"] img, img[class*="logo"]');
    if (logoImg?.alt?.trim()) return logoImg.alt.trim();
    return null;
  }

  // --- Overlay state refresh ---
  function refreshOverlay() {
    WPOverlay.updateState({ inRoom, isHost, userId, sessionId, roomState, hasVideo: !!video, wsConnected: WPWS.isConnected() });
    if (inRoom && !isHost) {
      WPOverlay.updateSyncIndicator(isHost, WPSync.getLastDrift());
    }
  }

  function getActiveVideoElement() {
    return video?.isConnected ? video : findBestVideoElement();
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
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'watchparty-ext') return;
    if (message.action === 'probe-surface') {
      sendResponse({ surface: 'stremio' });
      return true;
    }
    handleAction(message);
    return false;
  });

  // Action handler map — replaces monolithic switch for testability and clarity
  const actionHandlers = {
    'create-room': (m) => {
      if (WPWS.isReady()) {
        createRoomFromCommand(m).catch(() => { });
      } else if (extOk()) {
        stagePendingRoomCreateCommand({
          username: m.username,
          meta: m.meta,
          stream: m.stream,
          public: m.public,
          roomName: m.roomName,
          roomKey: m.roomKey,
        });
        WPWS.connect();
      } else {
        WPWS.connect();
      }
    },
    'join-room': (m) => {
      if (WPWS.isReady()) {
        joinRoomFromCommand(m).catch(() => { });
      } else if (extOk()) {
        stagePendingRoomJoinCommand({
          roomId: m.roomId,
          username: m.username,
          roomKey: m.roomKey,
          preferDirectJoin: m.preferDirectJoin === true,
        });
        WPWS.connect();
      } else {
        WPWS.connect();
      }
    },
    'open-sidebar': (m) => { WPOverlay.openSidebar(m.panel); },
    'leave-room': () => {
      clearTimeout(presenceTimeout);
      finalizeLeaveIntent({ sendLeave: true });
    },
    'toggle-public': async (m) => {
      if (m.public === false) {
        const roomId = roomState?.id;
        const requestedRoomKey = normalizeRoomKeyInput(m.roomKey);
        const existingRoomKey = await loadStoredRoomKey(roomId);
        const usersInRoom = Array.isArray(roomState?.users) ? roomState.users.length : 0;
        if (requestedRoomKey && existingRoomKey && requestedRoomKey !== existingRoomKey && usersInRoom > 1) {
          WPOverlay.showToast('Change the room key when you are alone in the room to avoid breaking private-room peers.', 3500);
          return;
        }
        let roomKey = requestedRoomKey || existingRoomKey;
        if (!roomKey) roomKey = await generatePrivateRoomKey();
        if (!roomKey) {
          WPOverlay.showToast('Failed to generate a private room key.', 2500);
          return;
        }
        await cacheRoomKeyForRoom(roomId, roomKey);
        if (typeof WPCrypto !== 'undefined') {
          try {
            WPCrypto.clear();
            await WPCrypto.importKey(roomKey);
          } catch { }
        }
        WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_PUBLIC, payload: { public: false, roomKey } });
        return;
      }
      await clearRoomKeyForRoom(roomState?.id);
      WPCrypto.clear();
      WPWS.send({ type: WPProtocol.C2S.ROOM_UPDATE_PUBLIC, payload: { public: true } });
    },
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
    'request-sync': () => { requestLatestHostSync(); },
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
  let lastPlaybackSecond = -1;
  const playbackInterval = setInterval(() => {
    if (!inRoom || !video || !isActiveVideoTab) {
      lastPlaybackStatus = '';
      lastPlaybackSecond = -1;
      return;
    }
    if (!chrome.runtime?.id) { clearInterval(playbackInterval); return; }
    const status = video.paused ? 'paused' : video.readyState < 3 ? 'buffering' : 'playing';
    const currentSecond = Number.isFinite(video.currentTime) ? Math.floor(Math.max(0, video.currentTime)) : 0;
    const statusChanged = status !== lastPlaybackStatus;
    const timeChanged = lastPlaybackSecond < 0 || Math.abs(currentSecond - lastPlaybackSecond) >= (status === 'playing' ? 3 : 1);
    if (!statusChanged && !timeChanged) return;
    lastPlaybackStatus = status;
    lastPlaybackSecond = currentSecond;
    WPWS.send({
      type: WPProtocol.C2S.USER_PLAYBACK_STATUS,
      payload: { status, time: Math.max(0, Number(video.currentTime) || 0) },
    });
  }, 3000);

  const hostShareInterval = setInterval(() => {
    updateKnownContentMeta();
    if (shouldShareHostContent()) {
      shareContentLink();
    }
  }, 4000);

  // --- Host stream update on SPA navigation (only from tab with video) ---
  window.addEventListener('hashchange', () => {
    updateKnownContentMeta();
    // Only the active video tab should update stream meta.
    if (shouldShareHostContent()) {
      shareContentLink();
    }
  });

  // --- Storage change listener for pending actions ---
  if (extOk()) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'session' && changes[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]) {
        if (!sessionId) return;
        if (WPWS.isReady()) { processPendingActions(); }
        else { WPWS.connect(); }
      }
      if (areaName === 'session' && changes[WPConstants.STORAGE.DEFERRED_LEAVE_ROOM]) {
        syncDeferredLeaveIntent(changes[WPConstants.STORAGE.DEFERRED_LEAVE_ROOM].newValue);
      }
      if (areaName === 'local' && changes[WPConstants.STORAGE.BACKEND_MODE]) {
        const nextMode = WPConstants.BACKEND.normalizeMode(changes[WPConstants.STORAGE.BACKEND_MODE].newValue);
        if (WPWS.setBackendMode(nextMode)) {
          WPWS.disconnect({ resetReplay: true });
          persistConnectionState();
          WPWS.connect();
        }
      }
      // Active video tab election — another tab claimed active status
      if (areaName === 'session' && changes[WPConstants.STORAGE.ACTIVE_VIDEO_TAB]) {
        const nextLease = changes[WPConstants.STORAGE.ACTIVE_VIDEO_TAB].newValue;
        isActiveVideoTab = WPConstants.VIDEO_TAB_LEASE.isOwner(nextLease, activeVideoLeaseId);
        if (!isActiveVideoTab && video && inRoom && WPConstants.VIDEO_TAB_LEASE.isExpired(nextLease)) {
          refreshActiveVideoLease({ force: true }).catch(() => {});
        }
      }
    });
  }

  // --- Cleanup ---
  window.addEventListener('beforeunload', () => {
    clearInterval(playbackInterval);
    clearInterval(hostShareInterval);
    if (activeVideoLeaseInterval) clearInterval(activeVideoLeaseInterval);
    releaseActiveTab();
    WPProfile.stop();
  });

  function init() {
    chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: 'surface-ready',
      surface: 'stremio',
    }).then((response) => {
      const nextTabId = Number.isInteger(response?.tabId) ? response.tabId : null;
      if (nextTabId == null || nextTabId === surfaceTabId) return;
      surfaceTabId = nextTabId;
      if (isActiveVideoTab || (inRoom && video)) {
        refreshActiveVideoLease({ force: true }).catch(() => {});
      }
    }).catch(() => {});
    chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: 'get-status',
    }).catch(() => {});
    WPOverlay.create();
    WPOverlay.initKeyboardShortcuts();
    WPOverlay.bindTypingIndicator(
      () => { if (inRoom) WPWS.send({ type: WPProtocol.C2S.ROOM_TYPING, payload: { typing: true } }); },
      () => { WPWS.send({ type: WPProtocol.C2S.ROOM_TYPING, payload: { typing: false } }); }
    );
    startVideoObserver();
    startActiveVideoLeaseHeartbeat();
    updateKnownContentMeta();
    WPProfile.start();

    // Generate or load persistent session ID (shared across all tabs via chrome.storage).
    // This lets the server identify all tabs as the same user — Twitch-style multi-tab.
    getExtensionState([
      WPConstants.STORAGE.SESSION_ID,
      WPConstants.STORAGE.BACKEND_MODE,
      WPConstants.STORAGE.ACTIVE_BACKEND,
      WPConstants.STORAGE.CURRENT_ROOM,
      WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT,
      WPConstants.STORAGE.DEFERRED_LEAVE_ROOM,
    ]).then((result) => {
      const storedSessionId = result[WPConstants.STORAGE.SESSION_ID];
      if (storedSessionId) {
        sessionId = storedSessionId;
      } else {
        sessionId = crypto.randomUUID();
        chrome.storage.local.set({ [WPConstants.STORAGE.SESSION_ID]: sessionId });
      }
      syncDeferredLeaveIntent(result[WPConstants.STORAGE.DEFERRED_LEAVE_ROOM]);
      const backendMode = WPConstants.BACKEND.normalizeMode(result[WPConstants.STORAGE.BACKEND_MODE]);
      const activeBackend = WPConstants.BACKEND.isKnownKey(result[WPConstants.STORAGE.ACTIVE_BACKEND])
        ? result[WPConstants.STORAGE.ACTIVE_BACKEND]
        : null;
      const bootstrapIntent = normalizeBootstrapRoomIntent(result[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]);
      if (!bootstrapIntent && result[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT] !== undefined) {
        clearBootstrapRoomIntent().catch(() => {});
      }
      const hasRoomBootstrap = !!result[WPConstants.STORAGE.CURRENT_ROOM]
        || !!bootstrapIntent;
      WPWS.setBackendMode(
        backendMode === WPConstants.BACKEND.MODES.AUTO && hasRoomBootstrap && activeBackend
          ? activeBackend
          : backendMode
      );
      persistConnectionState();
      // Every tab connects its own WS independently (like Twitch).
      // The server deduplicates by sessionId — multiple connections, one user.
      if (WPWS.isReady()) {
        processPendingActions();
      } else {
        WPWS.connect();
      }
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
