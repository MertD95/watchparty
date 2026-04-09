import './emoji-picker-element.js';

// Bridge: re-dispatch emoji-click so the content script can read it
document.addEventListener('emoji-click', (e) => {
  const unicode = e.detail?.unicode;
  if (unicode) {
    document.dispatchEvent(new CustomEvent('wp-emoji-selected', { detail: unicode }));
  }
}, true);

document.dispatchEvent(new CustomEvent('wp-emoji-lib-ready'));
