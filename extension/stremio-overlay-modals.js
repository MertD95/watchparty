// WatchParty — Modals & Toast Module
// Manages: Toast notifications (Popover API), ready check modal, countdown overlay.
// Exposes: WPModals global used by stremio-overlay.js

const WPModals = (() => {
  'use strict';

  const TOAST_DURATION_MS = 3000;

  // --- Toast notification (uses Popover API for top-layer rendering) ---
  function showToast(message, durationMs = TOAST_DURATION_MS) {
    const existing = document.getElementById('wp-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'wp-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = message;
    // Append to sidebar (not overlay) so it's positioned within the sidebar
    const sidebar = document.getElementById('wp-sidebar') || document.getElementById('wp-overlay');
    sidebar?.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('wp-toast-visible'));
    setTimeout(() => {
      toast.classList.remove('wp-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, durationMs);
  }

  // --- Ready check modal (Popover API) ---
  function showReadyCheck(action, confirmed, total, myUserId, dispatchAction = null) {
    let modal = document.getElementById('wp-ready-modal');
    if (action === 'cancelled' || action === 'completed') {
      if (modal) { try { modal.hidePopover(); } catch {} modal.remove(); }
      document.getElementById('wp-countdown')?.remove();
      return;
    }
    if (action === 'started') {
      if (modal) { try { modal.hidePopover(); } catch {} modal.remove(); }
      document.getElementById('wp-countdown')?.remove();
      modal = document.createElement('div');
      modal.id = 'wp-ready-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-label', 'Ready Check');
      modal.setAttribute('popover', 'manual');
      modal.innerHTML = `
        <div class="wp-ready-box">
          <div class="wp-ready-title">Ready Check</div>
          <div class="wp-ready-status" id="wp-ready-status">Waiting for everyone...</div>
          <div class="wp-ready-count" id="wp-ready-count">0 / ${total}</div>
          <button class="wp-ready-btn" id="wp-ready-confirm" autofocus>I'm Ready!</button>
          <button class="wp-ready-cancel" id="wp-ready-dismiss">Dismiss</button>
        </div>
      `;
      document.getElementById('wp-overlay')?.appendChild(modal);
      modal.showPopover();
      const confirmButton = document.getElementById('wp-ready-confirm');
      confirmButton.addEventListener('click', async (event) => {
        if (confirmButton.disabled) return;
        confirmButton.disabled = true;
        confirmButton.textContent = 'Sending...';
        let accepted = false;
        try {
          const result = typeof dispatchAction === 'function'
            ? await dispatchAction(WPConstants.ACTION.ROOM_READY_CHECK_UPDATE, { readyAction: 'confirm' }, event)
            : false;
          accepted = !!result && result.handled !== false && result.ok !== false;
        } catch { /* Keep the confirmation retryable when disconnected. */ }
        if (document.getElementById('wp-ready-modal') !== modal) return;
        confirmButton.disabled = accepted;
        confirmButton.textContent = accepted ? 'Waiting...' : "I'm Ready!";
        // Counts, countdowns, and playback come only from the server. A queued
        // local confirmation is not proof that every participant is ready.
      });
      document.getElementById('wp-ready-dismiss').addEventListener('click', () => {
        try { modal.hidePopover(); } catch {} modal.remove();
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
    document.getElementById('wp-ready-modal')?.remove();
    let el = document.getElementById('wp-countdown');
    if (seconds <= 0) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'wp-countdown';
      document.getElementById('wp-overlay')?.appendChild(el);
    }
    el.textContent = seconds;
    el.classList.remove('wp-countdown-active');
    void el.offsetHeight;
    el.classList.add('wp-countdown-active');
  }

  return { showToast, showReadyCheck, showCountdown };
})();
