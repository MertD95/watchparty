// WatchParty — Sync Engine
// Hooks into a <video> element and synchronizes playback via events from background.js.
// Implements: soft drift correction (playbackRate), hard seek, echo prevention.

const WPSync = (() => {
  'use strict';

  // --- Config ---
  const SOFT_DRIFT_MIN = 0.3;      // Start soft correction above 300ms
  const SOFT_DRIFT_MAX = 3.0;      // Hard seek above 3s
  const SOFT_RATE_SLOW = 0.95;     // When ahead of host
  const SOFT_RATE_FAST = 1.05;     // When behind host
  const SOFT_DRIFT_RESET = 0.1;    // Resume normal speed within 100ms
  const SYNC_REPORT_INTERVAL = 500; // Report state every 500ms
  const SEEK_COOLDOWN = 1500;       // Don't re-seek within 1.5s

  let video = null;
  let isHost = false;
  let isSyncing = false; // Echo prevention flag
  let lastReportTime = 0;
  let lastSeekTime = 0;
  let hostSpeed = 1;
  let correcting = false;
  let lastDrift = 0;
  let onSyncOut = null; // Callback: (state) => void

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
  }

  function detach() {
    if (!video) return;
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('seeked', onSeeked);
    video.removeEventListener('ratechange', onRateChange);
    video.removeEventListener('timeupdate', onTimeUpdate);
    video = null;
    onSyncOut = null;
    correcting = false;
    lastDrift = 0;
  }

  function setHost(val) { isHost = val; }
  function getLastDrift() { return lastDrift; }
  function isAttached() { return video !== null; }

  function applyRemote(player) {
    if (!video || isHost) return;
    hostSpeed = (typeof player.speed === 'number' && isFinite(player.speed) && player.speed >= 0.25 && player.speed <= 4) ? player.speed : 1;

    // Apply pause/play
    // pause() fires 'pause' synchronously — safe to reset flag immediately
    // play() fires 'play' asynchronously — must reset flag after promise resolves
    if (player.paused && !video.paused) {
      isSyncing = true; video.pause(); isSyncing = false;
    } else if (!player.paused && video.paused) {
      isSyncing = true;
      video.play().then(() => { isSyncing = false; }).catch(() => { isSyncing = false; });
    }

    // Drift correction
    const drift = player.time - video.currentTime;
    lastDrift = drift;
    const now = Date.now();

    if (Math.abs(drift) > SOFT_DRIFT_MAX) {
      if (now - lastSeekTime > SEEK_COOLDOWN) {
        isSyncing = true;
        video.currentTime = player.time;
        lastSeekTime = now;
        // seeked event fires asynchronously; use one-shot listener to clear flag
        video.addEventListener('seeked', () => { isSyncing = false; }, { once: true });
        correcting = false;
        video.playbackRate = hostSpeed;
      }
    } else if (Math.abs(drift) > SOFT_DRIFT_MIN) {
      correcting = true;
      video.playbackRate = drift > 0 ? SOFT_RATE_FAST : SOFT_RATE_SLOW;
    } else if (correcting && Math.abs(drift) < SOFT_DRIFT_RESET) {
      correcting = false;
      video.playbackRate = hostSpeed;
    }
  }

  // --- Internal event handlers ---

  function onPlay() { if (!isSyncing && isHost) report({ action: 'play' }); }
  function onPause() { if (!isSyncing && isHost) report({ action: 'pause' }); }
  function onSeeked() { if (!isSyncing && isHost) report({ action: 'seek' }); }

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

  // --- Constants exposed for UI (sync indicator thresholds) ---
  return {
    attach, detach, setHost, applyRemote,
    getLastDrift, isAttached,
    SOFT_DRIFT_MIN, SOFT_DRIFT_MAX,
  };
})();
