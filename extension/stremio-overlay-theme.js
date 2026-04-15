// WatchParty — Theme Module
// Manages accent color theming via CSS custom properties and chrome.storage.
// Exposes: WPTheme global used by stremio-overlay.js

const WPTheme = (() => {
  'use strict';

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

  function apply() {
    chrome.storage?.local?.get([WPConstants.STORAGE.ACCENT_COLOR, WPConstants.STORAGE.COMPACT_CHAT], (r) => {
      const accent = r[WPConstants.STORAGE.ACCENT_COLOR] || '#6366f1';
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
      // Compact class must be on #wp-sidebar (CSS rules use @scope(#wp-sidebar) { &.wp-compact ... })
      if (sidebar) {
        sidebar.classList.toggle('wp-compact', !!r[WPConstants.STORAGE.COMPACT_CHAT]);
      }
    });
  }

  function startListening() {
    apply();
    chrome.storage?.onChanged?.addListener((changes) => {
      if (changes[WPConstants.STORAGE.ACCENT_COLOR] || changes[WPConstants.STORAGE.COMPACT_CHAT]) apply();
    });
  }

  return { apply, startListening, hexToRgb, darkenHex, lightenHex };
})();
