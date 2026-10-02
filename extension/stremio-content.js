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
  let sessionToken = null; // Private proof for sessionId ownership; never sent to room peers

  // --- Active video tab election (Spotify-style: only ONE tab syncs at a time) ---
  // When multiple tabs have video, only the most recent one sends sync/playback/stream messages.
  // Other tabs remain passive (chat/reactions still work).
  let isActiveVideoTab = false;
  let pendingContentPublication = null;
  let roomContextGeneration = 0;
  let visibilityOperationRevision = 0;
  let blockedMedia = null;
  let followedContentKey = null;
  let followerContentChanged = false;
  let pendingRoomCreateCommand = null;
  let pendingRoomJoinCommand = null;
  let pendingJoinOptions = null;
  let pendingCreatedPrivateKeys = null;
  let pendingJoinedPrivateKeys = null;
  let pendingVisibilityPrivateKeys = null;
  let pendingVisibilityPrivateKeyRoomId = null;
  let deferredLeaveIntent = null;
  let lastJoinAttemptRoomId = null;
  let pendingJoinAttempt = null;
  const pendingMembershipOperations = new Map();
  const cancelledMembershipOperations = new Map();
  let roomIntentCancellationGeneration = 0;
  let shareContentLinkInFlight = false;
  let contentPublishTimer = null;
  let reconnectNoticeTimer = null;
  let reconnectNoticeShown = false;
  let surfaceTabId = null;
  let isControllerTab = false;
  let controllerLease = null;
  let controllerLeaseInterval = null;
  let activeVideoLeaseInterval = null;
  let resumeRoomPending = false;
  let pendingIntentWakeTimer = null;
  let playbackProjectionTimer = null;
  let playbackSyncRequestPending = false;
  let pendingHostPlaybackRestore = null;
  let hostPlaybackRestoreCleanup = null;
  let retiredPlaybackEpochs = new Set();
  const controllerLeaseId = crypto.randomUUID();
  const activeVideoLeaseId = crypto.randomUUID();
  const controllerLeaseResponses = WPControllerKernel.createLeaseResponseGuard();
  const activeVideoLeaseResponses = WPControllerKernel.createLeaseResponseGuard();
  const roomIntentResponses = WPControllerKernel.createLeaseResponseGuard();
  let pendingActionsPromise = null;
  const cinemetaTitleCache = new Map();
  const INITIAL_JOIN_HINT = WPRoomDomain.normalizeJoinHint(null);
  let controllerRuntimeState = WPControllerKernel.createInitialRuntimeState();
  let adapterRuntimeState = WPStremioRuntimeModel.createInitialAdapterRuntimeState(INITIAL_JOIN_HINT);

  const CHAT_HISTORY_LIMIT = 200;
  const PLACEHOLDER_ROOM_NAME = 'WatchParty Session';
  const PLACEHOLDER_STREAM_URL = 'https://watchparty.mertd.me/sync';
  const PLAYBACK_PROJECTION_INTERVAL_MS = 2000;

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

  function releaseActiveTab() {
    activeVideoLeaseResponses.invalidate();
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
    const requestRevision = activeVideoLeaseResponses.begin();
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
      if (!activeVideoLeaseResponses.isCurrent(requestRevision)) return isActiveVideoTab;
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

  function publishControllerRelease() {
    sessionWsConnected = false;
    syncControllerRuntimeState('controller.release.publish');
    syncAdapterRuntimeState('controller.release.publish');
    if (!extOk()) return;
    notifyBackground({
      action: WPConstants.ACTION.CONTROLLER_RELEASED,
      payload: {
        controllerLeaseId,
        room: buildProjectedRoomState(roomState),
        userId,
        sessionId,
        controllerRuntime: cloneRuntimeStateSnapshot(controllerRuntimeState),
        adapterState: cloneRuntimeStateSnapshot(adapterRuntimeState),
      },
    });
  }

  function disconnectControllerSocket(options = {}) {
    roomIntentResponses.invalidate();
    pendingActionsPromise = null;
    clearHostPlaybackRestore();
    // This must also cancel a pending backend probe/CONNECTING socket.
    WPWS.disconnect();
    WPSync.detach();
    sessionWsConnected = false;
    syncControllerRuntimeState('controller-socket.disconnect');
    refreshOverlay();
  }

  function releaseControllerTab() {
    controllerLeaseResponses.invalidate();
    if (!extOk()) return Promise.resolve(false);
    const wasController = isControllerTab;
    if (wasController) publishControllerRelease();
    isControllerTab = false;
    controllerLease = null;
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
    if (!extOk() || !sessionId || !sessionToken) return Promise.resolve(false);
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
    const requestRevision = controllerLeaseResponses.begin();
    return sendBackgroundMessage({
      action: WPConstants.ACTION.CONTROLLER_LEASE_CLAIM,
      lease,
      force: options.force === true,
    }).then((response) => {
      if (!controllerLeaseResponses.isCurrent(requestRevision)) return isControllerTab;
      const wasController = isControllerTab;
      isControllerTab = response?.claimed === true;
      controllerLease = isControllerTab ? WPConstants.CONTROLLER_TAB_LEASE.normalize(response?.lease) : null;
      syncControllerRuntimeState('controller-lease.refresh');
      if (isControllerTab) {
        ensureControllerConnection();
        if (video && inRoom && shouldShareHostContent()) {
          scheduleContentPublish(100);
        }
      } else if (wasController) {
        publishControllerRelease();
        disconnectControllerSocket({ force: true });
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
    const historyRoomId = roomState?.id;
    chatHistoryForStorage = messages.slice(-CHAT_HISTORY_LIMIT);
    for (const message of messages) {
      if (roomState?.id !== historyRoomId) return;
      await onChatMessage(message, { incrementUnread: false, persist: false, relay: false });
    }
  }

  async function hydrateStoredChatHistory(roomId) {
    if (!roomId || hydratedChatHistoryRoomId === roomId) return;
    hydratedChatHistoryRoomId = roomId;
    const messages = await loadStoredChatHistory(roomId);
    if (roomState?.id !== roomId) return;
    await applyStoredChatHistory(messages);
  }

  function ensureChatHistoryRoom(roomId) {
    const nextRoomId = roomId || null;
    if (activeChatHistoryRoomId === nextRoomId) return;
    activeChatHistoryRoomId = nextRoomId;
    hydratedChatHistoryRoomId = null;
    chatMessages = [];
    chatHistoryForStorage = [];
    pendingEncryptedMessages.length = 0;
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

  function normalizeCommandBackendMode(command = {}) {
    const mode = WPConstants.BACKEND.normalizeMode(command?.backendMode);
    return mode === WPConstants.BACKEND.MODES.AUTO ? null : mode;
  }

  function buildPendingRoomCreateCommand(command = {}) {
    const backendMode = normalizeCommandBackendMode(command);
    const pending = {
      username: command.username,
      meta: command.meta,
      stream: command.stream,
      public: command.public,
      listed: command.listed,
      roomName: command.roomName,
      accessKey: command.accessKey,
      e2eKey: command.e2eKey,
    };
    if (backendMode) pending.backendMode = backendMode;
    return pending;
  }

  function buildPendingRoomJoinCommand(command = {}) {
    const backendMode = normalizeCommandBackendMode(command);
    const pending = {
      roomId: command.roomId,
      username: command.username,
      accessKey: command.accessKey,
      e2eKey: command.e2eKey,
      preferDirectJoin: command.preferDirectJoin === true,
    };
    if (backendMode) pending.backendMode = backendMode;
    return pending;
  }

  function selectBackendModeForCommand(command = {}) {
    const backendMode = normalizeCommandBackendMode(command);
    return backendMode ? WPWS.setBackendMode(backendMode) : false;
  }

  function switchBackendForCommand(command, restageCommand) {
    const backendMode = normalizeCommandBackendMode(command);
    if (!backendMode) return false;
    const wasReady = WPWS.isReady();
    const activeBackend = WPWS.getActiveBackend();
    const modeChanged = WPWS.setBackendMode(backendMode);
    const needsReconnect = wasReady && activeBackend && activeBackend !== backendMode;
    if (!modeChanged && !needsReconnect) return false;
    if (needsReconnect) {
      restageCommand(command);
      if (roomState?.id) applyLocalLeaveState(roomState.id);
      WPWS.disconnect({ resetReplay: true });
      sessionWsConnected = false;
      WPSync.detach();
      syncControllerRuntimeState('backend.switch');
      refreshOverlay();
      ensureControllerConnection();
      return true;
    }
    return false;
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
    roomIntentResponses.invalidate();
    pendingRoomCreateCommand = command ? buildPendingRoomCreateCommand(command) : null;
    pendingRoomJoinCommand = null;
    if (pendingRoomCreateCommand) selectBackendModeForCommand(pendingRoomCreateCommand);
    resumeRoomPending = !!pendingRoomCreateCommand;
    syncControllerRuntimeState('pending-intent.create');
  }

  function stagePendingRoomJoinCommand(command) {
    roomIntentResponses.invalidate();
    pendingRoomJoinCommand = command ? buildPendingRoomJoinCommand(command) : null;
    pendingRoomCreateCommand = null;
    if (pendingRoomJoinCommand) selectBackendModeForCommand(pendingRoomJoinCommand);
    resumeRoomPending = !!pendingRoomJoinCommand;
    syncControllerRuntimeState('pending-intent.join');
  }

  function clearPendingRoomIntent(action) {
    if (action === WPConstants.ACTION.ROOM_CREATE) pendingRoomCreateCommand = null;
    if (action === WPConstants.ACTION.ROOM_JOIN) pendingRoomJoinCommand = null;
    resumeRoomPending = !!(pendingRoomCreateCommand || pendingRoomJoinCommand || deferredLeaveIntent?.roomId || roomState?.id || inRoom);
    syncControllerRuntimeState('pending-intent.clear');
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
    if (!username || !sessionId || !sessionToken) return false;
    WPWS.send({ type: WPProtocol.COMMAND.SESSION_HELLO, payload: { username, sessionId, sessionToken } });
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

  function applyLocalLeaveState(leavingRoomId, options = {}) {
    roomIntentResponses.invalidate();
    roomContextGeneration += 1;
    visibilityOperationRevision += 1;
    pendingContentPublication = null;
    blockedMedia = null;
    followedContentKey = null;
    followerContentChanged = false;
    pendingJoinAttempt = null;
    pendingMembershipOperations.clear();
    lastJoinAttemptRoomId = null;
    pendingJoinedPrivateKeys = null;
    clearHostPlaybackRestore();
    WPWS.setRoomScope(null);
    clearReconnectNotice();
    clearPlaybackProjectionTimer();
    playbackSyncRequestPending = false;
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
    if (leavingRoomId && options.preservePrivateKeys !== true) {
      WPRoomKeys.remove(leavingRoomId).catch(() => {});
    }
  }

  function finalizeLeaveIntent(options = {}) {
    const leavingRoomId = options.roomId || roomState?.id || deferredLeaveIntent?.roomId || lastJoinAttemptRoomId;
    if (!leavingRoomId && pendingMembershipOperations.size === 0
      && !pendingRoomCreateCommand && !pendingRoomJoinCommand && !pendingActionsPromise) return;
    roomIntentCancellationGeneration += 1;
    for (const [requestId, operation] of pendingMembershipOperations) {
      cancelledMembershipOperations.set(requestId, { ...operation, previousRoomId: roomState?.id });
    }
    while (cancelledMembershipOperations.size > 64) {
      cancelledMembershipOperations.delete(cancelledMembershipOperations.keys().next().value);
    }
    pendingRoomCreateCommand = null;
    pendingRoomJoinCommand = null;
    pendingCreatedPrivateKeys = null;
    // WebSocket preserves ordering: JOIN/CREATE followed by LEAVE cancels
    // membership even while its snapshot is still in flight. Do not wait for
    // application readiness or the pending target can resurrect after Leave.
    const leaveSent = options.sendLeave && WPWS.isReady()
      && WPWS.send({ type: WPProtocol.COMMAND.ROOM_LEAVE, payload: {} });
    if (leaveSent) {
      clearDeferredLeaveIntent(leavingRoomId);
    } else if (leavingRoomId) {
      rememberDeferredLeaveIntent(leavingRoomId);
      if (!WPWS.isConnected()) {
        ensureControllerConnection();
      }
    }
    applyLocalLeaveState(leavingRoomId);
    if (leaveSent) WPWS.markApplicationReady();
  }

  async function drainDeferredLeaveIntent() {
    if (!deferredLeaveIntent?.roomId || !WPWS.isReady()) return false;
    const operation = beginRoomOperation();
    const roomId = deferredLeaveIntent.roomId;
    const stored = await getExtensionState(WPConstants.STORAGE.USERNAME).catch(() => ({}));
    const username = stored?.[WPConstants.STORAGE.USERNAME];
    sendSessionHello(username);
    const accessKey = await loadStoredAccessKey(roomId);
    const payload = await buildRoomAccessPayload(roomId, accessKey);
    if (!isCurrentRoomOperation(operation) || deferredLeaveIntent?.roomId !== roomId) return false;
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
      stream?.videoId || '',
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
    return inRoom && isControllerTab && isActiveVideoTab && amIHost()
      && WPWS.isConnected() && WPWS.isApplicationReady();
  }

  function requestLatestHostSync() {
    if (!inRoom || isHost || !isActiveVideoTab || !WPWS.isReady()) return;
    playbackSyncRequestPending = true;
    if (WPWS.supportsCapability(WPProtocol.CAPABILITY?.PLAYBACK_TIMELINE_V1)) {
      WPWS.send({ type: WPProtocol.COMMAND.ROOM_PLAYBACK_REQUEST, payload: {} });
      return;
    }
    const player = roomState?.player || WPProtocol.DEFAULT_PLAYER;
    WPWS.send({
      type: WPProtocol.COMMAND.ROOM_PLAYBACK_PUBLISH,
      payload: {
        paused: player.paused === true,
        buffering: player.buffering === true,
        time: Number.isFinite(player.time) ? Math.max(0, player.time) : 0,
        speed: Number.isFinite(player.speed) ? player.speed : 1,
      },
    });
  }

  function syncPeerVideoToRoom(options = {}) {
    if (isHost || !video || !roomState?.player) return;
    if (!reconcileFollowerMedia()) return;
    if (!WPSync.isAttached()) attachSync();
    WPSync.applyRemote(roomState.player, { force: options.force === true });
    if (options.requestFresh === true) requestLatestHostSync();
    const drift = WPSync.getLastDrift();
    WPOverlay.updateSyncIndicator(isHost, drift);
    WPOverlay.showCatchUpButton(drift);
  }

  function pauseHostPlaybackForAutoPause() {
    if (!isHost) return;
    const activeVideo = getActiveVideoElement();
    if (!activeVideo || activeVideo.paused) return;
    activeVideo.pause();
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
    const directJoin = WPRoomDomain.hasDirectJoinFromJoinHint(room.joinHint)
      ? WPDirectPlay.classifyStream(room.stream)
      : { hasDirectJoin: false, url: null, directJoinType: room.joinHint?.directJoinType, failureReason: room.joinHint?.failureReason };
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

  function trustedPlayerRoute(value) {
    try {
      const url = new URL(value);
      if (!['https://web.stremio.com', 'https://web.strem.io', 'https://app.strem.io'].includes(url.origin)
        || !url.hash.startsWith('#/player/')) return null;
      return url;
    } catch { return null; }
  }

  function playerContentIdentity(value, stream = {}, meta = {}) {
    const target = trustedPlayerRoute(value);
    const match = target?.hash.match(/^#\/player\/[^/?#]+\/[^/?#]+\/[^/?#]+\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)/);
    try {
      const type = match ? decodeURIComponent(match[1]) : meta?.type;
      const id = match ? decodeURIComponent(match[2]) : meta?.id;
      const videoId = stream.videoId || (match ? decodeURIComponent(match[3]) : null);
      if (type === 'movie' && id && id !== 'unknown' && id !== 'pending') return `movie:${id}`;
      if (videoId) return `video:${videoId}`;
      // A series ID identifies the title, not the episode. Never treat two
      // episodes as matching solely because their parent series is the same.
      return null;
    } catch { return null; }
  }

  function roomContentIdentity(room) {
    return playerContentIdentity(room?.stream?.url, room?.stream, room?.meta);
  }

  function nativeMatchesRoomMedia(room = roomState, ignoreTransition = false) {
    if (!video || !room?.stream) return true;
    const stream = room.stream;
    if (!stream.url || stream.url === PLACEHOLDER_STREAM_URL) return true;
    const source = video.currentSrc || video.src || '';
    const currentContext = WPStremioAdapter.getCurrentContentContext();
    const canonicalIdentity = roomContentIdentity(room);
    const localIdentity = playerContentIdentity(currentContext.launchUrl);
    if (canonicalIdentity && localIdentity && canonicalIdentity !== localIdentity) return false;
    // A direct source match is stronger evidence than transient SPA routes.
    if (source && (source === stream.resolvedUrl || source === stream.url)) return true;
    if (!ignoreTransition && blockedMedia?.streamKey === buildSharedStreamKey(stream)
      && blockedMedia.video === video && blockedMedia.source === source) return false;
    // Different accounts/providers legitimately use different source URLs
    // for the same episode. Compare its identity, not an access token or
    // provider transport, while retaining the old-native-video transition gate.
    if (canonicalIdentity && canonicalIdentity === localIdentity) return true;
    const target = trustedPlayerRoute(stream.url);
    const current = trustedPlayerRoute(currentContext.launchUrl);
    // Routes include Stremio's encoded stream identity and episode/video ID.
    // They also work for blob/MSE, torrent and provider-proxied native sources.
    if (target && current) return target.hash === current.hash;
    return false;
  }

  function reconcileFollowerMedia() {
    if (isHost || !video || !inRoom) return true;
    if (nativeMatchesRoomMedia()) {
      blockedMedia = null;
      followerContentChanged = false;
      return true;
    }
    // Continuing to show a green sync indicator on a different episode is
    // worse than waiting explicitly for the matching player to be ready.
    WPSync.detach();
    if (!video.paused) video.pause?.();
    document.getElementById('wp-catchup-btn')?.remove();
    const key = `${roomState.id}:${buildSharedStreamKey(roomState.stream)}`;
    if (followedContentKey !== key) {
      followedContentKey = key;
      const directJoin = WPRoomDomain.hasDirectJoinFromJoinHint(roomState.joinHint) && typeof WPDirectPlay !== 'undefined'
        ? WPDirectPlay.classifyStream?.(roomState.stream) : null;
      const target = directJoin?.hasDirectJoin ? trustedPlayerRoute(directJoin.url) : null;
      if (followerContentChanged && isActiveVideoTab && target) {
        // Keep the user's Stremio origin/profile, and never navigate a page
        // to an arbitrary remote media URL supplied by another participant.
        WPOverlay.showToast('Host changed the stream. Opening the new video...', 3000);
        window.location.hash = target.hash.slice(1);
      } else {
        WPOverlay.showToast(target
          ? 'Your video differs from the host. Open the host stream to resume synchronization.'
          : 'The host changed content. Choose your own stream for the matching title and episode to resume synchronization.', 4500);
      }
    }
    return false;
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

  function clearPlaybackProjectionTimer() {
    if (!playbackProjectionTimer) return;
    WPRuntimeClock.clearTimeout(playbackProjectionTimer);
    playbackProjectionTimer = null;
  }

  function schedulePlaybackProjection(immediate = false) {
    if (immediate) {
      clearPlaybackProjectionTimer();
      persistState();
      return;
    }
    if (playbackProjectionTimer) return;
    playbackProjectionTimer = WPRuntimeClock.setTimeout(() => {
      playbackProjectionTimer = null;
      if (inRoom && roomState?.id) persistState();
    }, PLAYBACK_PROJECTION_INTERVAL_MS);
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
      // commitRoomState has already invalidated the old private context.
      // Never clear global crypto after awaiting cleanup for an old room.
      await clearPrivateKeysForRoom(roomId);
      return;
    }
    if (!pendingVisibilityPrivateKeys || pendingVisibilityPrivateKeyRoomId !== roomId) return;
    const keys = pendingVisibilityPrivateKeys;
    pendingVisibilityPrivateKeys = null;
    pendingVisibilityPrivateKeyRoomId = null;
    if (roomState?.id !== roomId || roomState.public !== false) return;
    // Start importing in the acknowledged room context, before any storage
    // await. A subsequent room change invalidates the import generation.
    if (keys.e2eKey && typeof WPCrypto !== 'undefined') {
      try {
        WPCrypto.clear();
        const importing = WPCrypto.importKey(keys.e2eKey);
        await Promise.all([importing, cachePrivateKeysForRoom(roomId, keys)]);
      } catch { /* ignore import failures for local recovery */ }
    } else {
      await cachePrivateKeysForRoom(roomId, keys);
    }
  }

  function publishSessionState() {
    if (!isControllerTab) return;
    syncControllerRuntimeState('publish.session-state');
    syncAdapterRuntimeState('publish.session-state');
    notifyBackground({
      action: WPConstants.ACTION.SESSION_STATE_PUBLISH,
      payload: {
        controllerLeaseId,
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
    WPWS.setRoomScope(nextRoom.id);
    clearPlaybackProjectionTimer();
    rememberPlaybackEpochTransition(roomState, nextRoom);
    const previousRoomId = roomState?.id;
    const previousPublic = roomState?.public;
    const previousStreamKey = buildSharedStreamKey(roomState?.stream);
    const nextStreamKey = buildSharedStreamKey(nextRoom.stream);
    if (previousRoomId !== nextRoom.id) {
      roomContextGeneration += 1;
      visibilityOperationRevision += 1;
      pendingContentPublication = null;
      pendingVisibilityPrivateKeys = null;
      pendingVisibilityPrivateKeyRoomId = null;
      blockedMedia = null;
      followedContentKey = null;
      followerContentChanged = false;
    } else if (previousStreamKey !== nextStreamKey && !WPUtils.isCurrentSessionOwner(nextRoom, userId, sessionId)
      && !(roomContentIdentity(roomState) && roomContentIdentity(roomState) === roomContentIdentity(nextRoom))) {
      followerContentChanged = true;
      // Even after route navigation a provider may briefly retain the old
      // <video>. Do not give that element the new content's timeline.
      const source = video?.currentSrc || video?.src || '';
      blockedMedia = video && !(source && (source === nextRoom.stream?.resolvedUrl || source === nextRoom.stream?.url))
        ? { video, source, streamKey: nextStreamKey } : null;
      pendingContentPublication = null;
    }
    roomState = nextRoom;
    if (pendingHostPlaybackRestore) {
      if (pendingHostPlaybackRestore.roomId !== nextRoom.id || !WPUtils.isCurrentSessionOwner(nextRoom, userId, sessionId)) {
        clearHostPlaybackRestore();
      } else if (nextRoom.player) {
        const pendingTimeline = WPPlaybackTimeline.normalizeTimeline(pendingHostPlaybackRestore.player);
        const currentTimeline = WPPlaybackTimeline.normalizeTimeline(nextRoom.player);
        if (pendingTimeline?.epoch !== currentTimeline?.epoch) {
          // Content may change while a provider is still loading. The old
          // video's deferred position must never seed the new content epoch.
          pendingHostPlaybackRestore.requestedFresh = false;
        }
        pendingHostPlaybackRestore.player = { ...nextRoom.player };
      }
    }
    resumeRoomPending = true;
    syncControllerRuntimeState(`room.${options.lifecycle || 'sync'}`);
    if (options.membershipOperation?.kind === 'create' && options.membershipOperation.keys && roomState.id) {
      const createdPrivateKeys = options.membershipOperation.keys;
      cachePrivateKeysForRoom(roomState.id, createdPrivateKeys).catch(() => {});
      if (createdPrivateKeys.e2eKey && typeof WPCrypto !== 'undefined') {
        WPCrypto.clear();
        WPCrypto.importKey(createdPrivateKeys.e2eKey).catch(() => {});
      }
      pendingCreatedPrivateKeys = null;
    } else if (options.membershipOperation?.kind === 'join' || pendingJoinedPrivateKeys?.roomId === roomState.id) {
      const joinedKeys = options.membershipOperation?.keys || pendingJoinedPrivateKeys;
      pendingJoinedPrivateKeys = null;
      // A rejected join must never replace the old room's active chat key.
      // Adopt the target key only once membership is acknowledged.
      WPCrypto.clear();
      if (roomState.public === false && joinedKeys?.e2eKey) {
        WPCrypto.importKey(joinedKeys.e2eKey).catch(() => {});
      }
    } else if (previousRoomId !== roomState.id || (roomState.public !== false && previousPublic === false)) {
      WPCrypto.clear();
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

  function rememberPlaybackEpochTransition(previousRoom, nextRoom) {
    if (previousRoom?.id !== nextRoom?.id) {
      retiredPlaybackEpochs = new Set();
      return;
    }
    const previousTimeline = WPPlaybackTimeline.normalizeTimeline(previousRoom?.player);
    const nextTimeline = WPPlaybackTimeline.normalizeTimeline(nextRoom?.player);
    if (!previousTimeline || !nextTimeline || previousTimeline.epoch === nextTimeline.epoch) return;
    retiredPlaybackEpochs.add(previousTimeline.epoch);
    if (retiredPlaybackEpochs.size > 8) {
      retiredPlaybackEpochs.delete(retiredPlaybackEpochs.values().next().value);
    }
  }

  function applyPlaybackUpdate(payload, options = {}) {
    const nextPlayer = payload?.player;
    if (!roomState?.id || !nextPlayer || typeof nextPlayer !== 'object') return false;
    const previousPlayer = roomState.player || WPProtocol.DEFAULT_PLAYER;
    const nextTimeline = WPPlaybackTimeline.normalizeTimeline(nextPlayer);
    if (nextTimeline && retiredPlaybackEpochs.has(nextTimeline.epoch)) return false;
    const serverAuthority = payload.authority === 'server';
    if (!WPPlaybackTimeline.isNewerFrame(nextPlayer, previousPlayer, {
      allowSameSequence: options.force === true || serverAuthority || !!pendingHostPlaybackRestore,
    })) return false;

    prevPlayerTime = Number.isFinite(previousPlayer.time) ? previousPlayer.time : 0;
    const nextRoom = { ...roomState, player: { ...nextPlayer } };
    rememberPlaybackEpochTransition(roomState, nextRoom);
    roomState = nextRoom;
    resumeRoomPending = true;

    const pausedEdge = previousPlayer.paused !== nextPlayer.paused;
    const bufferingEdge = previousPlayer.buffering !== nextPlayer.buffering;
    const timeJump = Math.abs((Number(nextPlayer.time) || 0) - prevPlayerTime) > 5;

    if (pendingHostPlaybackRestore && isHost) {
      pendingHostPlaybackRestore.player = { ...nextPlayer };
      restoreHostPlayback();
    } else if (isHost && video && serverAuthority) {
      WPSync.applyRemote(nextPlayer, { authoritative: true, force: true });
    } else if (!isHost && video) {
      if (timeJump) {
        const newTime = Number(nextPlayer.time) || 0;
        const mins = Math.floor(newTime / 60);
        const secs = Math.floor(newTime % 60).toString().padStart(2, '0');
        WPOverlay.showToast(`Host seeked to ${mins}:${secs}`);
      }
      syncPeerVideoToRoom({ force: options.force === true });
    }

    schedulePlaybackProjection(pausedEdge || bufferingEdge || timeJump);
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
    return commitRoomState(reduced.room, { ...options, lifecycle: options.lifecycle || 'sync' });
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
    // SESSION_READY is the one bootstrap entry point. An independent async
    // rejoin here used to race it and send a second join/create on every
    // reconnect, cancelling ready checks and publishing duplicate membership.
  });

  WPWS.onDisconnect(() => {
    roomIntentResponses.invalidate();
    pendingActionsPromise = null;
    pendingMembershipOperations.clear();
    clearHostPlaybackRestore();
    if (!isControllerTab) return;
    playbackSyncRequestPending = false;
    scheduleReconnectNotice();
    persistConnectionState();
    syncControllerRuntimeState('ws.disconnected');
    refreshOverlay();
  });

  function processWsEvent(msg) {
    if (!msg || !msg.type) return;
    const p = msg.payload;
    const eventRoomId = msg.roomId || p?.roomId;
    if (eventRoomId && msg.type !== WPProtocol.EVENT.ROOM_SNAPSHOT
      && msg.type !== WPProtocol.EVENT.ROOM_ERROR && eventRoomId !== roomState?.id) return;
    if (!roomState?.id && msg.type.startsWith('room.')
      && msg.type !== WPProtocol.EVENT.ROOM_SNAPSHOT && msg.type !== WPProtocol.EVENT.ROOM_ERROR) return;

    switch (msg.type) {
      case WPProtocol.EVENT.SESSION_READY:
        if (!p?.user?.id) return;
        userId = p.user.id;
        WPWS.setServerCapabilities(p.capabilities);
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
        {
          const cancelled = p.clientRequestId ? cancelledMembershipOperations.get(p.clientRequestId)
            : [...cancelledMembershipOperations.values()].find((operation) => operation.legacy
              && (operation.kind === 'join' ? operation.roomId === p.id : operation.previousRoomId !== p.id));
          if (cancelled) {
            cancelledMembershipOperations.delete(cancelled.requestId);
            // LEAVE is already ordered behind this request. Sending another
            // leave here could remove a newer explicit room the user joined.
            return;
          }
        }
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
        {
          const requestId = p.clientRequestId;
          // Old servers can be matched safely only when one operation is in
          // flight (or by a known join target). Never give a create's key to
          // an unrelated snapshot just because it arrived first.
          const candidates = [...pendingMembershipOperations.values()];
          const membershipOperation = requestId ? pendingMembershipOperations.get(requestId)
            : !supportsMembershipRequestIds()
              ? candidates.find((operation) => operation.kind === 'join' && operation.roomId === p.id)
                || (candidates.length === 1 && candidates[0].kind === 'create' && p.id !== roomState?.id ? candidates[0] : null)
              : null;
          if (membershipOperation) pendingMembershipOperations.delete(membershipOperation.requestId);
          if (lastJoinAttemptRoomId === p.id && (!requestId || requestId === pendingJoinAttempt?.requestId)) {
            lastJoinAttemptRoomId = null;
            pendingJoinAttempt = null;
          }
          delete p.clientRequestId;
          const resumingExistingRoom = !WPWS.isApplicationReady() && roomState?.id === p.id;
          if (resumingExistingRoom && WPUtils.isCurrentSessionOwner(p, userId, sessionId) && p.player) {
            pendingHostPlaybackRestore = { roomId: p.id, player: { ...p.player } };
          }
          adoptRoomSnapshot(p, {
            lifecycle: (!inRoom || !roomState?.id || roomState.id !== p.id) ? 'joined' : 'sync',
            membershipOperation,
          });
          if (pendingHostPlaybackRestore && isHost && video) {
            attachSync();
            restoreHostPlayback();
          }
        }
        if (pendingMembershipOperations.size === 0) {
          WPWS.markApplicationReady();
          if (pendingRoomCreateCommand || pendingRoomJoinCommand) processPendingActions();
        }
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
        if (p?.command === WPProtocol.COMMAND.ROOM_CONTENT_UPDATE) pendingContentPublication = null;
        WPOverlay.showRoomError?.(p);
        notifyBackground({ action: WPConstants.ACTION.ROOM_ERROR_EVENT, payload: p });
        // Correlated errors reject only their own draft; legacy servers can
        // still report an unscoped chat error. An accepted canonical echo is
        // the only confirmation that clears a pending draft.
        if (p?.command === WPProtocol.COMMAND.ROOM_CHAT_SEND
          || (!p?.command && lastUserAction === WPConstants.ACTION.ROOM_CHAT_SEND)) {
          if (!p?.roomId || p.roomId === roomState?.id) {
            WPOverlay.rejectPendingChat?.(p?.message || 'The message was not accepted.', p?.clientMessageId);
          }
        }
        if (p?.clientRequestId) {
          pendingMembershipOperations.delete(p.clientRequestId);
          if (pendingMembershipOperations.size === 0) WPWS.markApplicationReady();
        } else if (!supportsMembershipRequestIds() && pendingMembershipOperations.size === 1) {
          const operation = pendingMembershipOperations.values().next().value;
          const expectedCommand = operation.kind === 'create' ? WPProtocol.COMMAND.ROOM_CREATE : WPProtocol.COMMAND.ROOM_JOIN;
          if (!p?.command || p.command === expectedCommand || (operation.kind === 'join' && p.command === WPProtocol.COMMAND.ROOM_REJOIN)) {
            pendingMembershipOperations.delete(operation.requestId);
            WPWS.markApplicationReady();
          }
        }
        if (deferredLeaveIntent?.roomId && lastJoinAttemptRoomId === deferredLeaveIntent.roomId) {
          clearDeferredLeaveIntent(deferredLeaveIntent.roomId);
        }
        {
          const joinError = !p?.command || p.command === WPProtocol.COMMAND.ROOM_JOIN || p.command === WPProtocol.COMMAND.ROOM_REJOIN;
          const matchingAttempt = joinError && lastJoinAttemptRoomId
            && (!p?.roomId || p.roomId === lastJoinAttemptRoomId)
            && (!p?.clientRequestId || p.clientRequestId === pendingJoinAttempt?.requestId);
          const rejectedJoin = matchingAttempt && [WPProtocol.ERROR_CODE.ROOM_NOT_FOUND,
            WPProtocol.ERROR_CODE.INVALID_ROOM_KEY, WPProtocol.ERROR_CODE.ROOM_KEY_REQUIRED,
            WPProtocol.ERROR_CODE.USERNAME_IN_USE, WPProtocol.ERROR_CODE.COOLDOWN,
            WPProtocol.ERROR_CODE.VALIDATION_FAILED].includes(p?.code);
          if (rejectedJoin) {
            const target = lastJoinAttemptRoomId;
            if (pendingJoinAttempt?.requestId) pendingMembershipOperations.delete(pendingJoinAttempt.requestId);
            const retainedMembership = pendingJoinAttempt?.acknowledgedMembership === true
              && pendingJoinAttempt.previousRoomId === roomState?.id
              && pendingJoinAttempt.connection === WPWS.getConnectionGeneration();
            clearPendingJoinOptions(target);
            pendingJoinedPrivateKeys = null;
            pendingJoinAttempt = null;
            lastJoinAttemptRoomId = null;
            if (!retainedMembership && roomState?.id === target) {
              applyLocalLeaveState(target, { preservePrivateKeys: true });
            }
            if (p.code === WPProtocol.ERROR_CODE.INVALID_ROOM_KEY && target !== roomState?.id) {
              clearPrivateKeysForRoom(target).catch(() => {});
            }
            WPWS.clearQueue();
            WPWS.markApplicationReady();
            clearBootstrapRoomIntent();
            refreshOverlay();
            persistState();
          }
          if (p?.code === WPProtocol.ERROR_CODE.ROOM_NOT_FOUND) {
            WPOverlay.showToast('Requested room does not exist. Your current room has not been changed.', 3500);
          }
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
            const currentUsername = resolveKnownUsername();
            if (currentUsername) {
              setExtensionState({ [WPConstants.STORAGE.USERNAME]: currentUsername }).catch(() => {});
            }
            WPOverlay.showToast('That display name is already in use in this room.', 3000);
          } else if (p.code !== WPProtocol.ERROR_CODE.COOLDOWN && p.code !== WPProtocol.ERROR_CODE.VALIDATION_FAILED) {
            WPOverlay.showToast(p.message, 2000);
          }
        }
        if (pendingMembershipOperations.size === 0 && (pendingRoomCreateCommand || pendingRoomJoinCommand)) processPendingActions();
        break;

      case WPProtocol.EVENT.ROOM_TYPING_UPDATED:
        if (!p?.user) return;
        onTyping(p.user, p.typing);
        break;

      case WPProtocol.EVENT.ROOM_REACTION_APPENDED:
        if (!p?.user || !p?.emoji) return;
        WPOverlay.showReaction(p.user, p.emoji, roomState, p.messageId || null);
        notifyBackground({ action: WPConstants.ACTION.ROOM_REACTION_EVENT, payload: { ...p, roomId: roomState?.id } });
        break;

      case WPProtocol.EVENT.ROOM_PLAYBACK_AUTOPAUSED:
        if (!p?.name) return;
        pauseHostPlaybackForAutoPause();
        WPOverlay.showToast(`Paused \u2014 ${p.name} disconnected`);
        break;

      case WPProtocol.EVENT.ROOM_READY_CHECK_UPDATED:
        applyReducedRoomEvent(msg.type, p);
        WPOverlay.showReadyCheck(p.action, p.confirmed, p.total, sessionId || userId);
        break;

      case WPProtocol.EVENT.ROOM_READY_CHECK_COUNTDOWN:
        WPOverlay.showCountdown(p.seconds);
        break;

      case WPProtocol.EVENT.ROOM_BOOKMARK_APPENDED:
        if (!p) return;
        applyReducedRoomEvent(msg.type, p);
        WPOverlay.appendBookmark(p);
        notifyBackground({ action: WPConstants.ACTION.ROOM_BOOKMARK_EVENT, payload: { ...p, roomId: roomState?.id } });
        break;

      // --- Delta events (lightweight, avoid full room broadcasts) ---

      case WPProtocol.EVENT.ROOM_PLAYBACK_UPDATED:
        if (!p?.player || !roomState) return;
        {
          const forcePlaybackSync = playbackSyncRequestPending;
          if (applyPlaybackUpdate(p, { force: forcePlaybackSync })) {
            playbackSyncRequestPending = false;
          }
        }
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
  function supportsMembershipRequestIds() {
    return WPWS.supportsCapability(WPProtocol.CAPABILITY?.MEMBERSHIP_REQUEST_ID_V1);
  }

  function beginRoomOperation() {
    return { revision: roomIntentResponses.begin(), connection: WPWS.getConnectionGeneration(), requestId: crypto.randomUUID() };
  }

  function isCurrentRoomOperation(operation) {
    return extOk() && isControllerTab && WPWS.isReady()
      && operation.connection === WPWS.getConnectionGeneration()
      && roomIntentResponses.isCurrent(operation.revision);
  }

  async function createRoomFromCommand(command) {
    if (!command || !isControllerTab || !WPWS.isReady()) return;
    if (switchBackendForCommand(command, stagePendingRoomCreateCommand)) return;
    if (!supportsMembershipRequestIds() && pendingMembershipOperations.size > 0) {
      stagePendingRoomCreateCommand(command);
      return;
    }
    const operation = beginRoomOperation();
    pendingJoinedPrivateKeys = null;
    WPWS.clearQueue();
    WPWS.markApplicationPending();
    try {
      clearPendingJoinOptions();
      // Creation is an atomic server-side membership transition too. Keep
      // the acknowledged room/key until its replacement is accepted.
      sendSessionHello(command?.username);
      const context = WPStremioAdapter.getCurrentContentContext();
      const seedMeta = (isPlaceholderMeta(command?.meta) && context.meta) ? context.meta : command?.meta;
      const meta = await enrichContentMeta(seedMeta, context.launchUrl);
      if (!isCurrentRoomOperation(operation)) return;
      const rawStream = (isPlaceholderStream(command?.stream) && context.launchUrl)
        ? { url: context.launchUrl }
        : command?.stream;
      const { stream, joinHint } = await normalizeSharedStreamPayload(rawStream);
      if (!isCurrentRoomOperation(operation)) return;
      const isPublic = command?.public === true;
      const isListed = command?.listed !== false;
      /** @type {{ meta: any, stream: any, joinHint: any, public: boolean, listed: boolean, visibility: string, clientRequestId?: string, accessKey?: string, name?: string }} */
      const payload = {
        ...(supportsMembershipRequestIds() ? { clientRequestId: operation.requestId } : {}),
        meta,
        stream,
        joinHint,
        public: isPublic,
        listed: isListed,
        visibility: WPRoomDomain.visibilityFromPublic(isPublic),
      };
      if (payload.public === false) {
        const privateKeys = await resolvePrivateInviteKeys(command);
        if (!isCurrentRoomOperation(operation)) return;
        pendingCreatedPrivateKeys = privateKeys;
        if (!pendingCreatedPrivateKeys) {
          WPOverlay.showToast('Failed to generate a private access key.', 2500);
          WPWS.markApplicationReady();
          return;
        }
        payload.accessKey = pendingCreatedPrivateKeys.accessKey;
      } else {
        pendingCreatedPrivateKeys = null;
      }
      if (command?.roomName) payload.name = command.roomName;
      pendingMembershipOperations.set(operation.requestId, {
        ...operation, kind: 'create', keys: pendingCreatedPrivateKeys, legacy: !supportsMembershipRequestIds(),
      });
      if (!WPWS.send({ type: WPProtocol.COMMAND.ROOM_CREATE, payload })) {
        pendingMembershipOperations.delete(operation.requestId);
        WPWS.markApplicationReady();
      }
    } catch (error) {
      if (!isCurrentRoomOperation(operation)) return;
      WPWS.markApplicationReady();
      console.warn('[WatchParty] Failed to create room from command:', formatErrorMessage(error));
      WPOverlay.showToast('Failed to create the room from this Stremio page.', 3000);
    }
  }

  async function joinRoomFromCommand(command, stored = {}, options = {}) {
    if (!isControllerTab) return;
    if (switchBackendForCommand(command, stagePendingRoomJoinCommand)) return;
    if (!supportsMembershipRequestIds() && pendingMembershipOperations.size > 0) {
      stagePendingRoomJoinCommand(command);
      return;
    }
    const roomToJoin = command?.roomId;
    if (!roomToJoin || !extOk() || !WPWS.isReady()) return;
    const resumingProjectedRoom = options.replay === true
      && !WPWS.isApplicationReady() && roomState?.id === roomToJoin;
    const acknowledgedMembership = (WPWS.isApplicationReady()
      || (pendingJoinAttempt?.acknowledgedMembership && pendingJoinAttempt.previousRoomId === roomState?.id
        && pendingJoinAttempt.connection === WPWS.getConnectionGeneration())) && inRoom && !!roomState?.id;
    const previousRoomId = roomState?.id;
    const operation = beginRoomOperation();
    if (roomToJoin !== roomState?.id) WPWS.clearQueue();
    WPWS.markApplicationPending();
    const joinOptions = command?.preferDirectJoin === true
      ? { roomId: roomToJoin, preferDirectJoin: true }
      : null;
    syncPendingJoinOptions(joinOptions, roomToJoin);

    const accessKey = normalizePrivateKeyInput(command?.accessKey) || await loadStoredAccessKey(roomToJoin);
    const requestedE2eKey = normalizePrivateKeyInput(command?.e2eKey);
    const e2eKey = requestedE2eKey || (extOk() ? await WPRoomKeys.getE2eKey(roomToJoin) : null);
    if (!isCurrentRoomOperation(operation)) return;
    if (!e2eKey && (accessKey || (resumingProjectedRoom && roomState?.public === false))) {
      if (resumingProjectedRoom) {
        // A new socket has not rejoined this cached membership. Keep the
        // access credential for invite recovery, but do not present stale
        // users/host controls as an authenticated live room.
        applyLocalLeaveState(roomToJoin, { preservePrivateKeys: true });
      }
      WPOverlay.showToast('Paste the full invite link so private-room chat stays encrypted.', 3500);
      WPOverlay.openSidebar('room');
      WPWS.markApplicationReady();
      return;
    }
    if (accessKey || e2eKey) {
      await cachePrivateKeysForRoom(roomToJoin, { accessKey, e2eKey });
    }
    if (!isCurrentRoomOperation(operation)) return;
    const username = command?.username || stored[WPConstants.STORAGE.USERNAME];
    sendSessionHello(username);
    const payload = { ...await buildRoomAccessPayload(roomToJoin, accessKey),
      ...(supportsMembershipRequestIds() ? { clientRequestId: operation.requestId } : {}) };
    if (!isCurrentRoomOperation(operation)) return;
    pendingJoinedPrivateKeys = { roomId: roomToJoin, e2eKey };
    lastJoinAttemptRoomId = roomToJoin;
    pendingJoinAttempt = { roomId: roomToJoin, previousRoomId, acknowledgedMembership, connection: operation.connection, requestId: operation.requestId };
    pendingMembershipOperations.set(operation.requestId, { ...operation, kind: 'join', roomId: roomToJoin, keys: { e2eKey }, legacy: !supportsMembershipRequestIds() });
    const lastSeq = options.replay === true ? WPWS.getLastSeq() : 0;
    if (!WPWS.send(lastSeq > 0
      ? { type: WPProtocol.COMMAND.ROOM_REJOIN, payload: { ...payload, lastSeq } }
      : { type: WPProtocol.COMMAND.ROOM_JOIN, payload })) {
      pendingMembershipOperations.delete(operation.requestId);
      pendingJoinAttempt = null;
      lastJoinAttemptRoomId = null;
      WPWS.markApplicationReady();
    }
  }

  function processPendingActions() {
    if (!WPWS.isReady() || !extOk() || !isControllerTab) return;
    if (!supportsMembershipRequestIds() && pendingMembershipOperations.size > 0) return;
    // sessionId MUST be loaded before sending any room messages — otherwise server can't dedup
    if (!sessionId) return;
    if (pendingActionsPromise) return pendingActionsPromise;
    const connection = WPWS.getConnectionGeneration();
    const cancellation = roomIntentCancellationGeneration;
    const canContinue = () => isControllerTab && WPWS.isReady()
      && connection === WPWS.getConnectionGeneration() && cancellation === roomIntentCancellationGeneration;
    const processing = getExtensionState([
      WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT,
      WPConstants.STORAGE.DEFERRED_LEAVE_ROOM,
      WPConstants.STORAGE.CURRENT_ROOM,
      WPConstants.STORAGE.USERNAME,
    ]).then(async (stored) => {
      if (!canContinue()) return;
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
        if (!canContinue()) return;
        if (bootstrapIntent.action === WPConstants.ACTION.ROOM_CREATE) {
          await createRoomFromCommand(bootstrapIntent);
          return;
        }
        if (bootstrapIntent.action === WPConstants.ACTION.ROOM_JOIN) {
          await joinRoomFromCommand(bootstrapIntent, stored);
          return;
        }
      }

      // Storage notifications can wake us after a completed join. Only a
      // newly connected socket requires restoring its current membership.
      if (WPWS.isApplicationReady()) return;
      const roomToJoin = roomState?.id || stored[WPConstants.STORAGE.CURRENT_ROOM] || null;
      if (roomToJoin) {
        await joinRoomFromCommand({
          roomId: roomToJoin,
          username: stored[WPConstants.STORAGE.USERNAME],
          accessKey: await loadStoredAccessKey(roomToJoin),
          e2eKey: extOk() ? await WPRoomKeys.getE2eKey(roomToJoin) : null,
        }, stored, { replay: true });
        return;
      }
      WPWS.markApplicationReady();
    }).catch((error) => {
      if (canContinue()) console.warn('[WatchParty] Room bootstrap failed:', formatErrorMessage(error));
    }).finally(() => {
      if (pendingActionsPromise !== processing) return;
      pendingActionsPromise = null;
      if (canContinue() && (supportsMembershipRequestIds() || pendingMembershipOperations.size === 0)
        && (pendingRoomCreateCommand || pendingRoomJoinCommand)) processPendingActions();
    });
    pendingActionsPromise = processing;
    return processing;
  }

  /** Load the session-only E2E crypto key for a room. */
  function loadCryptoKeyForRoom(roomId) {
    if (!extOk()) return Promise.resolve();
    const context = roomContextGeneration;
    return WPRoomKeys.loadIntoCrypto(roomId, {
      isCurrent: () => roomState?.id === roomId && roomState.public === false && roomContextGeneration === context,
    }).then(() => {});
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
    WPSync.setHost(isHost);
    if (video) {
      refreshActiveVideoLease({ force: true }).catch(() => {});
      attachSync();
    }
    refreshOverlay();
    const directJoinResult = !isHost ? maybeHandlePendingDirectJoin(roomState) : null;
    if (!isHost) reconcileFollowerMedia();
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
            const roomId = roomState.id;
            const context = roomContextGeneration;
            const hash = window.location.hash;
            WPOverlay.showToast(`Navigating to: ${meta.name || meta.id}`);
            WPRuntimeClock.setTimeout(() => {
              if (inRoom && !video && roomState?.id === roomId && context === roomContextGeneration
                && window.location.hash === hash) window.location.hash = detailUrl.slice(1);
            }, 500);
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
    if (!isHost && !reconcileFollowerMedia()) return;
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
    const messageRoomId = roomState?.id;
    if (!messageRoomId || (message.roomId && message.roomId !== messageRoomId)) return;
    const cryptoGeneration = WPCrypto.getGeneration();
    const rawMessage = message;
    if (options.persist !== false) {
      rememberStoredChatMessage(rawMessage);
      persistStoredChatHistory(roomState?.id).catch(() => {});
    }
    // Decrypt E2E-encrypted messages
    if (WPCrypto.isEncrypted(message.content)) {
      const decrypted = await WPCrypto.decryptResult(message.content);
      if (roomState?.id !== messageRoomId || WPCrypto.getGeneration() !== cryptoGeneration) return;
      if (!decrypted.ok) {
        // Key not loaded yet — buffer for retry when key arrives
        if (pendingEncryptedMessages.length < 50) pendingEncryptedMessages.push(message);
        return; // Don't display garbled text
      }
      message = { ...message, content: decrypted.content };
    }
    if (!rememberChatMessage(message)) return;
    WPOverlay.appendChatMessage(message, roomState, userId);
    if (options.incrementUnread !== false && !isMe(message.user)) WPOverlay.incrementUnread();
    // Relay to side panel (it can't access content script globals)
    if (options.relay !== false) {
      notifyBackground({ action: WPConstants.ACTION.ROOM_CHAT_EVENT, payload: { ...message, roomId: messageRoomId } });
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
    notifyBackground({ action: WPConstants.ACTION.ROOM_TYPING_EVENT, payload: { user, typing, userName, roomId: roomState?.id } });
  }

  function applyPassiveChatMessage(message) {
    if (!message || isControllerTab || !inRoom || (message.roomId && message.roomId !== roomState?.id)) return;
    if (!rememberChatMessage(message)) return;
    WPOverlay.appendChatMessage(message, roomState, userId);
  }

  function applyPassiveBookmark(message) {
    if (!message || isControllerTab || !inRoom || (message.roomId && message.roomId !== roomState?.id)) return;
    WPOverlay.appendBookmark(message);
  }

  function applyPassiveReaction(message) {
    if (!message || isControllerTab || !inRoom || (message.roomId && message.roomId !== roomState?.id)) return;
    WPOverlay.showReaction(message.user, message.emoji, roomState, message.messageId || null);
  }

  function applyPassiveTyping(message) {
    if (!message || isControllerTab || !inRoom || (message.roomId && message.roomId !== roomState?.id)) return;
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
      if (roomState?.id !== payload.room?.id) {
        roomContextGeneration += 1;
        visibilityOperationRevision += 1;
        pendingContentPublication = null;
        blockedMedia = null;
        followedContentKey = null;
        followerContentChanged = false;
        WPCrypto.clear();
      } else if (roomState?.public === false && payload.room?.public !== false) {
        WPCrypto.clear();
      }
      roomState = payload.room || null;
      inRoom = !!roomState?.id;
      isHost = amIHost();
      WPSync.setHost(isHost);
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
  function contentPublisher() {
    return controllerLease && isControllerTab
      ? { id: controllerLease.leaseId, fence: controllerLease.fence } : undefined;
  }

  function contentIsPublished(stream, meta, shareKey) {
    const canonicalMatches = buildSharedStreamKey(roomState?.stream) === buildSharedStreamKey(stream)
      && (!meta || (roomState.meta?.id === meta.id && roomState.meta?.type === meta.type && roomState.meta?.name === meta.name));
    if (canonicalMatches) {
      pendingContentPublication = null;
      return true;
    }
    // Only suppress a genuinely in-flight update, scoped to membership and
    // controller authority. A lost/rejected update must remain retryable.
    const pending = pendingContentPublication;
    return pending?.key === shareKey && pending.roomId === roomState?.id
      && pending.connection === WPWS.getConnectionGeneration()
      && pending.fence === controllerLease?.fence
      && WPRuntimeClock.now() - pending.at < 2500;
  }

  function publishContent(payload, shareKey) {
    const publisher = contentPublisher();
    if (!WPWS.send({ type: WPProtocol.COMMAND.ROOM_CONTENT_UPDATE,
      payload: { ...payload, roomId: roomState?.id, ...(publisher ? { publisher } : {}) } })) return false;
    pendingContentPublication = { key: shareKey, roomId: roomState?.id, connection: WPWS.getConnectionGeneration(),
      fence: controllerLease?.fence, at: WPRuntimeClock.now() };
    return true;
  }

  async function shareContentLink() {
    if (shareContentLinkInFlight) return;
    shareContentLinkInFlight = true;
    try {
      const context = WPStremioAdapter.getCurrentContentContext();
      const roomId = roomState?.id;
      const connection = WPWS.getConnectionGeneration();
      const fence = controllerLease?.fence;
      const canPublish = () => shouldShareHostContent() && roomState?.id === roomId
        && WPWS.getConnectionGeneration() === connection
        && controllerLease?.fence === fence
        && WPStremioAdapter.getCurrentContentContext().launchUrl === context.launchUrl;
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
      if (!canPublish()) return;

      if (!context.meta) {
        const streamOnlyKey = `stream:::${buildSharedStreamKey(stream)}`;
        if (contentIsPublished(stream, null, streamOnlyKey)) {
          syncAdapterRuntimeState('adapter.publish.cached', {
            joinHint,
            lastPublishedShareKey: streamOnlyKey,
            lastPublishedLaunchUrl: context.launchUrl || null,
          });
          return;
        }
        syncAdapterRuntimeState('adapter.publish.stream-only', {
          joinHint,
          lastPublishedShareKey: streamOnlyKey,
          lastPublishedLaunchUrl: context.launchUrl || null,
        });
        publishContent({ stream, joinHint }, streamOnlyKey);
        return;
      }

      const meta = await enrichContentMeta(context.meta, context.launchUrl);
      if (!canPublish()) return;
      const shareKey = `${meta.type}:${meta.id}:${meta.name || ''}:${buildSharedStreamKey(stream)}`;
      if (contentIsPublished(stream, meta, shareKey)) {
        syncAdapterRuntimeState('adapter.publish.cached', {
          contentMeta: meta,
          joinHint,
          lastPublishedShareKey: shareKey,
          lastPublishedLaunchUrl: context.launchUrl || null,
        });
        return;
      }
      syncAdapterRuntimeState('adapter.publish.content', {
        contentMeta: meta,
        joinHint,
        lastPublishedShareKey: shareKey,
        lastPublishedLaunchUrl: context.launchUrl || null,
      });
      publishContent({ stream, meta, joinHint }, shareKey);
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
  function clearHostPlaybackRestore() {
    hostPlaybackRestoreCleanup?.();
    hostPlaybackRestoreCleanup = null;
    pendingHostPlaybackRestore = null;
  }

  function restoreHostPlayback() {
    const pending = pendingHostPlaybackRestore;
    if (!pending) return true;
    if (roomState?.id !== pending.roomId || !isHost) {
      clearHostPlaybackRestore();
      return true;
    }
    if (!video || !WPSync.isAttached()) return false;
    if (video.readyState < 3) {
      hostPlaybackRestoreCleanup?.();
      const targetVideo = video;
      const onReady = () => {
        if (video === targetVideo) restoreHostPlayback();
      };
      targetVideo.addEventListener('loadedmetadata', onReady);
      targetVideo.addEventListener('canplay', onReady);
      hostPlaybackRestoreCleanup = () => {
        targetVideo.removeEventListener('loadedmetadata', onReady);
        targetVideo.removeEventListener('canplay', onReady);
      };
      return false;
    }
    if (!nativeMatchesRoomMedia()) {
      // Taking control in a sibling tab with a different source must publish
      // that source first, not restore another episode's saved position.
      clearHostPlaybackRestore();
      scheduleContentPublish(0);
      return true;
    }
    // The native Stremio player often appears and autoplays after the room
    // snapshot. Its startup events are not new host intent: restore the saved
    // position/pause first, even when no video existed at snapshot time.
    if (!WPSync.applyRemote(pending.player, { authoritative: true, force: true })) {
      // Long provider startup can outlive the freshness window. Ask the
      // server to re-sample its timeline instead of publishing startup time.
      if (!pending.requestedFresh && WPWS.isConnected()) {
        pending.requestedFresh = true;
        WPWS.send({ type: WPProtocol.COMMAND.ROOM_PLAYBACK_REQUEST, payload: {} });
      }
      return false;
    }
    clearHostPlaybackRestore();
    return true;
  }

  function buildPlaybackPublishPayload(state) {
    const player = {
      paused: state.paused === true,
      buffering: state.buffering === true,
      time: Number.isFinite(state.time) ? Math.max(0, state.time) : 0,
      speed: Number.isFinite(state.speed) ? Math.max(0.25, Math.min(4, state.speed)) : 1,
    };
    if (!WPWS.supportsCapability(WPProtocol.CAPABILITY?.PLAYBACK_TIMELINE_V1)) return player;

    const publisher = controllerLease && isControllerTab
      ? { id: controllerLease.leaseId, fence: controllerLease.fence }
      : undefined;
    return {
      player,
      roomId: roomState?.id,
      ...(Number.isFinite(state.sampledAtServer) ? { sampledAtServer: state.sampledAtServer } : {}),
      ...(publisher ? { publisher } : {}),
    };
  }

  function attachSync() {
    if (!video) return;
    if (!isHost && !reconcileFollowerMedia()) return;
    if (WPSync.isAttached()) {
      restoreHostPlayback();
      return;
    }
    WPSync.attach(video, {
      isHost,
      onSync(state) {
        if (pendingHostPlaybackRestore) {
          restoreHostPlayback();
          return;
        }
        if (roomState && shouldShareHostContent()) {
          if (!nativeMatchesRoomMedia()) {
            // A local episode switch is content intent, not a seek in the
            // previous episode. Wait for its canonical content acknowledgement.
            scheduleContentPublish(0);
            return;
          }
          maybeRepairSharedPlayerRoute();
          const payload = buildPlaybackPublishPayload(state);
          const localPlayer = 'player' in payload ? payload.player : payload;
          applyPlaybackUpdate({
            player: { ...(roomState.player || WPProtocol.DEFAULT_PLAYER), ...localPlayer },
          }, { force: true });
          WPWS.send({
            type: WPProtocol.COMMAND.ROOM_PLAYBACK_PUBLISH,
            payload,
          });
        }
      },
    });
    restoreHostPlayback();
  }

  // --- Overlay state refresh ---
  function refreshOverlay() {
    ensureChatHistoryRoom(inRoom ? roomState?.id : null);
    const wsConnected = isControllerTab ? WPWS.isConnected() : sessionWsConnected;
    const mediaMismatch = inRoom && !isHost && !!video && !nativeMatchesRoomMedia();
    WPOverlay.updateState({ inRoom, isHost, userId, sessionId, roomState, hasVideo: !!video, wsConnected, mediaMismatch });
    if (inRoom && roomState?.id) {
      const roomId = roomState.id;
      loadCryptoKeyForRoom(roomId)
        .catch(() => {})
        .then(() => { if (roomState?.id === roomId) return hydrateStoredChatHistory(roomId); })
        .catch(() => {});
    }
    if (inRoom && !isHost && !mediaMismatch) {
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
    return handleAction(detail, { source: 'local', sourceSurface: 'overlay' })
      .catch((error) => ({ handled: false, error: formatErrorMessage(error) }));
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
      stagePendingRoomCreateCommand(message);
      refreshControllerLease({ force: !!video && inRoom && isActiveVideoTab }).then((claimed) => {
        if (!claimed) {
          schedulePendingIntentWake();
          sendResponse({ handled: true, staged: true });
          return;
        }
        if (WPWS.isReady()) {
          processPendingActions();
        } else {
          ensureControllerConnection();
        }
        sendResponse({ handled: true });
      }).catch(() => sendResponse({ handled: false }));
      return true;
    }
    if (message.action === WPConstants.ACTION.ROOM_JOIN) {
      stagePendingRoomJoinCommand(message);
      refreshControllerLease({ force: !!video && inRoom && isActiveVideoTab }).then((claimed) => {
        if (!claimed) {
          schedulePendingIntentWake();
          sendResponse({ handled: true, staged: true });
          return;
        }
        if (WPWS.isReady()) {
          processPendingActions();
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
      stagePendingRoomCreateCommand(m);
      if (WPWS.isReady()) {
        processPendingActions();
      } else if (extOk()) {
        ensureControllerConnection();
      } else {
        ensureControllerConnection();
      }
    },
    [WPConstants.ACTION.ROOM_JOIN]: (m) => {
      stagePendingRoomJoinCommand(m);
      if (WPWS.isReady()) {
        processPendingActions();
      } else if (extOk()) {
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
      const roomId = roomState?.id;
      const connection = WPWS.getConnectionGeneration();
      const context = roomContextGeneration;
      const revision = ++visibilityOperationRevision;
      const fence = controllerLease?.fence;
      const isCurrent = () => !!roomId && roomState?.id === roomId && inRoom && isControllerTab
        && WPWS.isConnected() && WPWS.isApplicationReady()
        && connection === WPWS.getConnectionGeneration() && context === roomContextGeneration
        && revision === visibilityOperationRevision && fence === controllerLease?.fence;
      const staleResult = () => ({ handled: false, error: 'The room changed before its visibility could be updated.' });
      if (!isCurrent() || (m.roomId && m.roomId !== roomId)) return staleResult();
      const nextPublic = typeof m.public === 'boolean' ? m.public : (roomState?.public !== false);
      const nextListed = m.listed !== false;
      if (nextPublic === false) {
        const requestedAccessKey = normalizePrivateKeyInput(m.accessKey);
        const existingAccessKey = await loadStoredAccessKey(roomId);
        if (!isCurrent()) return staleResult();
        const existingE2eKey = extOk() ? await WPRoomKeys.getE2eKey(roomId) : null;
        if (!isCurrent()) return staleResult();
        const usersInRoom = Array.isArray(roomState?.users) ? roomState.users.length : 0;
        const alreadyPrivate = roomState?.public === false;
        if (!alreadyPrivate && usersInRoom > 1) {
          WPOverlay.showToast('Make the room private while you are alone, then invite everyone using the encrypted invite link.', 4000);
          refreshOverlay();
          return { handled: false, error: 'Other members need a new private invite link.' };
        }
        const isChangingAccessKey = !!requestedAccessKey && requestedAccessKey !== existingAccessKey;
        if (alreadyPrivate && isChangingAccessKey && usersInRoom > 1) {
          WPOverlay.showToast('Change the access key when you are alone in the room to avoid breaking private-room peers.', 3500);
          refreshOverlay();
          return { handled: false, error: 'Other members need the new private invite link.' };
        }
        if (alreadyPrivate && !requestedAccessKey && !existingAccessKey) {
          WPOverlay.showToast('This browser does not have the invite key for this private room.', 3000);
          refreshOverlay();
          return { handled: false, error: 'The private invite key is missing.' };
        }
        const accessKey = requestedAccessKey || existingAccessKey || WPPrivateRoomKeys.generateAccessKey();
        const e2eKey = normalizePrivateKeyInput(m.e2eKey)
          || existingE2eKey
          || (!alreadyPrivate ? await WPPrivateRoomKeys.generateE2eKey() : null);
        if (!isCurrent()) return staleResult();
        if (!accessKey || (!alreadyPrivate && !e2eKey)) {
          WPOverlay.showToast('Failed to generate a private access key.', 2500);
          refreshOverlay();
          return { handled: false, error: 'Private key generation failed.' };
        }
        pendingVisibilityPrivateKeys = { accessKey, e2eKey };
        pendingVisibilityPrivateKeyRoomId = roomId;
        return WPWS.send({
          type: WPProtocol.COMMAND.ROOM_VISIBILITY_UPDATE,
          payload: {
            roomId,
            public: false,
            visibility: WPRoomDomain.ROOM_VISIBILITY.INVITE_ONLY,
            listed: nextListed,
            accessKey,
          },
        });
      }
      pendingVisibilityPrivateKeys = null;
      pendingVisibilityPrivateKeyRoomId = roomState?.id || null;
      return WPWS.send({
        type: WPProtocol.COMMAND.ROOM_VISIBILITY_UPDATE,
        payload: {
          roomId,
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
      const roomId = roomState?.id;
      const connection = WPWS.getConnectionGeneration();
      const cryptoGeneration = WPCrypto.getGeneration();
      if (!roomId || !inRoom || !isControllerTab || !WPWS.isApplicationReady() || !WPWS.isConnected()) {
        return { handled: false, error: 'Reconnect to the room before sending.' };
      }
      if (m.roomId && m.roomId !== roomId) return { handled: false, error: 'The room changed before the message could be sent.' };
      if (roomState.public === false && !WPCrypto.isEnabled()) {
        return { handled: false, error: 'The private-room chat key is missing. Rejoin using the full invite link.' };
      }
      lastUserAction = WPConstants.ACTION.ROOM_CHAT_SEND;
      try {
        const content = roomState.public === false ? await WPCrypto.encrypt(m.content) : m.content;
        if (roomState?.id !== roomId || !isControllerTab || !inRoom
          || WPWS.getConnectionGeneration() !== connection || WPCrypto.getGeneration() !== cryptoGeneration
          || !WPWS.isConnected() || !WPWS.isApplicationReady()) {
          return { handled: false, error: 'The room changed before the message could be sent.' };
        }
        const clientMessageId = typeof m.clientMessageId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m.clientMessageId)
          ? m.clientMessageId : undefined;
        return { handled: WPWS.send({ type: WPProtocol.COMMAND.ROOM_CHAT_SEND,
          payload: { content, roomId, ...(clientMessageId ? { clientMessageId } : {}) } }) === true };
      } catch (error) {
        return { handled: false, error: formatErrorMessage(error) };
      }
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
    const isCreateOrJoin = action === WPConstants.ACTION.ROOM_CREATE || action === WPConstants.ACTION.ROOM_JOIN;
    let stagedControllerIntent = false;
    if (CONTROLLER_ACTIONS.has(action) && !isControllerTab) {
      if ((options.source === 'runtime' || options.source === 'local') && action === WPConstants.ACTION.ROOM_CREATE) {
        stagePendingRoomCreateCommand(message);
        stagedControllerIntent = true;
      }
      if ((options.source === 'runtime' || options.source === 'local') && action === WPConstants.ACTION.ROOM_JOIN) {
        stagePendingRoomJoinCommand(message);
        stagedControllerIntent = true;
      }
      const claimed = await refreshControllerLease({ force: !!video && inRoom && isActiveVideoTab });
      if (!claimed) {
        if (stagedControllerIntent && !sessionId) {
          schedulePendingIntentWake();
          return { handled: true, staged: true };
        }
        if (options.source === 'runtime' && isCreateOrJoin) return { handled: false };
        if (options.source === 'runtime') return { handled: false };
        if (stagedControllerIntent) clearPendingRoomIntent(action);
        const response = await relayActionToController(message, sourceSurface);
        return { handled: response?.ok === true, relayed: true, error: response?.error };
      }
    }
    const handler = actionHandlers[message.action];
    if (!handler) return { handled: false };
    const result = await handler(message);
    if (result === false) return { handled: false, error: 'Reconnect to the room before trying again.' };
    if (result && typeof result === 'object') return result;
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
      const roomId = roomState?.id;
      const context = roomContextGeneration;
      const connection = WPWS.getConnectionGeneration();
      presenceTimeout = WPRuntimeClock.setTimeout(() => {
        if (inRoom && isActiveVideoTab && isControllerTab && roomState?.id === roomId
          && roomContextGeneration === context && WPWS.getConnectionGeneration() === connection
          && WPWS.isApplicationReady()) {
          WPWS.send({ type: WPProtocol.COMMAND.ROOM_MEMBER_PRESENCE_PUBLISH, payload: { status: 'away' } });
        }
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
      if (areaName === 'session' && changes[WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT]?.newValue) {
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
        controllerLeaseResponses.invalidate();
        const nextLease = changes[WPConstants.STORAGE.CONTROLLER_TAB].newValue;
        const nextIsController = WPConstants.CONTROLLER_TAB_LEASE.isOwner(nextLease, controllerLeaseId);
        controllerLease = nextIsController ? WPConstants.CONTROLLER_TAB_LEASE.normalize(nextLease) : null;
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
        activeVideoLeaseResponses.invalidate();
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

    // The worker serializes first-run credential creation across all tabs.
    // Never elect a controller or connect until the identity is persisted.
    Promise.all([sendBackgroundMessage({ action: WPConstants.ACTION.SESSION_IDENTITY_GET }), getExtensionState([
      WPConstants.STORAGE.BACKEND_MODE,
      WPConstants.STORAGE.ACTIVE_BACKEND,
      WPConstants.STORAGE.ROOM_STATE,
      WPConstants.STORAGE.USER_ID,
      WPConstants.STORAGE.WS_CONNECTED,
      WPConstants.STORAGE.CURRENT_ROOM,
      WPConstants.STORAGE.CONTROLLER_TAB,
      WPConstants.STORAGE.BOOTSTRAP_ROOM_INTENT,
      WPConstants.STORAGE.DEFERRED_LEAVE_ROOM,
    ])]).then(([identity, result]) => {
      if (!identity?.ok || !identity.sessionId || !identity.sessionToken) {
        throw new Error('Could not initialize the shared WatchParty session. Reload this tab to retry.');
      }
      sessionId = identity.sessionId;
      sessionToken = identity.sessionToken;
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
      controllerLease = isControllerTab
        ? WPConstants.CONTROLLER_TAB_LEASE.normalize(result[WPConstants.STORAGE.CONTROLLER_TAB])
        : null;
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
    }).catch((error) => {
      console.warn('[WatchParty] Session initialization failed:', formatErrorMessage(error));
      WPOverlay.showToast('Could not initialize WatchParty. Reload this tab to retry.');
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();


