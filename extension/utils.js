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
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  return { USER_COLORS, getUserColor, escapeHtml };
})();
