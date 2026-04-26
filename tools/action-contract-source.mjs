export const ACTION = Object.freeze({
  STATUS_GET: 'status.get',
  STATUS_UPDATED: 'status.updated',
  STREMIO_STATUS_UPDATED: 'stremio.status.updated',
  PROFILE_UPDATED: 'profile.updated',
  SURFACE_READY: 'surface.ready',
  PROBE_SURFACE: 'surface.probe',
  OPEN_SIDEBAR: 'sidebar.open',
  BOOTSTRAP_PENDING: 'bootstrap.pending',
  SESSION_STATE_PUBLISH: 'session.state.publish',
  CONTROLLER_RELEASED: 'controller.released',
  CONTROLLER_LEASE_CLAIM: 'controller.lease.claim',
  CONTROLLER_LEASE_RELEASE: 'controller.lease.release',
  ACTIVE_VIDEO_LEASE_CLAIM: 'video.lease.claim',
  ACTIVE_VIDEO_LEASE_RELEASE: 'video.lease.release',
  ROOM_CREATE: 'room.create',
  ROOM_JOIN: 'room.join',
  ROOM_LEAVE: 'room.leave',
  ROOM_CHAT_EVENT: 'room.chat.appended',
  ROOM_TYPING_EVENT: 'room.typing.updated',
  ROOM_BOOKMARK_EVENT: 'room.bookmark.appended',
  ROOM_REACTION_EVENT: 'room.reaction.appended',
  ROOM_ERROR_EVENT: 'room.error',
  ROOM_VISIBILITY_UPDATE: 'room.visibility.update',
  ROOM_SETTINGS_UPDATE: 'room.settings.update',
  ROOM_OWNERSHIP_TRANSFER: 'room.ownership.transfer',
  SESSION_USERNAME_UPDATE: 'session.username.update',
  ROOM_READY_CHECK_UPDATE: 'room.readyCheck.update',
  ROOM_BOOKMARK_ADD: 'room.bookmark.add',
  ROOM_BOOKMARK_SEEK: 'room.bookmark.seek',
  ROOM_CHAT_SEND: 'room.chat.send',
  ROOM_TYPING_SEND: 'room.typing.send',
  ROOM_REACTION_SEND: 'room.reaction.send',
  ROOM_MEMBER_PRESENCE_PUBLISH: 'room.member.presence.publish',
  ROOM_MEMBER_PLAYBACK_STATUS_PUBLISH: 'room.member.playbackStatus.publish',
  ROOM_PLAYBACK_REQUEST_SYNC: 'room.playback.sync.request',
  ROOM_RESUME: 'room.resume',
  APP_OPTIONS_OPEN: 'app.options.open',
  APP_STREMIO_OPEN: 'app.stremio.open',
  CLIPBOARD_COPY: 'clipboard.copy',
  SERVER_DIAGNOSTICS_GET: 'server.diagnostics.get',
  LOCAL_LANDING_ACCESS_SYNC: 'localLandingAccess.sync',
  AUTH_KEY_SAVE: 'auth.key.save',
  AUTH_KEY_CLEAR: 'auth.key.clear',
  OFFSCREEN_COPY: 'offscreen.copy',
});

