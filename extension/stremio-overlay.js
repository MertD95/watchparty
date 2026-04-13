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
      // No per-pill listener — handled by delegated click on #wp-chat-messages
      pillsContainer.appendChild(pill);
    }
    document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'send-reaction', emoji } }));
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
  // Resume AudioContext on first user interaction (required by browser autoplay policy)
  function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  document.addEventListener('click', () => ensureAudioCtx(), { once: true });

  function playNotifSound() {
    try {
      const ctx = ensureAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      gain.gain.value = 0.08;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.stop(ctx.currentTime + 0.15);
    } catch { /* audio not available */ }
  }

  // escapeHtml() provided by WPUtils (destructured above)


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
    // Clean up stale overlay from previous content script injection (e.g., after extension update)
    const existing = document.getElementById('wp-overlay');
    if (existing) existing.remove();
    const existingToggle = document.getElementById('wp-toggle-host');
    if (existingToggle) existingToggle.remove();

    overlay = document.createElement('div');
    overlay.id = 'wp-overlay';
    overlay.innerHTML = `
      <div id="wp-sidebar" class="wp-sidebar-hidden">
        <div id="wp-header">
          <span id="wp-title">WatchParty</span>
          <span id="wp-room-code" title="Click to copy"></span>
          <button id="wp-minimize-btn" title="Minimize" aria-label="Minimize sidebar">&#x2015;</button>
          <button id="wp-close-sidebar" title="Close" aria-label="Close sidebar">&times;</button>
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
          <div id="wp-chat-container" class="wp-hidden-el">
            <div id="wp-chat-messages"></div>
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
    // Hidden until positioned — avoids visible shift when Stremio's nav renders
    toggleHost.style.cssText = 'position:fixed;top:18px;right:128px;z-index:2147483647;width:42px;height:42px;visibility:hidden;';
    let positioned = false;
    function positionToggle() {
      const container = document.querySelector('[class*="buttons-container"]');
      if (container) {
        const r = container.getBoundingClientRect();
        if (r.width > 0) {
          toggleHost.style.top = Math.round(r.top + (r.height - 42) / 2) + 'px';
          toggleHost.style.right = Math.round(window.innerWidth - r.left + 8) + 'px';
          if (!positioned) {
            toggleHost.style.visibility = 'visible';
            positioned = true;
          }
          return true;
        }
      }
      return false;
    }
    // Poll rapidly until Stremio's nav renders (every 100ms, up to 3s)
    let posAttempts = 0;
    const posInterval = setInterval(() => {
      if (positionToggle() || ++posAttempts >= 30) {
        clearInterval(posInterval);
        if (!positioned) {
          // Fallback: show at hardcoded position if nav never appeared
          toggleHost.style.visibility = 'visible';
        }
      }
    }, 100);
    window.addEventListener('resize', () => positionToggle());
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
      <button title="WatchParty" aria-label="Toggle WatchParty sidebar">
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
        // Reaction mode: add pill to the message (verify element is still in DOM — may have been pruned)
        if (reactionTarget.pills?.isConnected) {
          toggleReaction(reactionTarget.pills, emoji);
        }
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
    bindChatDelegation();

    // Re-evaluate content margin on resize (handles switch between push and overlay mode)
    window.addEventListener('resize', () => {
      const sidebarOpen = !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden');
      updateContentMargin(sidebarOpen);
    });

    // Re-apply content margin on SPA navigation (Stremio rebuilds DOM, resets body.style.width)
    // MutationObserver detects when Stremio resets body.style, more reliable than hardcoded timeouts
    let marginObserver = null;
    function startMarginObserver() {
      if (marginObserver) return;
      marginObserver = new MutationObserver(() => {
        const sidebarOpen = !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden');
        if (sidebarOpen && !document.body.style.width?.includes(`${SIDEBAR_WIDTH}`)) {
          updateContentMargin(true);
        }
      });
      marginObserver.observe(document.body, { attributes: true, attributeFilter: ['style'] });
    }
    startMarginObserver();
    // Also re-apply on hashchange as a fallback
    window.addEventListener('hashchange', () => {
      const sidebarOpen = !document.getElementById('wp-sidebar')?.classList.contains('wp-sidebar-hidden');
      if (sidebarOpen) updateContentMargin(true);
    });

    // Theme: delegate to WPTheme module
    WPTheme.startListening();
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

        const btnRect = reactBtn.getBoundingClientRect();
        pickerEl.style.position = 'fixed';
        pickerEl.style.bottom = 'auto';
        pickerEl.style.top = (btnRect.bottom + 4) + 'px';
        pickerEl.style.right = (window.innerWidth - btnRect.right) + 'px';
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
    function expandSidebar() {
      $('wp-body').classList.remove('wp-hidden-el');
      $('wp-minimized-bar').classList.add('wp-hidden-el');
      $('wp-minimize-btn').classList.remove('wp-hidden-el');
    }
    $('wp-expand-btn').addEventListener('click', expandSidebar);
    $('wp-minimized-bar').addEventListener('click', expandSidebar);
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
      const gifContent = `[gif:${img.dataset.url}]`;
      document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'send-chat', content: gifContent } }));
      // Local echo + dedup tracking (same pattern as text chat)
      const container = document.getElementById('wp-chat-messages');
      if (container) {
        const div = buildMsgEl(
          `<span class="wp-chat-name" style="color:${getUserColor(cachedUserId)}">${escapeHtml(cachedUsername)}</span>`,
          `<img class="wp-chat-gif" src="${escapeHtml(img.dataset.url)}" alt="GIF" />`
        );
        div.classList.add('wp-chat-local');
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        const dedupKey = gifContent.substring(0, 300); // Truncate to match server's message limit
        localEchoSet.add(dedupKey);
        setTimeout(() => localEchoSet.delete(dedupKey), LOCAL_ECHO_TTL_MS);
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
      while (container.childElementCount > MAX_CHAT_MESSAGES && container.firstElementChild) container.removeChild(container.firstElementChild);
      container.scrollTop = container.scrollHeight;
      // Track for dedup (expire after 10s). Truncate to 300 chars to match server's limit.
      const dedupKey = content.substring(0, 300);
      localEchoSet.add(dedupKey);
      setTimeout(() => localEchoSet.delete(dedupKey), LOCAL_ECHO_TTL_MS);
    }

    document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'send-chat', content } }));
    document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'send-typing', typing: false } }));
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

    // Status + action buttons — only rebuild if content changed (avoids DOM churn on every playerSync)
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
      const newStatusHtml = `<span class="wp-status-line">${hostLabel}</span><span class="wp-status-line wp-muted">${videoStatus}</span>${actionsRow}`;
      if (status._lastHtml !== newStatusHtml) {
        status.innerHTML = newStatusHtml;
        status._lastHtml = newStatusHtml;
        // Bind action buttons (only when DOM was actually rebuilt)
        document.getElementById('wp-ready-check-btn')?.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'ready-check', readyAction: 'initiate' } }));
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
        document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'send-bookmark', time } }));
        // Local echo — show bookmark immediately (server broadcast also arrives but appendBookmark deduplicates by checking last message)
        appendBookmark({ user: cachedUserId, userName: cachedUsername, time, label: '' });
        showToast('Bookmark saved!', 1500);
      });
      } // end if (status._lastHtml !== newStatusHtml)
    }

    // Content link for peers — show what the host is watching
    if (contentLink) {
      if (!isHost && roomState.meta?.id && roomState.meta.id !== 'pending' && roomState.meta.id !== 'unknown') {
        const name = escapeHtml(roomState.meta.name || roomState.meta.id);
        const link = `https://web.stremio.com/#/detail/${encodeURIComponent(roomState.meta.type)}/${encodeURIComponent(roomState.meta.id)}`;
        const hasVideo = !!document.querySelector('video');
        if (hasVideo) {
          // Already watching — hide the link, not needed
          contentLink.classList.add('wp-hidden-el');
        } else {
          // Not watching yet — show movie name as a link to navigate
          contentLink.classList.remove('wp-hidden-el');
          contentLink.innerHTML = `<span class="wp-content-label">Host is watching:</span> <a href="${link}" class="wp-content-link-a">${name}</a>`;
        }
      } else {
        contentLink.classList.add('wp-hidden-el');
      }
    }

    // Users with presence, playback status, and ownership transfer
    // Only rebuild if user list actually changed (avoids DOM churn on every 500ms playerSync)
    if (usersDiv && roomState.users) {
      const usersKey = roomState.users.map(u => `${u.id}:${u.status}:${u.playbackStatus}`).join(',') + `:${roomState.owner}:${isHost}`;
      if (usersDiv._lastUsersKey === usersKey) {
        // No change — skip rebuild
      } else {
      usersDiv._lastUsersKey = usersKey;
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
      // Event delegation: single listener on usersDiv handles all transfer button clicks
      // (innerHTML replacement removes old DOM, so no duplicate listeners accumulate)
      usersDiv.onclick = (e) => {
        const btn = e.target.closest('.wp-transfer-btn');
        if (btn?.dataset.uid) {
          document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'transfer-ownership', targetUserId: btn.dataset.uid } }));
        }
      };
      } // end else (users changed)
    }

  }

  function updateSyncIndicator(isHost, drift) {
    const el = document.getElementById('wp-sync-indicator');
    if (!el) return;
    if (isHost) { el.classList.add('wp-hidden-el'); return; }
    el.classList.remove('wp-hidden-el');
    const abs = Math.abs(drift);
    if (abs < WPSync.SOFT_DRIFT_ENTER) {
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
    while (container.childElementCount > MAX_CHAT_MESSAGES && container.firstElementChild) container.removeChild(container.firstElementChild);
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
      const ctx = ensureAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 1200;
      osc.type = 'sine';
      gain.gain.value = 0.05;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.stop(ctx.currentTime + 0.12);
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
    // Early exit: skip DOM update if no one is typing and indicator is already hidden
    if (typingUsers.size === 0 && el.classList.contains('wp-hidden-el')) return;
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
    while (container.childElementCount > MAX_CHAT_MESSAGES && container.firstElementChild) container.removeChild(container.firstElementChild);
    container.scrollTop = container.scrollHeight;
  }

  function bindRoomCodeCopy(roomState) {
    const el = document.getElementById('wp-room-code');
    if (!el) return;
    el.onclick = async () => {
      let inviteUrl = `https://watchparty.mertd.me/r/${roomState?.id || el.textContent}`;
      // Include E2E encryption key in URL fragment (never sent to server)
      if (typeof WPCrypto !== 'undefined' && WPCrypto.isEnabled()) {
        const key = await WPCrypto.exportKey();
        if (key) inviteUrl += `#key=${key}`;
      }
      navigator.clipboard.writeText(inviteUrl).then(() => {
        el.textContent = 'Link copied!';
      }).catch(() => {
        el.textContent = 'Copy failed';
      }).finally(() => {
        setTimeout(() => { el.textContent = roomState?.id?.slice(0, 8) || ''; }, 1500);
      });
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
        document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'request-sync' } }));
        btn.remove();
      });
      document.getElementById('wp-overlay')?.appendChild(btn);
    }
    const secs = Math.abs(drift).toFixed(0);
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
