// WatchParty — Shared Utilities
// Used by: stremio-overlay.js, sidepanel.js, popup.js
// Loaded before all content scripts via manifest.json

const WPUtils = (() => {
  'use strict';

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

  function escapeHtml(str) {
    if (str == null) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function getMatchingRoomUser(room, userId, sessionId) {
    if (!room?.users?.length) return null;
    if (userId) {
      const directMatch = room.users.find((user) => user.id === userId);
      if (directMatch) return directMatch;
    }
    if (sessionId) {
      return room.users.find((user) => user.sessionId && user.sessionId === sessionId) || null;
    }
    return null;
  }

  function isCurrentSessionUser(user, userId, sessionId) {
    if (!user) return false;
    if (userId && user.id === userId) return true;
    return !!sessionId && !!user.sessionId && user.sessionId === sessionId;
  }

  function getCanonicalOwnerUser(room) {
    if (!room?.users?.length) return null;
    if (room.ownerSessionId) {
      const ownerBySession = room.users.find((user) => user.sessionId && user.sessionId === room.ownerSessionId);
      if (ownerBySession) return ownerBySession;
    }
    if (room.owner) {
      const ownerById = room.users.find((user) => user.id === room.owner);
      if (ownerById) return ownerById;
    }
    return null;
  }

  function isCurrentSessionOwner(room, userId, sessionId) {
    if (!room) return false;
    if (room.ownerSessionId && sessionId) return room.ownerSessionId === sessionId;
    if (room.owner && userId && room.owner === userId) return true;
    const ownerUser = getCanonicalOwnerUser(room);
    if (ownerUser?.sessionId && sessionId) return ownerUser.sessionId === sessionId;
    if (!ownerUser) {
      return !!getMatchingRoomUser(room, userId, sessionId);
    }
    return false;
  }

  async function copyText(text) {
    const value = String(text || '');
    if (!value) return false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {}

    let textarea = null;
    const active = document.activeElement;
    try {
      textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', 'readonly');
      textarea.setAttribute('aria-hidden', 'true');
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '-9999px';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      document.body.appendChild(textarea);
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      textarea?.remove();
      if (active && typeof active.focus === 'function') {
        try { active.focus({ preventScroll: true }); } catch { try { active.focus(); } catch {} }
      }
    }
  }

  async function copyTextViaExtension(text) {
    const value = String(text || '');
    if (!value || !chrome?.runtime?.sendMessage) return false;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'watchparty-ext',
        action: 'copy-to-clipboard',
        text: value,
      });
      return response?.ok === true;
    } catch {
      return false;
    }
  }

  async function copyTextDeferred(resolveText) {
    const loader = (typeof resolveText === 'function')
      ? resolveText
      : () => resolveText;
    let resolvedValue = '';

    try {
      resolvedValue = String(await loader() || '');
      if (!resolvedValue) return false;

      if (await copyTextViaExtension(resolvedValue)) return true;

      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        const item = new ClipboardItem({
          'text/plain': Promise.resolve(new Blob([resolvedValue], { type: 'text/plain' })),
        });
        await navigator.clipboard.write([item]);
        return true;
      }
    } catch {}

    try {
      return await copyText(resolvedValue || await loader());
    } catch {
      return false;
    }
  }

  return {
    USER_COLORS,
    getUserColor,
    escapeHtml,
    getMatchingRoomUser,
    isCurrentSessionUser,
    getCanonicalOwnerUser,
    isCurrentSessionOwner,
    copyText,
    copyTextDeferred,
    copyTextViaExtension,
  };
})();
