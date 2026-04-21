// WatchParty — Overlay UI
// Injects the sidebar, chat, reactions, emoji picker, and sync indicator into Stremio Web.

const WPOverlay = (() => {
  'use strict';

  // --- Constants ---
  const SIDEBAR_WIDTH = 320;
  const MAX_CHAT_MESSAGES = 200;
  const LOCAL_ECHO_TTL_MS = 10000;

  let overlay = null;
  let cachedUsername = 'You';
  let cachedUserId = null;
  let cachedRoomState = null;
  let launcherHost = null;
  let launcherButton = null;
  let launcherLabel = null;
  let launcherInRoom = false;
  let cachedIsHost = false;
  let activePanel = 'room';
  const ACCENT_SWATCHES = ['#6366f1', '#ec4899', '#22c55e', '#f59e0b', '#06b6d4', '#ef4444'];
  const localPreferences = {
    username: '',
    accentColor: '#6366f1',
    compactChat: false,
    reactionSound: true,
    floatingReactions: true,
  };
  let roomKeyRenderSeq = 0;
  let roomKeyDraftRoomId = null;
  let roomKeyDraftValue = '';

  // --- Emoji picker (emoji-picker-element library) ---
  function loadEmojiPicker() {
    // Inject as page-context module (custom elements need the main world)
    const script = document.createElement('script');
    script.type = 'module';
    script.src = chrome.runtime.getURL('vendor/emoji-loader.js');
    document.head.appendChild(script);
  }

  // --- Shared utilities (from utils.js, loaded before this file) ---
  const { getUserColor, escapeHtml } = WPUtils;

  // --- Per-message reactions (Discord-style) ---
  // Rules: one user = one reaction per emoji, toggle on/off, count = unique users
  let activePopupMsg = null;
  let reactionTarget = null; // { pills } — when set, emoji picker adds a reaction instead of inserting into chat

  function buildMsgEl(nameHtml, textHtml) {
    const div = document.createElement('div');
    div.className = 'wp-chat-msg';

    // Row: content on the left, toolbar on the right (inline, not floating)
    const row = document.createElement('div');
    row.className = 'wp-msg-row';

    const content = document.createElement('div');
    content.className = 'wp-msg-content';
    content.innerHTML = `${nameHtml} ${textHtml}`;
    row.appendChild(content);

    // Toolbar: small react icon, appears on hover, INSIDE the message row
    const toolbar = document.createElement('div');
    toolbar.className = 'wp-msg-toolbar';
    toolbar.innerHTML = '<button class="wp-msg-react-trigger" title="Add Reaction" aria-label="Add Reaction">☺</button>';
    row.appendChild(toolbar);
    div.appendChild(row);

    // Reaction pills (below message text)
    const pills = document.createElement('div');
    pills.className = 'wp-msg-pills';
    div.appendChild(pills);

    // No per-element listeners here — all handled by delegated listeners on #wp-chat-messages
    // (see bindChatDelegation() for hover, react button, and pill click handling)

    return div;
  }

  // Toggle reaction: one per user per emoji, no stacking
  function toggleReaction(pillsContainer, emoji) {
    const existing = pillsContainer.querySelector(`[data-emoji="${CSS.escape(emoji)}"]`);
    if (existing && existing.classList.contains('wp-pill-mine')) {
      // Already reacted with this emoji → remove own reaction
      const countEl = existing.querySelector('.wp-pill-count');
      const newCount = parseInt(countEl.textContent) - 1;
      if (newCount <= 0) { existing.remove(); } else {
        countEl.textContent = newCount;
        existing.classList.remove('wp-pill-mine');
      }
      return;
    }
    if (existing) {
      // Pill exists from others, add ours
      const countEl = existing.querySelector('.wp-pill-count');
      countEl.textContent = parseInt(countEl.textContent) + 1;
      existing.classList.add('wp-pill-mine');
    } else {
      // New pill
      const pill = document.createElement('button');
      pill.className = 'wp-react-pill wp-pill-mine';
      pill.dataset.emoji = emoji;
      pill.innerHTML = `<span class="wp-pill-emoji">${escapeHtml(emoji)}</span><span class="wp-pill-count">1</span>`;
      // No per-pill listener — handled by delegated click on #wp-chat-messages
      pillsContainer.appendChild(pill);
    }
    dispatchAction(WPConstants.ACTION.ROOM_REACTION_SEND, { emoji });
  }


  function closeReactionPopup() {
    if (reactionTarget) {
      const pickerEl = document.getElementById('wp-emoji-picker');
      if (pickerEl) {
        pickerEl.classList.add('wp-hidden-el');
        // Clear inline styles so CSS position:absolute takes over
        pickerEl.style.cssText = '';
      }
      reactionTarget = null;
    }
    if (activePopupMsg) {
      activePopupMsg.classList.remove('wp-msg-hovered');
      activePopupMsg = null;
    }
  }

  document.addEventListener('click', (e) => {
    // Don't close if clicking inside the picker
    const pickerEl = document.getElementById('wp-emoji-picker');
    if (pickerEl && pickerEl.contains(e.target)) return;
    closeReactionPopup();
  });

  // --- Notification sound ---
  let audioCtx = null;
  let userHasInteracted = false;
  // Create AudioContext only after user gesture (Chrome autoplay policy)
  function ensureAudioCtx() {
    if (!userHasInteracted) return null;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => { });
    return audioCtx;
  }
  document.addEventListener('click', () => { userHasInteracted = true; ensureAudioCtx(); }, { once: true });
  document.addEventListener('keydown', () => { userHasInteracted = true; }, { once: true });

  function playTone(frequency, gainValue, duration) {
    try {
      const ctx = ensureAudioCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(ctx.destination);
      osc.frequency.value = frequency;
      g.gain.value = gainValue;
      osc.start();
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.stop(ctx.currentTime + duration);
    } catch { /* audio not available */ }
  }

  function playNotifSound() { playTone(800, 0.08, 0.15); }

  // escapeHtml() provided by WPUtils (destructured above)

  // --- Sidebar visibility helpers (used 9+ times across file) ---
  function isSidebarOpen() {
    return !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden');
  }

  // --- Local echo dedup helpers ---
  const localEchoSet = new Set();
  function addLocalEcho(content) {
    const key = content.substring(0, 300);
    localEchoSet.add(key);
    setTimeout(() => localEchoSet.delete(key), LOCAL_ECHO_TTL_MS);
  }
  function isLocalEcho(content) {
    const key = content.substring(0, 300);
    if (localEchoSet.has(key)) { localEchoSet.delete(key); return true; }
    return false;
  }

  // --- DOM pruning helper ---
  function pruneChildren(container, max = MAX_CHAT_MESSAGES) {
    while (container.childElementCount > max && container.firstElementChild) {
      container.removeChild(container.firstElementChild);
    }
  }

  // --- Render cache (avoids rewriting unchanged DOM) ---
  const renderCache = {
    lastStatusHtml: '',
    lastUsersKey: '',
    lastRoomCode: '',
    lastMinInfo: '',
    lastContentLinkKey: 'hidden',
    lastSyncIndicatorKey: 'hidden',
    lastCatchUpLabel: '',
    catchUpVisible: false,
  };

  function resetRenderCache() {
    renderCache.lastStatusHtml = '';
    renderCache.lastUsersKey = '';
    renderCache.lastRoomCode = '';
    renderCache.lastMinInfo = '';
    renderCache.lastContentLinkKey = 'hidden';
    renderCache.lastSyncIndicatorKey = 'hidden';
    renderCache.lastCatchUpLabel = '';
    renderCache.catchUpVisible = false;
  }

  function removeCatchUpButton() {
    document.getElementById('wp-catchup-btn')?.remove();
    renderCache.lastCatchUpLabel = '';
    renderCache.catchUpVisible = false;
  }

  // --- Action dispatch helper ---
  function dispatchAction(action, detail = {}) {
    document.dispatchEvent(new CustomEvent('wp-action', { detail: { action, ...detail } }));
  }

  function normalizeUsernameInput(value) {
    return String(value || '').trim().slice(0, 25);
  }

  function syncLocalPreferenceState(result = {}) {
    if (typeof result[WPConstants.STORAGE.USERNAME] === 'string') {
      localPreferences.username = normalizeUsernameInput(result[WPConstants.STORAGE.USERNAME]);
    }
    localPreferences.accentColor = result[WPConstants.STORAGE.ACCENT_COLOR] || '#6366f1';
    localPreferences.compactChat = !!result[WPConstants.STORAGE.COMPACT_CHAT];
    localPreferences.reactionSound = result[WPConstants.STORAGE.REACTION_SOUND] !== false;
    localPreferences.floatingReactions = result[WPConstants.STORAGE.FLOATING_REACTIONS] !== false;
  }

  function loadLocalPreferences(callback) {
    chrome.storage?.local?.get([
      WPConstants.STORAGE.USERNAME,
      WPConstants.STORAGE.ACCENT_COLOR,
      WPConstants.STORAGE.COMPACT_CHAT,
      WPConstants.STORAGE.REACTION_SOUND,
      WPConstants.STORAGE.FLOATING_REACTIONS,
    ], (result) => {
      syncLocalPreferenceState(result);
      callback?.();
    });
  }

  function refreshLocalSettingsCard() {
    const container = document.getElementById('wp-local-settings');
    if (!container || !cachedRoomState) return;
    renderLocalSettingsCard(container);
  }

  function refreshRoomControlsCard(force = false) {
    const container = document.getElementById('wp-room-controls');
    if (!container || !cachedRoomState) return;
    if (force) delete container.dataset.shellKey;
    renderRoomControls(container, cachedRoomState, cachedIsHost);
  }

  function persistDisplayName(nextUsername) {
    const username = normalizeUsernameInput(nextUsername);
    if (!username) {
      showToast('Add a display name first.', 1800);
      return false;
    }
    localPreferences.username = username;
    cachedUsername = username;
    chrome.storage.local.set({ [WPConstants.STORAGE.USERNAME]: username });
    dispatchAction(WPConstants.ACTION.SESSION_USERNAME_UPDATE, { username });
    refreshLocalSettingsCard();
    return true;
  }

  function normalizeRoomKeyInput(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return /^[A-Za-z0-9_-]{16,200}$/.test(trimmed) ? trimmed : null;
  }

  function getStoredRoomKey(roomId) {
    return WPRoomKeys.get(roomId);
  }

  function clearRoomKeyDraft(roomId) {
    if (!roomId || roomKeyDraftRoomId === roomId) {
      roomKeyDraftRoomId = null;
      roomKeyDraftValue = '';
    }
  }

  function getRoomKeyHelpText(roomState, isHost, hasRoomKey) {
    const othersInRoom = Math.max(0, (roomState?.users?.length || 0) - 1);
    if (isHost) {
      return othersInRoom > 0
        ? 'Change the invite key when you are alone in the room to avoid breaking private-room peers.'
        : 'Changing the invite key updates future invite links for this private room.';
    }
    return hasRoomKey
      ? 'This invite key is part of the room link for this browser.'
      : 'Paste a full invite link when joining private rooms so the key reaches this browser.';
  }

  async function handleRoomKeySave(roomState, isHost) {
    const input = document.getElementById('wp-room-key-input');
    const button = document.getElementById('wp-room-key-save');
    const roomId = roomState?.id;
    if (!roomId || roomState?.public !== false || !input) return;
    if (!isHost) {
      showToast('Only the host can change the invite key.', 2500);
      return;
    }

    const nextKey = normalizeRoomKeyInput(input.value);
    if (!nextKey) {
      showToast('Use 16-200 letters, numbers, underscores, or hyphens.', 3000);
      input.focus();
      return;
    }

    const othersInRoom = Math.max(0, (roomState?.users?.length || 0) - 1);
    if (othersInRoom > 0) {
      showToast('Change the invite key when you are alone in the room to avoid breaking private-room peers.', 3500);
      return;
    }

    const existingKey = await getStoredRoomKey(roomId);
    if (existingKey === nextKey) {
      showToast('That invite key is already active for this private room.', 2200);
      return;
    }

    roomKeyDraftRoomId = roomId;
    roomKeyDraftValue = nextKey;
    if (button) {
      button.disabled = true;
      button.textContent = 'Updating...';
    }

    dispatchAction(WPConstants.ACTION.ROOM_VISIBILITY_UPDATE, { public: false, roomKey: nextKey });
    showToast('Invite key updated for future room links.', 2200);

    setTimeout(() => {
      if (button) {
        button.disabled = false;
        button.textContent = 'Update Key';
      }
      refreshRoomControlsCard();
    }, 250);
  }

  function renderRoomKeyControls(roomState, isHost) {
    const input = document.getElementById('wp-room-key-input');
    const help = document.getElementById('wp-room-key-help');
    const button = document.getElementById('wp-room-key-save');
    if (!input || !help) {
      clearRoomKeyDraft(roomState?.id);
      return;
    }

    const roomId = roomState?.id;
    input.oninput = () => {
      roomKeyDraftRoomId = roomId || null;
      roomKeyDraftValue = input.value;
    };
    input.onkeydown = (event) => {
      if (event.key === 'Enter' && isHost) {
        event.preventDefault();
        handleRoomKeySave(roomState, isHost).catch(() => { });
      }
    };
    if (button) {
      button.onclick = () => { handleRoomKeySave(roomState, isHost).catch(() => { }); };
    }

    if (!roomId || roomState?.public !== false) {
      input.dataset.roomId = '';
      input.dataset.roomKeyLoaded = '';
      clearRoomKeyDraft(roomId);
      return;
    }

    const roomChanged = input.dataset.roomId !== roomId;
    const isEditing = document.activeElement === input && roomKeyDraftRoomId === roomId;
    const hasLoadedKey = input.dataset.roomKeyLoaded === 'true';
    const keepVisibleState = (!roomChanged && (hasLoadedKey || !!input.value)) || isEditing;

    input.dataset.roomId = roomId;
    input.disabled = !keepVisibleState;
    input.readOnly = !isHost;
    input.placeholder = isHost ? 'Invite key will appear here' : 'Invite key unavailable on this browser';
    if (!keepVisibleState) {
      help.textContent = isHost ? 'Loading invite key...' : 'Invite key is included when you copy the room link.';
    }
    if (button) {
      button.hidden = !isHost;
      button.disabled = !isHost;
      button.textContent = 'Update Key';
    }

    const renderSeq = ++roomKeyRenderSeq;
    getStoredRoomKey(roomId).then((roomKey) => {
      if (renderSeq !== roomKeyRenderSeq) return;

      input.disabled = false;
      input.readOnly = !isHost;
      input.dataset.roomKeyLoaded = roomKey ? 'true' : '';
      if (!isEditing) {
        input.value = roomKey || '';
        clearRoomKeyDraft(roomId);
      } else if (roomKeyDraftRoomId === roomId) {
        input.value = roomKeyDraftValue;
      }
      help.textContent = getRoomKeyHelpText(roomState, isHost, !!roomKey);
    }).catch(() => {
      if (renderSeq !== roomKeyRenderSeq) return;
      input.disabled = false;
      input.readOnly = !isHost;
      input.dataset.roomKeyLoaded = '';
      help.textContent = isHost
        ? 'WatchParty could not load the invite key on this browser.'
        : 'Invite key unavailable on this browser.';
    });
  }

  // --- Push Stremio content when sidebar opens/closes ---
  function getContentPushTarget() {
    return document.getElementById('app') || document.body;
  }

  function clearContentMargin(target) {
    if (!target) return;
    target.style.transition = '';
    target.style.width = '';
    target.style.maxWidth = '';
    target.style.overflow = '';
  }

  function isContentMarginApplied() {
    const target = getContentPushTarget();
    return target?.style.width?.includes(`${SIDEBAR_WIDTH}`) || false;
  }

  function updateContentMargin(sidebarOpen) {
    const target = getContentPushTarget();
    clearContentMargin(document.body);
    if (target && target !== document.body) clearContentMargin(target);

    // On small screens, sidebar overlays instead of pushing content
    if (window.innerWidth <= 640) return;

    target.style.transition = 'width .2s ease';
    target.style.width = sidebarOpen ? `calc(100% - ${SIDEBAR_WIDTH}px)` : '';
    target.style.maxWidth = sidebarOpen ? `calc(100% - ${SIDEBAR_WIDTH}px)` : '';
    if (target !== document.body) target.style.overflow = sidebarOpen ? 'hidden' : '';
    document.body.style.overflow = sidebarOpen ? 'hidden' : '';
  }

  function getDefaultPanel() {
    if (!launcherInRoom) return 'room';
    return cachedIsHost ? 'room' : 'chat';
  }

  function closeFloatingPanels() {
    document.getElementById('wp-emoji-picker')?.classList.add('wp-hidden-el');
    document.getElementById('wp-gif-picker')?.classList.add('wp-hidden-el');
    closeReactionPopup();
  }

  function updateLauncherState(options = {}) {
    if (!launcherHost || !launcherButton || !launcherLabel) return;
    const open = options.open ?? isSidebarOpen();
    const inRoom = options.inRoom ?? launcherInRoom;
    const compact = window.innerWidth <= 640;
    const positionLauncher = launcherHost._wpPosition;
    if (typeof positionLauncher === 'function') positionLauncher(open);
    launcherButton.classList.toggle('is-open', open);
    launcherButton.classList.toggle('is-room', inRoom);
    launcherButton.classList.toggle('is-compact', compact);
    launcherLabel.textContent = !inRoom ? 'WatchParty' : (open ? 'Hide' : 'Room');
    launcherButton.title = open
      ? 'Hide WatchParty'
      : (inRoom ? 'Open WatchParty sidebar' : 'Open WatchParty');
    launcherButton.setAttribute('aria-label', launcherButton.title);
  }

  function updateChatTabBadge() {
    const badge = document.getElementById('wp-tab-chat-badge');
    if (!badge) return;
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      badge.classList.remove('wp-hidden-el');
    } else {
      badge.classList.add('wp-hidden-el');
    }
  }

  function updateChatEmptyState(roomStateForHint = null) {
    const empty = document.getElementById('wp-chat-empty');
    const detail = document.getElementById('wp-chat-empty-text');
    const messages = document.getElementById('wp-chat-messages');
    if (!empty || !detail || !messages) return;
    if (!launcherInRoom || messages.childElementCount > 0) {
      empty.classList.add('wp-hidden-el');
      return;
    }
    detail.textContent = roomStateForHint?.public === false
      ? 'Private-room messages stay encrypted. Say hi, share a GIF, or switch to Room for playback controls.'
      : 'Say hi, share a GIF, or switch to Room for playback controls.';
    empty.classList.remove('wp-hidden-el');
  }

  function setActivePanel(panel, options = {}) {
    const allowedPanel = (!launcherInRoom && panel !== 'room') ? 'room' : (panel || getDefaultPanel());
    activePanel = allowedPanel;

    const chatPanel = document.getElementById('wp-panel-chat');
    const peoplePanel = document.getElementById('wp-panel-people');
    const roomPanel = document.getElementById('wp-panel-room');
    const prefsPanel = document.getElementById('wp-panel-prefs');
    const chatTab = document.querySelector('[data-panel="chat"]');
    const peopleTab = document.querySelector('[data-panel="people"]');
    const roomTab = document.querySelector('[data-panel="room"]');
    const prefsTab = document.querySelector('[data-panel="prefs"]');
    const nextInRoom = options.inRoom ?? launcherInRoom;

    if (chatPanel) chatPanel.classList.toggle('wp-hidden-el', activePanel !== 'chat');
    if (peoplePanel) peoplePanel.classList.toggle('wp-hidden-el', activePanel !== 'people');
    if (roomPanel) roomPanel.classList.toggle('wp-hidden-el', activePanel !== 'room');
    if (prefsPanel) prefsPanel.classList.toggle('wp-hidden-el', activePanel !== 'prefs');

    for (const [btn, panelName] of [[chatTab, 'chat'], [peopleTab, 'people'], [roomTab, 'room'], [prefsTab, 'prefs']]) {
      if (!btn) continue;
      const enabled = nextInRoom || panelName === 'room';
      btn.disabled = !enabled;
      btn.classList.toggle('wp-tab-active', panelName === activePanel);
      btn.classList.toggle('wp-tab-disabled', !enabled);
      btn.setAttribute('aria-selected', panelName === activePanel ? 'true' : 'false');
      btn.setAttribute('tabindex', panelName === activePanel ? '0' : '-1');
    }

    if (activePanel !== 'chat') closeFloatingPanels();
    if (activePanel === 'chat' && options.clearUnread !== false) clearUnread();
    updateLauncherState({ open: isSidebarOpen(), inRoom: nextInRoom });
  }

  function closeSidebar() {
    const sidebar = document.getElementById('wp-sidebar');
    if (!sidebar) return;
    sidebar.classList.add('wp-sidebar-hidden');
    updateContentMargin(false);
    closeFloatingPanels();
    updateLauncherState({ open: false });
  }

  function openSidebar(panel = activePanel || getDefaultPanel()) {
    const sidebar = document.getElementById('wp-sidebar');
    if (!sidebar) return;
    sidebar.classList.remove('wp-sidebar-hidden');
    updateContentMargin(true);
    setActivePanel(panel, { clearUnread: panel === 'chat' });
    updateLauncherState({ open: true });
  }


  // --- Toggle button (Shadow DOM, fixed position, independent of Stremio's DOM) ---
  function initToggleButton() {
    const toggleHost = document.createElement('div');
    toggleHost.id = 'wp-toggle-host';
    toggleHost.style.cssText = 'position:fixed;top:18px;right:128px;z-index:2147483647;visibility:hidden;';
    let placementFrame = null;

    function getLauncherRow() {
      const containers = [...document.querySelectorAll('[class*="buttons-container"]')]
        .filter((container) => container instanceof HTMLElement && container.isConnected)
        .map((container) => ({ container, rect: container.getBoundingClientRect(), style: getComputedStyle(container) }))
        .filter(({ rect, style }) =>
          rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && rect.top >= 0
          && rect.top < 120
          && rect.right > window.innerWidth / 2
          && rect.width < 400
        )
        .sort((a, b) => {
          if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
          return b.rect.right - a.rect.right;
        });
      return containers[0]?.container || null;
    }

    function placeLauncher(forceOpen = isSidebarOpen()) {
      const compact = window.innerWidth <= 640;
      if (compact && forceOpen) {
        toggleHost.dataset.wpPlacement = 'mobile-hidden';
        toggleHost.style.display = 'none';
        toggleHost.style.visibility = 'hidden';
        toggleHost.style.pointerEvents = 'none';
        return true;
      }

      const row = getLauncherRow();
      if (row) {
        if (toggleHost.parentElement !== row) row.prepend(toggleHost);
        toggleHost.dataset.wpPlacement = 'inline';
        toggleHost.style.position = 'relative';
        toggleHost.style.top = 'auto';
        toggleHost.style.right = 'auto';
        toggleHost.style.left = 'auto';
        toggleHost.style.bottom = 'auto';
        toggleHost.style.display = 'block';
        toggleHost.style.flex = '0 0 auto';
        toggleHost.style.marginRight = '8px';
        toggleHost.style.marginLeft = '0';
        toggleHost.style.alignSelf = 'center';
        toggleHost.style.zIndex = '1';
        toggleHost.style.pointerEvents = 'auto';
        toggleHost.style.visibility = 'visible';
        return true;
      }

      if (toggleHost.parentElement !== document.body) document.body.appendChild(toggleHost);
      toggleHost.dataset.wpPlacement = 'floating';
      toggleHost.style.position = 'fixed';
      toggleHost.style.top = forceOpen ? '64px' : '18px';
      toggleHost.style.right = `${forceOpen
        ? (compact ? 16 : SIDEBAR_WIDTH + 16)
        : (compact ? 16 : 128)}px`;
      toggleHost.style.left = 'auto';
      toggleHost.style.bottom = 'auto';
      toggleHost.style.display = '';
      toggleHost.style.flex = '';
      toggleHost.style.marginRight = '0';
      toggleHost.style.marginLeft = '0';
      toggleHost.style.alignSelf = '';
      toggleHost.style.pointerEvents = 'auto';
      toggleHost.style.zIndex = '2147483647';
      toggleHost.style.visibility = 'visible';
      return true;
    }

    function schedulePlacement(forceOpen = isSidebarOpen()) {
      if (placementFrame) cancelAnimationFrame(placementFrame);
      placementFrame = requestAnimationFrame(() => {
        placementFrame = null;
        placeLauncher(forceOpen);
      });
    }

    let placementAttempts = 0;
    const placementInterval = setInterval(() => {
      schedulePlacement();
      if (++placementAttempts >= 30 || getLauncherRow()) clearInterval(placementInterval);
    }, 150);
    setInterval(() => {
      if (!launcherHost?.isConnected) return;
      if (launcherHost.dataset.wpPlacement !== 'inline' || isSidebarOpen()) {
        schedulePlacement();
      }
    }, 1000);
    window.addEventListener('resize', () => schedulePlacement());
    const shadow = toggleHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { display:block; }
        button {
          min-width:126px; height:42px; padding:0 14px 0 12px; border-radius:999px; border:none;
          background:rgba(99,102,241,0.85); color:#fff;
          display:flex; align-items:center; justify-content:flex-start; gap:10px;
          cursor:pointer; transition:background .15s, transform .15s, box-shadow .15s;
          box-shadow:0 10px 28px rgba(0,0,0,0.35);
          font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        }
        button:hover { background:rgba(99,102,241,1); transform:translateY(-1px); }
        button.is-open {
          background:rgba(15,23,42,0.94);
          box-shadow:0 12px 30px rgba(0,0,0,0.4);
        }
        button.is-open:hover { background:rgba(30,41,59,0.98); }
        button.is-room .label { letter-spacing:0.01em; }
        button.is-compact {
          min-width:42px;
          width:42px;
          padding:0;
          gap:0;
          justify-content:center;
        }
        button.is-compact .label { display:none; }
        button.is-compact .icon {
          width:18px;
          height:18px;
        }
        .icon {
          width:20px; height:20px; flex-shrink:0;
          display:flex; align-items:center; justify-content:center;
        }
        .label {
          white-space:nowrap;
          overflow:hidden;
          text-overflow:ellipsis;
        }
        svg { width:20px; height:20px; }
      </style>
      <button title="Open WatchParty" aria-label="Open WatchParty">
        <span class="icon">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
        </span>
        <span class="label">WatchParty</span>
      </button>
    `;
    launcherHost = toggleHost;
    launcherButton = shadow.querySelector('button');
    launcherLabel = shadow.querySelector('.label');
    toggleHost._wpShadowBtn = launcherButton;
    toggleHost._wpPosition = schedulePlacement;
    const unreadBadge = document.createElement('span');
    unreadBadge.id = 'wp-unread-badge';
    unreadBadge.className = 'wp-hidden-el';
    toggleHost.appendChild(unreadBadge);

    function toggleSidebar() {
      if (isSidebarOpen()) closeSidebar();
      else openSidebar();
    }
    shadow.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); toggleSidebar(); });
    toggleHost.addEventListener('click', toggleSidebar);
    document.body.appendChild(toggleHost);

    let observerQueued = false;
    const placementObserver = new MutationObserver(() => {
      if (observerQueued) return;
      observerQueued = true;
      requestAnimationFrame(() => {
        observerQueued = false;
        schedulePlacement();
      });
    });
    placementObserver.observe(document.body, { childList: true, subtree: true });

    updateLauncherState({ open: false, inRoom: false });
  }

  // --- Emoji picker setup ---
  function initEmojiPicker() {
    const pickerContainer = document.getElementById('wp-emoji-picker');
    loadEmojiPicker();
    document.addEventListener('wp-emoji-lib-ready', () => {
      const picker = document.createElement('emoji-picker');
      picker.setAttribute('class', 'dark');
      picker.setAttribute('data-source', chrome.runtime.getURL('vendor/emoji-data.json'));
      picker.addEventListener('keydown', (e) => e.stopPropagation());
      picker.addEventListener('keyup', (e) => e.stopPropagation());
      picker.addEventListener('keypress', (e) => e.stopPropagation());
      pickerContainer.appendChild(picker);
    }, { once: true });

    document.addEventListener('wp-emoji-selected', (e) => {
      const emoji = e.detail;
      if (!emoji) return;
      if (reactionTarget) {
        if (reactionTarget.pills?.isConnected) toggleReaction(reactionTarget.pills, emoji);
        closeReactionPopup();
      } else {
        const input = document.getElementById('wp-chat-input');
        if (input) {
          const start = input.selectionStart || input.value.length;
          const end = input.selectionEnd || start;
          input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
          input.selectionStart = input.selectionEnd = start + emoji.length;
          input.focus();
        }
        pickerContainer.classList.add('wp-hidden-el');
      }
    });
  }

  // --- Margin observer (re-applies body width on SPA navigation) ---
  function initMarginObserver() {
    window.addEventListener('resize', () => updateContentMargin(isSidebarOpen()));
    const observer = new MutationObserver(() => {
      if (isSidebarOpen() && !isContentMarginApplied()) {
        updateContentMargin(true);
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('hashchange', () => {
      if (isSidebarOpen()) updateContentMargin(true);
    });
  }

  // --- Create overlay DOM ---
  function create() {
    if (overlay) return;
    const existing = document.getElementById('wp-overlay');
    if (existing) existing.remove();
    const existingToggle = document.getElementById('wp-toggle-host');
    if (existingToggle) existingToggle.remove();

    overlay = document.createElement('div');
    overlay.id = 'wp-overlay';
    overlay.innerHTML = `
      <div id="wp-sidebar" class="wp-sidebar-hidden">
        <div id="wp-header">
          <div id="wp-header-main">
            <span id="wp-title">WatchParty</span>
            <span id="wp-room-code" title="Click to copy"></span>
          </div>
          <button id="wp-close-sidebar" title="Close" aria-label="Close sidebar">&times;</button>
        </div>
        <div id="wp-tabbar" role="tablist" aria-label="WatchParty panels">
          <button class="wp-tab-btn wp-tab-active" data-panel="chat" role="tab" aria-selected="true">
            <span>Chat</span>
            <span id="wp-tab-chat-badge" class="wp-tab-badge wp-hidden-el"></span>
          </button>
          <button class="wp-tab-btn" data-panel="people" role="tab" aria-selected="false">
            <span>People</span>
          </button>
          <button class="wp-tab-btn" data-panel="room" role="tab" aria-selected="false">
            <span>Room</span>
          </button>
          <button class="wp-tab-btn" data-panel="prefs" role="tab" aria-selected="false">
            <span>Prefs</span>
          </button>
        </div>
        <div id="wp-body">
          <section id="wp-panel-chat" class="wp-panel" role="tabpanel">
            <div id="wp-chat-container" class="wp-hidden-el">
              <div id="wp-chat-empty">
                <div class="wp-chat-empty-card">
                  <div class="wp-chat-empty-title">Chat is live</div>
                  <div id="wp-chat-empty-text" class="wp-chat-empty-text"></div>
                </div>
              </div>
              <div id="wp-chat-messages"></div>
              <div id="wp-typing-indicator" class="wp-hidden-el"></div>
              <div id="wp-chat-input-row">
                <button id="wp-emoji-btn" title="Insert emoji" aria-label="Insert emoji">&#x1F600;</button>
                <button id="wp-gif-btn" title="Send GIF" aria-label="Send GIF">GIF</button>
                <input id="wp-chat-input" type="text" placeholder="Type a message..." maxlength="300" autocomplete="off" aria-label="Chat message" />
                <button id="wp-chat-send">Send</button>
              </div>
              <div id="wp-gif-picker" class="wp-hidden-el">
                <input id="wp-gif-search" type="text" placeholder="Search GIFs..." autocomplete="off" />
                <div id="wp-gif-results"></div>
              </div>
              <div id="wp-emoji-picker" class="wp-hidden-el"></div>
            </div>
          </section>
          <section id="wp-panel-people" class="wp-panel wp-hidden-el" role="tabpanel">
            <div id="wp-users"></div>
          </section>
          <section id="wp-panel-room" class="wp-panel wp-panel-room wp-hidden-el" role="tabpanel">
            <div id="wp-status"></div>
            <div id="wp-sync-indicator" class="wp-hidden-el"></div>
            <div id="wp-content-link" class="wp-hidden-el"></div>
            <div id="wp-room-controls"></div>
          </section>
          <section id="wp-panel-prefs" class="wp-panel wp-panel-room wp-hidden-el" role="tabpanel">
            <div id="wp-local-settings"></div>
          </section>
        </div>
      </div>
      <div id="wp-reaction-container"></div>
    `;
    document.body.appendChild(overlay);

    initToggleButton();
    initEmojiPicker();
    bindEvents();
    bindChatDelegation();
    initMarginObserver();
    WPTheme.startListening();
    loadLocalPreferences(() => refreshLocalSettingsCard());
  }

  // --- Chat event delegation (replaces per-message listeners) ---
  function bindChatDelegation() {
    const chatMessages = document.getElementById('wp-chat-messages');
    if (!chatMessages) return;

    // Delegated hover: mouseenter/mouseleave don't bubble, but mouseover/mouseout do
    chatMessages.addEventListener('mouseover', (e) => {
      const msg = e.target.closest('.wp-chat-msg');
      if (msg) msg.classList.add('wp-msg-hovered');
    });
    chatMessages.addEventListener('mouseout', (e) => {
      const msg = e.target.closest('.wp-chat-msg');
      if (!msg) return;
      // Keep hover if reaction popup is open for this message
      if (activePopupMsg === msg) return;
      // Check if we're leaving to something still inside the message
      if (msg.contains(e.relatedTarget)) return;
      msg.classList.remove('wp-msg-hovered');
    });

    // Delegated click: handles react buttons, reaction pills, and bookmark times
    chatMessages.addEventListener('click', (e) => {
      // React button → open emoji picker in reaction mode
      const reactBtn = e.target.closest('.wp-msg-react-trigger');
      if (reactBtn) {
        e.stopPropagation();
        const msg = reactBtn.closest('.wp-chat-msg');
        const pills = msg?.querySelector('.wp-msg-pills');
        const pickerEl = document.getElementById('wp-emoji-picker');
        if (!pickerEl || !msg || !pills) return;

        // If already open for this message, close it
        if (activePopupMsg === msg && !pickerEl.classList.contains('wp-hidden-el')) {
          closeReactionPopup();
          return;
        }
        closeReactionPopup();

        reactionTarget = { pills };
        activePopupMsg = msg;

        // Position picker near the message (inside sidebar via CSS absolute)
        pickerEl.style.cssText = '';
        pickerEl.classList.remove('wp-hidden-el');
        return;
      }

      // Reaction pill → toggle reaction
      const pill = e.target.closest('.wp-react-pill');
      if (pill) {
        const pillsContainer = pill.closest('.wp-msg-pills');
        if (pillsContainer && pill.dataset.emoji) {
          toggleReaction(pillsContainer, pill.dataset.emoji);
        }
        return;
      }
    });
  }

  function isOverlayInputNode(node) {
    return node instanceof Element && (
      node.id === 'wp-chat-input'
      || node.id === 'wp-gif-search'
      || !!node.closest('#wp-chat-input-row')
      || !!node.closest('#wp-gif-picker')
      || !!node.closest('#wp-emoji-picker')
    );
  }

  function eventTargetsOverlayInput(event) {
    if (isOverlayInputNode(event.target)) return true;
    if (typeof event.composedPath !== 'function') return false;
    return event.composedPath().some(isOverlayInputNode);
  }

  function hasOverlayInputFocus() {
    return isOverlayInputNode(document.activeElement);
  }

  function bindInputFieldGuards(input, options = {}) {
    const { allowEnterSubmit = false, onEscape = null } = options;
    if (!input) return;

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const lowerKey = String(e.key || '').toLowerCase();
      if (allowEnterSubmit && e.key === 'Enter') {
        e.preventDefault();
        sendChat();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onEscape?.();
        return;
      }
      if (e.altKey && lowerKey === 'w') {
        e.preventDefault();
      }
    });
    input.addEventListener('keyup', (e) => {
      if (e.altKey && String(e.key || '').toLowerCase() === 'w') e.preventDefault();
      e.stopPropagation();
    });
    input.addEventListener('keypress', (e) => {
      if ((allowEnterSubmit && e.key === 'Enter') || (e.altKey && String(e.key || '').toLowerCase() === 'w')) {
        e.preventDefault();
      }
      e.stopPropagation();
    });
  }

  // --- Event bindings ---
  function bindEvents() {
    const $ = (id) => document.getElementById(id);

    $('wp-close-sidebar').addEventListener('click', closeSidebar);
    document.querySelectorAll('.wp-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => setActivePanel(btn.dataset.panel));
    });
    $('wp-chat-send').addEventListener('click', () => sendChat());
    bindInputFieldGuards($('wp-chat-input'), { allowEnterSubmit: true });
    // --- Emoji picker toggle (library handles everything else) ---
    $('wp-emoji-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pickerEl = $('wp-emoji-picker');
      // Reset to chat mode: clear any reaction target, restore default position
      reactionTarget = null;
      if (activePopupMsg) {
        activePopupMsg.classList.remove('wp-msg-hovered');
        activePopupMsg = null;
      }
      pickerEl.style.cssText = '';
      pickerEl.classList.toggle('wp-hidden-el');
    });

    // --- GIF picker ---
    let gifDebounce = null;
    $('wp-gif-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      $('wp-gif-picker').classList.toggle('wp-hidden-el');
      $('wp-emoji-picker').classList.add('wp-hidden-el');
      if (!$('wp-gif-picker').classList.contains('wp-hidden-el')) {
        $('wp-gif-search').focus();
        searchGifs('trending');
      }
    });
    bindInputFieldGuards($('wp-gif-search'), {
      onEscape() {
        $('wp-gif-picker').classList.add('wp-hidden-el');
        $('wp-chat-input')?.focus();
      },
    });
    $('wp-gif-search').addEventListener('input', (e) => {
      clearTimeout(gifDebounce);
      const q = e.target.value.trim();
      gifDebounce = setTimeout(() => searchGifs(q || 'trending'), 300);
    });
    // Event delegation for GIF clicks (avoids per-element listeners on every search)
    $('wp-gif-results').addEventListener('click', (e) => {
      const img = e.target.closest('.wp-gif-item');
      if (!img?.dataset.url) return;
      const gifContent = `[gif:${img.dataset.url}]`;
      dispatchAction(WPConstants.ACTION.ROOM_CHAT_SEND, { content: gifContent });
      // Local echo + dedup tracking (same pattern as text chat)
      const container = document.getElementById('wp-chat-messages');
      if (container) {
        const div = buildMsgEl(
          `<span class="wp-chat-name" style="color:${getUserColor(cachedSessionId || cachedUserId)}">${escapeHtml(cachedUsername)}</span>`,
          `<img class="wp-chat-gif" src="${escapeHtml(img.dataset.url)}" alt="GIF" />`
        );
        div.classList.add('wp-chat-local');
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        addLocalEcho(gifContent);
      }
      $('wp-gif-picker').classList.add('wp-hidden-el');
      $('wp-chat-input')?.focus();
    });

    async function searchGifs(query) {
      const results = $('wp-gif-results');
      try {
        // Tenor API browser key (public, restricted by HTTP referrer — standard for client-side GIF search)
        const TENOR_KEY = 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ';
        const endpoint = query === 'trending'
          ? `https://tenor.googleapis.com/v2/featured?key=${TENOR_KEY}&limit=20&media_filter=tinygif`
          : `https://tenor.googleapis.com/v2/search?key=${TENOR_KEY}&q=${encodeURIComponent(query)}&limit=20&media_filter=tinygif`;
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error(`Tenor API ${res.status}`);
        const data = await res.json();
        results.innerHTML = (data.results || []).map(g => {
          const url = g.media_formats?.tinygif?.url || g.media_formats?.gif?.url || '';
          return url ? `<img class="wp-gif-item" src="${escapeHtml(url)}" data-url="${escapeHtml(url)}" loading="lazy" />` : '';
        }).join('');
      } catch { results.innerHTML = '<div style="text-align:center;color:#666;padding:16px">Search failed</div>'; }
    }
  }

  let lastSendTime = 0;
  function disableSendButton() {
    const btn = document.getElementById('wp-chat-send');
    if (!btn) return;
    btn.disabled = true;
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
    setTimeout(() => { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; }, 3000);
  }
  function sendChat() {
    const input = document.getElementById('wp-chat-input');
    if (!input || !input.value.trim()) return;
    const btn = document.getElementById('wp-chat-send');
    if (btn?.disabled) return; // Already in cooldown
    // Client-side cooldown — prevent rapid sends (server has 3s cooldown)
    const now = Date.now();
    if (now - lastSendTime < 3000) return;
    lastSendTime = now;
    disableSendButton();
    const content = input.value.trim();

    // Optimistic local echo — show message immediately
    const container = document.getElementById('wp-chat-messages');
    if (container) {
      const div = buildMsgEl(
        `<span class="wp-chat-name" style="color:${getUserColor(cachedSessionId || cachedUserId)}">${escapeHtml(cachedUsername)}</span>`,
        `<span class="wp-chat-text">${escapeHtml(content)}</span>`
      );
      div.classList.add('wp-chat-local');
      container.appendChild(div);
      pruneChildren(container);
      container.scrollTop = container.scrollHeight;
      addLocalEcho(content);
    }

    dispatchAction(WPConstants.ACTION.ROOM_CHAT_SEND, { content });
    dispatchAction(WPConstants.ACTION.ROOM_TYPING_SEND, { typing: false });
    input.value = '';
  }

  // --- State updates ---

  let cachedSessionId = null;

  function updateState({ inRoom, isHost, userId, sessionId, roomState, hasVideo, wsConnected }) {
    if (sessionId) cachedSessionId = sessionId;
    const previousRoomId = cachedRoomState?.id;
    cachedRoomState = roomState || null;
    if (previousRoomId && previousRoomId !== roomState?.id) {
      clearRoomKeyDraft(previousRoomId);
    }
    cachedIsHost = !!isHost;
    // Cache username for local echo
    if (userId && roomState?.users) {
      cachedUserId = userId;
      const me = roomState.users.find(u => u.id === userId || (cachedSessionId && u.sessionId === cachedSessionId));
      if (me) cachedUsername = me.name;
    }
    launcherInRoom = !!(inRoom && roomState);
    if (!overlay) return;

    // Re-apply content margin if sidebar is open (Stremio SPA navigation can reset body width)
    if (isSidebarOpen()) {
      updateContentMargin(true);
    }

    const status = document.getElementById('wp-status');
    const roomCode = document.getElementById('wp-room-code');
    const usersDiv = document.getElementById('wp-users');
    const contentLink = document.getElementById('wp-content-link');
    const syncInd = document.getElementById('wp-sync-indicator');
    const roomControls = document.getElementById('wp-room-controls');
    const localSettings = document.getElementById('wp-local-settings');

    const chatContainer = document.getElementById('wp-chat-container');
    if (!inRoom || !roomState) {
      resetRenderCache();
      launcherInRoom = false;
      if (status) status.innerHTML = '<div class="wp-empty-state">Not in a room.<br/><a class="wp-empty-link" href="https://watchparty.mertd.me" target="_blank" rel="noreferrer">Create or join from WatchParty</a>.</div>';
      if (roomCode) roomCode.textContent = '';
      if (usersDiv) usersDiv.innerHTML = '';
      if (contentLink) contentLink.classList.add('wp-hidden-el');
      if (syncInd) syncInd.classList.add('wp-hidden-el');
      if (roomControls) roomControls.innerHTML = '';
      if (localSettings) localSettings.innerHTML = '';
      if (chatContainer) chatContainer.classList.add('wp-hidden-el');
      document.getElementById('wp-chat-empty')?.classList.add('wp-hidden-el');
      removeCatchUpButton();
      setActivePanel('room', { inRoom: false, clearUnread: false });
      updateLauncherState({ inRoom: false });
      return;
    }

    // Show chat when in room
    if (chatContainer) chatContainer.classList.remove('wp-hidden-el');

    const nextRoomCode = roomState.id?.slice(0, 8) || '';
    if (roomCode && renderCache.lastRoomCode !== nextRoomCode) {
      roomCode.textContent = nextRoomCode;
      renderCache.lastRoomCode = nextRoomCode;
    }

    if (status) renderStatusButtons(status, isHost, hasVideo, wsConnected, roomState);
    if (contentLink) renderContentLink(contentLink, isHost, roomState);
    if (roomControls) renderRoomControls(roomControls, roomState, isHost);
    if (localSettings) renderLocalSettingsCard(localSettings);
    if (usersDiv && roomState.users) renderUsersList(usersDiv, roomState, userId, isHost);
    if (isHost || !hasVideo) removeCatchUpButton();
    updateChatEmptyState(roomState);
    if (!launcherInRoom || activePanel === 'room') setActivePanel(getDefaultPanel(), { inRoom: true, clearUnread: activePanel === 'chat' });
    updateLauncherState({ inRoom: true });
  }

  function renderStatusButtons(status, isHost, hasVideo, wsConnected, roomState) {
    const hostLabel = isHost ? 'You are hosting this room' : 'You are synced to the host';
    const videoStatus = hasVideo
      ? 'Playback can sync from this tab.'
      : 'Open a Stremio video in this tab to sync playback.';
    const connectionStatus = wsConnected === false
      ? '<span class="wp-status-line wp-warning">Connection lost — trying to reconnect</span>'
      : '';
    const roomLabel = roomState?.name || roomState?.meta?.name || 'WatchParty room';
    let actions = '';
    if (hasVideo && isHost) actions += `<button class="wp-action-btn" id="wp-ready-check-btn" title="Ready Check">✋ Ready?</button>`;
    if (hasVideo) actions += `<button class="wp-action-btn" id="wp-bookmark-btn" title="Bookmark this moment">📌 Bookmark</button>`;
    const actionsRow = actions ? `<div class="wp-action-row">${actions}</div>` : '';
    const newStatusHtml = `<span class="wp-status-line wp-status-heading">${escapeHtml(roomLabel)}</span><span class="wp-status-line">${hostLabel}</span>${connectionStatus}<span class="wp-status-line wp-muted">${videoStatus}</span>${actionsRow}`;
    if (renderCache.lastStatusHtml === newStatusHtml) return;
    status.innerHTML = newStatusHtml;
    renderCache.lastStatusHtml = newStatusHtml;
    document.getElementById('wp-ready-check-btn')?.addEventListener('click', () => {
      dispatchAction(WPConstants.ACTION.ROOM_READY_CHECK_UPDATE, { readyAction: 'initiate' });
      const video = document.querySelector('video');
      if (video && !video.paused) video.pause();
      const userCount = document.getElementById('wp-users')?.children.length || 1;
      showReadyCheck('started', [], userCount, cachedUserId);
    });
    document.getElementById('wp-bookmark-btn')?.addEventListener('click', () => {
      const video = document.querySelector('video');
      if (!video) return;
      const time = video.currentTime;
      dispatchAction(WPConstants.ACTION.ROOM_BOOKMARK_ADD, { time });
      appendBookmark({ user: cachedUserId, userName: cachedUsername, time, label: '' });
      showToast('Bookmark saved!', 1500);
    });
  }

  function renderRoomControls(container, roomState, isHost) {
    const sessionSummary = roomState.public
      ? 'Listed publicly on WatchParty.'
      : 'Invite link required. Private-room messages stay encrypted.';
    const autoPause = roomState.settings?.autoPauseOnDisconnect === true;
    const isPrivateRoom = roomState.public === false;
    const shellKey = isHost ? 'host' : 'guest';
    if (container.dataset.shellKey !== shellKey || !container.querySelector('#wp-room-controls-copy')) {
      container.innerHTML = `
        <div class="wp-card-title">Room controls</div>
        <div class="wp-card-copy" id="wp-room-controls-copy"></div>
        ${isHost ? `
          <div class="wp-settings-subtitle">Shared with everyone</div>
          <div class="wp-setting-list">
            ${buildToggleRow('wp-session-public', 'Listed publicly', 'Let people discover this room from WatchParty before they have the invite link.', false)}
            ${buildToggleRow('wp-session-autopause', 'Pause if someone drops', 'Pause playback if someone disconnects unexpectedly.', false)}
          </div>
        ` : `
          <div class="wp-settings-note">Only the host can change privacy and playback safeguards. You can still copy the invite link and leave from here.</div>
        `}
        <div id="wp-room-key-section" class="wp-hidden-el">
          <div class="wp-settings-subtitle">Invite key</div>
          <div class="wp-name-row wp-room-key-row">
            <input id="wp-room-key-input" class="wp-name-input wp-room-key-input" type="text" spellcheck="false" autocomplete="off" />
            ${isHost ? '<button class="wp-name-save wp-room-key-btn" id="wp-room-key-save" type="button">Update Key</button>' : ''}
          </div>
          <div class="wp-room-key-help" id="wp-room-key-help"></div>
        </div>
        <div class="wp-settings-subtitle">Actions</div>
        <div class="wp-inline-grid">
          <button class="wp-action-btn" id="wp-copy-invite-btn" type="button">Copy Invite</button>
          <button class="wp-action-btn" id="wp-leave-room-btn" type="button">Leave Room</button>
        </div>
      `;
      container.dataset.shellKey = shellKey;
    }

    const summary = container.querySelector('#wp-room-controls-copy');
    if (summary && summary.textContent !== sessionSummary) {
      summary.textContent = sessionSummary;
    }

    const publicToggle = container.querySelector('#wp-session-public');
    if (publicToggle && publicToggle.checked !== !!roomState.public) {
      publicToggle.checked = !!roomState.public;
    }

    const autoPauseToggle = container.querySelector('#wp-session-autopause');
    if (autoPauseToggle && autoPauseToggle.checked !== autoPause) {
      autoPauseToggle.checked = autoPause;
    }

    const roomKeySection = container.querySelector('#wp-room-key-section');
    roomKeySection?.classList.toggle('wp-hidden-el', !isPrivateRoom);

    container.querySelector('#wp-copy-invite-btn').onclick = async () => {
      const copied = await copyInviteUrl(roomState);
      showToast(copied ? 'Invite copied' : 'Copy failed', 1600);
    };
    container.querySelector('#wp-leave-room-btn').onclick = () => {
      dispatchAction(WPConstants.ACTION.ROOM_LEAVE);
    };
    if (publicToggle) {
      publicToggle.onchange = (event) => {
        dispatchAction(WPConstants.ACTION.ROOM_VISIBILITY_UPDATE, { public: !!event.target.checked });
      };
    }
    if (autoPauseToggle) {
      autoPauseToggle.onchange = (event) => {
        dispatchAction(WPConstants.ACTION.ROOM_SETTINGS_UPDATE, { settings: { autoPauseOnDisconnect: !!event.target.checked } });
      };
    }
    renderRoomKeyControls(roomState, isHost);
  }

  function buildAccentSwatchButtons() {
    return ACCENT_SWATCHES.map((color) => `
      <button
        type="button"
        class="wp-color-btn${localPreferences.accentColor === color ? ' is-active' : ''}"
        data-color="${color}"
        title="${color}"
        style="background:${color}"
      ></button>
    `).join('');
  }

  function buildToggleRow(inputId, label, description, checked) {
    return `
      <label class="wp-setting-row" for="${inputId}">
        <span class="wp-setting-copy">
          <span class="wp-setting-label">${escapeHtml(label)}</span>
          <span class="wp-setting-desc">${escapeHtml(description)}</span>
        </span>
        <span class="wp-toggle-shell">
          <input type="checkbox" id="${inputId}" ${checked ? 'checked' : ''} />
          <span class="wp-toggle-ui" aria-hidden="true">
            <span class="wp-toggle-knob"></span>
          </span>
        </span>
      </label>
    `;
  }

  function renderLocalSettingsCard(container) {
    if (!container.dataset.shellReady || !container.querySelector('#wp-settings-username')) {
      container.innerHTML = `
        <div class="wp-card-title">Preferences</div>
        <div class="wp-card-copy">These settings only affect this browser. Room controls stay shared with the host.</div>
        <div class="wp-settings-subtitle">Display name</div>
        <div class="wp-name-row">
          <input id="wp-settings-username" class="wp-name-input" type="text" maxlength="25" placeholder="Display name" />
          <button class="wp-name-save" id="wp-settings-save-name" type="button">Save</button>
        </div>
        <div class="wp-settings-subtitle">Sidebar behaviour</div>
        <div class="wp-setting-list">
          ${buildToggleRow('wp-settings-compact', 'Compact chat', 'Show denser spacing in the WatchParty sidebar.', false)}
          ${buildToggleRow('wp-settings-sound', 'Reaction sounds', 'Play short audio cues when reactions land.', false)}
          ${buildToggleRow('wp-settings-floating', 'Floating reactions', 'Show emoji bursts over the video when reactions arrive.', false)}
        </div>
        <div class="wp-settings-subtitle">Accent color</div>
        <div class="wp-color-row">${buildAccentSwatchButtons()}</div>
      `;
      container.dataset.shellReady = 'true';

      const saveName = () => persistDisplayName(container.querySelector('#wp-settings-username')?.value || '');
      container.querySelector('#wp-settings-save-name')?.addEventListener('click', saveName);
      container.querySelector('#wp-settings-username')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          saveName();
        }
      });
      container.querySelector('#wp-settings-compact')?.addEventListener('change', (event) => {
        chrome.storage.local.set({ [WPConstants.STORAGE.COMPACT_CHAT]: !!event.target.checked });
      });
      container.querySelector('#wp-settings-sound')?.addEventListener('change', (event) => {
        chrome.storage.local.set({ [WPConstants.STORAGE.REACTION_SOUND]: !!event.target.checked });
      });
      container.querySelector('#wp-settings-floating')?.addEventListener('change', (event) => {
        chrome.storage.local.set({ [WPConstants.STORAGE.FLOATING_REACTIONS]: !!event.target.checked });
      });
      container.querySelectorAll('.wp-color-btn').forEach((button) => {
        button.addEventListener('click', () => {
          chrome.storage.local.set({ [WPConstants.STORAGE.ACCENT_COLOR]: button.dataset.color || '#6366f1' });
        });
      });
    }

    const displayName = normalizeUsernameInput(localPreferences.username || cachedUsername);
    const usernameInput = container.querySelector('#wp-settings-username');
    if (usernameInput && document.activeElement !== usernameInput && usernameInput.value !== displayName) {
      usernameInput.value = displayName;
    }

    const compactToggle = container.querySelector('#wp-settings-compact');
    if (compactToggle && compactToggle.checked !== !!localPreferences.compactChat) {
      compactToggle.checked = !!localPreferences.compactChat;
    }

    const soundToggle = container.querySelector('#wp-settings-sound');
    if (soundToggle && soundToggle.checked !== !!localPreferences.reactionSound) {
      soundToggle.checked = !!localPreferences.reactionSound;
    }

    const floatingToggle = container.querySelector('#wp-settings-floating');
    if (floatingToggle && floatingToggle.checked !== !!localPreferences.floatingReactions) {
      floatingToggle.checked = !!localPreferences.floatingReactions;
    }

    container.querySelectorAll('.wp-color-btn').forEach((button) => {
      const isActive = (button.dataset.color || '#6366f1') === localPreferences.accentColor;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  function getDirectStreamUrl(roomState) {
    return WPUtils.getDirectJoinUrl(roomState);
  }

  function renderContentLink(contentLink, isHost, roomState) {
    const hasMeta = !!roomState.meta?.id && roomState.meta.id !== 'pending' && roomState.meta.id !== 'unknown';
    const directStreamUrl = getDirectStreamUrl(roomState);
    if (isHost || (!hasMeta && !directStreamUrl) || document.querySelector('video')) {
      if (renderCache.lastContentLinkKey !== 'hidden') {
        contentLink.classList.add('wp-hidden-el');
        renderCache.lastContentLinkKey = 'hidden';
      }
      return;
    }

    const name = escapeHtml(roomState.meta?.name || roomState.meta?.id || 'Host stream');
    const detailUrl = hasMeta
      ? `https://web.stremio.com/#/detail/${encodeURIComponent(roomState.meta.type)}/${encodeURIComponent(roomState.meta.id)}`
      : '';
    const contentLinkKey = `${detailUrl}:${directStreamUrl || ''}:${name}`;
    if (renderCache.lastContentLinkKey === contentLinkKey) {
      if (contentLink.classList.contains('wp-hidden-el')) contentLink.classList.remove('wp-hidden-el');
      return;
    }

    const label = hasMeta ? 'Host is watching:' : 'Host shared a stream:';
    const primaryLinkHtml = hasMeta
      ? `<a href="${detailUrl}" class="wp-content-link-a">${name}</a>`
      : `<span class="wp-content-link-a">${name}</span>`;
    const directLinkHtml = directStreamUrl
      ? ` <span class="wp-content-label">&middot;</span> <a href="${directStreamUrl}" class="wp-content-link-a">Open host stream</a>`
      : '';

    contentLink.classList.remove('wp-hidden-el');
    contentLink.innerHTML = `<span class="wp-content-label">${label}</span> ${primaryLinkHtml}${directLinkHtml}`;
    renderCache.lastContentLinkKey = contentLinkKey;
  }

  function formatPlaybackClock(timeSeconds) {
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) return '';
    const totalSeconds = Math.floor(timeSeconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  function getPlaybackSummary(user, roomState) {
    const label = formatPlaybackClock(user?.playbackTime);
    if (!label) return { label: '', title: '' };
    let title = label;
    const hostTime = roomState?.player?.time;
    if (Number.isFinite(hostTime)) {
      const drift = user.playbackTime - hostTime;
      if (Math.abs(drift) >= 1) {
        title = `${label} (${Math.abs(drift).toFixed(0)}s ${drift < 0 ? 'behind' : 'ahead of'} host)`;
      }
    }
    return { label, title };
  }

  function renderUsersList(usersDiv, roomState, userId, isHost) {
    const usersKey = roomState.users.map(u => `${u.id}:${u.status}:${u.playbackStatus}:${u.playbackTime ?? ''}:${u.sessionId ?? ''}`).join(',') + `:${roomState.owner}:${roomState.ownerSessionId ?? ''}:${isHost}`;
    if (renderCache.lastUsersKey === usersKey) return;
    renderCache.lastUsersKey = usersKey;
    const canonicalOwner = WPUtils.getCanonicalOwnerUser(roomState);
    const canonicalOwnerId = canonicalOwner?.id || roomState.owner || null;
    const canonicalOwnerSessionId = canonicalOwner?.sessionId || roomState.ownerSessionId || null;
    usersDiv.innerHTML = roomState.users.map(u => {
      const isMe = WPUtils.isCurrentSessionUser(u, userId, cachedSessionId);
      const isOwner = (
        (!!canonicalOwnerSessionId && !!u.sessionId && u.sessionId === canonicalOwnerSessionId)
        || (!!canonicalOwnerId && u.id === canonicalOwnerId)
        || (!canonicalOwner && isHost && isMe)
      );
      const color = getUserColor(u.sessionId || u.id);
      const crown = isOwner ? '<span class="wp-crown">👑</span>' : '';
      const you = isMe ? ' <span class="wp-you">(you)</span>' : '';
      const transferBtn = (isHost && !isMe && !isOwner)
        ? `<button class="wp-transfer-btn" data-uid="${u.id}" title="Transfer host">Make Host</button>`
        : '';
      let statusIcon = '';
      if (u.playbackStatus === 'buffering') statusIcon = '<span class="wp-user-status wp-status-buffering" title="Buffering">⟳</span>';
      else if (u.playbackStatus === 'paused') statusIcon = '<span class="wp-user-status wp-status-paused" title="Paused">❚❚</span>';
      else if (u.playbackStatus === 'playing') statusIcon = '<span class="wp-user-status wp-status-playing" title="Playing">▶</span>';
      const playback = getPlaybackSummary(u, roomState);
      const playbackLabel = playback.label
        ? `<span class="wp-user-playhead" title="${escapeHtml(playback.title)}">${escapeHtml(playback.label)}</span>`
        : '';
      const awayClass = u.status === 'away' ? ' wp-user-away' : '';
      return `<div class="wp-user${awayClass}"><span class="wp-user-dot" style="background:${color}"></span><span class="wp-user-main">${crown}<span class="wp-user-name">${escapeHtml(u.name)}</span>${you}</span>${statusIcon}${playbackLabel}${transferBtn}</div>`;
    }).join('');
    usersDiv.onclick = (e) => {
      const btn = e.target.closest('.wp-transfer-btn');
      if (btn?.dataset.uid) dispatchAction(WPConstants.ACTION.ROOM_OWNERSHIP_TRANSFER, { targetUserId: btn.dataset.uid });
    };
  }

  function updateSyncIndicator(isHost, drift) {
    const el = document.getElementById('wp-sync-indicator');
    if (!el) return;

    let nextKey = 'hidden';
    let nextHtml = '';
    if (!isHost) {
      const abs = Math.abs(drift);
      if (abs < WPSync.SOFT_DRIFT_ENTER) {
        nextKey = 'ok';
        nextHtml = '<span class="wp-sync-ok">Synced</span>';
      } else if (abs < WPSync.SOFT_DRIFT_MAX) {
        const dir = drift > 0 ? 'behind' : 'ahead';
        const rounded = abs.toFixed(1);
        nextKey = `drift:${rounded}:${dir}`;
        nextHtml = `<span class="wp-sync-drift">Catching up (${rounded}s ${dir})</span>`;
      } else {
        nextKey = 'seek';
        nextHtml = '<span class="wp-sync-seek">Seeking...</span>';
      }
    }

    if (renderCache.lastSyncIndicatorKey === nextKey) return;
    renderCache.lastSyncIndicatorKey = nextKey;
    if (nextKey === 'hidden') {
      el.classList.add('wp-hidden-el');
      return;
    }
    el.classList.remove('wp-hidden-el');
    el.innerHTML = nextHtml;
  }

  // Track displayed message IDs to prevent duplicates (covers TTL expiry edge case)
  const displayedMessageIds = new Set();

  function appendChatMessage(msg, roomState, myUserId) {
    const container = document.getElementById('wp-chat-messages');
    if (!container) return;

    // ID-based dedup: if message has a server ID and we've already shown it, skip
    if (msg.id && displayedMessageIds.has(msg.id)) return;
    if (msg.id) {
      displayedMessageIds.add(msg.id);
      // Prune old IDs to prevent unbounded growth (keep last 500)
      if (displayedMessageIds.size > 500) {
        const first = displayedMessageIds.values().next().value;
        displayedMessageIds.delete(first);
      }
    }

    // Content-based dedup: replace local echo with server-confirmed version
    // Match by sessionId — msg.user is client ID which changes per-tab
    const msgSender = roomState?.users?.find(u => u.id === msg.user);
    // Use msg.sessionId (from server) for stable identity — falls back to roomState lookup, then raw client ID
    const msgSessionId = msg.sessionId || msgSender?.sessionId;
    const isMsgFromMe = msg.user === myUserId || (cachedSessionId && msgSessionId === cachedSessionId);
    if (isMsgFromMe && isLocalEcho(msg.content)) {
      const localMsg = container.querySelector('.wp-chat-local');
      if (localMsg) localMsg.remove();
    }

    const userName = msgSender?.name || msg.userName || 'Unknown';
    // Use sessionId for stable color (same user = same color across tabs and chat history)
    const color = getUserColor(msgSessionId || msg.user);
    // Detect GIF messages: [gif:URL] — only allow https:// URLs
    const gifMatch = msg.content.match(/^\[gif:(https:\/\/[^\]]+)\]$/);
    const contentHtml = gifMatch
      ? `<img class="wp-chat-gif" src="${escapeHtml(gifMatch[1])}" alt="GIF" />`
      : `<span class="wp-chat-text">${escapeHtml(msg.content)}</span>`;
    const div = buildMsgEl(
      `<span class="wp-chat-name" style="color:${color}">${escapeHtml(userName)}</span>`,
      contentHtml
    );
    container.appendChild(div);
    // Prune old DOM nodes to prevent memory buildup
    pruneChildren(container);
    container.scrollTop = container.scrollHeight;
    updateChatEmptyState(roomState);
    // Notification sound if sidebar is hidden
    if (!isSidebarOpen() && !isMsgFromMe) {
      playNotifSound();
    }
  }

  // --- Reaction settings (sound + floating emojis, both toggleable) ---
  let reactionSoundEnabled = true;
  let floatingReactionsEnabled = true;
  loadLocalPreferences(() => {
    reactionSoundEnabled = localPreferences.reactionSound;
    floatingReactionsEnabled = localPreferences.floatingReactions;
    refreshLocalSettingsCard();
  });
  chrome.storage?.onChanged?.addListener((changes) => {
    let shouldRefreshSettings = false;
    let shouldRefreshRoomControls = false;
    if (changes[WPConstants.STORAGE.USERNAME]) {
      localPreferences.username = normalizeUsernameInput(changes[WPConstants.STORAGE.USERNAME].newValue);
      shouldRefreshSettings = true;
    }
    if (changes[WPConstants.STORAGE.ACCENT_COLOR]) {
      localPreferences.accentColor = changes[WPConstants.STORAGE.ACCENT_COLOR].newValue || '#6366f1';
      shouldRefreshSettings = true;
    }
    if (changes[WPConstants.STORAGE.COMPACT_CHAT]) {
      localPreferences.compactChat = !!changes[WPConstants.STORAGE.COMPACT_CHAT].newValue;
      shouldRefreshSettings = true;
    }
    if (changes[WPConstants.STORAGE.REACTION_SOUND]) {
      reactionSoundEnabled = changes[WPConstants.STORAGE.REACTION_SOUND].newValue !== false;
      localPreferences.reactionSound = reactionSoundEnabled;
      shouldRefreshSettings = true;
    }
    if (changes[WPConstants.STORAGE.FLOATING_REACTIONS]) {
      floatingReactionsEnabled = changes[WPConstants.STORAGE.FLOATING_REACTIONS].newValue !== false;
      localPreferences.floatingReactions = floatingReactionsEnabled;
      shouldRefreshSettings = true;
    }
    const currentRoomKeyStorageKey = cachedRoomState?.id ? WPConstants.STORAGE.roomKey(cachedRoomState.id) : null;
    if (currentRoomKeyStorageKey && changes[currentRoomKeyStorageKey]) {
      shouldRefreshRoomControls = true;
    }
    if (shouldRefreshSettings) refreshLocalSettingsCard();
    if (shouldRefreshRoomControls) refreshRoomControlsCard();
  });

  function playReactionSound() {
    if (!reactionSoundEnabled) return;
    playTone(1200, 0.05, 0.12);
  }

  function showReaction(uid, emoji, roomState) {
    const reactionUser = roomState?.users?.find(u => u.id === uid);
    const isOwnReaction = uid === cachedUserId || (cachedSessionId && reactionUser?.sessionId === cachedSessionId);
    // Play sound for all reactions (own + others) — user expects audio feedback
    playReactionSound();
    // Floating emoji animation (can be disabled)
    if (!floatingReactionsEnabled) return;
    const container = document.getElementById('wp-reaction-container');
    if (!container) return;
    const userName = reactionUser?.name || '';
    const el = document.createElement('div');
    el.className = 'wp-floating-reaction';
    el.innerHTML = `<span class="wp-reaction-emoji">${escapeHtml(emoji)}</span><span class="wp-reaction-name">${escapeHtml(userName)}</span>`;
    el.style.left = (20 + Math.random() * 60) + '%';
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  function updateTypingIndicator(typingUsers, myUserId, roomState) {
    const el = document.getElementById('wp-typing-indicator');
    if (!el) return;
    // Early exit: skip DOM update if no one is typing and indicator is already hidden
    if (typingUsers.size === 0 && el.classList.contains('wp-hidden-el')) return;
    const names = [];
    for (const [uid] of typingUsers) {
      // Skip own typing indicator (match by sessionId for multi-tab)
      const typingUser = roomState?.users?.find(u => u.id === uid);
      const isOwnTyping = uid === myUserId || (cachedSessionId && typingUser?.sessionId === cachedSessionId);
      if (isOwnTyping) continue;
      if (typingUser) names.push(typingUser.name);
    }
    if (names.length === 0) {
      el.classList.add('wp-hidden-el');
    } else {
      el.classList.remove('wp-hidden-el');
      const text = names.length === 1 ? `${names[0]} is typing...` : `${names.join(', ')} are typing...`;
      el.textContent = text;
    }
  }

  // --- Toast, Ready Check, Countdown: delegated to WPModals module ---
  function showToast(message, durationMs) { WPModals.showToast(message, durationMs); }
  function showReadyCheck(action, confirmed, total, myUserId) { WPModals.showReadyCheck(action, confirmed, total, myUserId); }
  function showCountdown(seconds) { WPModals.showCountdown(seconds); }

  // --- Bookmarks ---
  let lastBookmarkKey = '';
  function appendBookmark(msg) {
    const container = document.getElementById('wp-chat-messages');
    if (!container) return;
    // Deduplicate: skip if same user+time within short window (local echo + server broadcast)
    const key = `${msg.user}:${Math.floor(msg.time)}`;
    if (key === lastBookmarkKey) return;
    lastBookmarkKey = key;
    setTimeout(() => { if (lastBookmarkKey === key) lastBookmarkKey = ''; }, 3000);
    const mins = Math.floor(msg.time / 60);
    const secs = Math.floor(msg.time % 60).toString().padStart(2, '0');
    const timeStr = `${mins}:${secs}`;
    const div = document.createElement('div');
    div.className = 'wp-chat-msg wp-bookmark-msg';
    div.innerHTML = `<span class="wp-bookmark-icon">📌</span> <span class="wp-chat-name" style="color:${getUserColor(cachedSessionId || msg.user)}">${escapeHtml(msg.userName)}</span> bookmarked <button class="wp-bookmark-time" data-time="${msg.time}">${timeStr}</button> <span class="wp-chat-text">${msg.label ? escapeHtml(msg.label) : ''}</span>`;
    div.querySelector('.wp-bookmark-time')?.addEventListener('click', () => {
      const video = document.querySelector('video');
      if (video) {
        video.currentTime = msg.time;
        showToast(`Seeking to ${timeStr}`, 1500);
      } else {
        showToast(`Bookmark: ${timeStr}`, 1500);
      }
    });
    container.appendChild(div);
    pruneChildren(container);
    container.scrollTop = container.scrollHeight;
    updateChatEmptyState(cachedRoomState);
  }

  async function buildInviteUrl(roomId) {
    let inviteUrl = await new Promise((resolve) => {
      chrome.storage.session.get(WPConstants.STORAGE.ACTIVE_BACKEND, (sessionResult) => {
        const sessionActiveBackend = !chrome.runtime?.id || chrome.runtime.lastError
          ? undefined
          : sessionResult?.[WPConstants.STORAGE.ACTIVE_BACKEND];
        chrome.storage.local.get([WPConstants.STORAGE.BACKEND_MODE, WPConstants.STORAGE.ACTIVE_BACKEND], (result) => {
          resolve(WPConstants.BACKEND.buildInviteUrl(
            roomId,
            result[WPConstants.STORAGE.BACKEND_MODE],
            sessionActiveBackend ?? result[WPConstants.STORAGE.ACTIVE_BACKEND]
          ));
        });
      });
    });
    let roomKey = null;
    if (typeof WPCrypto !== 'undefined' && WPCrypto.isEnabled()) {
      roomKey = await WPCrypto.exportKey();
    }
    if (roomKey) return `${inviteUrl}#key=${roomKey}`;
    return WPRoomKeys.appendToInviteUrl(roomId, inviteUrl);
  }

  async function copyInviteUrl(roomState) {
    try {
      const roomId = roomState?.id;
      if (!roomId) return false;
      return await WPUtils.copyTextDeferred(() => buildInviteUrl(roomId));
    } catch {
      return false;
    }
  }

  function bindRoomCodeCopy(roomState) {
    const el = document.getElementById('wp-room-code');
    if (!el) return;
    el.onclick = async () => {
      const copied = await copyInviteUrl(roomState);
      el.textContent = copied ? 'Link copied!' : 'Copy failed';
      setTimeout(() => { el.textContent = roomState?.id?.slice(0, 8) || ''; }, 1500);
    };
  }

  function bindTypingIndicator(onTypingStart, onTypingStop) {
    const input = document.getElementById('wp-chat-input');
    if (!input) return;
    let typingTimeout = null;
    let isTyping = false;
    input.addEventListener('input', () => {
      if (!isTyping) {
        isTyping = true;
        onTypingStart(); // Send only once per typing session
      }
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        isTyping = false;
        onTypingStop();
      }, 2000);
    });
  }

  // --- Unread badge on toggle button ---
  let unreadCount = 0;

  function incrementUnread() {
    if (isSidebarOpen() && activePanel === 'chat') return;
    unreadCount++;
    updateUnreadBadge();
  }

  function clearUnread() {
    unreadCount = 0;
    updateUnreadBadge();
  }

  function updateUnreadBadge() {
    const badge = document.getElementById('wp-unread-badge');
    if (!badge) return;
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
      badge.classList.remove('wp-hidden-el');
    } else {
      badge.classList.add('wp-hidden-el');
    }
    updateChatTabBadge();
    updateLauncherState();
  }

  // --- Keyboard shortcuts ---
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (eventTargetsOverlayInput(e) || hasOverlayInputFocus()) return;
      // Alt+W: toggle sidebar
      if (e.altKey && e.key === 'w') {
        e.preventDefault();
        document.getElementById('wp-toggle-host')?.click();
      }
      // Escape: close sidebar
      if (e.key === 'Escape') {
        if (isSidebarOpen()) closeSidebar();
      }
    });
  }

  // --- Catch-up button (shown when user is behind host) ---
  function showCatchUpButton(drift) {
    if (Math.abs(drift) < 5) {
      if (renderCache.catchUpVisible) removeCatchUpButton();
      return;
    }
    let btn = document.getElementById('wp-catchup-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'wp-catchup-btn';
      btn.addEventListener('click', () => {
        dispatchAction(WPConstants.ACTION.ROOM_PLAYBACK_REQUEST_SYNC);
        removeCatchUpButton();
      });
      document.getElementById('wp-overlay')?.appendChild(btn);
    }
    const secs = Math.abs(drift).toFixed(0);
    const label = `⚡ Catch up (${secs}s behind)`;
    renderCache.catchUpVisible = true;
    if (renderCache.lastCatchUpLabel === label) return;
    renderCache.lastCatchUpLabel = label;
    btn.textContent = `⚡ Catch up (${secs}s behind)`;
  }


  // --- CSS loaded from stremio-overlay.css via manifest.json ---



  return {
    create, updateState, updateSyncIndicator,
    appendChatMessage, showReaction, updateTypingIndicator,
    openSidebar, bindRoomCodeCopy, bindTypingIndicator,
    playNotifSound, showToast,
    showReadyCheck, showCountdown, appendBookmark,
    incrementUnread, clearUnread, initKeyboardShortcuts,
    showCatchUpButton,
  };
})();

