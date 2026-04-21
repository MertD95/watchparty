(() => {
  'use strict';

  function fallbackCopyText(text) {
    const value = String(text || '');
    if (!value) return false;

    const textarea = document.createElement('textarea');
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
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }

  async function copyText(text) {
    const value = String(text || '');
    if (!value) return false;

    try {
      if (fallbackCopyText(value)) return true;
    } catch {}

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {}

    return false;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'watchparty-ext' || message?.target !== 'offscreen' || message?.action !== 'offscreen.copy') {
      return false;
    }

    copyText(message.text)
      .then((copied) => {
        sendResponse(copied ? { ok: true } : { ok: false, error: 'Copy failed' });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || 'Copy failed' });
      });

    return true;
  });
})();

