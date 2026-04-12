// WatchParty — Modals & Toast Module
// Manages: Toast notifications (Popover API), ready check modal, countdown overlay.
// Exposes: WPModals global used by stremio-overlay.js

const WPModals = (() => {
  'use strict';

  const TOAST_DURATION_MS = 3000;
  let localCountdownTimer = null;

  // --- Toast notification (uses Popover API for top-layer rendering) ---
  function showToast(message, durationMs = TOAST_DURATION_MS) {
    const existing = document.getElementById('wp-toast');
    if (existing) { try { existing.hidePopover(); } catch {} existing.remove(); }
    const toast = document.createElement('div');
    toast.id = 'wp-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('popover', 'manual');
    toast.textContent = message;
    document.getElementById('wp-overlay')?.appendChild(toast);
    toast.showPopover();
    requestAnimationFrame(() => toast.classList.add('wp-toast-visible'));
    setTimeout(() => {
      toast.classList.remove('wp-toast-visible');
      setTimeout(() => { try { toast.hidePopover(); } catch {} toast.remove(); }, 300);
    }, durationMs);
  }

  // --- Ready check modal (Popover API) ---
  function showReadyCheck(action, confirmed, total, myUserId) {
    let modal = document.getElementById('wp-ready-modal');
    if (action === 'cancelled' || action === 'completed') {
      if (localCountdownTimer) { clearInterval(localCountdownTimer); localCountdownTimer = null; }
      if (modal) { try { modal.hidePopover(); } catch {} modal.remove(); }
      return;
    }
    if (action === 'started') {
      if (modal) { try { modal.hidePopover(); } catch {} modal.remove(); }
      const video = document.querySelector('video');
      if (video && !video.paused) video.pause();
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
      document.getElementById('wp-ready-confirm').addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('wp-action', { detail: { action: 'ready-check', readyAction: 'confirm' } }));
        document.getElementById('wp-ready-confirm').disabled = true;
        document.getElementById('wp-ready-confirm').textContent = 'Waiting...';
        const countEl = document.getElementById('wp-ready-count');
        if (countEl) {
          const parts = countEl.textContent.split('/').map(s => parseInt(s.trim()));
          const newConfirmed = (parts[0] || 0) + 1;
          const total = parts[1] || 1;
          countEl.textContent = `${newConfirmed} / ${total}`;
          if (newConfirmed >= total) {
            document.getElementById('wp-ready-modal')?.remove();
            if (localCountdownTimer) clearInterval(localCountdownTimer);
            let count = 3;
            localCountdownTimer = setInterval(() => {
              showCountdown(count);
              count--;
              if (count < 0) { clearInterval(localCountdownTimer); localCountdownTimer = null; showCountdown(0); }
            }, 1000);
          }
        }
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
    el.classList.remove('wp-countdown-active');
    void el.offsetHeight;
    el.classList.add('wp-countdown-active');
  }

  return { showToast, showReadyCheck, showCountdown };
})();