export const ACTION_ROUTE = Object.freeze({
  STATUS_GET: {
    sources: ['popup', 'sidepanel', 'options', 'watchparty-bridge'],
    target: 'background',
  },
  STATUS_UPDATED: {
    sources: ['background'],
    target: 'extension-surfaces',
  },
  STREMIO_STATUS_UPDATED: {
    sources: ['background'],
    target: 'watchparty-bridge',
  },
  PROFILE_UPDATED: {
    sources: ['background', 'stremio-profile'],
    target: 'background',
  },
  SURFACE_READY: {
    sources: ['watchparty-bridge', 'stremio-content'],
    target: 'background',
  },
  PROBE_SURFACE: {
    sources: ['background'],
    target: 'extension-surfaces',
  },
  OPEN_SIDEBAR: {
    sources: ['background'],
    target: 'stremio-content',
  },
  BOOTSTRAP_PENDING: {
    sources: ['background'],
    target: 'stremio-content',
  },
  SESSION_STATE_PUBLISH: {
    sources: ['stremio-content'],
    target: 'background',
  },
  CONTROLLER_RELEASED: {
    sources: ['stremio-content'],
    target: 'background',
  },
  CONTROLLER_LEASE_CLAIM: {
    sources: ['stremio-content'],
    target: 'background',
  },
  CONTROLLER_LEASE_RELEASE: {
    sources: ['stremio-content'],
    target: 'background',
  },
  ACTIVE_VIDEO_LEASE_CLAIM: {
    sources: ['stremio-content'],
    target: 'background',
  },
  ACTIVE_VIDEO_LEASE_RELEASE: {
    sources: ['stremio-content'],
    target: 'background',
  },
  ROOM_CREATE: {
    sources: ['popup', 'watchparty-bridge', 'background'],
    target: 'controller',
  },
  ROOM_JOIN: {
    sources: ['popup', 'watchparty-bridge', 'background'],
    target: 'controller',
  },
  ROOM_LEAVE: {
    sources: ['overlay', 'popup', 'sidepanel'],
    target: 'controller',
    requiresTrustedEvent: true,
  },
  ROOM_CHAT_EVENT: {
    sources: ['stremio-content', 'background'],
    target: 'extension-surfaces',
  },
  ROOM_TYPING_EVENT: {
    sources: ['stremio-content', 'background'],
    target: 'extension-surfaces',
  },
  ROOM_BOOKMARK_EVENT: {
    sources: ['stremio-content', 'background'],
    target: 'extension-surfaces',
  },
  ROOM_REACTION_EVENT: {
    sources: ['stremio-content', 'background'],
    target: 'stremio-content',
  },
  ROOM_ERROR_EVENT: {
    sources: ['stremio-content', 'background'],
    target: 'extension-surfaces',
  },
  ROOM_VISIBILITY_UPDATE: {
    sources: ['overlay'],
    target: 'controller',
    requiresTrustedEvent: true,
  },
  ROOM_SETTINGS_UPDATE: {
    sources: ['overlay'],
    target: 'controller',
    requiresTrustedEvent: true,
  },
  ROOM_OWNERSHIP_TRANSFER: {
    sources: ['overlay'],
    target: 'controller',
    requiresTrustedEvent: true,
  },
  SESSION_USERNAME_UPDATE: {
    sources: ['overlay'],
    target: 'controller',
    requiresTrustedEvent: true,
  },
  ROOM_READY_CHECK_UPDATE: {
    sources: ['overlay', 'sidepanel'],
    target: 'controller',
    requiresTrustedEvent: true,
  },
  ROOM_BOOKMARK_ADD: {
    sources: ['overlay', 'sidepanel'],
    target: 'controller',
    requiresTrustedEvent: true,
  },
  ROOM_BOOKMARK_SEEK: {
    sources: ['sidepanel'],
    target: 'controller',
    requiresTrustedEvent: true,
  },
  ROOM_CHAT_SEND: {
    sources: ['overlay', 'sidepanel'],
    target: 'controller',
    requiresTrustedEvent: true,
  },
  ROOM_TYPING_SEND: {
    sources: ['overlay', 'sidepanel'],
    target: 'controller',
    requiresTrustedEvent: true,
  },
  ROOM_REACTION_SEND: {
    sources: ['overlay'],
    target: 'controller',
    requiresTrustedEvent: true,
  },
  ROOM_MEMBER_PRESENCE_PUBLISH: {
    sources: ['stremio-content', 'background'],
    target: 'controller',
    activeVideoOnly: true,
  },
  ROOM_MEMBER_PLAYBACK_STATUS_PUBLISH: {
    sources: ['stremio-content', 'background'],
    target: 'controller',
    activeVideoOnly: true,
  },
  ROOM_PLAYBACK_REQUEST_SYNC: {
    sources: ['overlay'],
    target: 'controller',
    requiresTrustedEvent: true,
    activeVideoOnly: true,
  },
  ROOM_RESUME: {
    sources: ['popup', 'options', 'watchparty-bridge'],
    target: 'background',
  },
  APP_OPTIONS_OPEN: {
    sources: ['watchparty-bridge'],
    target: 'background',
  },
  APP_STREMIO_OPEN: {
    sources: ['popup', 'options', 'watchparty-bridge'],
    target: 'background',
  },
  CLIPBOARD_COPY: {
    sources: ['shared-utils', 'options'],
    target: 'background',
  },
  SERVER_DIAGNOSTICS_GET: {
    sources: ['options'],
    target: 'background',
  },
  LOCAL_LANDING_ACCESS_SYNC: {
    sources: ['options'],
    target: 'background',
  },
  AUTH_KEY_SAVE: {
    sources: ['stremio-profile'],
    target: 'background',
  },
  AUTH_KEY_CLEAR: {
    sources: ['options'],
    target: 'background',
  },
  OFFSCREEN_COPY: {
    sources: ['background'],
    target: 'offscreen',
  },
});
