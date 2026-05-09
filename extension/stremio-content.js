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
  let sessionWsConnected = false;
  let prevPlayerTime = 0;
  let chatMessages = [];
  let chatHistoryForStorage = [];
  let activeChatHistoryRoomId = null;
  let hydratedChatHistoryRoomId = null;
  let observer = null;
  let typingUsers = new Map();
  let lastUserAction = null;

  let sessionId = null; // Persistent session ID — same across all tabs

  // --- Active video tab election (Spotify-style: only ONE tab syncs at a time) ---
  // When multiple tabs have video, only the most recent one sends sync/playback/stream messages.
  // Other tabs remain passive (chat/reactions still work).
  let isActiveVideoTab = false;
  let lastSharedContentKey = null;
  let pendingRoomCreateCommand = null;
  let pendingRoomJoinCommand = null;
  let pendingJoinOptions = null;
  let pendingCreatedPrivateKeys = null;
  let pendingVisibilityPrivateKeys = null;
  let pendingVisibilityPrivateKeyRoomId = null;
  let deferredLeaveIntent = null;
  let lastJoinAttemptRoomId = null;
  let shareContentLinkInFlight = false;
  let contentPublishTimer = null;
  let reconnectNoticeTimer = null;
  let reconnectNoticeShown = false;
  let surfaceTabId = null;
  let isControllerTab = false;
  let controllerLeaseInterval = null;
  let activeVideoLeaseInterval = null;
  let resumeRoomPending = false;
  let pendingIntentWakeTimer = null;
  const controllerLeaseId = crypto.randomUUID();
  const activeVideoLeaseId = crypto.randomUUID();
  const cinemetaTitleCache = new Map();
  const INITIAL_JOIN_HINT = WPRoomDomain.normalizeJoinHint(null);
  let controllerRuntimeState = WPControllerKernel.createInitialRuntimeState();
  let adapterRuntimeState = WPStremioRuntimeModel.createInitialAdapterRuntimeState(INITIAL_JOIN_HINT);

  const CHAT_HISTORY_LIMIT = 200;
  const PLACEHOLDER_ROOM_NAME = 'WatchParty Session';
  const PLACEHOLDER_STREAM_URL = 'https://watchparty.mertd.me/sync';

  function formatErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function buildControllerRuntimeSnapshot() {
    return WPControllerKernel.buildRuntimeSnapshot({
      surfaceTabId,
      sessionIdKnown: !!sessionId,
      wantsController: shouldOwnController(),
      isControllerTab,
      isActiveVideoTab,
      wsConnected: isControllerTab ? WPWS.isConnected() : sessionWsConnected,
      inRoom,
      hasVideo: !!video,
      resumeRoomPending,
      pendingCreate: !!pendingRoomCreateCommand,
      pendingJoin: !!pendingRoomJoinCommand,
      deferredLeave: !!deferredLeaveIntent,
      lastAction: lastUserAction || null,
    });
  }

  function syncControllerRuntimeState(eventType) {
    controllerRuntimeState = WPControllerKernel.reduceRuntimeState(
      controllerRuntimeState,
      eventType,
      buildControllerRuntimeSnapshot(),
    );
    return controllerRuntimeState;
  }

  function buildAdapterRuntimeSnapshot(overrides = {}) {
    const context = WPStremioAdapter.getCurrentContentContext();
    const launchUrl = overrides.launchUrl === undefined ? (context.launchUrl || null) : overrides.launchUrl;
    const publishedMatchesRoute = !!launchUrl && adapterRuntimeState.lastPublishedLaunchUrl === launchUrl;
    const nextJoinHint = overrides.joinHint !== undefined
      ? WPRoomDomain.normalizeJoinHint(overrides.joinHint)
      : (publishedMatchesRoute ? adapterRuntimeState.joinHint : INITIAL_JOIN_HINT);
    return WPStremioAdapter.buildRuntimeSnapshot({
      hasVideo: !!video,
      launchUrl,
      contentMeta: overrides.contentMeta === undefined ? (context.meta ? { ...context.meta } : null) : overrides.contentMeta,
      joinHint: nextJoinHint,
      lastPublishedShareKey: overrides.lastPublishedShareKey === undefined ? adapterRuntimeState.lastPublishedShareKey : overrides.lastPublishedShareKey,
      lastPublishedLaunchUrl: overrides.lastPublishedLaunchUrl === undefined ? adapterRuntimeState.lastPublishedLaunchUrl : overrides.lastPublishedLaunchUrl,
    });
  }

  function syncAdapterRuntimeState(eventType, overrides = {}) {
    adapterRuntimeState = WPStremioRuntimeModel.reduceAdapterRuntimeState(adapterRuntimeState, {
      type: eventType,
      at: WPRuntimeClock.now(),
      snapshot: buildAdapterRuntimeSnapshot(overrides),
    });
    return adapterRuntimeState;
  }

  function clearReconnectNotice(options = {}) {
    if (reconnectNoticeTimer) {
      WPRuntimeClock.clearTimeout(reconnectNoticeTimer);
      reconnectNoticeTimer = null;
    }
    if (options.preserveShown !== true) reconnectNoticeShown = false;
  }

  function scheduleReconnectNotice() {
    if (reconnectNoticeTimer || !inRoom) return;
    reconnectNoticeTimer = WPRuntimeClock.setTimeout(() => {
      reconnectNoticeTimer = null;
      if (!inRoom || WPWS.isConnected()) return;
      reconnectNoticeShown = true;
      WPOverlay.showToast('WatchParty disconnected. Trying to reconnect — the room may show as reconnecting until you are back online.', 5000);
      refreshOverlay();
    }, 2500);
  }

  function sendBackgroundMessage(message) {
    if (!extOk()) return Promise.resolve(null);
    return chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      ...message,
    }).catch(() => null);
  }

  function claimActiveTab() {
    const lease = WPConstants.VIDEO_TAB_LEASE.build({
      leaseId: activeVideoLeaseId,
      tabId: surfaceTabId,
      sessionId,
    });
    if (!lease) return Promise.resolve(false);
    return sendBackgroundMessage({
      action: WPConstants.ACTION.ACTIVE_VIDEO_LEASE_CLAIM,
      lease,
    }).then((response) => {
      isActiveVideoTab = response?.claimed === true;
      syncControllerRuntimeState('video-lease.claim');
      return isActiveVideoTab;
    });
  }

  function releaseActiveTab() {
    if (!extOk()) return Promise.resolve(false);
    isActiveVideoTab = false;
    syncControllerRuntimeState('video-lease.release');
    return sendBackgroundMessage({
      action: WPConstants.ACTION.ACTIVE_VIDEO_LEASE_RELEASE,
      leaseId: activeVideoLeaseId,
    }).then((response) => response?.released === true);
  }

  function refreshActiveVideoLease(options = {}) {
    if (!extOk() || !video || !inRoom) return Promise.resolve(false);
    const lease = WPConstants.VIDEO_TAB_LEASE.build({
      leaseId: activeVideoLeaseId,
      tabId: surfaceTabId,
      sessionId,
    });
    if (!lease) return Promise.resolve(false);
    return sendBackgroundMessage({
      action: WPConstants.ACTION.ACTIVE_VIDEO_LEASE_CLAIM,
      lease,
      force: options.force === true,
    }).then((response) => {
      isActiveVideoTab = response?.claimed === true;
      syncControllerRuntimeState('video-lease.refresh');
      if (isActiveVideoTab && video && inRoom && shouldShareHostContent()) {
        scheduleContentPublish(100);
      }
      return isActiveVideoTab;
    });
  }

  function startActiveVideoLeaseHeartbeat() {
    if (activeVideoLeaseInterval) return;
    activeVideoLeaseInterval = WPRuntimeClock.setInterval(() => {
      if (!extOk()) {
        WPRuntimeClock.clearInterval(activeVideoLeaseInterval);
        activeVideoLeaseInterval = null;
        return;
      }
      refreshActiveVideoLease().then((claimed) => {
        if (!claimed || !video || !inRoom) return;
        if (!WPSync.isAttached()) attachSync();
      }).catch(() => {});
    }, WPConstants.VIDEO_TAB_LEASE.RENEW_INTERVAL_MS);
  }

  function shouldOwnController() {
    return !!sessionId && (
      resumeRoomPending
      || !!pendingRoomCreateCommand
      || !!pendingRoomJoinCommand
      || !!deferredLeaveIntent
      || !!roomState?.id
      || inRoom
      || WPWS.isConnected()
      || (!!video && isActiveVideoTab)
    );
  }

  function scheduleContentPublish(delayMs = 0) {
    if (contentPublishTimer) WPRuntimeClock.clearTimeout(contentPublishTimer);
    contentPublishTimer = WPRuntimeClock.setTimeout(() => {
      contentPublishTimer = null;
      if (shouldShareHostContent()) shareContentLink();
    }, delayMs);
  }

  function schedulePendingIntentWake() {
    if (pendingIntentWakeTimer || !extOk()) return;
    pendingIntentWakeTimer = WPRuntimeClock.setTimeout(() => {
      pendingIntentWakeTimer = null;
      if (!sessionId) {
        schedulePendingIntentWake();
        return;
      }
      refreshControllerLease().then((claimed) => {
        if (!claimed) return;
        if (WPWS.isReady()) processPendingActions();
        else ensureControllerConnection();
      }).catch(() => {});
    }, 250);
  }

  function claimControllerTab() {
    const lease = WPConstants.CONTROLLER_TAB_LEASE.build({
      leaseId: controllerLeaseId,
      tabId: surfaceTabId,
      sessionId,
    });
    if (!lease) return Promise.resolve(false);
    return sendBackgroundMessage({
      action: WPConstants.ACTION.CONTROLLER_LEASE_CLAIM,
      lease,
    }).then((response) => {
      isControllerTab = response?.claimed === true;
      syncControllerRuntimeState('controller-lease.claim');
      return isControllerTab;
    });
  }

  function publishControllerRelease() {
    sessionWsConnected = false;
    syncControllerRuntimeState('controller.release.publish');
    syncAdapterRuntimeState('controller.release.publish');
    if (!extOk()) return;
    notifyBackground({
      action: WPConstants.ACTION.CONTROLLER_RELEASED,
      payload: {
        room: buildProjectedRoomState(roomState),
        userId,
        sessionId,
        controllerRuntime: cloneRuntimeStateSnapshot(controllerRuntimeState),
        adapterState: cloneRuntimeStateSnapshot(adapterRuntimeState),
      },
    });
  }

  function disconnectControllerSocket(options = {}) {
    if (!WPWS.isConnected() && options.force !== true) return;
    WPWS.disconnect();
    WPSync.detach();
    sessionWsConnected = false;
    syncControllerRuntimeState('controller-socket.disconnect');
    refreshOverlay();
  }

  function releaseControllerTab() {
    if (!extOk()) return Promise.resolve(false);
    const wasController = isControllerTab;
    if (wasController) publishControllerRelease();
    isControllerTab = false;
    syncControllerRuntimeState('controller-lease.release');
    if (wasController) disconnectControllerSocket();
    return sendBackgroundMessage({
      action: WPConstants.ACTION.CONTROLLER_LEASE_RELEASE,
      leaseId: controllerLeaseId,
    }).then((response) => response?.released === true);
  }

  function ensureControllerConnection() {
    if (!isControllerTab || WPWS.isConnected()) return;
    WPWS.connect();
  }

  function refreshControllerLease(options = {}) {
    if (!extOk() || !sessionId) return Promise.resolve(false);
    if (!shouldOwnController()) {
      if (isControllerTab) {
        return releaseControllerTab().then(() => false);
      }
      return Promise.resolve(false);
    }
    const lease = WPConstants.CONTROLLER_TAB_LEASE.build({
      leaseId: controllerLeaseId,
      tabId: surfaceTabId,
      sessionId,
    });
    if (!lease) return Promise.resolve(false);
    return sendBackgroundMessage({
      action: WPConstants.ACTION.CONTROLLER_LEASE_CLAIM,
      lease,
      force: options.force === true,
    }).then((response) => {
      isControllerTab = response?.claimed === true;
      syncControllerRuntimeState('controller-lease.refresh');
      if (isControllerTab) {
        ensureControllerConnection();
        if (video && inRoom && shouldShareHostContent()) {
          scheduleContentPublish(100);
        }
      }
      return isControllerTab;
    });
  }

  function startControllerLeaseHeartbeat() {
    if (controllerLeaseInterval) return;
    controllerLeaseInterval = WPRuntimeClock.setInterval(() => {
      if (!extOk()) {
        WPRuntimeClock.clearInterval(controllerLeaseInterval);
        controllerLeaseInterval = null;
        return;
      }
      refreshControllerLease({ force: !!video && inRoom && isActiveVideoTab }).catch(() => {});
    }, WPConstants.CONTROLLER_TAB_LEASE.RENEW_INTERVAL_MS);
  }

  // --- Extension context guard (WS survives extension reloads, but chrome APIs don't) ---
  function extOk() { return !!chrome.runtime?.id; }

  function getExtensionState(keys) {
    if (!extOk()) return Promise.resolve({});
    return WPRuntimeState.get(keys);
  }

  function setExtensionState(values) {
    if (!extOk()) return Promise.resolve();
    return WPRuntimeState.set(values);
  }

  function removeExtensionState(keys) {
    if (!extOk()) return Promise.resolve();
    return WPRuntimeState.remove(keys);
  }

  function chatMessageKey(message) {
    if (!message || typeof message !== 'object') return '';
    if (typeof message.id === 'string' && message.id) return `id:${message.id}`;
    return [
      'fallback',
      message.date || '',
      message.sessionId || '',
      message.user || '',
      message.content || '',
    ].join(':');
  }

  function rememberChatMessage(message) {
    const key = chatMessageKey(message);
    if (key && chatMessages.some((entry) => chatMessageKey(entry) === key)) return false;
    chatMessages.push(message);
    if (chatMessages.length > CHAT_HISTORY_LIMIT) chatMessages.shift();
    return true;
  }

  function rememberStoredChatMessage(message) {
    const key = chatMessageKey(message);
    if (key && chatHistoryForStorage.some((entry) => chatMessageKey(entry) === key)) return;
    chatHistoryForStorage.push(message);
    if (chatHistoryForStorage.length > CHAT_HISTORY_LIMIT) chatHistoryForStorage.shift();
  }

  function persistStoredChatHistory(roomId = roomState?.id) {
    if (!extOk() || !roomId) return Promise.resolve();
    const storageKey = WPConstants.STORAGE.roomChatHistory(roomId);
    return setExtensionState({
      [storageKey]: chatHistoryForStorage.slice(-CHAT_HISTORY_LIMIT),
    });
  }

  async function loadStoredChatHistory(roomId) {
    if (!extOk() || !roomId) return [];
    const storageKey = WPConstants.STORAGE.roomChatHistory(roomId);
    const stored = await getExtensionState(storageKey).catch(() => ({}));
    return normalizeStoredChatHistory(stored[storageKey]);
  }

  function normalizeStoredChatHistory(value) {
    return Array.isArray(value)
      ? value.filter((message) => message && typeof message.content === 'string').slice(-CHAT_HISTORY_LIMIT)
      : [];
  }

  async function applyStoredChatHistory(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    chatHistoryForStorage = messages.slice(-CHAT_HISTORY_LIMIT);
    for (const message of messages) {
      await onChatMessage(message, { incrementUnread: false, persist: false, relay: false });
    }
  }

  async function hydrateStoredChatHistory(roomId) {
    if (!roomId || hydratedChatHistoryRoomId === roomId) return;
    hydratedChatHistoryRoomId = roomId;
    const messages = await loadStoredChatHistory(roomId);
    await applyStoredChatHistory(messages);
  }

  function ensureChatHistoryRoom(roomId) {
    const nextRoomId = roomId || null;
    if (activeChatHistoryRoomId === nextRoomId) return;
    activeChatHistoryRoomId = nextRoomId;
    hydratedChatHistoryRoomId = null;
    chatMessages = [];
    chatHistoryForStorage = [];
    WPOverlay.clearChatMessages?.();
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
    resumeRoomPending = !!pendingRoomCreateCommand;
    syncControllerRuntimeState('pending-intent.create');
  }

  function stagePendingRoomJoinCommand(command) {
    pendingRoomJoinCommand = command ? { ...command } : null;
    pendingRoomCreateCommand = null;
    resumeRoomPending = !!pendingRoomJoinCommand;
    syncControllerRuntimeState('pending-intent.join');
  }

  function cachePrivateKeysForRoom(roomId, keys = {}) {
    if (!extOk()) return Promise.resolve();
    return WPRoomKeys.setKeys(roomId, keys);
  }

  function clearPrivateKeysForRoom(roomId) {
    if (!extOk()) return Promise.resolve();
    return WPRoomKeys.remove(roomId);
  }

  function loadStoredAccessKey(roomId) {
    if (!extOk()) return Promise.resolve(null);
    return WPRoomKeys.getAccessKey(roomId);
  }

  function loadStoredInviteAccessToken(roomId) {
    if (!extOk()) return Promise.resolve(null);
    return WPRoomKeys.getInviteAccessToken(roomId);
  }

  async function buildRoomAccessPayload(roomId, accessKey) {
    const inviteAccessToken = await loadStoredInviteAccessToken(roomId);
    return {
      id: roomId,
      accessKey: accessKey || undefined,
      inviteAccessToken: inviteAccessToken || undefined,
    };
  }

  async function resolvePrivateInviteKeys(command = {}) {
    return WPPrivateRoomKeys.resolveCreateKeys(command);
  }

  function normalizePrivateKeyInput(value) {
    return WPPrivateRoomKeys.normalize(value);
  }

  function normalizeUsername(value) {
    const username = typeof value === 'string' ? value.trim() : '';
    return username && username.length <= WPProtocol.LIMITS.USERNAME_MAX ? username : null;
  }

  function resolveKnownUsername(...candidates) {
    for (const candidate of candidates) {
      const username = normalizeUsername(candidate);
      if (username) return username;
    }
    const currentUser = roomState?.users?.find((user) => {
      if (user.id === userId) return true;
      return !!(sessionId && user.sessionId && user.sessionId === sessionId);
    });
    return normalizeUsername(currentUser?.name);
  }

  function sendSessionHello(usernameCandidate) {
    const username = resolveKnownUsername(usernameCandidate);
    if (!username || !sessionId) return false;
    WPWS.send({ type: WPProtocol.COMMAND.SESSION_HELLO, payload: { username, sessionId } });
    return true;
  }

  function normalizeDeferredLeaveIntent(value) {
    if (!value || typeof value !== 'object') return null;
    const roomId = typeof value.roomId === 'string' ? value.roomId.trim() : '';
    if (!roomId) return null;
    const requestedAt = Number(value.requestedAt);
    return {
      roomId,
      requestedAt: Number.isFinite(requestedAt) && requestedAt > 0 ? requestedAt : WPRuntimeClock.now(),
    };
  }

  function syncDeferredLeaveIntent(value) {
    deferredLeaveIntent = normalizeDeferredLeaveIntent(value);
    if (deferredLeaveIntent) resumeRoomPending = true;
    syncControllerRuntimeState('deferred-leave.sync');
    return deferredLeaveIntent;
  }

  function rememberDeferredLeaveIntent(roomId) {
    const normalizedRoomId = typeof roomId === 'string' ? roomId.trim() : '';
    if (!normalizedRoomId) return null;
    const nextIntent = {
      roomId: normalizedRoomId,
      requestedAt: WPRuntimeClock.now(),
    };
    deferredLeaveIntent = nextIntent;
    resumeRoomPending = true;
    syncControllerRuntimeState('deferred-leave.remember');
    if (extOk()) {
      setExtensionState({ [WPConstants.STORAGE.DEFERRED_LEAVE_ROOM]: nextIntent }).catch(() => { });
    }
    return nextIntent;
  }

  function clearDeferredLeaveIntent(roomId) {
    if (roomId && deferredLeaveIntent?.roomId && deferredLeaveIntent.roomId !== roomId) return;
    deferredLeaveIntent = null;
    resumeRoomPending = !!roomState?.id || !!pendingRoomCreateCommand || !!pendingRoomJoinCommand;
    syncControllerRuntimeState('deferred-leave.clear');
    if (!extOk()) return;
    removeExtensionState(WPConstants.STORAGE.DEFERRED_LEAVE_ROOM).catch(() => { });
  }

  function applyLocalLeaveState(leavingRoomId) {
    clearReconnectNotice();
    clearPendingJoinOptions();
    inRoom = false;
    roomState = null;
    isHost = false;
    resumeRoomPending = false;
    syncControllerRuntimeState('room.leave.local');
    releaseActiveTab();
    WPSync.detach();
    WPCrypto.clear();
    document.getElementById('wp-catchup-btn')?.remove();
    refreshOverlay();
    persistState();
    if (!extOk()) return;
    removeExtensionState(WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT).catch(() => { });
    if (leavingRoomId) {
      WPRoomKeys.remove(leavingRoomId).catch(() => {});
    }
  }

  function finalizeLeaveIntent(options = {}) {
    const leavingRoomId = options.roomId || roomState?.id || deferredLeaveIntent?.roomId;
    if (!leavingRoomId) return;
    if (options.sendLeave && inRoom && WPWS.isReady() && WPWS.isApplicationReady()) {
      clearDeferredLeaveIntent(leavingRoomId);
      WPWS.send({ type: WPProtocol.COMMAND.ROOM_LEAVE, payload: {} });
    } else {
      rememberDeferredLeaveIntent(leavingRoomId);
      if (!WPWS.isConnected()) {
        ensureControllerConnection();
      }
    }
    applyLocalLeaveState(leavingRoomId);
  }

  async function drainDeferredLeaveIntent() {
    if (!deferredLeaveIntent?.roomId || !WPWS.isReady()) return false;
    const roomId = deferredLeaveIntent.roomId;
    const stored = await getExtensionState(WPConstants.STORAGE.USERNAME).catch(() => ({}));
    const username = stored?.[WPConstants.STORAGE.USERNAME];
    sendSessionHello(username);
    const accessKey = await loadStoredAccessKey(roomId);
    const payload = await buildRoomAccessPayload(roomId, accessKey);
    lastJoinAttemptRoomId = roomId;
    WPWS.send({
      type: WPProtocol.COMMAND.ROOM_JOIN,
      payload,
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

  async function normalizeSharedStreamPayload(stream) {
    const fallbackStream = stream && typeof stream === 'object' ? { ...stream } : {};
    try {
      const normalizedStream = await withTimeout(
        () => WPDirectPlay.normalizeSharedStream(stream),
        1500,
      );
      const finalStream = normalizedStream && typeof normalizedStream === 'object'
        ? normalizedStream
        : fallbackStream;
      return {
        stream: finalStream,
        joinHint: WPDirectPlay.buildJoinHint(finalStream),
      };
    } catch (error) {
      console.warn('[WatchParty] Failed to normalize shared stream payload:', formatErrorMessage(error));
      return {
        stream: fallbackStream,
        joinHint: WPDirectPlay.buildJoinHint(fallbackStream),
      };
    }
  }

  function shouldShareHostContent() {
    return inRoom && isControllerTab && isActiveVideoTab && amIHost();
  }

  function requestLatestHostSync() {
    if (!inRoom || isHost || !isActiveVideoTab || !WPWS.isReady()) return;
    WPWS.send({ type: WPProtocol.COMMAND.ROOM_PLAYBACK_PUBLISH, payload: roomState?.player || WPProtocol.DEFAULT_PLAYER });
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
        WPRuntimeClock.clearTimeout(fallbackTimer);
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
    fallbackTimer = WPRuntimeClock.setTimeout(handleReady, 2500);
    syncPeerVideoToRoom({ requestFresh: true });
  }

  function maybeRepairSharedPlayerRoute() {
    if (!shouldShareHostContent()) return;
    const hash = window.location.hash || '';
    if (!hash.startsWith('#/player/')) return;
    const currentLaunchUrl = WPStremioAdapter.getCurrentLaunchUrl(hash);
    if (!currentLaunchUrl || roomState?.stream?.url === currentLaunchUrl) return;
    scheduleContentPublish(0);
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
          timer = WPRuntimeClock.setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) WPRuntimeClock.clearTimeout(timer);
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
    if (!extOk() || !isControllerTab) return;
    sessionWsConnected = WPWS.isConnected();
    syncControllerRuntimeState('persist.state');
    publishSessionState();
  }

  function persistConnectionState() {
    if (!extOk() || !isControllerTab) return;
    sessionWsConnected = WPWS.isConnected();
    syncControllerRuntimeState('persist.connection');
    publishSessionState();
  }

  function notifyBackground(data) {
    if (!extOk()) return;
    try {
      chrome.runtime.sendMessage({ type: 'watchparty-ext', ...data }).catch(() => { });
    } catch { /* context invalidated */ }
  }

  function cloneRoomSnapshot(room) {
    return WPControllerKernel.cloneRoomSnapshot(room);
  }

  function buildProjectedRoomState(room) {
    const snapshot = cloneRoomSnapshot(room);
    if (!snapshot) return null;
    snapshot.joinHint = WPRoomDomain.normalizeJoinHint(snapshot.joinHint);
    snapshot.hasDirectJoin = WPRoomDomain.hasDirectJoinFromJoinHint(snapshot.joinHint);
    snapshot.directJoinType = snapshot.joinHint?.directJoinType || null;
    delete snapshot.messages;
    return snapshot;
  }

  function cloneRuntimeStateSnapshot(value) {
    if (!value || typeof value !== 'object') return null;
    return JSON.parse(JSON.stringify(value));
  }

  async function applyConfirmedPrivateKeyUpdate(roomId, nextPublic) {
    if (!roomId) return;
    if (nextPublic) {
      pendingVisibilityPrivateKeys = null;
      pendingVisibilityPrivateKeyRoomId = null;
      await clearPrivateKeysForRoom(roomId);
      WPCrypto.clear();
      return;
    }
    if (!pendingVisibilityPrivateKeys || pendingVisibilityPrivateKeyRoomId !== roomId) return;
    await cachePrivateKeysForRoom(roomId, pendingVisibilityPrivateKeys);
    if (pendingVisibilityPrivateKeys.e2eKey && typeof WPCrypto !== 'undefined') {
      try {
        WPCrypto.clear();
        await WPCrypto.importKey(pendingVisibilityPrivateKeys.e2eKey);
      } catch { /* ignore import failures for local recovery */ }
    }
    pendingVisibilityPrivateKeys = null;
    pendingVisibilityPrivateKeyRoomId = null;
  }

  function publishSessionState() {
    if (!isControllerTab) return;
    syncControllerRuntimeState('publish.session-state');
    syncAdapterRuntimeState('publish.session-state');
    notifyBackground({
      action: WPConstants.ACTION.SESSION_STATE_PUBLISH,
      payload: {
        room: buildProjectedRoomState(roomState),
        userId,
        sessionId,
        wsConnected: WPWS.isConnected(),
        activeBackend: WPWS.getActiveBackend(),
        activeBackendUrl: WPWS.getActiveWsUrl(),
        controllerRuntime: cloneRuntimeStateSnapshot(controllerRuntimeState),
        adapterState: cloneRuntimeStateSnapshot(adapterRuntimeState),
      },
    });
  }

  function commitRoomState(nextRoom, options = {}) {
    if (!nextRoom?.id) return false;
    roomState = nextRoom;
    resumeRoomPending = true;
    lastJoinAttemptRoomId = null;
    syncControllerRuntimeState(`room.${options.lifecycle || 'sync'}`);
    if (pendingCreatedPrivateKeys && roomState.id) {
      cachePrivateKeysForRoom(roomState.id, pendingCreatedPrivateKeys);
      pendingCreatedPrivateKeys = null;
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
    const reduced = WPControllerKernel.reduceRoomState(roomState, {
      type: WPProtocol.EVENT.ROOM_SNAPSHOT,
      payload: nextRoom,
    });
    if (!reduced.changed || !reduced.room) return false;
    prevPlayerTime = reduced.previousPlayerTime || 0;
    return commitRoomState(reduced.room, { lifecycle: options.lifecycle || 'sync' });
  }

  function applyRoomStateDelta(mutator, options = {}) {
    if (!roomState) return false;
    const nextRoom = cloneRoomSnapshot(roomState);
    if (!nextRoom) return false;
    mutator(nextRoom);
    return commitRoomState(nextRoom, options);
  }

  function applyReducedRoomEvent(type, payload, options = {}) {
    const reduced = WPControllerKernel.reduceRoomState(roomState, { type, payload }, {
      userId,
      sessionId,
    });
    if (!reduced.changed || !reduced.room) return false;
    if (
      type === WPProtocol.EVENT.ROOM_PLAYBACK_UPDATED
      || type === WPProtocol.EVENT.ROOM_CONTENT_UPDATED
    ) {
      prevPlayerTime = reduced.previousPlayerTime || 0;
    }
    const committed = commitRoomState(reduced.room, options);
    if (!committed) return false;
    for (const effect of reduced.effects || []) {
      if (effect.type === 'room-key-visibility-confirmed') {
        applyConfirmedPrivateKeyUpdate(effect.roomId, effect.public).catch(() => {});
      }
    }
    return true;
  }

  // --- WS callbacks ---
  WPWS.onConnect(() => {
    if (!isControllerTab) return;
    const shouldAnnounceReconnect = reconnectNoticeShown;
    clearReconnectNotice();
    persistConnectionState();
    syncControllerRuntimeState('ws.connected');
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
      loadCryptoKeyForRoom(roomState.id).then(async () => {
        sendSessionHello(stored[WPConstants.STORAGE.USERNAME]);
        const accessKey = await loadStoredAccessKey(roomState.id);
        const payload = await buildRoomAccessPayload(roomState.id, accessKey);
        const seq = WPWS.getLastSeq();
        lastJoinAttemptRoomId = roomState.id;
        if (seq > 0) {
          WPWS.send({ type: WPProtocol.COMMAND.ROOM_REJOIN, payload: { ...payload, lastSeq: seq } });
        } else {
          WPWS.send({ type: WPProtocol.COMMAND.ROOM_JOIN, payload });
        }
      });
    });
  });

  WPWS.onDisconnect(() => {
    if (!isControllerTab) return;
    scheduleReconnectNotice();
    persistConnectionState();
    syncControllerRuntimeState('ws.disconnected');
    refreshOverlay();
  });

  function processWsEvent(msg) {
    if (!msg || !msg.type) return;
    const p = msg.payload;

    switch (msg.type) {
      case WPProtocol.EVENT.SESSION_READY:
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

      case WPProtocol.EVENT.ROOM_SNAPSHOT:
        if (!p?.id) return;
        if (p.inviteAccessToken && extOk()) {
          WPRoomKeys.setInviteAccessToken(p.id, p.inviteAccessToken).catch(() => {});
        }
        delete p.inviteAccessToken;
        if (shouldDrainDeferredLeave(p)) {
          lastJoinAttemptRoomId = null;
          clearDeferredLeaveIntent(p.id);
          WPWS.send({ type: WPProtocol.COMMAND.ROOM_LEAVE, payload: {} });
          applyLocalLeaveState(p.id);
          WPWS.clearQueue();
          WPWS.markApplicationReady();
          return;
        }
        adoptRoomSnapshot(p, {
          lifecycle: (!inRoom || !roomState?.id || roomState.id !== p.id) ? 'joined' : 'sync',
        });
        WPWS.markApplicationReady();
        break;

      case WPProtocol.EVENT.ROOM_CHAT_APPENDED:
        if (!p) return;
        onChatMessage(p);
        break;

      case WPProtocol.EVENT.ROOM_CHAT_HISTORY:
        if (!p?.messages) return;
        // Load persisted chat history (on join/rejoin)
        for (const msg of p.messages) {
          onChatMessage(msg);
        }
        break;

      case WPProtocol.EVENT.SESSION_USER_UPDATED:
        if (!p?.user?.id) return;
        userId = p.user.id;
        persistState();
        break;

      case WPProtocol.EVENT.ROOM_ERROR:
        notifyBackground({ action: WPConstants.ACTION.ROOM_ERROR_EVENT, payload: p });
        if (deferredLeaveIntent?.roomId && lastJoinAttemptRoomId === deferredLeaveIntent.roomId) {
          clearDeferredLeaveIntent(deferredLeaveIntent.roomId);
        }
        if (p?.code === WPProtocol.ERROR_CODE.ROOM_NOT_FOUND) {
          const wasInRoom = inRoom;
          clearPendingJoinOptions();
          inRoom = false; roomState = null;
          WPSync.detach();
          WPWS.clearQueue();
          WPWS.markApplicationReady();
          if (extOk()) removeExtensionState(WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT).catch(() => {});
          refreshOverlay();
          persistState();
          if (wasInRoom || p?.code === WPProtocol.ERROR_CODE.ROOM_NOT_FOUND) {
            WPOverlay.showToast('Room no longer exists', 3000);
          }
        }
        if (p?.code === WPProtocol.ERROR_CODE.INVALID_ROOM_KEY && lastJoinAttemptRoomId) {
          clearPrivateKeysForRoom(lastJoinAttemptRoomId);
        }
        if (
          p?.code === WPProtocol.ERROR_CODE.INVALID_ROOM_KEY
          || p?.code === WPProtocol.ERROR_CODE.ROOM_KEY_REQUIRED
          || p?.code === WPProtocol.ERROR_CODE.USERNAME_IN_USE
        ) {
          clearPendingJoinOptions();
          WPWS.clearQueue();
          WPWS.markApplicationReady();
        }
        // Show error feedback for non-room errors
        if (p?.code !== WPProtocol.ERROR_CODE.ROOM_NOT_FOUND && p?.message) {
          if (p.code === WPProtocol.ERROR_CODE.COOLDOWN && lastUserAction === WPConstants.ACTION.ROOM_CHAT_SEND) {
            WPOverlay.showToast('Slow down! Wait a moment before sending again.', 2000);
          } else if (p.code === WPProtocol.ERROR_CODE.NOT_OWNER) {
            WPOverlay.showToast('Only the host can do that.', 2000);
          } else if (p.code === WPProtocol.ERROR_CODE.ROOM_KEY_REQUIRED) {
            WPOverlay.showToast('This private room requires an access key.', 2500);
          } else if (p.code === WPProtocol.ERROR_CODE.INVALID_ROOM_KEY) {
            WPOverlay.showToast('Access key is invalid. Check the invite link or try again.', 3000);
          } else if (p.code === WPProtocol.ERROR_CODE.USERNAME_IN_USE) {
            WPOverlay.showToast('That display name is already in use in this room.', 3000);
          } else if (p.code !== WPProtocol.ERROR_CODE.COOLDOWN && p.code !== WPProtocol.ERROR_CODE.VALIDATION_FAILED) {
            WPOverlay.showToast(p.message, 2000);
          }
        }
        break;

      case WPProtocol.EVENT.ROOM_TYPING_UPDATED:
        if (!p?.user) return;
        onTyping(p.user, p.typing);
        break;

      case WPProtocol.EVENT.ROOM_REACTION_APPENDED:
        if (!p?.user || !p?.emoji) return;
        WPOverlay.showReaction(p.user, p.emoji, roomState, p.messageId || null);
        notifyBackground({ action: WPConstants.ACTION.ROOM_REACTION_EVENT, payload: p });
        break;

      case WPProtocol.EVENT.ROOM_PLAYBACK_AUTOPAUSED:
        if (!p?.name) return;
        WPOverlay.showToast(`Paused \u2014 ${p.name} disconnected`);
        break;

      case WPProtocol.EVENT.ROOM_READY_CHECK_UPDATED:
        applyReducedRoomEvent(msg.type, p);
        WPOverlay.showReadyCheck(p.action, p.confirmed, p.total, userId);
        break;

      case WPProtocol.EVENT.ROOM_READY_CHECK_COUNTDOWN:
        WPOverlay.showCountdown(p.seconds);
        break;

      case WPProtocol.EVENT.ROOM_BOOKMARK_APPENDED:
        if (!p) return;
        applyReducedRoomEvent(msg.type, p);
        WPOverlay.appendBookmark(p);
        notifyBackground({ action: WPConstants.ACTION.ROOM_BOOKMARK_EVENT, payload: p });
        break;

      // --- Delta events (lightweight, avoid full room broadcasts) ---

      case WPProtocol.EVENT.ROOM_PLAYBACK_UPDATED:
        if (!p?.player || !roomState) return;
        applyReducedRoomEvent(msg.type, p, { lifecycle: 'sync' });
        break;

      case WPProtocol.EVENT.ROOM_MEMBER_PRESENCE_UPDATED:
        if (!p?.userId || !roomState?.users) return;
        applyReducedRoomEvent(msg.type, p);
        break;

      case WPProtocol.EVENT.ROOM_MEMBER_PLAYBACK_STATUS_UPDATED:
        if (!p?.userId || !roomState?.users) return;
        applyReducedRoomEvent(msg.type, p);
        break;

      case WPProtocol.EVENT.ROOM_SETTINGS_UPDATED:
        if (!p?.settings || !roomState) return;
        applyReducedRoomEvent(msg.type, p);
        break;

      case WPProtocol.EVENT.ROOM_OWNERSHIP_UPDATED:
        if (!p?.owner || !roomState) return;
        applyReducedRoomEvent(msg.type, p, { lifecycle: 'sync' });
        break;

      case WPProtocol.EVENT.ROOM_VISIBILITY_UPDATED:
        if (typeof p?.public !== 'boolean' || !p?.visibility || !roomState) return;
        applyReducedRoomEvent(msg.type, p);
        break;

      case WPProtocol.EVENT.ROOM_CONTENT_UPDATED:
        if (!p?.stream || !p?.player || !roomState) return;
        applyReducedRoomEvent(msg.type, p, { lifecycle: 'sync' });
        break;

      case WPProtocol.EVENT.ROOM_MEMBER_UPSERTED:
        if (!p?.user || !roomState) return;
        applyReducedRoomEvent(msg.type, p);
        break;

      case WPProtocol.EVENT.ROOM_MEMBER_REMOVED:
        if (!p?.userId || !roomState) return;
        applyReducedRoomEvent(msg.type, p);
        break;
    }
  }

  // Wire up: active tab processes WS events and broadcasts to passive tabs
  WPWS.onMessage((msg) => {
    if (!isControllerTab) return;
    processWsEvent(msg);
  });

  // --- Process pending create/join actions from storage ---
  async function createRoomFromCommand(command) {
    if (!isControllerTab) return;
    try {
      clearPendingJoinOptions();
      if (inRoom) {
        WPWS.send({ type: WPProtocol.COMMAND.ROOM_LEAVE, payload: {} });
        inRoom = false; roomState = null; isHost = false;
      }
      sendSessionHello(command?.username);
      const context = WPStremioAdapter.getCurrentContentContext();
      const seedMeta = (isPlaceholderMeta(command?.meta) && context.meta) ? context.meta : command?.meta;
      const meta = await enrichContentMeta(seedMeta, context.launchUrl);
      const rawStream = (isPlaceholderStream(command?.stream) && context.launchUrl)
        ? { url: context.launchUrl }
        : command?.stream;
      const { stream, joinHint } = await normalizeSharedStreamPayload(rawStream);
      const isPublic = command?.public === true;
      const isListed = command?.listed !== false;
      const payload = {
        meta,
        stream,
        joinHint,
        public: isPublic,
        listed: isListed,
        visibility: WPRoomDomain.visibilityFromPublic(isPublic),
      };
      if (payload.public === false) {
        pendingCreatedPrivateKeys = await resolvePrivateInviteKeys(command);
        if (!pendingCreatedPrivateKeys) {
          WPOverlay.showToast('Failed to generate a private access key.', 2500);
          return;
        }
        payload.accessKey = pendingCreatedPrivateKeys.accessKey;
      } else {
        pendingCreatedPrivateKeys = null;
        WPCrypto.clear();
      }
      if (command?.roomName) payload.name = command.roomName;
      WPWS.send({ type: WPProtocol.COMMAND.ROOM_CREATE, payload });
    } catch (error) {
      console.warn('[WatchParty] Failed to create room from command:', formatErrorMessage(error));
      WPOverlay.showToast('Failed to create the room from this Stremio page.', 3000);
    }
  }

  async function joinRoomFromCommand(command, stored = {}) {
    if (!isControllerTab) return;
    const roomToJoin = command?.roomId;
    if (!roomToJoin || !extOk() || !WPWS.isReady()) return;
    const joinOptions = command?.preferDirectJoin === true
      ? { roomId: roomToJoin, preferDirectJoin: true }
      : null;
    syncPendingJoinOptions(joinOptions, roomToJoin);

    const accessKey = normalizePrivateKeyInput(command?.accessKey) || await loadStoredAccessKey(roomToJoin);
    const requestedE2eKey = normalizePrivateKeyInput(command?.e2eKey);
    const e2eKey = requestedE2eKey || (extOk() ? await WPRoomKeys.getE2eKey(roomToJoin) : null);
    if (accessKey || e2eKey) {
      await cachePrivateKeysForRoom(roomToJoin, { accessKey, e2eKey });
    }
    if (e2eKey && !WPCrypto.isEnabled()) {
      try { await WPCrypto.importKey(e2eKey); } catch { /* invalid key */ }
    }
    const username = command?.username || stored[WPConstants.STORAGE.USERNAME];
    sendSessionHello(username);
    const payload = await buildRoomAccessPayload(roomToJoin, accessKey);
    lastJoinAttemptRoomId = roomToJoin;
    WPWS.send({ type: WPProtocol.COMMAND.ROOM_JOIN, payload });
  }

  function processPendingActions() {
    if (!WPWS.isReady() || !extOk() || !isControllerTab) return;
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
        if (bootstrapIntent.action === WPConstants.ACTION.ROOM_CREATE) {
          await createRoomFromCommand(bootstrapIntent);
          return;
        }
        if (bootstrapIntent.action === WPConstants.ACTION.ROOM_JOIN) {
          await joinRoomFromCommand(bootstrapIntent, stored);
          return;
        }
      }

      const roomToJoin = stored[WPConstants.STORAGE.CURRENT_ROOM] || null;
      if (roomToJoin) {
        await joinRoomFromCommand({
          roomId: roomToJoin,
          username: stored[WPConstants.STORAGE.USERNAME],
          accessKey: await loadStoredAccessKey(roomToJoin),
          e2eKey: extOk() ? await WPRoomKeys.getE2eKey(roomToJoin) : null,
        }, stored);
        return;
      }
      WPWS.markApplicationReady();
    });
  }

  /** Load the session-only E2E crypto key for a room. */
  function loadCryptoKeyForRoom(roomId) {
    if (!extOk()) return Promise.resolve();
    return WPRoomKeys.loadIntoCrypto(roomId).then(() => {});
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
      scheduleContentPublish(0);
    } else if (directJoinResult?.handled && !directJoinResult.failed) {
      WPOverlay.openSidebar();
      return;
    } else {
      // Auto-navigate to host's content — but only if this tab doesn't already have video
      // (prevents a tab mid-playback from being redirected)
      if (!video) {
        const meta = roomState.meta;
        if (meta?.id && meta.id !== 'pending' && meta.id !== 'unknown' && meta.type) {
          const currentInfo = WPStremioAdapter.getCurrentContentInfo();
          if (!currentInfo || currentInfo.id !== meta.id) {
            const detailUrl = `#/detail/${encodeURIComponent(meta.type)}/${encodeURIComponent(meta.id)}`;
            WPOverlay.showToast(`Navigating to: ${meta.name || meta.id}`);
            WPRuntimeClock.setTimeout(() => { window.location.hash = detailUrl.slice(1); }, 500);
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

  async function onChatMessage(message, options = {}) {
    const rawMessage = message;
    if (options.persist !== false) {
      rememberStoredChatMessage(rawMessage);
      persistStoredChatHistory(roomState?.id).catch(() => {});
    }
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
    if (!rememberChatMessage(message)) return;
    WPOverlay.appendChatMessage(message, roomState, userId);
    if (options.incrementUnread !== false && !isMe(message.user)) WPOverlay.incrementUnread();
    // Relay to side panel (it can't access content script globals)
    if (options.relay !== false) {
      notifyBackground({ action: WPConstants.ACTION.ROOM_CHAT_EVENT, payload: message });
    }
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
      if (existing) WPRuntimeClock.clearTimeout(existing);
      typingUsers.set(user, WPRuntimeClock.setTimeout(() => {
        typingUsers.delete(user);
        WPOverlay.updateTypingIndicator(typingUsers, userId, roomState);
      }, 3000));
    } else {
      const t = typingUsers.get(user);
      if (t) WPRuntimeClock.clearTimeout(t);
      typingUsers.delete(user);
    }
    WPOverlay.updateTypingIndicator(typingUsers, userId, roomState);
    const userName = roomState?.users?.find((entry) => entry.id === user)?.name || null;
    notifyBackground({ action: WPConstants.ACTION.ROOM_TYPING_EVENT, payload: { user, typing, userName } });
  }

  function applyPassiveChatMessage(message) {
    if (!message || isControllerTab) return;
    if (!rememberChatMessage(message)) return;
    WPOverlay.appendChatMessage(message, roomState, userId);
  }

  function applyPassiveBookmark(message) {
    if (!message || isControllerTab) return;
    WPOverlay.appendBookmark(message);
  }

  function applyPassiveReaction(message) {
    if (!message || isControllerTab) return;
    WPOverlay.showReaction(message.user, message.emoji, roomState, message.messageId || null);
  }

  function applyPassiveTyping(message) {
    if (!message || isControllerTab) return;
    if (message.typing) {
      const existing = typingUsers.get(message.user);
      if (existing) WPRuntimeClock.clearTimeout(existing);
      typingUsers.set(message.user, WPRuntimeClock.setTimeout(() => {
        typingUsers.delete(message.user);
        WPOverlay.updateTypingIndicator(typingUsers, userId, roomState);
      }, 3000));
    } else {
      const existing = typingUsers.get(message.user);
      if (existing) WPRuntimeClock.clearTimeout(existing);
      typingUsers.delete(message.user);
    }
    WPOverlay.updateTypingIndicator(typingUsers, userId, roomState);
  }

  function applySharedRuntimeProjection(payload = {}) {
    if (payload.userId !== undefined) userId = payload.userId || null;
    if (payload.sessionId !== undefined && payload.sessionId) sessionId = payload.sessionId;
    if (payload.wsConnected !== undefined) sessionWsConnected = payload.wsConnected === true;
    if (payload.controllerRuntime && typeof payload.controllerRuntime === 'object') {
      controllerRuntimeState = { ...controllerRuntimeState, ...payload.controllerRuntime };
    }
    if (payload.adapterState && typeof payload.adapterState === 'object') {
      adapterRuntimeState = { ...adapterRuntimeState, ...payload.adapterState };
    }
    if (payload.room !== undefined) {
      roomState = payload.room || null;
      inRoom = !!roomState?.id;
      isHost = amIHost();
      resumeRoomPending = !!roomState?.id || !!pendingRoomCreateCommand || !!pendingRoomJoinCommand || !!deferredLeaveIntent;
      if (!inRoom) {
        clearReconnectNotice();
        WPSync.detach();
        releaseActiveTab();
        typingUsers.clear();
        WPOverlay.updateTypingIndicator(typingUsers, userId, roomState);
      } else if (!isControllerTab && video && isActiveVideoTab) {
        refreshControllerLease({ force: true }).catch(() => {});
      }
    }
    syncControllerRuntimeState('projection.apply');
    syncAdapterRuntimeState('projection.apply');
    refreshOverlay();
  }

  // --- Content link sharing ---
  async function shareContentLink() {
    if (shareContentLinkInFlight) return;
    shareContentLinkInFlight = true;
    try {
      const context = WPStremioAdapter.getCurrentContentContext();
      syncAdapterRuntimeState('adapter.evaluate', {
        launchUrl: context.launchUrl || null,
        contentMeta: context.meta ? { ...context.meta } : null,
      });
      if (!context.meta && !context.launchUrl) {
        syncAdapterRuntimeState('adapter.unavailable', {
          launchUrl: null,
          contentMeta: null,
          joinHint: INITIAL_JOIN_HINT,
        });
        return;
      }

      const rawStream = context.launchUrl
        ? { url: context.launchUrl }
        : { url: PLACEHOLDER_STREAM_URL };
      const { stream, joinHint } = await normalizeSharedStreamPayload(rawStream);
      if (!shouldShareHostContent()) return;

      if (!context.meta) {
        const streamOnlyKey = `stream:::${buildSharedStreamKey(stream)}`;
        if (lastSharedContentKey === streamOnlyKey) {
          syncAdapterRuntimeState('adapter.publish.cached', {
            joinHint,
            lastPublishedShareKey: streamOnlyKey,
            lastPublishedLaunchUrl: context.launchUrl || null,
          });
          return;
        }
        lastSharedContentKey = streamOnlyKey;
        syncAdapterRuntimeState('adapter.publish.stream-only', {
          joinHint,
          lastPublishedShareKey: streamOnlyKey,
          lastPublishedLaunchUrl: context.launchUrl || null,
        });
        WPWS.send({ type: WPProtocol.COMMAND.ROOM_CONTENT_UPDATE, payload: { stream, joinHint } });
        return;
      }

      const meta = await enrichContentMeta(context.meta, context.launchUrl);
      const shareKey = `${meta.type}:${meta.id}:${meta.name || ''}:${buildSharedStreamKey(stream)}`;
      if (lastSharedContentKey === shareKey) {
        syncAdapterRuntimeState('adapter.publish.cached', {
          contentMeta: meta,
          joinHint,
          lastPublishedShareKey: shareKey,
          lastPublishedLaunchUrl: context.launchUrl || null,
        });
        return;
      }
      lastSharedContentKey = shareKey;
      syncAdapterRuntimeState('adapter.publish.content', {
        contentMeta: meta,
        joinHint,
        lastPublishedShareKey: shareKey,
        lastPublishedLaunchUrl: context.launchUrl || null,
      });
      WPWS.send({ type: WPProtocol.COMMAND.ROOM_CONTENT_UPDATE, payload: { stream, meta, joinHint } });
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
      videoCheckTimer = WPRuntimeClock.setTimeout(() => {
        videoCheckTimer = null;
        const v = findBestVideoElement();
        if (v && v !== video) {
          if (WPSync.isAttached()) WPSync.detach();
          video = v;
          syncControllerRuntimeState('video.detected');
          syncAdapterRuntimeState('video.detected');
          if (inRoom) {
            refreshActiveVideoLease({ force: true }).catch(() => {}); // This tab now owns sync
            refreshControllerLease({ force: true }).catch(() => {});
            attachSync();
            if (!isHost) schedulePeerVideoResync(v);
            if (shouldShareHostContent()) scheduleContentPublish(100);
          }
          refreshOverlay();
        } else if (!v && video) {
          WPSync.detach();
          video = null;
          syncControllerRuntimeState('video.lost');
          syncAdapterRuntimeState('video.lost');
          releaseActiveTab();
          refreshOverlay();
        }
      }, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const v = findBestVideoElement();
    if (v) {
      video = v;
      syncControllerRuntimeState('video.initial');
      syncAdapterRuntimeState('video.initial');
      if (inRoom) {
        refreshActiveVideoLease({ force: true }).catch(() => {});
        refreshControllerLease({ force: true }).catch(() => {});
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
          WPWS.send({ type: WPProtocol.COMMAND.ROOM_PLAYBACK_PUBLISH, payload: { paused: state.paused, buffering: state.buffering, time: state.time, speed: state.speed } });
        }
      },
    });
  }

  // --- Overlay state refresh ---
  function refreshOverlay() {
    ensureChatHistoryRoom(inRoom ? roomState?.id : null);
    const wsConnected = isControllerTab ? WPWS.isConnected() : sessionWsConnected;
    WPOverlay.updateState({ inRoom, isHost, userId, sessionId, roomState, hasVideo: !!video, wsConnected });
    if (inRoom && roomState?.id) {
      loadCryptoKeyForRoom(roomState.id)
        .catch(() => {})
        .then(() => hydrateStoredChatHistory(roomState.id))
        .catch(() => {});
    }
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

  const CONTROLLER_ACTIONS = new Set(WPActionContract.getActionsForTarget('controller'));

  function resolveActionSource(message, options = {}) {
    if (typeof options.sourceSurface === 'string') return options.sourceSurface;
    if (typeof message?.sourceSurface === 'string') return message.sourceSurface;
    if (options.source === 'local') return 'overlay';
    if (options.source === 'runtime') return 'background';
    return null;
  }

  function isActionAllowedForSource(message, options = {}) {
    return WPActionContract.isAllowedSource(message?.action, resolveActionSource(message, options));
  }

  function relayActionToController(message, sourceSurface) {
    if (!extOk()) return Promise.resolve({ ok: false });
    return chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      ...message,
      sourceSurface,
    }).catch(() => ({ ok: false }));
  }

  // --- Action dispatch (from overlay events + background/popup messages) ---
  WPOverlay.setActionDispatcher?.((detail) => {
    handleAction(detail, { source: 'local', sourceSurface: 'overlay' }).catch(() => {});
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'watchparty-ext') return false;
    if (!isActionAllowedForSource(message, { source: 'runtime' })) {
      sendResponse({ handled: false, error: 'ACTION_SOURCE_NOT_ALLOWED' });
      return true;
    }
    if (message.action === WPConstants.ACTION.PROBE_SURFACE) {
      sendResponse({ surface: 'stremio' });
      return true;
    }
    if (message.action === WPConstants.ACTION.ROOM_CHAT_EVENT) {
      applyPassiveChatMessage(message.payload);
      sendResponse({ handled: true });
      return true;
    }
    if (message.action === WPConstants.ACTION.ROOM_TYPING_EVENT) {
      applyPassiveTyping(message.payload);
      sendResponse({ handled: true });
      return true;
    }
    if (message.action === WPConstants.ACTION.ROOM_BOOKMARK_EVENT) {
      applyPassiveBookmark(message.payload);
      sendResponse({ handled: true });
      return true;
    }
    if (message.action === WPConstants.ACTION.ROOM_REACTION_EVENT) {
      applyPassiveReaction(message.payload);
      sendResponse({ handled: true });
      return true;
    }
    if (message.action === WPConstants.ACTION.ROOM_CREATE) {
      stagePendingRoomCreateCommand({
        username: message.username,
        meta: message.meta,
        stream: message.stream,
        public: message.public,
        listed: message.listed,
        roomName: message.roomName,
        accessKey: message.accessKey,
        e2eKey: message.e2eKey,
      });
      refreshControllerLease({ force: !!video && inRoom && isActiveVideoTab }).then((claimed) => {
        if (!claimed) {
          schedulePendingIntentWake();
          sendResponse({ handled: true, staged: true });
          return;
        }
        if (WPWS.isReady()) {
          const command = pendingRoomCreateCommand;
          pendingRoomCreateCommand = null;
          createRoomFromCommand(command).catch(() => {});
        } else {
          ensureControllerConnection();
        }
        sendResponse({ handled: true });
      }).catch(() => sendResponse({ handled: false }));
      return true;
    }
    if (message.action === WPConstants.ACTION.ROOM_JOIN) {
      stagePendingRoomJoinCommand({
        roomId: message.roomId,
        username: message.username,
        accessKey: message.accessKey,
        e2eKey: message.e2eKey,
        preferDirectJoin: message.preferDirectJoin === true,
      });
      refreshControllerLease({ force: !!video && inRoom && isActiveVideoTab }).then((claimed) => {
        if (!claimed) {
          schedulePendingIntentWake();
          sendResponse({ handled: true, staged: true });
          return;
        }
        if (WPWS.isReady()) {
          const command = pendingRoomJoinCommand;
          pendingRoomJoinCommand = null;
          joinRoomFromCommand(command).catch(() => {});
        } else {
          ensureControllerConnection();
        }
        sendResponse({ handled: true });
      }).catch(() => sendResponse({ handled: false }));
      return true;
    }
    if (message.action === WPConstants.ACTION.BOOTSTRAP_PENDING) {
      if (!sessionId) {
        schedulePendingIntentWake();
      } else {
        refreshControllerLease().then((claimed) => {
          if (!claimed) return;
          if (WPWS.isReady()) processPendingActions();
          else ensureControllerConnection();
        }).catch(() => {});
      }
      sendResponse({ handled: true });
      return true;
    }
    if (message.action === WPConstants.ACTION.STATUS_UPDATED) {
      if (!isControllerTab) applySharedRuntimeProjection(message.payload || {});
      sendResponse({ handled: true });
      return true;
    }
    Promise.resolve(handleAction(message, { source: 'runtime' }))
      .then((result) => sendResponse(result || { handled: false }))
      .catch(() => sendResponse({ handled: false }));
    return true;
  });

  // Action handler map — replaces monolithic switch for testability and clarity
  const actionHandlers = {
    [WPConstants.ACTION.ROOM_CREATE]: (m) => {
      if (WPWS.isReady()) {
        createRoomFromCommand(m).catch(() => { });
      } else if (extOk()) {
        stagePendingRoomCreateCommand({
          username: m.username,
          meta: m.meta,
          stream: m.stream,
          public: m.public,
          listed: m.listed,
          roomName: m.roomName,
          accessKey: m.accessKey,
          e2eKey: m.e2eKey,
        });
        ensureControllerConnection();
      } else {
        ensureControllerConnection();
      }
    },
    [WPConstants.ACTION.ROOM_JOIN]: (m) => {
      if (WPWS.isReady()) {
        joinRoomFromCommand(m).catch(() => { });
      } else if (extOk()) {
        stagePendingRoomJoinCommand({
          roomId: m.roomId,
          username: m.username,
          accessKey: m.accessKey,
          e2eKey: m.e2eKey,
          preferDirectJoin: m.preferDirectJoin === true,
        });
        ensureControllerConnection();
      } else {
        ensureControllerConnection();
      }
    },
    [WPConstants.ACTION.OPEN_SIDEBAR]: (m) => { WPOverlay.openSidebar(m.panel); },
    [WPConstants.ACTION.ROOM_LEAVE]: () => {
      WPRuntimeClock.clearTimeout(presenceTimeout);
      finalizeLeaveIntent({ sendLeave: true });
    },
    [WPConstants.ACTION.ROOM_VISIBILITY_UPDATE]: async (m) => {
      const nextPublic = typeof m.public === 'boolean' ? m.public : (roomState?.public !== false);
      const nextListed = m.listed !== false;
      if (nextPublic === false) {
        const roomId = roomState?.id;
        const requestedAccessKey = normalizePrivateKeyInput(m.accessKey);
        const existingAccessKey = await loadStoredAccessKey(roomId);
        const existingE2eKey = extOk() ? await WPRoomKeys.getE2eKey(roomId) : null;
        const usersInRoom = Array.isArray(roomState?.users) ? roomState.users.length : 0;
        const alreadyPrivate = roomState?.public === false;
        const isChangingAccessKey = !!requestedAccessKey && requestedAccessKey !== existingAccessKey;
        if (alreadyPrivate && isChangingAccessKey && usersInRoom > 1) {
          WPOverlay.showToast('Change the access key when you are alone in the room to avoid breaking private-room peers.', 3500);
          refreshOverlay();
          return;
        }
        if (alreadyPrivate && !requestedAccessKey && !existingAccessKey) {
          WPOverlay.showToast('This browser does not have the invite key for this private room.', 3000);
          refreshOverlay();
          return;
        }
        const accessKey = requestedAccessKey || existingAccessKey || WPPrivateRoomKeys.generateAccessKey();
        const e2eKey = normalizePrivateKeyInput(m.e2eKey)
          || existingE2eKey
          || (!alreadyPrivate ? await WPPrivateRoomKeys.generateE2eKey() : null);
        if (!accessKey || (!alreadyPrivate && !e2eKey)) {
          WPOverlay.showToast('Failed to generate a private access key.', 2500);
          refreshOverlay();
          return;
        }
        pendingVisibilityPrivateKeys = { accessKey, e2eKey };
        pendingVisibilityPrivateKeyRoomId = roomId;
        WPWS.send({
          type: WPProtocol.COMMAND.ROOM_VISIBILITY_UPDATE,
          payload: {
            public: false,
            visibility: WPRoomDomain.ROOM_VISIBILITY.INVITE_ONLY,
            listed: nextListed,
            accessKey,
          },
        });
        return;
      }
      pendingVisibilityPrivateKeys = null;
      pendingVisibilityPrivateKeyRoomId = roomState?.id || null;
      WPWS.send({
        type: WPProtocol.COMMAND.ROOM_VISIBILITY_UPDATE,
        payload: {
          public: true,
          visibility: WPRoomDomain.ROOM_VISIBILITY.PUBLIC,
          listed: nextListed,
        },
      });
    },
    [WPConstants.ACTION.ROOM_SETTINGS_UPDATE]: (m) => WPWS.send({ type: WPProtocol.COMMAND.ROOM_SETTINGS_UPDATE, payload: m.settings }),
    [WPConstants.ACTION.ROOM_OWNERSHIP_TRANSFER]: (m) => WPWS.send({ type: WPProtocol.COMMAND.ROOM_OWNERSHIP_TRANSFER, payload: { userId: m.targetUserId } }),
    [WPConstants.ACTION.SESSION_USERNAME_UPDATE]: (m) => sendSessionHello(m.username),
    [WPConstants.ACTION.ROOM_READY_CHECK_UPDATE]: (m) => WPWS.send({ type: WPProtocol.COMMAND.ROOM_READY_CHECK_UPDATE, payload: { action: m.readyAction } }),
    [WPConstants.ACTION.ROOM_BOOKMARK_ADD]: (m) => WPWS.send({ type: WPProtocol.COMMAND.ROOM_BOOKMARK_ADD, payload: { time: resolveBookmarkTime(m.time), label: m.label } }),
    [WPConstants.ACTION.ROOM_BOOKMARK_SEEK]: (m) => seekToBookmarkTime(m.time),
    [WPConstants.ACTION.ROOM_CHAT_SEND]: async (m) => {
      lastUserAction = WPConstants.ACTION.ROOM_CHAT_SEND;
      const content = WPCrypto.isEnabled() ? await WPCrypto.encrypt(m.content) : m.content;
      WPWS.send({ type: WPProtocol.COMMAND.ROOM_CHAT_SEND, payload: { content } });
    },
    [WPConstants.ACTION.ROOM_TYPING_SEND]: (m) => { lastUserAction = WPConstants.ACTION.ROOM_TYPING_SEND; WPWS.send({ type: WPProtocol.COMMAND.ROOM_TYPING_SEND, payload: { typing: m.typing } }); },
    [WPConstants.ACTION.ROOM_REACTION_SEND]: (m) => WPWS.send({ type: WPProtocol.COMMAND.ROOM_REACTION_SEND, payload: { emoji: m.emoji, messageId: m.messageId || undefined } }),
    [WPConstants.ACTION.ROOM_MEMBER_PRESENCE_PUBLISH]: (m) => WPWS.send({ type: WPProtocol.COMMAND.ROOM_MEMBER_PRESENCE_PUBLISH, payload: { status: m.status } }),
    [WPConstants.ACTION.ROOM_MEMBER_PLAYBACK_STATUS_PUBLISH]: (m) => WPWS.send({ type: WPProtocol.COMMAND.ROOM_MEMBER_PLAYBACK_STATUS_PUBLISH, payload: { status: m.status } }),
    [WPConstants.ACTION.ROOM_PLAYBACK_REQUEST_SYNC]: () => { requestLatestHostSync(); },
  };

  async function handleAction(message, options = {}) {
    const action = message?.action;
    if (!action) return { handled: false };
    const sourceSurface = resolveActionSource(message, options);
    if (!WPActionContract.isAllowedSource(action, sourceSurface)) {
      return { handled: false, error: 'ACTION_SOURCE_NOT_ALLOWED' };
    }
    if (CONTROLLER_ACTIONS.has(action) && !isControllerTab) {
      if (options.source === 'runtime' && action === WPConstants.ACTION.ROOM_CREATE) {
        stagePendingRoomCreateCommand({
          username: message.username,
          meta: message.meta,
          stream: message.stream,
          public: message.public,
          listed: message.listed,
          roomName: message.roomName,
          accessKey: message.accessKey,
          e2eKey: message.e2eKey,
        });
      }
      if (options.source === 'runtime' && action === WPConstants.ACTION.ROOM_JOIN) {
        stagePendingRoomJoinCommand({
          roomId: message.roomId,
          username: message.username,
          accessKey: message.accessKey,
          e2eKey: message.e2eKey,
          preferDirectJoin: message.preferDirectJoin === true,
        });
      }
      const claimed = await refreshControllerLease({ force: !!video && inRoom && isActiveVideoTab });
      if (!claimed) {
        if (options.source === 'runtime' && (action === WPConstants.ACTION.ROOM_CREATE || action === WPConstants.ACTION.ROOM_JOIN)) {
          schedulePendingIntentWake();
          return { handled: true, staged: true };
        }
        if (options.source === 'runtime') return { handled: false };
        await relayActionToController(message, sourceSurface);
        return { handled: true, relayed: true };
      }
    }
    const handler = actionHandlers[message.action];
    if (!handler) return { handled: false };
    await handler(message);
    return { handled: true, controller: CONTROLLER_ACTIONS.has(action) ? isControllerTab : undefined };
  }

  // --- Presence (only from tab with video to avoid multi-tab conflicts) ---
  let presenceTimeout = null;
  document.addEventListener('visibilitychange', () => {
    if (!inRoom) return;
    // Only the active video tab reports presence — prevents away/active flicker
    if (!isActiveVideoTab || !isControllerTab) return;
    WPRuntimeClock.clearTimeout(presenceTimeout);
    if (document.visibilityState === 'hidden') {
      presenceTimeout = WPRuntimeClock.setTimeout(() => {
        WPWS.send({ type: WPProtocol.COMMAND.ROOM_MEMBER_PRESENCE_PUBLISH, payload: { status: 'away' } });
      }, 10000);
    } else {
      WPWS.send({ type: WPProtocol.COMMAND.ROOM_MEMBER_PRESENCE_PUBLISH, payload: { status: 'active' } });
    }
  });

  // --- Playback status reporting (only from tab with active video) ---
  let lastPlaybackStatus = '';
  let lastPlaybackSecond = -1;
  const playbackInterval = WPRuntimeClock.setInterval(() => {
    if (!inRoom || !video || !isActiveVideoTab || !isControllerTab) {
      lastPlaybackStatus = '';
      lastPlaybackSecond = -1;
      return;
    }
    if (!chrome.runtime?.id) { WPRuntimeClock.clearInterval(playbackInterval); return; }
    const status = video.paused ? 'paused' : video.readyState < 3 ? 'buffering' : 'playing';
    const currentSecond = Number.isFinite(video.currentTime) ? Math.floor(Math.max(0, video.currentTime)) : 0;
    const statusChanged = status !== lastPlaybackStatus;
    const timeChanged = lastPlaybackSecond < 0 || Math.abs(currentSecond - lastPlaybackSecond) >= (status === 'playing' ? 3 : 1);
    if (!statusChanged && !timeChanged) return;
    lastPlaybackStatus = status;
    lastPlaybackSecond = currentSecond;
    WPWS.send({
      type: WPProtocol.COMMAND.ROOM_MEMBER_PLAYBACK_STATUS_PUBLISH,
      payload: { status, time: Math.max(0, Number(video.currentTime) || 0) },
    });
  }, 3000);

  const hostShareInterval = WPRuntimeClock.setInterval(() => {
    WPStremioAdapter.updateKnownContentMeta();
    syncAdapterRuntimeState('adapter.interval');
    if (shouldShareHostContent()) {
      scheduleContentPublish(150);
    }
  }, 4000);

  // --- Host stream update on SPA navigation (only from tab with video) ---
  window.addEventListener('hashchange', () => {
    WPStremioAdapter.updateKnownContentMeta();
    syncAdapterRuntimeState('route.hashchange');
    // Only the active video tab should update stream meta.
    if (shouldShareHostContent()) {
      scheduleContentPublish(100);
    }
  });

  // --- Storage change listener for pending actions ---
  if (extOk()) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'session' && changes[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]) {
        resumeRoomPending = true;
        if (!sessionId) {
          schedulePendingIntentWake();
          return;
        }
        refreshControllerLease().then((claimed) => {
          if (!claimed) return;
          if (WPWS.isReady()) processPendingActions();
          else ensureControllerConnection();
        }).catch(() => {});
      }
      if (areaName === 'session' && changes[WPConstants.STORAGE.DEFERRED_LEAVE_ROOM]) {
        syncDeferredLeaveIntent(changes[WPConstants.STORAGE.DEFERRED_LEAVE_ROOM].newValue);
        if (!sessionId) {
          schedulePendingIntentWake();
          return;
        }
        refreshControllerLease().then((claimed) => {
          if (!claimed) return;
          if (WPWS.isReady()) processPendingActions();
          else ensureControllerConnection();
        }).catch(() => {});
      }
      if (areaName === 'session' && roomState?.id) {
        const historyChange = changes[WPConstants.STORAGE.roomChatHistory(roomState.id)];
        if (historyChange?.newValue) {
          applyStoredChatHistory(normalizeStoredChatHistory(historyChange.newValue)).catch(() => {});
        }
      }
      if (areaName === 'session' && changes[WPConstants.STORAGE.CONTROLLER_TAB]) {
        const nextLease = changes[WPConstants.STORAGE.CONTROLLER_TAB].newValue;
        const nextIsController = WPConstants.CONTROLLER_TAB_LEASE.isOwner(nextLease, controllerLeaseId);
        if (nextIsController !== isControllerTab) {
          const wasController = isControllerTab;
          isControllerTab = nextIsController;
          syncControllerRuntimeState('controller-lease.storage');
          if (isControllerTab) {
            if (WPWS.isReady()) processPendingActions();
            else ensureControllerConnection();
          } else {
            if (wasController) publishControllerRelease();
            disconnectControllerSocket({ force: true });
          }
          refreshOverlay();
        }
      }
      if (areaName === 'local' && changes[WPConstants.STORAGE.BACKEND_MODE]) {
        const nextMode = WPConstants.BACKEND.normalizeMode(changes[WPConstants.STORAGE.BACKEND_MODE].newValue);
        if (WPWS.setBackendMode(nextMode)) {
          if (isControllerTab) {
            WPWS.disconnect({ resetReplay: true });
            persistConnectionState();
            ensureControllerConnection();
          } else {
            sessionWsConnected = false;
            refreshOverlay();
          }
        }
      }
      // Active video tab election — another tab claimed active status
      if (areaName === 'session' && changes[WPConstants.STORAGE.ACTIVE_VIDEO_TAB]) {
        const nextLease = changes[WPConstants.STORAGE.ACTIVE_VIDEO_TAB].newValue;
        isActiveVideoTab = WPConstants.VIDEO_TAB_LEASE.isOwner(nextLease, activeVideoLeaseId);
        syncControllerRuntimeState('video-lease.storage');
        if (isActiveVideoTab && inRoom) {
          refreshControllerLease({ force: true }).catch(() => {});
        } else if (!isActiveVideoTab && video && inRoom && WPConstants.VIDEO_TAB_LEASE.isExpired(nextLease)) {
          refreshActiveVideoLease({ force: true }).catch(() => {});
        }
      }
    });
  }

  // --- Cleanup ---
  window.addEventListener('beforeunload', () => {
    WPRuntimeClock.clearInterval(playbackInterval);
    WPRuntimeClock.clearInterval(hostShareInterval);
    if (controllerLeaseInterval) WPRuntimeClock.clearInterval(controllerLeaseInterval);
    if (activeVideoLeaseInterval) WPRuntimeClock.clearInterval(activeVideoLeaseInterval);
    if (pendingIntentWakeTimer) WPRuntimeClock.clearTimeout(pendingIntentWakeTimer);
    if (contentPublishTimer) WPRuntimeClock.clearTimeout(contentPublishTimer);
    releaseActiveTab();
    releaseControllerTab();
    WPProfile.stop();
  });

  function init() {
    chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: WPConstants.ACTION.SURFACE_READY,
      surface: 'stremio',
    }).then((response) => {
      const nextTabId = Number.isInteger(response?.tabId) ? response.tabId : null;
      if (nextTabId == null || nextTabId === surfaceTabId) return;
      surfaceTabId = nextTabId;
      syncControllerRuntimeState('surface.ready');
      if (isControllerTab || isActiveVideoTab || (inRoom && video)) {
        refreshControllerLease({ force: !!video && inRoom }).catch(() => {});
        refreshActiveVideoLease({ force: true }).catch(() => {});
      }
    }).catch(() => {});
    chrome.runtime.sendMessage({
      type: 'watchparty-ext',
      action: WPConstants.ACTION.STATUS_GET,
    }).then((response) => {
      if (!response || isControllerTab) return;
      applySharedRuntimeProjection({
        room: response.room || null,
        userId: response.userId || null,
        sessionId: response.sessionId || null,
        wsConnected: response.wsConnected === true,
      });
    }).catch(() => {});
    WPOverlay.create();
    WPOverlay.initKeyboardShortcuts();
    WPOverlay.bindTypingIndicator(
      () => { if (inRoom) handleAction({ action: WPConstants.ACTION.ROOM_TYPING_SEND, typing: true }, { source: 'local' }).catch(() => {}); },
      () => { handleAction({ action: WPConstants.ACTION.ROOM_TYPING_SEND, typing: false }, { source: 'local' }).catch(() => {}); }
    );
    startVideoObserver();
    startControllerLeaseHeartbeat();
    startActiveVideoLeaseHeartbeat();
    WPStremioAdapter.updateKnownContentMeta();
    WPProfile.start();

    // Generate or load persistent session ID (shared across all tabs via chrome.storage).
    // This lets the server identify all tabs as the same user — Twitch-style multi-tab.
    getExtensionState([
      WPConstants.STORAGE.SESSION_ID,
      WPConstants.STORAGE.BACKEND_MODE,
      WPConstants.STORAGE.ACTIVE_BACKEND,
      WPConstants.STORAGE.ROOM_STATE,
      WPConstants.STORAGE.USER_ID,
      WPConstants.STORAGE.WS_CONNECTED,
      WPConstants.STORAGE.CURRENT_ROOM,
      WPConstants.STORAGE.CONTROLLER_TAB,
      WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT,
      WPConstants.STORAGE.DEFERRED_LEAVE_ROOM,
    ]).then((result) => {
      const storedSessionId = result[WPConstants.STORAGE.SESSION_ID];
      if (storedSessionId) {
        sessionId = storedSessionId;
      } else {
        sessionId = crypto.randomUUID();
        setExtensionState({ [WPConstants.STORAGE.SESSION_ID]: sessionId }).catch(() => {});
      }
      syncControllerRuntimeState('session.ready');
      syncDeferredLeaveIntent(result[WPConstants.STORAGE.DEFERRED_LEAVE_ROOM]);
      const backendMode = WPConstants.BACKEND.normalizeMode(result[WPConstants.STORAGE.BACKEND_MODE]);
      const activeBackend = WPConstants.BACKEND.isKnownKey(result[WPConstants.STORAGE.ACTIVE_BACKEND])
        ? result[WPConstants.STORAGE.ACTIVE_BACKEND]
        : null;
      const bootstrapIntent = normalizeBootstrapRoomIntent(result[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]);
      if (!bootstrapIntent && result[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT] !== undefined) {
        clearBootstrapRoomIntent().catch(() => {});
      }
      isControllerTab = WPConstants.CONTROLLER_TAB_LEASE.isOwner(result[WPConstants.STORAGE.CONTROLLER_TAB], controllerLeaseId);
      applySharedRuntimeProjection({
        userId: result[WPConstants.STORAGE.USER_ID] || null,
        room: result[WPConstants.STORAGE.ROOM_STATE] || null,
        wsConnected: result[WPConstants.STORAGE.WS_CONNECTED] === true,
      });
      const hasRoomBootstrap = !!result[WPConstants.STORAGE.CURRENT_ROOM]
        || !!bootstrapIntent
        || !!deferredLeaveIntent
        || !!result[WPConstants.STORAGE.ROOM_STATE]?.id;
      resumeRoomPending = hasRoomBootstrap;
      syncControllerRuntimeState('runtime.bootstrap');
      syncAdapterRuntimeState('runtime.bootstrap');
      WPWS.setBackendMode(
        backendMode === WPConstants.BACKEND.MODES.AUTO && hasRoomBootstrap && activeBackend
          ? activeBackend
          : backendMode
      );
      // Only the elected controller tab owns the shared room socket.
      refreshControllerLease({ force: !!video && !!result[WPConstants.STORAGE.ROOM_STATE]?.id }).then((claimed) => {
        if (!claimed) {
          refreshOverlay();
          return;
        }
        if (WPWS.isReady()) {
          processPendingActions();
        } else {
          ensureControllerConnection();
        }
      }).catch(() => {
        refreshOverlay();
      });
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();


