// WatchParty for Stremio — Content Script for Stremio Web
// Orchestrates: video detection, sync engine, overlay UI, profile reading.
// Modules: stremio-sync.js (WPSync), stremio-overlay.js (WPOverlay), stremio-profile.js (WPProfile)

(() => {
  'use strict';

  // --- State ---
  let video = null;
  let inRoom = false;
  let isHost = false;
  let userId = null;
  let roomState = null;
  let chatMessages = [];
  let observer = null;
  let typingUsers = new Map();

  // --- Inject fetch/XHR interceptor into page context ---
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = () => script.remove();
  (document.documentElement || document.head || document.body).appendChild(script);

  // --- Video element detection ---
  function startVideoObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      const v = document.querySelector('video');
      if (v && v !== video) {
        video = v;
        if (inRoom) attachSync();
        refreshOverlay();
      } else if (!v && video) {
        WPSync.detach();
        video = null;
        refreshOverlay();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const v = document.querySelector('video');
    if (v) { video = v; if (inRoom) attachSync(); }
  }

  // --- Sync wiring ---
  function attachSync() {
    if (!video || WPSync.isAttached()) return;
    WPSync.attach(video, {
      isHost,
      onSync(state) {
        chrome.runtime.sendMessage({
          type: 'watchparty-ext', action: 'player-sync', ...state,
        }).catch(() => {});
      },
    });
  }

  // --- Stremio page info ---
  function getCurrentContentInfo() {
    const hash = window.location.hash;
    const m = hash.match(/#\/(?:detail|metadetails)\/(\w+)\/(tt\d+)/);
    if (m) return { type: m[1], id: m[2], url: window.location.href };
    return null;
  }

  function getContentTitle() {
    const el = document.querySelector('[class*="title"]');
    if (el) return el.textContent?.trim() || null;
    const t = document.title;
    return (t && t !== 'Stremio') ? t : null;
  }

  // --- Overlay state refresh ---
  function refreshOverlay() {
    WPOverlay.updateState({ inRoom, isHost, userId, roomState, hasVideo: !!video });
    if (inRoom && !isHost) {
      WPOverlay.updateSyncIndicator(isHost, WPSync.getLastDrift());
    }
  }

  // --- Message handling from background ---
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'watchparty-ext') return;

    switch (message.action) {
      case 'room-joined':
        inRoom = true;
        roomState = message.room;
        userId = message.userId;
        isHost = roomState.owner === userId;
        if (video) attachSync();
        refreshOverlay();
        WPOverlay.bindRoomCodeCopy(roomState);
        WPOverlay.playNotifSound();
        if (isHost) {
          const info = getCurrentContentInfo();
          if (info) {
            chrome.runtime.sendMessage({
              type: 'watchparty-ext', action: 'share-content-link',
              meta: { id: info.id, type: info.type, name: getContentTitle() || info.id },
            }).catch(() => {});
          }
        }
        WPOverlay.openSidebar();
        break;

      case 'room-sync':
        roomState = message.room;
        userId = message.userId;
        const wasHost = isHost;
        isHost = roomState.owner === userId;
        WPSync.setHost(isHost);
        refreshOverlay();
        if (!isHost && roomState.player) {
          WPSync.applyRemote(roomState.player);
          WPOverlay.updateSyncIndicator(isHost, WPSync.getLastDrift());
        }
        if (!wasHost && isHost) WPOverlay.playNotifSound();
        break;

      case 'room-left':
        inRoom = false; roomState = null; isHost = false;
        WPSync.detach();
        refreshOverlay();
        break;

      case 'chat-message':
        chatMessages.push(message.message);
        if (chatMessages.length > 200) chatMessages.shift();
        WPOverlay.appendChatMessage(message.message, roomState, userId);
        break;

      case 'typing': {
        if (message.typing) {
          const existing = typingUsers.get(message.user);
          if (existing) clearTimeout(existing);
          typingUsers.set(message.user, setTimeout(() => {
            typingUsers.delete(message.user);
            WPOverlay.updateTypingIndicator(typingUsers, userId, roomState);
          }, 3000));
        } else {
          const t = typingUsers.get(message.user);
          if (t) clearTimeout(t);
          typingUsers.delete(message.user);
        }
        WPOverlay.updateTypingIndicator(typingUsers, userId, roomState);
        break;
      }

      case 'reaction':
        WPOverlay.showReaction(message.user, message.emoji, roomState);
        break;

      case 'error':
        if (message.error === 'room') {
          inRoom = false; roomState = null;
          WPSync.detach();
          refreshOverlay();
        }
        break;
    }
  });

  // Visibility recovery
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && inRoom && !isHost) {
      chrome.runtime.sendMessage({
        type: 'watchparty-ext', action: 'request-sync',
      }).catch(() => {});
    }
  });

  // --- Initialize ---
  function init() {
    WPOverlay.create();
    WPOverlay.bindTypingIndicator(
      () => {
        if (!inRoom) return;
        chrome.runtime.sendMessage({
          type: 'watchparty-ext', action: 'send-typing', typing: true,
        }).catch(() => {});
      },
      () => {
        chrome.runtime.sendMessage({
          type: 'watchparty-ext', action: 'send-typing', typing: false,
        }).catch(() => {});
      }
    );
    startVideoObserver();
    WPProfile.start();

    // Check if already in a room
    chrome.runtime.sendMessage(
      { type: 'watchparty-ext', action: 'get-status' },
      (response) => {
        if (response?.room) {
          inRoom = true;
          roomState = response.room;
          userId = response.userId;
          isHost = roomState.owner === userId;
          if (video) attachSync();
        }
        refreshOverlay();
      }
    );

    // Handle pending room join from landing page
    chrome.storage.local.get('pendingRoomJoin', ({ pendingRoomJoin }) => {
      if (pendingRoomJoin) {
        chrome.storage.local.remove('pendingRoomJoin');
        chrome.storage.local.get('wpUsername', ({ wpUsername }) => {
          chrome.runtime.sendMessage({
            type: 'watchparty-ext', action: 'join-room',
            username: wpUsername || `Guest${Math.random().toString(36).slice(2, 6)}`,
            roomId: pendingRoomJoin,
          }).catch(() => {});
        });
      }
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
