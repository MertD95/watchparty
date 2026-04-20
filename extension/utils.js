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

  return { USER_COLORS, getUserColor, escapeHtml, copyText };
})();
