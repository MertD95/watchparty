// WatchParty — Overlay UI
// Injects the sidebar, chat, reactions, emoji picker, and sync indicator into Stremio Web.

const WPOverlay = (() => {
  'use strict';

  // --- Constants ---
  const SIDEBAR_WIDTH = 320;
  const MAX_CHAT_MESSAGES = 200;
  const TOAST_DURATION_MS = 3000;
  const LOCAL_ECHO_TTL_MS = 10000;

  let overlay = null;
  let cachedUsername = 'You';
  let cachedUserId = null;

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
    return USER_COLORS[((hash % USER_COLORS.length) + USER_COLORS.length) % USER_COLORS.length];
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
    // On small screens, sidebar overlays instead of pushing content
    if (window.innerWidth <= 640) {
      document.body.style.width = '';
      document.body.style.overflow = '';
      return;
    }
    document.body.style.transition = 'width .2s ease';
    document.body.style.width = sidebarOpen ? `calc(100% - ${SIDEBAR_WIDTH}px)` : '';
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
              <button id="wp-gif-btn" title="Send GIF">GIF</button>
              <input id="wp-chat-input" type="text" placeholder="Type a message..." maxlength="300" autocomplete="off" />
              <button id="wp-chat-send">Send</button>
            </div>
            <div id="wp-gif-picker" class="wp-hidden-el">
              <input id="wp-gif-search" type="text" placeholder="Search GIFs..." autocomplete="off" />
              <div id="wp-gif-results"></div>
            </div>
          </div>
        </div>
      </div>
      <div id="wp-reaction-container"></div>
      <div id="wp-emoji-picker" class="wp-hidden-el"></div>
    `;

    document.body.appendChild(overlay);

    // Toggle button — Shadow DOM, fixed position, independent of Stremio's DOM
    const toggleHost = document.createElement('div');
    toggleHost.id = 'wp-toggle-host';
    toggleHost.style.cssText = 'position:fixed;top:18px;right:128px;z-index:2147483647;width:42px;height:42px;';
    // Position toggle to the left of Stremio's buttons — measure once, cache result
    let cachedToggleRight = 128; // fallback
    function positionToggle() {
      const container = document.querySelector('[class*="buttons-container"]');
      if (container) {
        const r = container.getBoundingClientRect();
        if (r.width > 0) {
          cachedToggleRight = Math.round(window.innerWidth - r.left + 8);
          toggleHost.style.top = Math.round(r.top + (r.height - 42) / 2) + 'px';
          toggleHost.style.right = cachedToggleRight + 'px';
        }
      }
    }
    // Measure after DOM settles, then only on resize
    setTimeout(positionToggle, 500);
    setTimeout(positionToggle, 1500);
    window.addEventListener('resize', positionToggle);
    const shadow = toggleHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { display:block; }
        button {
          width:42px; height:42px; border-radius:50%; border:none;
          background:rgba(99,102,241,0.85); color:#fff;
          display:flex; align-items:center; justify-content:center;
          cursor:pointer; transition:background .15s, transform .15s;
          box-shadow:0 2px 8px rgba(0,0,0,0.3);
        }
        button:hover { background:rgba(99,102,241,1); transform:scale(1.05); }
        svg { width:22px; height:22px; }
      </style>
      <button title="WatchParty">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
      </button>
    `;
    // Store ref to shadow button for theme updates (shadow is closed, can't access externally)
    toggleHost._wpShadowBtn = shadow.querySelector('button');
    // Unread badge (outside shadow so we can query it)
    const unreadBadge = document.createElement('span');
    unreadBadge.id = 'wp-unread-badge';
    unreadBadge.className = 'wp-hidden-el';
    toggleHost.appendChild(unreadBadge);

    function toggleSidebar() {
      const sidebar = document.getElementById('wp-sidebar');
      sidebar.classList.toggle('wp-sidebar-hidden');
      const nowOpen = !sidebar.classList.contains('wp-sidebar-hidden');
      updateContentMargin(nowOpen);
      // Hide toggle button when sidebar is open to prevent overlap with close button
      toggleHost.style.display = nowOpen ? 'none' : '';
      if (nowOpen) clearUnread();
    }
    // Listen on host for programmatic clicks, inner button handles real user clicks
    shadow.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); toggleSidebar(); });
    toggleHost.addEventListener('click', toggleSidebar);
    document.body.appendChild(toggleHost);

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

    // Re-evaluate content margin on resize (handles switch between push and overlay mode)
    window.addEventListener('resize', () => {
      const sidebarOpen = !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden');
      updateContentMargin(sidebarOpen);
    });

    // Re-apply content margin on SPA navigation (Stremio rebuilds DOM, resets body.style.width)
    window.addEventListener('hashchange', () => {
      const sidebarOpen = !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden');
      if (sidebarOpen) {
        // Stremio's DOM rebuild is async — re-apply after a short delay
        setTimeout(() => updateContentMargin(true), 100);
        setTimeout(() => updateContentMargin(true), 500);
      }
    });

    // --- Theme application ---
    function hexToRgb(hex) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `${r},${g},${b}`;
    }
    function darkenHex(hex, amount) {
      const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
      const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
      const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
      return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    }
    function lightenHex(hex, amount) {
      const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount);
      const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount);
      const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount);
      return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    }
    function applyTheme() {
      chrome.storage?.local?.get(['wpAccentColor', 'wpCompactChat'], (r) => {
        const accent = r.wpAccentColor || '#6366f1';
        const sidebar = document.getElementById('wp-sidebar');
        if (sidebar) {
          sidebar.style.setProperty('--wp-accent', accent);
          sidebar.style.setProperty('--wp-accent-hover', darkenHex(accent, 14));
          sidebar.style.setProperty('--wp-accent-light', lightenHex(accent, 26));
          sidebar.style.setProperty('--wp-accent-rgb', hexToRgb(accent));
        }
        // Update toggle button in Shadow DOM (closed — use stored ref)
        const toggleHost = document.getElementById('wp-toggle-host');
        const btn = toggleHost?._wpShadowBtn;
        if (btn) {
          const rgb = hexToRgb(accent);
          btn.style.background = `rgba(${rgb},0.85)`;
          btn.onmouseenter = () => { btn.style.background = `rgba(${rgb},1)`; };
          btn.onmouseleave = () => { btn.style.background = `rgba(${rgb},0.85)`; };
        }
        const overlay = document.getElementById('wp-overlay');
        if (overlay) {
          overlay.classList.toggle('wp-compact', !!r.wpCompactChat);
        }
      });
    }
    applyTheme();
    chrome.storage?.onChanged?.addListener((changes) => {
      if (changes.wpAccentColor || changes.wpCompactChat) applyTheme();
    });
  }

  // --- Event bindings ---
  function bindEvents() {
    const $ = (id) => document.getElementById(id);

    $('wp-close-sidebar').addEventListener('click', () => {
      $('wp-sidebar').classList.add('wp-sidebar-hidden');
      updateContentMargin(false);
      // Re-show toggle button
      $('wp-toggle-host').style.display = '';
      // Close any open pickers
      $('wp-emoji-picker')?.classList.add('wp-hidden-el');
      $('wp-gif-picker')?.classList.add('wp-hidden-el');
    });
    $('wp-minimize-btn').addEventListener('click', () => {
      $('wp-body').classList.add('wp-hidden-el');
      $('wp-minimized-bar').classList.remove('wp-hidden-el');
      $('wp-minimize-btn').classList.add('wp-hidden-el');
    });
    $('wp-expand-btn').addEventListener('click', () => {
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
    $('wp-gif-search').addEventListener('input', (e) => {
      clearTimeout(gifDebounce);
      const q = e.target.value.trim();
      gifDebounce = setTimeout(() => searchGifs(q || 'trending'), 300);
    });
    // Event delegation for GIF clicks (avoids per-element listeners on every search)
    $('wp-gif-results').addEventListener('click', (e) => {
      const img = e.target.closest('.wp-gif-item');
      if (!img?.dataset.url) return;
      chrome.runtime.sendMessage({
        type: 'watchparty-ext', action: 'send-chat', content: `[gif:${img.dataset.url}]`,
      }).catch(() => {});
      // Local echo
      const container = document.getElementById('wp-chat-messages');
      if (container) {
        const div = buildMsgEl(
          `<span class="wp-chat-name" style="color:${getUserColor(cachedUserId)}">${escapeHtml(cachedUsername)}</span>`,
          `<img class="wp-chat-gif" src="${escapeHtml(img.dataset.url)}" alt="GIF" />`
        );
        div.classList.add('wp-chat-local');
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
      }
      $('wp-gif-picker').classList.add('wp-hidden-el');
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
        `<span class="wp-chat-name" style="color:${getUserColor(cachedUserId)}">${escapeHtml(cachedUsername)}</span>`,
        `<span class="wp-chat-text">${escapeHtml(content)}</span>`
      );
      div.classList.add('wp-chat-local');
      container.appendChild(div);
      while (container.childElementCount > MAX_CHAT_MESSAGES) container.removeChild(container.firstChild);
      container.scrollTop = container.scrollHeight;
      // Track for dedup (expire after 10s)
      localEchoSet.add(content);
      setTimeout(() => localEchoSet.delete(content), LOCAL_ECHO_TTL_MS);
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
    // Cache username for local echo
    if (userId && roomState?.users) {
      cachedUserId = userId;
      const me = roomState.users.find(u => u.id === userId);
      if (me) cachedUsername = me.name;
    }
    if (!overlay) return;

    // Re-apply content margin if sidebar is open (Stremio SPA navigation can reset body width)
    const sidebarOpen = !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden');
    if (sidebarOpen) updateContentMargin(true);

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

    // Status + action buttons
    if (status) {
      const hostLabel = isHost ? 'You are the host' : 'Synced to host';
      const videoStatus = hasVideo ? 'Video detected' : 'No video detected';
      let actions = '';
      if (hasVideo && isHost) {
        actions += `<button class="wp-action-btn" id="wp-ready-check-btn" title="Ready Check">✋ Ready?</button>`;
      }
      if (hasVideo) {
        actions += `<button class="wp-action-btn" id="wp-bookmark-btn" title="Bookmark this moment">📌 Bookmark</button>`;
      }
      const actionsRow = actions ? `<div class="wp-action-row">${actions}</div>` : '';
      status.innerHTML = `<span class="wp-status-line">${hostLabel}</span><span class="wp-status-line wp-muted">${videoStatus}</span>${actionsRow}`;
      // Bind action buttons
      document.getElementById('wp-ready-check-btn')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'watchparty-ext', action: 'ready-check', readyAction: 'initiate' }).catch(() => {});
        // Pause video during ready check
        const video = document.querySelector('video');
        if (video && !video.paused) video.pause();
        // Local echo — show ready check modal immediately for the host
        const userCount = document.getElementById('wp-users')?.children.length || 1;
        showReadyCheck('started', [], userCount, cachedUserId);
      });
      document.getElementById('wp-bookmark-btn')?.addEventListener('click', () => {
        const video = document.querySelector('video');
        if (!video) return;
        const time = video.currentTime;
        chrome.runtime.sendMessage({ type: 'watchparty-ext', action: 'send-bookmark', time }).catch(() => {});
        // Local echo — show bookmark immediately (server broadcast also arrives but appendBookmark deduplicates by checking last message)
        appendBookmark({ user: cachedUserId, userName: cachedUsername, time, label: '' });
        showToast('Bookmark saved!', 1500);
      });
    }

    // Content link for peers — show what the host is watching with a button to navigate
    if (contentLink) {
      if (!isHost && roomState.meta?.id && roomState.meta.id !== 'pending' && roomState.meta.id !== 'unknown') {
        contentLink.classList.remove('wp-hidden-el');
        const name = escapeHtml(roomState.meta.name || roomState.meta.id);
        const link = `https://web.stremio.com/#/detail/${encodeURIComponent(roomState.meta.type)}/${encodeURIComponent(roomState.meta.id)}`;
        const hasVideo = !!document.querySelector('video');
        if (hasVideo) {
          // Already watching — just show what's playing
          contentLink.innerHTML = `<span class="wp-content-label">Watching:</span> <span style="color:#fff;font-weight:500">${name}</span>`;
        } else {
          // Not watching yet — show prominent button to go to the movie
          contentLink.innerHTML = `
            <div style="text-align:center">
              <div style="color:#fff;font-weight:500;margin-bottom:6px">${name}</div>
              <a href="${link}" class="wp-action-btn" style="display:inline-block;padding:6px 16px;color:var(--wp-accent-light);text-decoration:none">Pick a stream to watch</a>
            </div>`;
        }
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
    // Detect GIF messages: [gif:URL]
    const gifMatch = msg.content.match(/^\[gif:(https?:\/\/[^\]]+)\]$/);
    const contentHtml = gifMatch
      ? `<img class="wp-chat-gif" src="${escapeHtml(gifMatch[1])}" alt="GIF" />`
      : `<span class="wp-chat-text">${escapeHtml(msg.content)}</span>`;
    const div = buildMsgEl(
      `<span class="wp-chat-name" style="color:${color}">${escapeHtml(userName)}</span>`,
      contentHtml
    );
    container.appendChild(div);
    // Prune old DOM nodes to prevent memory buildup
    while (container.childElementCount > MAX_CHAT_MESSAGES) container.removeChild(container.firstChild);
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
    // Don't play sound for own reactions
    if (uid !== cachedUserId) playReactionSound();
    const container = document.getElementById('wp-reaction-container');
    if (!container) return;
    const userName = roomState?.users?.find(u => u.id === uid)?.name || '';
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
  function showToast(message, durationMs = TOAST_DURATION_MS) {
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

  // --- Ready check ---
  function showReadyCheck(action, confirmed, total, myUserId) {
    let modal = document.getElementById('wp-ready-modal');
    if (action === 'cancelled' || action === 'completed') {
      if (modal) modal.remove();
      return;
    }
    if (action === 'started') {
      if (modal) modal.remove();
      // Pause video during ready check
      const video = document.querySelector('video');
      if (video && !video.paused) video.pause();
      modal = document.createElement('div');
      modal.id = 'wp-ready-modal';
      modal.innerHTML = `
        <div class="wp-ready-box">
          <div class="wp-ready-title">Ready Check</div>
          <div class="wp-ready-status" id="wp-ready-status">Waiting for everyone...</div>
          <div class="wp-ready-count" id="wp-ready-count">0 / ${total}</div>
          <button class="wp-ready-btn" id="wp-ready-confirm">I'm Ready!</button>
          <button class="wp-ready-cancel" id="wp-ready-dismiss">Dismiss</button>
        </div>
      `;
      document.getElementById('wp-overlay')?.appendChild(modal);
      document.getElementById('wp-ready-confirm').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'watchparty-ext', action: 'ready-check', readyAction: 'confirm' }).catch(() => {});
        document.getElementById('wp-ready-confirm').disabled = true;
        document.getElementById('wp-ready-confirm').textContent = 'Waiting...';
        // Local echo: update count
        const countEl = document.getElementById('wp-ready-count');
        if (countEl) {
          const parts = countEl.textContent.split('/').map(s => parseInt(s.trim()));
          const newConfirmed = (parts[0] || 0) + 1;
          const total = parts[1] || 1;
          countEl.textContent = `${newConfirmed} / ${total}`;
          // If all confirmed, remove modal and trigger local countdown
          if (newConfirmed >= total) {
            document.getElementById('wp-ready-modal')?.remove();
            let count = 3;
            const timer = setInterval(() => {
              showCountdown(count);
              count--;
              if (count < 0) { clearInterval(timer); showCountdown(0); }
            }, 1000);
          }
        }
      });
      document.getElementById('wp-ready-dismiss').addEventListener('click', () => {
        modal.remove();
      });
    }
    if (action === 'updated' && modal) {
      const countEl = document.getElementById('wp-ready-count');
      if (countEl) countEl.textContent = `${confirmed.length} / ${total}`;
      const iConfirmed = confirmed.includes(myUserId);
      const confirmBtn = document.getElementById('wp-ready-confirm');
      if (confirmBtn && iConfirmed) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Waiting...';
      }
    }
  }

  // --- Countdown overlay ---
  function showCountdown(seconds) {
    // Remove ready modal as soon as countdown starts
    document.getElementById('wp-ready-modal')?.remove();
    let el = document.getElementById('wp-countdown');
    if (seconds <= 0) {
      if (el) el.remove();
      // Play the video when countdown finishes
      const video = document.querySelector('video');
      if (video && video.paused) video.play().catch(() => {});
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'wp-countdown';
      document.getElementById('wp-overlay')?.appendChild(el);
    }
    el.textContent = seconds;
    el.className = 'wp-countdown-pulse';
    // Force re-trigger animation
    void el.offsetHeight;
    el.className = 'wp-countdown-pulse wp-countdown-active';
    if (seconds <= 0) setTimeout(() => el.remove(), 1000);
  }

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
    div.innerHTML = `<span class="wp-bookmark-icon">📌</span> <span class="wp-chat-name" style="color:${getUserColor(msg.user)}">${escapeHtml(msg.userName)}</span> bookmarked <button class="wp-bookmark-time" data-time="${msg.time}">${timeStr}</button> <span class="wp-chat-text">${msg.label ? escapeHtml(msg.label) : ''}</span>`;
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
    while (container.childElementCount > MAX_CHAT_MESSAGES) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
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

  // --- Unread badge on toggle button ---
  let unreadCount = 0;

  function incrementUnread() {
    const sidebar = document.getElementById('wp-sidebar');
    if (sidebar && !sidebar.classList.contains('wp-sidebar-hidden')) return; // sidebar open, don't count
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
  }

  // --- Keyboard shortcuts ---
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Alt+W: toggle sidebar
      if (e.altKey && e.key === 'w') {
        e.preventDefault();
        document.getElementById('wp-toggle-host')?.click();
      }
      // Escape: close sidebar
      if (e.key === 'Escape') {
        const sidebar = document.getElementById('wp-sidebar');
        if (sidebar && !sidebar.classList.contains('wp-sidebar-hidden')) {
          sidebar.classList.add('wp-sidebar-hidden');
          updateContentMargin(false);
        }
      }
    });
  }

  // --- Catch-up button (shown when user is behind host) ---
  function showCatchUpButton(drift) {
    let btn = document.getElementById('wp-catchup-btn');
    if (Math.abs(drift) < 5) {
      if (btn) btn.remove();
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'wp-catchup-btn';
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'watchparty-ext', action: 'request-sync' }).catch(() => {});
        btn.remove();
      });
      document.getElementById('wp-overlay')?.appendChild(btn);
    }
    const secs = Math.abs(drift).toFixed(0);
    btn.textContent = `⚡ Catch up (${secs}s behind)`;
  }

  // --- Presence avatar bar on video ---
  function updatePresenceBar(users) {
    let bar = document.getElementById('wp-presence-bar');
    if (!users || users.length === 0) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'wp-presence-bar';
      document.getElementById('wp-overlay')?.appendChild(bar);
    }
    bar.innerHTML = users.map(u => {
      const color = getUserColor(u.id);
      const isAway = u.status === 'away';
      const initial = (u.name || '?')[0].toUpperCase();
      const statusDot = u.playbackStatus === 'buffering' ? '⟳' : u.playbackStatus === 'paused' ? '⏸' : '';
      return `<div class="wp-avatar${isAway ? ' wp-avatar-away' : ''}" style="background:${color}" title="${escapeHtml(u.name)}">${initial}${statusDot ? `<span class="wp-avatar-status">${statusDot}</span>` : ''}</div>`;
    }).join('');
  }

  // --- Ephemeral chat bubble on video ---
  function showChatBubble(userName, content, userId) {
    if (content.length > 60) return; // Only short messages
    const sidebar = document.getElementById('wp-sidebar');
    if (sidebar && !sidebar.classList.contains('wp-sidebar-hidden')) return; // Sidebar open, no need
    let container = document.getElementById('wp-bubble-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'wp-bubble-container';
      document.getElementById('wp-overlay')?.appendChild(container);
    }
    const bubble = document.createElement('div');
    bubble.className = 'wp-chat-bubble';
    bubble.innerHTML = `<strong style="color:${getUserColor(userId)}">${escapeHtml(userName)}</strong> ${escapeHtml(content)}`;
    container.appendChild(bubble);
    requestAnimationFrame(() => bubble.classList.add('wp-bubble-visible'));
    setTimeout(() => {
      bubble.classList.remove('wp-bubble-visible');
      setTimeout(() => bubble.remove(), 300);
    }, 4000);
    // Max 3 bubbles at once
    while (container.children.length > 3) container.removeChild(container.firstChild);
  }

  // --- CSS loaded from stremio-overlay.css via manifest.json ---



  return {
    create, updateState, updateSyncIndicator,
    appendChatMessage, showReaction, updateTypingIndicator,
    openSidebar, bindRoomCodeCopy, bindTypingIndicator,
    playNotifSound, showToast,
    showReadyCheck, showCountdown, appendBookmark,
    incrementUnread, clearUnread, initKeyboardShortcuts,
    showCatchUpButton, updatePresenceBar, showChatBubble,
  };
})();
