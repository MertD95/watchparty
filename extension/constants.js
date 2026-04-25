// WatchParty — Shared Constants
// Used by: all extension scripts (content scripts, popup, sidepanel, background)
// Loaded before all other scripts via manifest.json / HTML script tags.

const WPConstants = (() => {
  'use strict';

  const BACKEND_MODES = Object.freeze({
    AUTO: 'auto',
    LOCAL: 'local',
    LIVE: 'live',
  });

  const BACKENDS = Object.freeze({
    [BACKEND_MODES.LOCAL]: Object.freeze({
      key: BACKEND_MODES.LOCAL,
      label: 'Local',
      wsUrl: 'ws://localhost:8181',
      httpUrl: 'http://localhost:8181',
      landingOrigin: 'http://localhost:8090',
    }),
    [BACKEND_MODES.LIVE]: Object.freeze({
      key: BACKEND_MODES.LIVE,
      label: 'Live',
      wsUrl: 'wss://ws.mertd.me',
      httpUrl: 'https://ws.mertd.me',
      landingOrigin: 'https://watchparty.mertd.me',
    }),
  });

  function isKnownBackendKey(value) {
    return value === BACKEND_MODES.LOCAL || value === BACKEND_MODES.LIVE;
  }

  function normalizeBackendMode(value) {
    return isKnownBackendKey(value) ? value : BACKEND_MODES.AUTO;
  }

  function getBackendInfo(key) {
    return BACKENDS[isKnownBackendKey(key) ? key : BACKEND_MODES.LIVE];
  }

  function resolveBackendKey(mode, activeKey) {
    const normalizedMode = normalizeBackendMode(mode);
    if (normalizedMode === BACKEND_MODES.LOCAL || normalizedMode === BACKEND_MODES.LIVE) return normalizedMode;
    return isKnownBackendKey(activeKey) ? activeKey : BACKEND_MODES.LIVE;
  }

  function getBrowseUrl(mode, activeKey) {
    return getBackendInfo(resolveBackendKey(mode, activeKey)).landingOrigin;
  }

  function buildInviteUrl(roomId, mode, activeKey) {
    return `${getBrowseUrl(mode, activeKey)}/r/${roomId}`;
  }

  const ROOM_KEY_LOCAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const BOOTSTRAP_ROOM_INTENT_TTL_MS = 3 * 60 * 1000;
  const CONTROLLER_TAB_LEASE_TTL_MS = 15 * 1000;
  const CONTROLLER_TAB_LEASE_RENEW_INTERVAL_MS = 5 * 1000;
  const VIDEO_TAB_LEASE_TTL_MS = 15 * 1000;
  const VIDEO_TAB_LEASE_RENEW_INTERVAL_MS = 5 * 1000;

  const COORDINATOR_MODE = Object.freeze({
    IDLE: 'idle',
    BOOTSTRAP_PENDING: 'bootstrap_pending',
    CONTROLLER_CLAIMING: 'controller_claiming',
    CONTROLLER_ACTIVE: 'controller_active',
    CONTROLLER_RECOVERING: 'controller_recovering',
    CONTROLLER_MISSING: 'controller_missing',
  });

  const CONTROLLER_RUNTIME_PHASE = Object.freeze({
    BOOTING: 'booting',
    PASSIVE: 'passive',
    CLAIMING: 'claiming',
    CONNECTING: 'connecting',
    ACTIVE: 'active',
    ACTIVE_IN_ROOM: 'active_in_room',
    RECOVERING: 'recovering',
  });

  const ADAPTER_ROUTE = Object.freeze({
    IDLE: 'idle',
    DETAIL: 'detail',
    PLAYER: 'player',
    OTHER: 'other',
  });

  const ADAPTER_AVAILABILITY = Object.freeze({
    UNAVAILABLE: 'unavailable',
    DETAIL_ONLY: 'detail_only',
    PLAYER_PENDING: 'player_pending',
    DIRECT_JOIN_READY: 'direct_join_ready',
    MANUAL_JOIN_ONLY: 'manual_join_only',
  });

  function normalizeTabId(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  function normalizeRequestedAt(value) {
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  const ACTION = WPAction;

  // Chrome storage keys — single source of truth across all extension files
  const STORAGE = Object.freeze({
    ROOM_STATE: 'wpRoomState',
    USER_ID: 'wpUserId',
    WS_CONNECTED: 'wpWsConnected',
    BACKEND_MODE: 'wpBackendMode',
    ACTIVE_BACKEND: 'wpActiveBackend',
    ACTIVE_BACKEND_URL: 'wpActiveBackendUrl',
    CONTROLLER_RUNTIME: 'wpControllerRuntime',
    ADAPTER_STATE: 'wpAdapterState',
    LAST_ROOM_ERROR: 'wpLastRoomError',
    USERNAME: 'wpUsername',
    SESSION_ID: 'wpSessionId',
    CURRENT_ROOM: 'currentRoom',
    ACCENT_COLOR: 'wpAccentColor',
    COMPACT_CHAT: 'wpCompactChat',
    REACTION_SOUND: 'wpReactionSound',
    FLOATING_REACTIONS: 'wpFloatingReactions',
    STREMIO_PROFILE: 'stremioProfile',
    SAVED_AUTH_KEY: 'savedAuthKey',
    BOOTSTRAP_ROOM_INTENT: 'wpBootstrapRoomIntent',
    DEFERRED_LEAVE_ROOM: 'wpDeferredLeaveRoom',
    CONTROLLER_TAB: 'wpControllerTab', // controller-tab lease { leaseId, tabId, sessionId, claimedAt }
    ACTIVE_VIDEO_TAB: 'wpActiveVideoTab', // active video-tab lease { leaseId, tabId, sessionId, claimedAt }
    // Dynamic key helper for per-room encryption keys
    roomKey(roomId) { return `wpRoomKey:${roomId}`; },
  });

  // Storage contract — keep long-lived preferences in local storage, runtime room
  // state in session storage, and same-tab imperative commands in memory.
  const STORAGE_CONTRACT = Object.freeze({
    DURABLE: Object.freeze([
      STORAGE.BACKEND_MODE,
      STORAGE.USERNAME,
      STORAGE.SESSION_ID,
      STORAGE.ACCENT_COLOR,
      STORAGE.COMPACT_CHAT,
      STORAGE.REACTION_SOUND,
      STORAGE.FLOATING_REACTIONS,
      STORAGE.STREMIO_PROFILE,
    ]),
    SESSION_RUNTIME: Object.freeze([
      STORAGE.ROOM_STATE,
      STORAGE.USER_ID,
      STORAGE.WS_CONNECTED,
      STORAGE.ACTIVE_BACKEND,
      STORAGE.ACTIVE_BACKEND_URL,
      STORAGE.CONTROLLER_RUNTIME,
      STORAGE.ADAPTER_STATE,
      STORAGE.LAST_ROOM_ERROR,
      STORAGE.CURRENT_ROOM,
      STORAGE.CONTROLLER_TAB,
      STORAGE.ACTIVE_VIDEO_TAB,
    ]),
    BOOTSTRAP_SESSION: Object.freeze([
      STORAGE.BOOTSTRAP_ROOM_INTENT,
      STORAGE.DEFERRED_LEAVE_ROOM,
    ]),
    SENSITIVE_SESSION: Object.freeze([
      STORAGE.SAVED_AUTH_KEY,
    ]),
    IN_MEMORY_ONLY: Object.freeze([
      'pendingRoomCreateCommand',
      'pendingRoomJoinCommand',
      'pendingJoinOptions',
      'deferredLeaveIntent',
      'controllerLease',
      'activeVideoLease',
    ]),
  });

  const BOOTSTRAP_ROOM_INTENT = Object.freeze({
    TTL_MS: BOOTSTRAP_ROOM_INTENT_TTL_MS,
    buildCreate(command = {}) {
      return {
        action: ACTION.ROOM_CREATE,
        username: typeof command.username === 'string' ? command.username.trim() : '',
        meta: command.meta || null,
        stream: command.stream || null,
        public: command.public === true,
        listed: command.listed !== false,
        roomName: typeof command.roomName === 'string' && command.roomName.trim() ? command.roomName.trim() : undefined,
        roomKey: typeof command.roomKey === 'string' && command.roomKey.trim() ? command.roomKey.trim() : undefined,
        requestedAt: normalizeRequestedAt(command.requestedAt),
      };
    },
    buildJoin(command = {}) {
      const roomId = typeof command.roomId === 'string' ? command.roomId.trim() : '';
      if (!roomId) return null;
      return {
        action: ACTION.ROOM_JOIN,
        roomId,
        username: typeof command.username === 'string' ? command.username.trim() : '',
        roomKey: typeof command.roomKey === 'string' && command.roomKey.trim() ? command.roomKey.trim() : undefined,
        preferDirectJoin: command.preferDirectJoin === true,
        requestedAt: normalizeRequestedAt(command.requestedAt),
      };
    },
    isExpired(requestedAt, now = Date.now()) {
      return !Number.isFinite(requestedAt) || requestedAt <= 0 || (now - requestedAt) > BOOTSTRAP_ROOM_INTENT_TTL_MS;
    },
    normalize(value, now = Date.now()) {
      if (!value || typeof value !== 'object') return null;
      if (value.action === ACTION.ROOM_CREATE) {
        const normalized = this.buildCreate(value);
        return this.isExpired(normalized.requestedAt, now) ? null : normalized;
      }
      if (value.action === ACTION.ROOM_JOIN) {
        const normalized = this.buildJoin(value);
        return this.isExpired(normalized.requestedAt, now) ? null : normalized;
      }
      return null;
    },
  });

  const CONTROLLER_TAB_LEASE = Object.freeze({
    TTL_MS: CONTROLLER_TAB_LEASE_TTL_MS,
    RENEW_INTERVAL_MS: CONTROLLER_TAB_LEASE_RENEW_INTERVAL_MS,
    build({ leaseId, tabId, sessionId, claimedAt = Date.now(), fence = 0 }) {
      if (typeof leaseId !== 'string' || !leaseId.trim()) return null;
      return {
        leaseId: leaseId.trim(),
        tabId: normalizeTabId(tabId),
        sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null,
        claimedAt: Number.isFinite(claimedAt) && claimedAt > 0 ? claimedAt : Date.now(),
        fence: Number.isFinite(fence) && fence >= 0 ? Math.floor(fence) : 0,
      };
    },
    normalize(value) {
      if (!value || typeof value !== 'object') return null;
      if (typeof value.leaseId !== 'string' || !value.leaseId.trim()) return null;
      return {
        leaseId: value.leaseId.trim(),
        tabId: normalizeTabId(value.tabId),
        sessionId: typeof value.sessionId === 'string' && value.sessionId.trim() ? value.sessionId.trim() : null,
        claimedAt: Number.isFinite(value.claimedAt) && value.claimedAt > 0 ? value.claimedAt : Date.now(),
        fence: Number.isFinite(value.fence) && value.fence >= 0 ? Math.floor(value.fence) : 0,
      };
    },
    isOwner(value, leaseId) {
      const normalized = this.normalize(value);
      return !!normalized && normalized.leaseId === leaseId;
    },
    isExpired(value, now = Date.now()) {
      const normalized = this.normalize(value);
      return !normalized || (now - normalized.claimedAt) > CONTROLLER_TAB_LEASE_TTL_MS;
    },
    shouldRenew(value, now = Date.now()) {
      const normalized = this.normalize(value);
      return !normalized || (now - normalized.claimedAt) >= CONTROLLER_TAB_LEASE_RENEW_INTERVAL_MS;
    },
  });

  const VIDEO_TAB_LEASE = Object.freeze({
    TTL_MS: VIDEO_TAB_LEASE_TTL_MS,
    RENEW_INTERVAL_MS: VIDEO_TAB_LEASE_RENEW_INTERVAL_MS,
    build({ leaseId, tabId, sessionId, claimedAt = Date.now(), fence = 0 }) {
      if (typeof leaseId !== 'string' || !leaseId.trim()) return null;
      return {
        leaseId: leaseId.trim(),
        tabId: normalizeTabId(tabId),
        sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null,
        claimedAt: Number.isFinite(claimedAt) && claimedAt > 0 ? claimedAt : Date.now(),
        fence: Number.isFinite(fence) && fence >= 0 ? Math.floor(fence) : 0,
      };
    },
    normalize(value) {
      if (!value || typeof value !== 'object') return null;
      if (typeof value.leaseId !== 'string' || !value.leaseId.trim()) return null;
      return {
        leaseId: value.leaseId.trim(),
        tabId: normalizeTabId(value.tabId),
        sessionId: typeof value.sessionId === 'string' && value.sessionId.trim() ? value.sessionId.trim() : null,
        claimedAt: Number.isFinite(value.claimedAt) && value.claimedAt > 0 ? value.claimedAt : Date.now(),
        fence: Number.isFinite(value.fence) && value.fence >= 0 ? Math.floor(value.fence) : 0,
      };
    },
    isOwner(value, leaseId) {
      const normalized = this.normalize(value);
      return !!normalized && normalized.leaseId === leaseId;
    },
    isExpired(value, now = Date.now()) {
      const normalized = this.normalize(value);
      return !normalized || (now - normalized.claimedAt) > VIDEO_TAB_LEASE_TTL_MS;
    },
    shouldRenew(value, now = Date.now()) {
      const normalized = this.normalize(value);
      return !normalized || (now - normalized.claimedAt) >= VIDEO_TAB_LEASE_RENEW_INTERVAL_MS;
    },
  });

  const ROOM_KEYS = Object.freeze({
    LOCAL_TTL_MS: ROOM_KEY_LOCAL_TTL_MS,
    encodeForLocal(roomKey) {
      const value = typeof roomKey === 'string' ? roomKey.trim() : '';
      if (!value) return null;
      return {
        value,
        storedAt: Date.now(),
      };
    },
    decodeFromLocal(storedValue, now = Date.now()) {
      if (!storedValue || typeof storedValue !== 'object') {
        return { value: null, expired: false };
      }
      const value = typeof storedValue.value === 'string' ? storedValue.value.trim() : '';
      const storedAt = Number(storedValue.storedAt);
      if (!value || !Number.isFinite(storedAt) || storedAt <= 0) {
        return { value: null, expired: true };
      }
      const expired = (now - storedAt) > ROOM_KEY_LOCAL_TTL_MS;
      return {
        value: expired ? null : value,
        expired,
      };
    },
  });

  const BACKEND = Object.freeze({
    MODES: BACKEND_MODES,
    LOCAL: BACKENDS[BACKEND_MODES.LOCAL],
    LIVE: BACKENDS[BACKEND_MODES.LIVE],
    isKnownKey: isKnownBackendKey,
    normalizeMode: normalizeBackendMode,
    getInfo: getBackendInfo,
    resolveKey: resolveBackendKey,
    getBrowseUrl,
    buildInviteUrl,
  });

  return {
    STORAGE,
    STORAGE_CONTRACT,
    BACKEND,
    ROOM_KEYS,
    CONTROLLER_TAB_LEASE,
    VIDEO_TAB_LEASE,
    BOOTSTRAP_ROOM_INTENT,
    COORDINATOR_MODE,
    CONTROLLER_RUNTIME_PHASE,
    ADAPTER_ROUTE,
    ADAPTER_AVAILABILITY,
    ACTION,
  };
})();
