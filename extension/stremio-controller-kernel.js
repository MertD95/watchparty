// WatchParty controller kernel helpers.
// This pure wrapper keeps controller state transitions explicit while
// stremio-content.js continues to own browser effects and the WebSocket.

const WPControllerKernel = (() => {
  'use strict';

  function cloneRoomSnapshot(room) {
    if (!room) return null;
    return {
      ...room,
      meta: room.meta ? { ...room.meta } : room.meta,
      stream: room.stream ? { ...room.stream } : room.stream,
      player: room.player ? { ...room.player } : room.player,
      settings: room.settings ? { ...room.settings } : room.settings,
      readyCheck: room.readyCheck ? {
        ...room.readyCheck,
        confirmed: Array.isArray(room.readyCheck.confirmed) ? [...room.readyCheck.confirmed] : [],
      } : room.readyCheck,
      users: Array.isArray(room.users) ? room.users.map((user) => ({ ...user })) : [],
      bookmarks: Array.isArray(room.bookmarks) ? room.bookmarks.map((bookmark) => ({ ...bookmark })) : [],
      messages: Array.isArray(room.messages) ? room.messages.map((message) => ({ ...message })) : [],
    };
  }

  function upsertRoomUser(users, user) {
    const nextUsers = Array.isArray(users) ? users.map((entry) => ({ ...entry })) : [];
    const idx = nextUsers.findIndex((entry) => {
      if (user.sessionId && entry.sessionId) return entry.sessionId === user.sessionId;
      return entry.id === user.id;
    });
    if (idx >= 0) nextUsers[idx] = { ...nextUsers[idx], ...user };
    else nextUsers.push({ ...user });
    return nextUsers;
  }

  function removeRoomUser(users, removedUser) {
    if (!Array.isArray(users)) return [];
    return users.filter((entry) => {
      if (removedUser.sessionId && entry.sessionId) return entry.sessionId !== removedUser.sessionId;
      return entry.id !== removedUser.userId;
    });
  }

  function createInitialRuntimeState() {
    return WPStremioRuntimeModel.createInitialControllerRuntimeState();
  }

  function buildRuntimeSnapshot(input = {}) {
    return {
      surfaceTabId: Number.isInteger(input.surfaceTabId) ? input.surfaceTabId : null,
      sessionIdKnown: !!input.sessionIdKnown,
      wantsController: !!input.wantsController,
      isControllerTab: !!input.isControllerTab,
      isActiveVideoTab: !!input.isActiveVideoTab,
      wsConnected: !!input.wsConnected,
      inRoom: !!input.inRoom,
      hasVideo: !!input.hasVideo,
      resumeRoomPending: !!input.resumeRoomPending,
      pendingCreate: !!input.pendingCreate,
      pendingJoin: !!input.pendingJoin,
      deferredLeave: !!input.deferredLeave,
      lastAction: input.lastAction || null,
    };
  }

  function reduceRuntimeState(state, eventType, snapshot, at = Date.now()) {
    return WPStremioRuntimeModel.reduceControllerRuntimeState(state, {
      type: eventType,
      at,
      snapshot: buildRuntimeSnapshot(snapshot),
    });
  }

  function getControllerActions(actionRoutes) {
    return new Set(
      Object.values(actionRoutes || {})
        .filter((route) => route?.target === 'controller')
        .map((route) => route.action)
    );
  }

  function reduceRoomState(currentRoom, event, context = {}) {
    const type = event?.type || '';
    const payload = event?.payload || {};

    if (type === WPProtocol.EVENT.ROOM_SNAPSHOT) {
      const room = cloneRoomSnapshot(payload);
      return {
        changed: !!room?.id,
        room,
        previousPlayerTime: currentRoom?.player?.time || 0,
        effects: [],
      };
    }

    const nextRoom = cloneRoomSnapshot(currentRoom);
    if (!nextRoom?.id) return { changed: false, room: currentRoom || null, effects: [] };
    const previousPlayerTime = nextRoom.player?.time || 0;
    const effects = [];
    let changed = true;

    switch (type) {
      case WPProtocol.EVENT.ROOM_READY_CHECK_UPDATED:
        if (payload.action === 'started' || payload.action === 'updated') {
          nextRoom.readyCheck = {
            confirmed: Array.isArray(payload.confirmed) ? [...payload.confirmed] : [],
            total: Number.isFinite(payload.total) ? payload.total : (nextRoom.readyCheck?.total || nextRoom.users?.length || 0),
          };
        } else {
          delete nextRoom.readyCheck;
        }
        break;

      case WPProtocol.EVENT.ROOM_BOOKMARK_APPENDED:
        nextRoom.bookmarks = Array.isArray(nextRoom.bookmarks) ? nextRoom.bookmarks : [];
        nextRoom.bookmarks.push({ ...payload });
        if (nextRoom.bookmarks.length > 50) nextRoom.bookmarks.shift();
        break;

      case WPProtocol.EVENT.ROOM_PLAYBACK_UPDATED:
        if (!payload.player) return { changed: false, room: currentRoom || null, effects: [] };
        nextRoom.player = { ...payload.player };
        break;

      case WPProtocol.EVENT.ROOM_MEMBER_PRESENCE_UPDATED: {
        if (!payload.userId) return { changed: false, room: currentRoom || null, effects: [] };
        const user = nextRoom.users.find((entry) => entry.id === payload.userId);
        if (!user) return { changed: false, room: currentRoom || null, effects: [] };
        user.status = payload.status;
        break;
      }

      case WPProtocol.EVENT.ROOM_MEMBER_PLAYBACK_STATUS_UPDATED: {
        if (!payload.userId) return { changed: false, room: currentRoom || null, effects: [] };
        const user = nextRoom.users.find((entry) => entry.id === payload.userId);
        if (!user) return { changed: false, room: currentRoom || null, effects: [] };
        user.playbackStatus = payload.status;
        if (Number.isFinite(payload.time)) user.playbackTime = payload.time;
        break;
      }

      case WPProtocol.EVENT.ROOM_SETTINGS_UPDATED:
        if (!payload.settings) return { changed: false, room: currentRoom || null, effects: [] };
        nextRoom.settings = { ...payload.settings };
        break;

      case WPProtocol.EVENT.ROOM_OWNERSHIP_UPDATED:
        if (!payload.owner) return { changed: false, room: currentRoom || null, effects: [] };
        nextRoom.owner = payload.owner;
        nextRoom.ownerSessionId = payload.ownerSessionId ?? null;
        break;

      case WPProtocol.EVENT.ROOM_VISIBILITY_UPDATED:
        if (typeof payload.public !== 'boolean' || !payload.visibility) {
          return { changed: false, room: currentRoom || null, effects: [] };
        }
        nextRoom.public = payload.public;
        nextRoom.visibility = payload.visibility;
        nextRoom.listed = payload.listed !== false;
        effects.push({ type: 'room-key-visibility-confirmed', roomId: nextRoom.id, public: payload.public });
        break;

      case WPProtocol.EVENT.ROOM_CONTENT_UPDATED:
        if (!payload.stream || !payload.player) return { changed: false, room: currentRoom || null, effects: [] };
        nextRoom.stream = { ...payload.stream };
        if (payload.meta) nextRoom.meta = { ...payload.meta };
        if (payload.joinHint) nextRoom.joinHint = WPRoomDomain.normalizeJoinHint(payload.joinHint);
        nextRoom.player = { ...payload.player };
        break;

      case WPProtocol.EVENT.ROOM_MEMBER_UPSERTED:
        if (!payload.user) return { changed: false, room: currentRoom || null, effects: [] };
        nextRoom.users = upsertRoomUser(nextRoom.users, payload.user);
        break;

      case WPProtocol.EVENT.ROOM_MEMBER_REMOVED:
        if (!payload.userId) return { changed: false, room: currentRoom || null, effects: [] };
        nextRoom.users = removeRoomUser(nextRoom.users, payload);
        break;

      default:
        changed = false;
    }

    return {
      changed,
      room: changed ? nextRoom : currentRoom || null,
      previousPlayerTime,
      effects,
      context,
    };
  }

  return {
    cloneRoomSnapshot,
    createInitialRuntimeState,
    buildRuntimeSnapshot,
    reduceRuntimeState,
    getControllerActions,
    reduceRoomState,
  };
})();
