/* Preview-only dependencies: no Stremio controller, socket, or playback adapter. */
const WPWS = { getBackendMode: () => 'local', getActiveBackend: () => 'local' };

document.addEventListener('DOMContentLoaded', () => {
  function render(status) {
    WPOverlay.updateState({ inRoom: !!status.room, isHost: status.room?.owner === status.userId,
      userId: status.userId, sessionId: status.sessionId, roomState: status.room,
      hasVideo: false, wsConnected: status.wsConnected });
    if (status.room) WPOverlay.bindRoomCodeCopy(status.room);
  }
  WPOverlay.setActionDispatcher(message => WPPreview.dispatch(message));
  WPOverlay.create();
  render(WPPreview.getStatus());
  WPPreview.subscribe(render);
  WPPreview.onMessage(message => {
    const state = WPPreview.getStatus();
    if (message.action === 'room.chat.appended' && state.room?.id === message.payload.roomId) {
      WPOverlay.appendChatMessage(message.payload, state.room, state.userId);
    }
    if (message.action === 'room.reaction.appended') {
      WPOverlay.showReaction(message.payload.user, message.payload.emoji, state.room, message.payload.messageId);
    }
  });
  WPOverlay.openSidebar();
  WPOverlay.initKeyboardShortcuts();
  const openSettings = () => WPOverlay.openSidebar('prefs');
  document.getElementById('preview-show-settings').addEventListener('click', openSettings);
  document.getElementById('preview-reset').addEventListener('click', () => WPPreview.reset());
  if (new URLSearchParams(location.search).get('panel') === 'prefs') openSettings();
});
