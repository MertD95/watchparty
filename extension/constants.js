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

  // Chrome storage keys — single source of truth across all extension files
  const STORAGE = Object.freeze({
    ROOM_STATE: 'wpRoomState',
    USER_ID: 'wpUserId',
    WS_CONNECTED: 'wpWsConnected',
    BACKEND_MODE: 'wpBackendMode',
    ACTIVE_BACKEND: 'wpActiveBackend',
    ACTIVE_BACKEND_URL: 'wpActiveBackendUrl',
    USERNAME: 'wpUsername',
    SESSION_ID: 'wpSessionId',
    CURRENT_ROOM: 'currentRoom',
    ACCENT_COLOR: 'wpAccentColor',
    COMPACT_CHAT: 'wpCompactChat',
    REACTION_SOUND: 'wpReactionSound',
    FLOATING_REACTIONS: 'wpFloatingReactions',
    STREMIO_PROFILE: 'stremioProfile',
    SAVED_AUTH_KEY: 'savedAuthKey',
    PENDING_ROOM_CREATE: 'pendingRoomCreate',
    PENDING_ROOM_JOIN: 'pendingRoomJoin',
    PENDING_ROOM_JOIN_OPTIONS: 'pendingRoomJoinOptions',
    PENDING_LEAVE_ROOM: 'pendingLeaveRoom',
    DEFERRED_LEAVE_ROOM: 'wpDeferredLeaveRoom',
    PENDING_ACTION: 'pendingAction',
    ROOM_SERVICE_ACTIVE: 'wpRoomServiceActive',
    ROOM_SERVICE_ERROR: 'wpRoomServiceError',
    ACTIVE_VIDEO_TAB: 'wpActiveVideoTab', // userId of the tab that owns sync/playback
    // Dynamic key helper for per-room encryption keys
    roomKey(roomId) { return `wpRoomKey:${roomId}`; },
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
      if (typeof storedValue === 'string') {
        return { value: storedValue, expired: false, legacy: true };
      }
      if (!storedValue || typeof storedValue !== 'object') {
        return { value: null, expired: false, legacy: false };
      }
      const value = typeof storedValue.value === 'string' ? storedValue.value.trim() : '';
      const storedAt = Number(storedValue.storedAt);
      if (!value || !Number.isFinite(storedAt) || storedAt <= 0) {
        return { value: null, expired: true, legacy: false };
      }
      const expired = (now - storedAt) > ROOM_KEY_LOCAL_TTL_MS;
      return {
        value: expired ? null : value,
        expired,
        legacy: false,
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

  return { STORAGE, BACKEND, ROOM_KEYS };
})();
