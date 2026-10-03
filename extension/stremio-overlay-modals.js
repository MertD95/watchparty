// WatchParty — Modals & Toast Module
// Manages: Toast notifications (Popover API), ready check modal, countdown overlay.
// Exposes: WPModals global used by stremio-overlay.js

const WPModals = (() => {
  'use strict';

  const TOAST_DURATION_MS = 3000;

  function removeReadyModal(modal) {
    if (!modal) return;
    clearTimeout(modal.confirmationTimer);
    try { modal.hidePopover(); } catch {}
    modal.remove();
  }

  async function sendReadyAction(dispatchAction, detail, event) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(dispatchAction?.(WPConstants.ACTION.ROOM_READY_CHECK_UPDATE, detail, event)),
        new Promise(resolve => { timer = setTimeout(() => resolve({ handled: false, error: 'No response. Reconnect and try again.' }), 8000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

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
  function showReadyCheck(action, confirmed, total, myUserId, dispatchAction = null, options = {}) {
    confirmed = Array.isArray(confirmed) ? confirmed : [];
    total = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
    let modal = document.getElementById('wp-ready-modal');
    if (action === 'cancelled' || action === 'completed') {
      removeReadyModal(modal);
      document.getElementById('wp-countdown')?.remove();
      return;
    }
    if (action === 'started') {
      removeReadyModal(modal);
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
          ${options.isHost ? '<button class="wp-ready-cancel" id="wp-ready-stop">Cancel for everyone</button>' : ''}
        </div>
      `;
      document.getElementById('wp-overlay')?.appendChild(modal);
      modal.showPopover();
      const confirmButton = document.getElementById('wp-ready-confirm');
      confirmButton.addEventListener('click', async (event) => {
        if (confirmButton.disabled) return;
        clearTimeout(modal.confirmationTimer);
        confirmButton.disabled = true;
        confirmButton.textContent = 'Sending...';
        let accepted = false;
        let errorMessage = '';
        try {
          const result = await sendReadyAction(dispatchAction, { readyAction: 'confirm' }, event);
          accepted = !!result && result.handled !== false && result.ok !== false;
          errorMessage = result?.error || '';
        } catch { /* Keep the confirmation retryable when disconnected. */ }
        if (document.getElementById('wp-ready-modal') !== modal) return;
        const confirmedByServer = modal.confirmedByServer === true;
        confirmButton.disabled = accepted || confirmedByServer;
        confirmButton.textContent = accepted || confirmedByServer ? 'Waiting...' : "I'm Ready!";
        if (!accepted && !confirmedByServer) {
          document.getElementById('wp-ready-status').textContent = errorMessage || 'Could not confirm. Reconnect and try again.';
        } else if (!confirmedByServer) {
          modal.confirmationTimer = setTimeout(() => {
            if (document.getElementById('wp-ready-modal') !== modal || modal.confirmedByServer) return;
            confirmButton.disabled = false;
            confirmButton.textContent = "I'm Ready!";
            document.getElementById('wp-ready-status').textContent = 'Confirmation was not received. Try again.';
          }, 8000);
        }
        // Counts, countdowns, and playback come only from the server. A queued
        // local confirmation is not proof that every participant is ready.
      });
      document.getElementById('wp-ready-dismiss').addEventListener('click', () => {
        removeReadyModal(modal);
      });
      document.getElementById('wp-ready-stop')?.addEventListener('click', async (event) => {
        const button = document.getElementById('wp-ready-stop');
        if (!button || button.disabled) return;
        button.disabled = true;
        let result;
        try { result = await sendReadyAction(dispatchAction, { readyAction: 'cancel' }, event); } catch {}
        if (document.getElementById('wp-ready-modal') !== modal) return;
        button.disabled = false;
        if (!result || result.handled === false || result.ok === false) {
          const status = document.getElementById('wp-ready-status');
          if (status) status.textContent = result?.error || 'Could not cancel. Reconnect and try again.';
        }
        // The server's cancellation event closes every participant's dialog.
      });
    }
    if ((action === 'updated' || action === 'started') && modal) {
      const countEl = document.getElementById('wp-ready-count');
      if (countEl) countEl.textContent = `${confirmed.length} / ${total}`;
      const iConfirmed = confirmed.includes(myUserId);
      modal.confirmedByServer = iConfirmed;
      const confirmBtn = document.getElementById('wp-ready-confirm');
      if (confirmBtn && iConfirmed) {
        clearTimeout(modal.confirmationTimer);
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Waiting...';
      }
    }
  }

  // --- Countdown overlay ---
  function showCountdown(seconds) {
    removeReadyModal(document.getElementById('wp-ready-modal'));
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
