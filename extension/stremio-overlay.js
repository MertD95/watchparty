// WatchParty — Overlay UI
// Injects the sidebar, chat, reactions, emoji picker, and sync indicator into Stremio Web.

const WPOverlay = (() => {
  'use strict';

  let overlay = null;
  let sidebarMinimized = false;

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
          <div id="wp-controls" class="wp-hidden-el"></div>
          <div id="wp-users"></div>
          <div id="wp-typing-indicator" class="wp-hidden-el"></div>
          <div id="wp-reactions-bar"></div>
          <div id="wp-chat-container">
            <div id="wp-chat-messages"></div>
            <div id="wp-chat-input-row">
              <button id="wp-emoji-btn" title="React">&#x1F600;</button>
              <input id="wp-chat-input" type="text" placeholder="Type a message..." maxlength="300" autocomplete="off" />
              <button id="wp-chat-send">Send</button>
            </div>
          </div>
        </div>
      </div>
      <div id="wp-reaction-container"></div>
      <button id="wp-toggle-btn" title="WatchParty">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        <span id="wp-badge" class="wp-hidden-el">0</span>
      </button>
      <div id="wp-emoji-picker" class="wp-hidden-el">
        ${['👍','👏','😂','😮','😢','❤️','🔥','🎉','💀','👀'].map(e =>
          `<button class="wp-emoji-pick" data-emoji="${e}">${e}</button>`
        ).join('')}
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = getCSS();
    document.head.appendChild(style);
    document.body.appendChild(overlay);
    bindEvents();
  }

  // --- Event bindings ---
  function bindEvents() {
    const $ = (id) => document.getElementById(id);

    $('wp-toggle-btn').addEventListener('click', () => {
      $('wp-sidebar').classList.remove('wp-sidebar-hidden');
      $('wp-toggle-btn').style.display = 'none';
    });
    $('wp-close-sidebar').addEventListener('click', () => {
      $('wp-sidebar').classList.add('wp-sidebar-hidden');
      $('wp-toggle-btn').style.display = 'flex';
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
    $('wp-emoji-btn').addEventListener('click', () => {
      $('wp-emoji-picker').classList.toggle('wp-hidden-el');
    });
    document.querySelectorAll('.wp-emoji-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'watchparty-ext', action: 'send-reaction', emoji: btn.dataset.emoji,
        }).catch(() => {});
        $('wp-emoji-picker').classList.add('wp-hidden-el');
      });
    });
  }

  function sendChat() {
    const input = document.getElementById('wp-chat-input');
    if (!input || !input.value.trim()) return;
    chrome.runtime.sendMessage({
      type: 'watchparty-ext', action: 'send-chat', content: input.value.trim(),
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
    const badge = document.getElementById('wp-badge');
    const controls = document.getElementById('wp-controls');
    const contentLink = document.getElementById('wp-content-link');
    const syncInd = document.getElementById('wp-sync-indicator');
    const minInfo = document.getElementById('wp-min-info');

    const chatContainer = document.getElementById('wp-chat-container');

    if (!inRoom || !roomState) {
      if (status) status.innerHTML = '<div class="wp-empty-state">Not in a room.<br/>Use the extension popup to create or join one.</div>';
      if (roomCode) roomCode.textContent = '';
      if (usersDiv) usersDiv.innerHTML = '';
      if (badge) badge.classList.add('wp-hidden-el');
      if (controls) controls.classList.add('wp-hidden-el');
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

    // Host controls
    if (controls) {
      if (isHost) {
        controls.classList.remove('wp-hidden-el');
        const isPublic = roomState.public || false;
        controls.innerHTML = `
          <label class="wp-toggle-label">
            <input type="checkbox" id="wp-public-toggle" ${isPublic ? 'checked' : ''} />
            <span>Public room</span>
          </label>
        `;
        document.getElementById('wp-public-toggle').addEventListener('change', (e) => {
          chrome.runtime.sendMessage({
            type: 'watchparty-ext', action: 'toggle-public', public: e.target.checked,
          }).catch(() => {});
        });
      } else {
        controls.classList.add('wp-hidden-el');
      }
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

    // Users with ownership transfer
    if (usersDiv && roomState.users) {
      usersDiv.innerHTML = roomState.users.map(u => {
        const isOwner = u.id === roomState.owner;
        const isMe = u.id === userId;
        const color = getUserColor(u.id);
        const crown = isOwner ? '<span class="wp-crown">👑</span>' : '';
        const you = isMe ? ' <span class="wp-you">(you)</span>' : '';
        const transferBtn = (isHost && !isMe && !isOwner)
          ? `<button class="wp-transfer-btn" data-uid="${u.id}" title="Transfer host">Make Host</button>`
          : '';
        return `<div class="wp-user"><span class="wp-user-dot" style="background:${color}"></span>${crown}${escapeHtml(u.name)}${you}${transferBtn}</div>`;
      }).join('');
      usersDiv.querySelectorAll('.wp-transfer-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          chrome.runtime.sendMessage({
            type: 'watchparty-ext', action: 'transfer-ownership', targetUserId: btn.dataset.uid,
          }).catch(() => {});
        });
      });
    }

    if (badge && roomState.users) {
      badge.textContent = roomState.users.length;
      badge.classList.remove('wp-hidden-el');
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
    const userName = roomState?.users?.find(u => u.id === msg.user)?.name || 'Unknown';
    const color = getUserColor(msg.user);
    const div = document.createElement('div');
    div.className = 'wp-chat-msg';
    div.innerHTML = `<span class="wp-chat-name" style="color:${color}">${escapeHtml(userName)}</span> <span class="wp-chat-text">${escapeHtml(msg.content)}</span>`;
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
  }

  function bindRoomCodeCopy(roomState) {
    const el = document.getElementById('wp-room-code');
    if (!el) return;
    el.onclick = () => {
      navigator.clipboard.writeText(roomState?.id || el.textContent).catch(() => {});
      el.textContent = 'Copied!';
      setTimeout(() => { el.textContent = roomState?.id?.slice(0, 8) || ''; }, 1000);
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

      /* Toggle button — positioned below Stremio's top nav to avoid overlap */
      #wp-toggle-btn {
        pointer-events:all; position:fixed; top:60px; right:16px; z-index:2147483647;
        background:rgba(99,102,241,0.9); border:none; border-radius:50%;
        width:40px; height:40px; display:flex; align-items:center; justify-content:center;
        cursor:pointer; color:#fff; box-shadow:0 2px 12px rgba(0,0,0,0.4);
        transition:transform .15s,background .15s;
      }
      #wp-toggle-btn:hover { transform:scale(1.1); background:rgba(99,102,241,1); }
      #wp-badge {
        position:absolute; top:-4px; right:-4px; background:#ef4444; color:#fff;
        font-size:10px; font-weight:bold; border-radius:50%; width:18px; height:18px;
        display:flex; align-items:center; justify-content:center;
      }

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

      /* Controls */
      #wp-controls {
        padding:8px 16px; border-bottom:1px solid rgba(255,255,255,0.08);
        background:rgba(255,255,255,0.02);
      }
      .wp-toggle-label {
        display:flex; align-items:center; gap:8px; font-size:12px; color:#ccc; cursor:pointer;
      }
      .wp-toggle-label input[type="checkbox"] { accent-color:#6366f1; }

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
      .wp-transfer-btn {
        margin-left:auto; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1);
        border-radius:4px; padding:2px 8px; font-size:10px; color:#999; cursor:pointer; flex-shrink:0;
      }
      .wp-transfer-btn:hover { background:rgba(99,102,241,0.2); color:#818cf8; border-color:rgba(99,102,241,0.3); }

      /* Typing */
      #wp-typing-indicator { padding:2px 16px 4px; font-size:11px; color:#888; font-style:italic; }
      #wp-reactions-bar { display:flex; gap:4px; padding:0 16px 4px; flex-wrap:wrap; }

      /* Chat */
      #wp-chat-container { flex:1; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
      #wp-chat-messages {
        flex:1; overflow-y:auto; padding:8px 16px; font-size:12px; min-height:80px;
        scrollbar-width:thin; scrollbar-color:rgba(255,255,255,0.15) transparent;
      }
      .wp-chat-msg { margin-bottom:6px; line-height:1.5; word-break:break-word; }
      .wp-chat-name { font-weight:600; }
      .wp-chat-text { color:#ccc; }
      #wp-chat-input-row {
        display:flex; padding:8px 12px; gap:6px;
        border-top:1px solid rgba(255,255,255,0.1);
        background:rgba(0,0,0,0.15);
      }
      #wp-emoji-btn {
        background:none; border:none; font-size:16px; cursor:pointer; padding:0 4px;
        flex-shrink:0;
      }
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

      /* Emoji picker — positioned relative to sidebar bottom */
      #wp-emoji-picker {
        pointer-events:all; position:fixed; bottom:60px; right:16px; z-index:2147483647;
        background:rgba(20,20,40,0.98); border:1px solid rgba(255,255,255,0.15);
        border-radius:10px; padding:8px; display:flex; gap:4px; flex-wrap:wrap; width:200px;
        box-shadow:0 4px 16px rgba(0,0,0,0.4);
      }
      .wp-emoji-pick {
        background:none; border:none; font-size:22px; cursor:pointer; padding:4px;
        border-radius:6px; transition:background .1s;
      }
      .wp-emoji-pick:hover { background:rgba(255,255,255,0.1); }

      /* Floating reactions */
      #wp-reaction-container {
        pointer-events:none; position:fixed; top:0; left:0; width:100vw; height:100vh; z-index:99998;
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
    `;
  }

  return {
    create, updateState, updateSyncIndicator,
    appendChatMessage, showReaction, updateTypingIndicator,
    openSidebar, bindRoomCodeCopy, bindTypingIndicator,
    playNotifSound,
  };
})();
