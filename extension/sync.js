// WatchParty — Sync Engine
// Hooks into a <video> element and synchronizes playback via events from background.js.
// Implements: soft drift correction (playbackRate), hard seek, echo prevention, visibility recovery.

const WPSync = (() => {
  'use strict';

  // --- Config ---
  const SOFT_DRIFT_MIN = 0.3;      // Start soft correction above 300ms
  const SOFT_DRIFT_MAX = 3.0;      // Hard seek above 3s
  const SOFT_RATE_SLOW = 0.95;     // When ahead of host
  const SOFT_RATE_FAST = 1.05;     // When behind host
  const SOFT_DRIFT_RESET = 0.1;    // Resume normal speed within 100ms
  const SYNC_REPORT_INTERVAL = 500; // Report state every 500ms (via timeupdate)
  const SEEK_COOLDOWN = 1500;       // Don't re-seek within 1.5s of a seek

  let video = null;
  let isHost = false;
  let isSyncing = false; // Echo prevention flag
  let lastReportTime = 0;
  let lastSeekTime = 0;
  let hostSpeed = 1;
  let correcting = false;
  let onSyncOut = null; // Callback: (state) => void — sends to background

  // --- Public API ---

  function attach(videoEl, options) {
    detach();
    video = videoEl;
    isHost = options.isHost || false;
    onSyncOut = options.onSync || null;

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('ratechange', onRateChange);
    video.addEventListener('timeupdate', onTimeUpdate);

    document.addEventListener('visibilitychange', onVisibility);
  }

  function detach() {
    if (!video) return;
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('seeked', onSeeked);
    video.removeEventListener('ratechange', onRateChange);
    video.removeEventListener('timeupdate', onTimeUpdate);
    document.removeEventListener('visibilitychange', onVisibility);
    video = null;
    onSyncOut = null;
    correcting = false;
  }

  function setHost(val) {
    isHost = val;
  }

  // Called when we receive sync state from the host (via background → content script)
  function applyRemote(state) {
    if (!video || isHost) return;

    const now = Date.now();
    hostSpeed = state.speed || 1;

    // Apply pause/play
    if (state.paused && !video.paused) {
      isSyncing = true;
      video.pause();
      isSyncing = false;
    } else if (!state.paused && video.paused) {
      isSyncing = true;
      video.play().catch(() => {});
      isSyncing = false;
    }

    // Drift correction
    const drift = state.time - video.currentTime; // positive = we're behind

    if (Math.abs(drift) > SOFT_DRIFT_MAX) {
      // Hard seek
      if (now - lastSeekTime > SEEK_COOLDOWN) {
        isSyncing = true;
        video.currentTime = state.time;
        lastSeekTime = now;
        isSyncing = false;
        correcting = false;
        video.playbackRate = hostSpeed;
      }
    } else if (Math.abs(drift) > SOFT_DRIFT_MIN) {
      // Soft correction via playbackRate
      correcting = true;
      video.playbackRate = drift > 0 ? SOFT_RATE_FAST : SOFT_RATE_SLOW;
    } else if (correcting && Math.abs(drift) < SOFT_DRIFT_RESET) {
      // Close enough — resume normal speed
      correcting = false;
      video.playbackRate = hostSpeed;
    }
  }

  // --- Internal event handlers ---

  function onPlay() {
    if (isSyncing || !isHost) return;
    report({ action: 'play' });
  }

  function onPause() {
    if (isSyncing || !isHost) return;
    report({ action: 'pause' });
  }

  function onSeeked() {
    if (isSyncing || !isHost) return;
    report({ action: 'seek' });
  }

  function onRateChange() {
    if (isSyncing || !isHost || correcting) return;
    hostSpeed = video.playbackRate;
    report({ action: 'speed' });
  }

  function onTimeUpdate() {
    if (!isHost) return;
    const now = Date.now();
    if (now - lastReportTime < SYNC_REPORT_INTERVAL) return;
    lastReportTime = now;
    report({ action: 'tick' });
  }

  function onVisibility() {
    if (document.visibilityState === 'visible' && !isHost) {
      // Force re-sync when tab becomes visible
      if (onSyncOut) onSyncOut({ action: 'request-sync' });
    }
  }

  function report(extra) {
    if (!video || !onSyncOut) return;
    onSyncOut({
      ...extra,
      paused: video.paused,
      time: video.currentTime,
      speed: correcting ? hostSpeed : video.playbackRate,
      buffering: video.readyState < 3,
    });
  }

  return { attach, detach, setHost, applyRemote };
})();

// Export for content script
if (typeof globalThis !== 'undefined') {
  globalThis.WPSync = WPSync;
}
