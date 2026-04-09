// WatchParty — Overlay UI
// Injects the sidebar, chat, reactions, emoji picker, and sync indicator into Stremio Web.

const WPOverlay = (() => {
  'use strict';

  let overlay = null;
  let sidebarMinimized = false;

  // --- Emoji picker (emoji-picker-element library) ---
  function loadEmojiPicker() {
    // Inject as page-context module (custom elements need the main world)
    const script = document.createElement('script');
    script.type = 'module';
    script.src = chrome.runtime.getURL('vendor/emoji-loader.js');
    document.head.appendChild(script);
  }

  // --- User colors (deterministic from userId) ---
  const USER_COLORS = [
    '#6366f1', '#ec4899', '#f59e0b', '#22c55e', '#06b6d4',
    '#a855f7', '#ef4444', '#3b82f6', '#14b8a6', '#f97316',
  ];

  function getUserColor(uid) {
    if (!uid) return USER_COLORS[0];
    let hash = 0;
    for (let i = 0; i < uid.length; i++) hash = ((hash << 5) - hash + uid.charCodeAt(i)) | 0;
    return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
  }

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
    const reactBtn = document.createElement('button');
    reactBtn.className = 'wp-msg-react-trigger';
    reactBtn.innerHTML = '☺';
    reactBtn.title = 'Add Reaction';
    toolbar.appendChild(reactBtn);
    row.appendChild(toolbar);
    div.appendChild(row);

    // Reaction pills (below message text)
    const pills = document.createElement('div');
    pills.className = 'wp-msg-pills';
    div.appendChild(pills);

    // Hover: show toolbar via class
    div.addEventListener('mouseenter', () => div.classList.add('wp-msg-hovered'));
    div.addEventListener('mouseleave', () => {
      // Keep hover if popup is open for THIS message
      if (activePopupMsg === div) return;
      div.classList.remove('wp-msg-hovered');
    });

    // Click react button → open the shared emoji picker in "reaction mode"
    reactBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pickerEl = document.getElementById('wp-emoji-picker');
      if (!pickerEl) return;

      // If already open for this message, close it
      if (activePopupMsg === div && !pickerEl.classList.contains('wp-hidden-el')) {
        closeReactionPopup();
        return;
      }
      closeReactionPopup();

      // Set reaction mode — the emoji-click handler checks this
      reactionTarget = { pills };
      activePopupMsg = div;

      // Reposition picker near the react button
      const btnRect = reactBtn.getBoundingClientRect();
      pickerEl.style.position = 'fixed';
      pickerEl.style.bottom = 'auto';
      pickerEl.style.top = (btnRect.bottom + 4) + 'px';
      pickerEl.style.right = (window.innerWidth - btnRect.right) + 'px';
      pickerEl.classList.remove('wp-hidden-el');
    });

    return div;
  }

  // Toggle reaction: one per user per emoji, no stacking
  function toggleReaction(pillsContainer, emoji) {
    const existing = pillsContainer.querySelector(`[data-emoji="${emoji}"]`);
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
      pill.innerHTML = `<span class="wp-pill-emoji">${emoji}</span><span class="wp-pill-count">1</span>`;
      pill.addEventListener('click', () => toggleReaction(pillsContainer, emoji));
      pillsContainer.appendChild(pill);
    }
    chrome.runtime.sendMessage({
      type: 'watchparty-ext', action: 'send-reaction', emoji,
    }).catch(() => {});
  }


  function closeReactionPopup() {
    if (reactionTarget) {
      const pickerEl = document.getElementById('wp-emoji-picker');
      if (pickerEl) {
        pickerEl.classList.add('wp-hidden-el');
        // Reset to default chat position
        pickerEl.style.position = 'fixed';
        pickerEl.style.top = 'auto';
        pickerEl.style.bottom = '60px';
        pickerEl.style.right = '16px';
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
  function playNotifSound() {
    try {
      if (!audioCtx) audioCtx = new AudioContext();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = 800;
      gain.gain.value = 0.08;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
      osc.stop(audioCtx.currentTime + 0.15);
    } catch { /* audio not available */ }
  }

  // --- HTML escaping ---
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }


  // --- Push Stremio content when sidebar opens/closes ---
  function updateContentMargin(sidebarOpen) {
    document.body.style.transition = 'width .2s ease';
    document.body.style.width = sidebarOpen ? 'calc(100% - 320px)' : '';
    document.body.style.overflow = sidebarOpen ? 'hidden' : '';
  }


  // --- Create overlay DOM ---
  function create() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'wp-overlay';
    overlay.innerHTML = `
      <div id="wp-sidebar" class="wp-sidebar-hidden">
        <div id="wp-header">
          <span id="wp-title">WatchParty</span>
          <span id="wp-room-code" title="Click to copy"></span>
          <button id="wp-minimize-btn" title="Minimize">&#x2015;</button>
          <button id="wp-close-sidebar" title="Close">&times;</button>
        </div>
        <div id="wp-minimized-bar" class="wp-hidden-el">
          <span id="wp-min-info"></span>
          <button id="wp-expand-btn">Expand</button>
        </div>
        <div id="wp-body">
          <div id="wp-status"></div>
          <div id="wp-sync-indicator" class="wp-hidden-el"></div>
          <div id="wp-content-link" class="wp-hidden-el"></div>
          <div id="wp-users"></div>
          <div id="wp-typing-indicator" class="wp-hidden-el"></div>
          <div id="wp-chat-container">
            <div id="wp-chat-messages"></div>
            <div id="wp-chat-input-row">
              <button id="wp-emoji-btn" title="Insert emoji">&#x1F600;</button>
              <input id="wp-chat-input" type="text" placeholder="Type a message..." maxlength="300" autocomplete="off" />
              <button id="wp-chat-send">Send</button>
            </div>
          </div>
        </div>
      </div>
      <div id="wp-reaction-container"></div>
      <div id="wp-emoji-picker" class="wp-hidden-el"></div>
    `;

    const style = document.createElement('style');
    style.textContent = getCSS();
    document.head.appendChild(style);
    document.body.appendChild(overlay);

    // Inject toggle button INTO Stremio's nav button container
    function createToggleBtn() {
      const btn = document.createElement('div');
      btn.id = 'wp-toggle-btn';
      btn.title = 'WatchParty';
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>';
      btn.addEventListener('click', () => {
        const sidebar = document.getElementById('wp-sidebar');
        sidebar.classList.toggle('wp-sidebar-hidden');
        const nowOpen = !sidebar.classList.contains('wp-sidebar-hidden');
        updateContentMargin(nowOpen);
      });
      return btn;
    }

    // Inject into ALL Stremio buttons-containers (each route has its own nav)
    function injectToggleBtns() {
      const fsBtns = document.querySelectorAll('[title="Enter fullscreen mode"]');
      fsBtns.forEach(fsBtn => {
        const container = fsBtn.parentElement;
        if (!container || container.querySelector('.wp-toggle-injected')) return;
        const btn = createToggleBtn();
        // Use a class instead of id since there may be multiple copies
        btn.removeAttribute('id');
        btn.classList.add('wp-toggle-injected');
        // Inherit Stremio's sizing classes from the sibling icon
        fsBtn.className.split(' ').forEach(cls => { if (cls) btn.classList.add(cls); });
        container.insertBefore(btn, container.firstChild);
      });
      return fsBtns.length > 0;
    }

    // Inject immediately if already rendered, then watch for new route containers
    injectToggleBtns();
    new MutationObserver(injectToggleBtns).observe(document.body, { childList: true, subtree: true });

    // Load emoji-picker-element library and create the picker
    const pickerContainer = document.getElementById('wp-emoji-picker');
    loadEmojiPicker();
    document.addEventListener('wp-emoji-lib-ready', () => {
      const picker = document.createElement('emoji-picker');
      picker.setAttribute('class', 'dark');
      picker.setAttribute('data-source', chrome.runtime.getURL('vendor/emoji-data.json'));
      pickerContainer.appendChild(picker);
    }, { once: true });

    // Listen for emoji selection (bridged from page world via emoji-loader.js)
    document.addEventListener('wp-emoji-selected', (e) => {
      const emoji = e.detail;
      if (!emoji) return;

      if (reactionTarget) {
        // Reaction mode: add pill to the message
        toggleReaction(reactionTarget.pills, emoji);
        closeReactionPopup();
      } else {
        // Chat mode: insert emoji into input
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

    bindEvents();
  }

  // --- Event bindings ---
  function bindEvents() {
    const $ = (id) => document.getElementById(id);

    $('wp-close-sidebar').addEventListener('click', () => {
      $('wp-sidebar').classList.add('wp-sidebar-hidden');
      updateContentMargin(false);
    });
    $('wp-minimize-btn').addEventListener('click', () => {
      sidebarMinimized = true;
      $('wp-body').classList.add('wp-hidden-el');
      $('wp-minimized-bar').classList.remove('wp-hidden-el');
      $('wp-minimize-btn').classList.add('wp-hidden-el');
    });
    $('wp-expand-btn').addEventListener('click', () => {
      sidebarMinimized = false;
      $('wp-body').classList.remove('wp-hidden-el');
      $('wp-minimized-bar').classList.add('wp-hidden-el');
      $('wp-minimize-btn').classList.remove('wp-hidden-el');
    });
    $('wp-chat-send').addEventListener('click', () => sendChat());
    $('wp-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat();
    });
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
      pickerEl.style.position = 'fixed';
      pickerEl.style.top = 'auto';
      pickerEl.style.bottom = '60px';
      pickerEl.style.right = '16px';
      pickerEl.classList.toggle('wp-hidden-el');
    });
  }

  // Track locally echoed messages to deduplicate server echoes
  const localEchoSet = new Set();

  function sendChat() {
    const input = document.getElementById('wp-chat-input');
    if (!input || !input.value.trim()) return;
    const content = input.value.trim();

    // Optimistic local echo — show message immediately
    const container = document.getElementById('wp-chat-messages');
    if (container) {
      const div = buildMsgEl(
        `<span class="wp-chat-name" style="color:#6366f1">You</span>`,
        `<span class="wp-chat-text">${escapeHtml(content)}</span>`
      );
      div.classList.add('wp-chat-local');
      container.appendChild(div);
      while (container.childElementCount > 200) container.removeChild(container.firstChild);
      container.scrollTop = container.scrollHeight;
      // Track for dedup (expire after 10s)
      localEchoSet.add(content);
      setTimeout(() => localEchoSet.delete(content), 10000);
    }

    chrome.runtime.sendMessage({
      type: 'watchparty-ext', action: 'send-chat', content,
    }).catch(() => {});
    chrome.runtime.sendMessage({
      type: 'watchparty-ext', action: 'send-typing', typing: false,
    }).catch(() => {});
    input.value = '';
  }

  // --- State updates ---

  function updateState({ inRoom, isHost, userId, roomState, hasVideo }) {
    if (!overlay) return;

    const status = document.getElementById('wp-status');
    const roomCode = document.getElementById('wp-room-code');
    const usersDiv = document.getElementById('wp-users');
    const contentLink = document.getElementById('wp-content-link');
    const syncInd = document.getElementById('wp-sync-indicator');
    const minInfo = document.getElementById('wp-min-info');

    const chatContainer = document.getElementById('wp-chat-container');
    if (!inRoom || !roomState) {
      if (status) status.innerHTML = '<div class="wp-empty-state">Not in a room.<br/>Use the extension popup to create or join one.</div>';
      if (roomCode) roomCode.textContent = '';
      if (usersDiv) usersDiv.innerHTML = '';
      if (contentLink) contentLink.classList.add('wp-hidden-el');
      if (syncInd) syncInd.classList.add('wp-hidden-el');
      if (chatContainer) chatContainer.classList.add('wp-hidden-el');
      return;
    }

    // Show chat when in room
    if (chatContainer) chatContainer.classList.remove('wp-hidden-el');

    if (roomCode) roomCode.textContent = roomState.id?.slice(0, 8) || '';
    if (minInfo) minInfo.textContent = `${roomState.users?.length || 0} watching`;

    // Status
    if (status) {
      const hostLabel = isHost ? 'You are the host' : 'Synced to host';
      const videoStatus = hasVideo ? 'Video detected' : 'No video detected';
      status.innerHTML = `<span class="wp-status-line">${hostLabel}</span><span class="wp-status-line wp-muted">${videoStatus}</span>`;
    }

    // Content link for peers
    if (contentLink) {
      if (!isHost && roomState.meta?.id && roomState.meta.id !== 'pending' && roomState.meta.id !== 'unknown') {
        contentLink.classList.remove('wp-hidden-el');
        const name = escapeHtml(roomState.meta.name || roomState.meta.id);
        const link = `https://web.stremio.com/#/detail/${encodeURIComponent(roomState.meta.type)}/${encodeURIComponent(roomState.meta.id)}`;
        contentLink.innerHTML = `<span class="wp-content-label">Watching:</span> <a href="${link}" class="wp-content-link-a">${name}</a>`;
      } else {
        contentLink.classList.add('wp-hidden-el');
      }
    }

    // Users with presence, playback status, and ownership transfer
    if (usersDiv && roomState.users) {
      usersDiv.innerHTML = roomState.users.map(u => {
        const isOwner = u.id === roomState.owner;
        const isMe = u.id === userId;
        const color = getUserColor(u.id);
        const isAway = u.status === 'away';
        const crown = isOwner ? '<span class="wp-crown">👑</span>' : '';
        const you = isMe ? ' <span class="wp-you">(you)</span>' : '';
        const transferBtn = (isHost && !isMe && !isOwner)
          ? `<button class="wp-transfer-btn" data-uid="${u.id}" title="Transfer host">Make Host</button>`
          : '';
        // Playback status icon
        let statusIcon = '';
        if (u.playbackStatus === 'buffering') {
          statusIcon = '<span class="wp-user-status wp-status-buffering" title="Buffering">⟳</span>';
        } else if (u.playbackStatus === 'paused') {
          statusIcon = '<span class="wp-user-status wp-status-paused" title="Paused">❚❚</span>';
        } else if (u.playbackStatus === 'playing') {
          statusIcon = '<span class="wp-user-status wp-status-playing" title="Playing">▶</span>';
        }
        const awayClass = isAway ? ' wp-user-away' : '';
        return `<div class="wp-user${awayClass}"><span class="wp-user-dot" style="background:${color}"></span>${crown}${escapeHtml(u.name)}${you}${statusIcon}${transferBtn}</div>`;
      }).join('');
      usersDiv.querySelectorAll('.wp-transfer-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          chrome.runtime.sendMessage({
            type: 'watchparty-ext', action: 'transfer-ownership', targetUserId: btn.dataset.uid,
          }).catch(() => {});
        });
      });
    }

  }

  function updateSyncIndicator(isHost, drift) {
    const el = document.getElementById('wp-sync-indicator');
    if (!el) return;
    if (isHost) { el.classList.add('wp-hidden-el'); return; }
    el.classList.remove('wp-hidden-el');
    const abs = Math.abs(drift);
    if (abs < WPSync.SOFT_DRIFT_MIN) {
      el.innerHTML = '<span class="wp-sync-ok">Synced</span>';
    } else if (abs < WPSync.SOFT_DRIFT_MAX) {
      const dir = drift > 0 ? 'behind' : 'ahead';
      el.innerHTML = `<span class="wp-sync-drift">Catching up (${abs.toFixed(1)}s ${dir})</span>`;
    } else {
      el.innerHTML = '<span class="wp-sync-seek">Seeking...</span>';
    }
  }

  function appendChatMessage(msg, roomState, myUserId) {
    const container = document.getElementById('wp-chat-messages');
    if (!container) return;

    // Deduplicate: if this is our own message that was already locally echoed, replace the local echo
    if (msg.user === myUserId && localEchoSet.has(msg.content)) {
      localEchoSet.delete(msg.content);
      // Find and replace the local echo with the server-confirmed version (correct name/color)
      const localMsg = container.querySelector('.wp-chat-local');
      if (localMsg) localMsg.remove();
    }

    const userName = roomState?.users?.find(u => u.id === msg.user)?.name || 'Unknown';
    const color = getUserColor(msg.user);
    const div = buildMsgEl(
      `<span class="wp-chat-name" style="color:${color}">${escapeHtml(userName)}</span>`,
      `<span class="wp-chat-text">${escapeHtml(msg.content)}</span>`
    );
    container.appendChild(div);
    // Prune old DOM nodes to prevent memory buildup
    while (container.childElementCount > 200) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
    // Notification sound if sidebar is hidden
    const sidebar = document.getElementById('wp-sidebar');
    if (sidebar?.classList.contains('wp-sidebar-hidden') && msg.user !== myUserId) {
      playNotifSound();
    }
  }

  // --- Reaction sound (toggleable) ---
  let reactionSoundEnabled = true;
  chrome.storage?.local?.get('wpReactionSound', (r) => {
    if (r && r.wpReactionSound === false) reactionSoundEnabled = false;
  });
  // Live-update when toggled from popup
  chrome.storage?.onChanged?.addListener((changes) => {
    if (changes.wpReactionSound) reactionSoundEnabled = changes.wpReactionSound.newValue !== false;
  });

  function playReactionSound() {
    if (!reactionSoundEnabled) return;
    try {
      if (!audioCtx) audioCtx = new AudioContext();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = 1200;
      osc.type = 'sine';
      gain.gain.value = 0.05;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
      osc.stop(audioCtx.currentTime + 0.12);
    } catch { /* audio not available */ }
  }

  function showReaction(uid, emoji, roomState) {
    const container = document.getElementById('wp-reaction-container');
    if (!container) return;
    const userName = roomState?.users?.find(u => u.id === uid)?.name || '';
    const el = document.createElement('div');
    el.className = 'wp-floating-reaction';
    el.innerHTML = `<span class="wp-reaction-emoji">${escapeHtml(emoji)}</span><span class="wp-reaction-name">${escapeHtml(userName)}</span>`;
    el.style.left = (20 + Math.random() * 60) + '%';
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
    playReactionSound();
  }

  function updateTypingIndicator(typingUsers, myUserId, roomState) {
    const el = document.getElementById('wp-typing-indicator');
    if (!el) return;
    const names = [];
    for (const [uid] of typingUsers) {
      if (uid === myUserId) continue;
      const u = roomState?.users?.find(u => u.id === uid);
      if (u) names.push(u.name);
    }
    if (names.length === 0) {
      el.classList.add('wp-hidden-el');
    } else {
      el.classList.remove('wp-hidden-el');
      const text = names.length === 1 ? `${names[0]} is typing...` : `${names.join(', ')} are typing...`;
      el.textContent = text;
    }
  }

  function openSidebar() {
    document.getElementById('wp-sidebar')?.classList.remove('wp-sidebar-hidden');
    updateContentMargin(true);
  }

  // --- Toast notification ---
  function showToast(message, durationMs = 3000) {
    const existing = document.getElementById('wp-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'wp-toast';
    toast.textContent = message;
    document.getElementById('wp-overlay')?.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('wp-toast-visible'));
    setTimeout(() => {
      toast.classList.remove('wp-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, durationMs);
  }

  function bindRoomCodeCopy(roomState) {
    const el = document.getElementById('wp-room-code');
    if (!el) return;
    el.onclick = () => {
      const inviteUrl = `https://watchparty.mertd.me/r/${roomState?.id || el.textContent}`;
      navigator.clipboard.writeText(inviteUrl).catch(() => {});
      el.textContent = 'Link copied!';
      setTimeout(() => { el.textContent = roomState?.id?.slice(0, 8) || ''; }, 1500);
    };
  }

  function bindTypingIndicator(onTypingStart, onTypingStop) {
    const input = document.getElementById('wp-chat-input');
    if (!input) return;
    let typingTimeout = null;
    input.addEventListener('input', () => {
      onTypingStart();
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(onTypingStop, 2000);
    });
  }

  // --- CSS ---
  function getCSS() {
    return `
      #wp-overlay { position:fixed; top:0; right:0; z-index:2147483646; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; pointer-events:none; }
      #wp-overlay * { box-sizing:border-box; }
      .wp-hidden-el { display:none !important; }

      /* Toggle button — injected into Stremio's nav, sized by inherited classes */
      .wp-toggle-injected {
        position:relative;
        display:flex !important; align-items:center !important; justify-content:center !important;
        background:rgba(99,102,241,0.85) !important; border:none !important; border-radius:50% !important;
        cursor:pointer !important; color:#fff !important;
        transition:background .15s !important;
      }
      .wp-toggle-injected:hover { background:rgba(99,102,241,1) !important; }
      .wp-toggle-injected svg { width:55%; height:55%; }

      /* Sidebar — top offset to sit below Stremio nav, strong shadow for separation */
      #wp-sidebar {
        pointer-events:all; position:fixed; top:0; right:0; width:320px; height:100vh;
        max-height:100vh; overflow:hidden;
        background:#0f0f1e; border-left:1px solid rgba(99,102,241,0.3);
        box-shadow:-4px 0 20px rgba(0,0,0,0.5);
        display:flex; flex-direction:column; transition:transform .2s ease;
        z-index:2147483647; isolation:isolate;
      }
      #wp-sidebar.wp-sidebar-hidden { transform:translateX(100%); pointer-events:none; }
      #wp-header {
        display:flex; align-items:center; gap:8px; padding:12px 16px;
        border-bottom:1px solid rgba(255,255,255,0.1);
        background:rgba(99,102,241,0.08);
      }
      #wp-title { font-weight:600; font-size:14px; color:#fff; flex-shrink:0; }
      #wp-room-code {
        font-family:'Consolas','Monaco',monospace; font-size:11px; color:#6366f1;
        background:rgba(99,102,241,0.15); padding:2px 6px; border-radius:4px; cursor:pointer;
      }
      #wp-room-code:hover { background:rgba(99,102,241,0.25); }
      #wp-room-code:empty { display:none; }
      #wp-minimize-btn, #wp-close-sidebar {
        background:none; border:none; color:#666; font-size:18px;
        cursor:pointer; padding:0 4px; line-height:1;
      }
      #wp-minimize-btn { margin-left:auto; }
      #wp-close-sidebar { margin-left:4px; }
      #wp-minimize-btn:hover, #wp-close-sidebar:hover { color:#fff; }

      /* Minimized bar */
      #wp-minimized-bar {
        display:flex; align-items:center; justify-content:space-between;
        padding:10px 16px; border-bottom:1px solid rgba(255,255,255,0.05);
      }
      #wp-min-info { font-size:12px; color:#999; }
      #wp-expand-btn {
        background:rgba(99,102,241,0.2); color:#818cf8; border:none; border-radius:4px;
        padding:4px 10px; font-size:11px; cursor:pointer;
      }
      #wp-expand-btn:hover { background:rgba(99,102,241,0.3); }

      /* Body */
      #wp-body { display:flex; flex-direction:column; flex:1; min-height:0; }
      #wp-status {
        padding:10px 16px; font-size:12px; color:#ccc;
        border-bottom:1px solid rgba(255,255,255,0.08);
        background:rgba(255,255,255,0.02);
      }
      .wp-status-line { display:block; margin-bottom:2px; }
      .wp-muted { color:#666; }

      /* Not-in-room empty state */
      .wp-empty-state { padding:32px 20px; text-align:center; color:#888; font-size:13px; line-height:1.7; }

      /* Sync indicator */
      #wp-sync-indicator { padding:6px 16px; font-size:11px; border-bottom:1px solid rgba(255,255,255,0.05); }
      .wp-sync-ok { color:#22c55e; }
      .wp-sync-drift { color:#f59e0b; }
      .wp-sync-seek { color:#ef4444; }

      /* Content link */
      #wp-content-link {
        padding:8px 16px; font-size:12px;
        background:rgba(34,197,94,0.06); border-bottom:1px solid rgba(255,255,255,0.08);
      }
      .wp-content-label { color:#888; }
      .wp-content-link-a { color:#4ade80; text-decoration:underline; }

      /* (Controls moved to popup — no sidebar controls section) */

      /* Users — compact list, limited height to give chat more room */
      #wp-users {
        padding:6px 16px; border-bottom:1px solid rgba(255,255,255,0.08);
        max-height:120px; overflow-y:auto;
      }
      .wp-user {
        display:flex; align-items:center; gap:6px; font-size:12px; color:#ddd; padding:2px 0;
      }
      .wp-user-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
      .wp-crown { font-size:12px; }
      .wp-you { color:#888; font-size:11px; }
      .wp-user-away { opacity:0.4; }
      .wp-user-away .wp-user-dot { animation:wp-pulse 2s infinite; }
      @keyframes wp-pulse { 0%,100% { opacity:0.4; } 50% { opacity:0.8; } }
      .wp-user-status { font-size:9px; color:#666; margin-left:2px; }
      .wp-status-playing { color:#22c55e; }
      .wp-status-paused { color:#f59e0b; }
      .wp-status-buffering { color:#6366f1; animation:wp-spin 1s linear infinite; }
      @keyframes wp-spin { from { display:inline-block; transform:rotate(0deg); } to { transform:rotate(360deg); } }
      .wp-transfer-btn {
        margin-left:auto; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1);
        border-radius:4px; padding:2px 8px; font-size:10px; color:#999; cursor:pointer; flex-shrink:0;
      }
      .wp-transfer-btn:hover { background:rgba(99,102,241,0.2); color:#818cf8; border-color:rgba(99,102,241,0.3); }

      /* Typing */
      #wp-typing-indicator { padding:2px 16px 4px; font-size:11px; color:#888; font-style:italic; }
      /* Discord-style messages + reactions */
      .wp-chat-msg { padding:2px 16px; border-radius:4px; margin-bottom:1px; }
      .wp-chat-msg.wp-msg-hovered { background:rgba(255,255,255,0.03); }

      /* Message row: content left, toolbar right, single line */
      .wp-msg-row { display:flex; align-items:center; gap:4px; }
      .wp-msg-content { flex:1; min-width:0; line-height:1.5; word-break:break-word; }

      /* Toolbar: inline at the right end of the message row, hidden until hover */
      .wp-msg-toolbar {
        flex-shrink:0; display:none; align-items:center;
      }
      .wp-msg-hovered .wp-msg-toolbar { display:flex; }
      .wp-msg-react-trigger {
        background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.08);
        color:#888; font-size:12px; cursor:pointer;
        padding:1px 6px; border-radius:4px; line-height:1.2;
        transition:all .1s;
      }
      .wp-msg-react-trigger:hover {
        background:rgba(99,102,241,0.15); border-color:rgba(99,102,241,0.3); color:#818cf8;
      }

      /* Reaction pills below message */
      .wp-msg-pills { display:flex; flex-wrap:wrap; gap:4px; padding:2px 0 0 0; }
      .wp-msg-pills:empty { display:none; }
      .wp-react-pill {
        display:inline-flex; align-items:center; gap:3px;
        background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.08);
        border-radius:10px; padding:1px 6px; cursor:pointer; font-size:11px;
        color:#999; transition:all .12s;
      }
      .wp-react-pill:hover { background:rgba(255,255,255,0.1); border-color:rgba(255,255,255,0.15); }
      .wp-react-pill.wp-pill-mine {
        background:rgba(99,102,241,0.15); border-color:rgba(99,102,241,0.3); color:#818cf8;
      }
      .wp-pill-emoji { font-size:13px; line-height:1; }
      .wp-pill-count { font-size:11px; font-weight:500; }

      /* Chat */
      #wp-chat-container { flex:1; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
      #wp-chat-messages {
        flex:1; overflow-y:auto; padding:8px 0; font-size:12px; min-height:80px;
        scrollbar-width:thin; scrollbar-color:rgba(255,255,255,0.15) transparent;
      }
      /* .wp-chat-msg styles are in the reactions section above */
      .wp-chat-name { font-weight:600; }
      .wp-chat-text { color:#ccc; }
      #wp-chat-input-row {
        display:flex; padding:8px 12px; gap:6px;
        border-top:1px solid rgba(255,255,255,0.1);
        background:rgba(0,0,0,0.15);
      }
      #wp-emoji-btn {
        background:none; border:none; font-size:16px; cursor:pointer; padding:0 4px;
        flex-shrink:0; opacity:0.7; transition:opacity .1s;
      }
      #wp-emoji-btn:hover { opacity:1; }
      #wp-chat-input {
        flex:1; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15);
        border-radius:6px; padding:6px 10px; color:#fff; font-size:12px; outline:none;
        min-width:0;
      }
      #wp-chat-input:focus { border-color:#6366f1; }
      #wp-chat-input::placeholder { color:#555; }
      #wp-chat-send {
        background:#6366f1; color:#fff; border:none; border-radius:6px;
        padding:6px 12px; font-size:12px; cursor:pointer; flex-shrink:0;
      }
      #wp-chat-send:hover { background:#5558e6; }
      #wp-chat-send:active { transform:scale(0.96); }

      /* Emoji picker — emoji-picker-element library */
      #wp-emoji-picker {
        pointer-events:all; position:fixed; bottom:60px; right:16px; z-index:2147483647;
        border-radius:12px; overflow:hidden;
        box-shadow:0 8px 32px rgba(0,0,0,0.5);
      }
      #wp-emoji-picker emoji-picker {
        --background:rgba(15,15,30,0.98);
        --border-color:rgba(255,255,255,0.12);
        --button-active-background:rgba(99,102,241,0.25);
        --button-hover-background:rgba(255,255,255,0.08);
        --category-font-color:#888;
        --emoji-padding:0.3rem;
        --emoji-size:1.3rem;
        --indicator-color:#6366f1;
        --input-border-color:rgba(255,255,255,0.12);
        --input-font-color:#fff;
        --input-placeholder-color:#555;
        --num-columns:8;
        --outline-color:#6366f1;
        --search-background:rgba(255,255,255,0.08);
        --text-color:#ccc;
        width:320px; height:340px;
      }

      /* Floating reactions */
      #wp-reaction-container {
        pointer-events:none; position:fixed; top:0; left:0; width:100vw; height:100vh; z-index:2147483647;
        overflow:hidden;
      }
      .wp-floating-reaction {
        position:absolute; bottom:80px; display:flex; flex-direction:column; align-items:center;
        animation:wp-float-up 3s ease-out forwards; opacity:0;
      }
      .wp-reaction-emoji { font-size:32px; }
      .wp-reaction-name { font-size:10px; color:rgba(255,255,255,0.7); margin-top:2px; }
      @keyframes wp-float-up {
        0% { opacity:1; transform:translateY(0) scale(1); }
        70% { opacity:1; }
        100% { opacity:0; transform:translateY(-200px) scale(1.3); }
      }

      /* Toast notification */
      #wp-toast {
        pointer-events:none; position:fixed; top:70px; left:50%; transform:translateX(-50%) translateY(-10px);
        background:rgba(15,15,30,0.95); color:#fff; font-size:13px;
        padding:8px 20px; border-radius:8px; z-index:2147483647;
        border:1px solid rgba(99,102,241,0.3); box-shadow:0 4px 16px rgba(0,0,0,0.4);
        opacity:0; transition:opacity .3s, transform .3s;
      }
      #wp-toast.wp-toast-visible { opacity:1; transform:translateX(-50%) translateY(0); }
    `;
  }

  return {
    create, updateState, updateSyncIndicator,
    appendChatMessage, showReaction, updateTypingIndicator,
    openSidebar, bindRoomCodeCopy, bindTypingIndicator,
    playNotifSound, showToast,
  };
})();
