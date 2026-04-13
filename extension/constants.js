// WatchParty — Shared Constants
// Used by: all extension scripts (content scripts, popup, sidepanel, background)
// Loaded before all other scripts via manifest.json / HTML script tags.

const WPConstants = (() => {
  'use strict';

  // Chrome storage keys — single source of truth across all extension files
  const STORAGE = Object.freeze({
    ROOM_STATE: 'wpRoomState',
    USER_ID: 'wpUserId',
    WS_CONNECTED: 'wpWsConnected',
    USERNAME: 'wpUsername',
    SESSION_ID: 'wpSessionId',
    CURRENT_ROOM: 'currentRoom',
    ACCENT_COLOR: 'wpAccentColor',
    COMPACT_CHAT: 'wpCompactChat',
    REACTION_SOUND: 'wpReactionSound',
    STREMIO_PROFILE: 'stremioProfile',
    SAVED_AUTH_KEY: 'savedAuthKey',
    PENDING_ROOM_CREATE: 'pendingRoomCreate',
    PENDING_ROOM_JOIN: 'pendingRoomJoin',
    PENDING_LEAVE_ROOM: 'pendingLeaveRoom',
    PENDING_ACTION: 'pendingAction',
    // Dynamic key helper for per-room encryption keys
    roomKey(roomId) { return `wpRoomKey:${roomId}`; },
  });

  return { STORAGE };
})();
