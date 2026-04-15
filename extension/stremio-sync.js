// WatchParty — Sync Engine
// Hooks into a <video> element and synchronizes playback via events from background.js.
// Implements: soft drift correction (playbackRate), hard seek, echo prevention.

const WPSync = (() => {
  'use strict';

  // --- Config ---
  const SOFT_DRIFT_ENTER = 0.35;    // Enter soft correction above 350ms (hysteresis: enter > exit)
  const SOFT_DRIFT_EXIT = 0.05;     // Exit soft correction below 50ms
  const SOFT_DRIFT_MAX = 3.0;       // Hard seek above 3s
  const CORRECTION_GAIN = 0.03;     // Proportional gain: 3% speed adjustment per second of drift
  const CORRECTION_MAX = 0.10;      // Clamp at ±10% speed (0.9x–1.1x) to stay imperceptible
  const SYNC_REPORT_INTERVAL = 500; // Report state every 500ms
  const SEEK_COOLDOWN = 2000;       // Don't re-seek within 2s (was 1.5s — too tight for slow connections)

  let video = null;
  let isHost = false;
  let isSyncing = false; // Echo prevention flag
  let seekInProgress = false; // Separate flag for hard-seek race condition prevention
  let lastReportTime = 0;
  let lastSeekTime = 0;
  let hostSpeed = 1;
  let correcting = false;
  let lastDrift = 0;
  let clockOffset = 0; // ms offset from Cristian's algorithm
  let lastRemoteSeekTime = 0; // Prevent seek cascades: ignore remote seeks within cooldown of a local seek
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
    seekInProgress = false;
    isSyncing = false;
    lastDrift = 0;
    lastRemoteSeekTime = 0;
  }

  function setHost(val) { isHost = val; }
  function getLastDrift() { return lastDrift; }
  function isAttached() { return video !== null; }
  function setClockOffset(offset) { clockOffset = offset; }

  function applyRemote(player) {
    if (!video || isHost) return;
    // Don't apply corrections while a hard seek is in-flight
    if (seekInProgress) return;
    // Validate player state — reject NaN/Infinity/negative time
    if (typeof player.time !== 'number' || !isFinite(player.time) || player.time < 0) return;
    if (typeof player.paused !== 'boolean') return;

    hostSpeed = (typeof player.speed === 'number' && isFinite(player.speed) && player.speed >= 0.25 && player.speed <= 4) ? player.speed : 1;

    // Skip drift correction if either side is buffering
    const peerBuffering = video.readyState < 3;
    const hostBuffering = player.buffering ?? false;

    // Apply pause/play
    // pause() fires 'pause' synchronously — safe to reset flag immediately
    // play() fires 'play' asynchronously — must reset flag after promise resolves
    if (player.paused && !video.paused) {
      isSyncing = true; video.pause(); isSyncing = false;
    } else if (!player.paused && video.paused) {
      isSyncing = true;
      video.play().then(() => { isSyncing = false; }).catch((e) => { isSyncing = false; if (e.name !== 'AbortError') console.warn('[WPSync] play() failed:', e.message); });
    }

    // Drift correction — compensate for network latency using clockOffset
    // clockOffset is (serverTime - clientTime - rtt/2) from Cristian's algorithm.
    // It represents how far the server clock is ahead of ours, already adjusted for one-way latency.
    // Convert ms to seconds (no halving — the offset is already one-way).
    const latencyCompensation = clockOffset / 1000;
    const drift = (player.time + latencyCompensation) - video.currentTime;
    lastDrift = drift;
    const now = Date.now();

    // Don't correct drift while either side is buffering — causes cascading seeks
    if (peerBuffering || hostBuffering) return;

    if (Math.abs(drift) > SOFT_DRIFT_MAX) {
      if (now - lastSeekTime > SEEK_COOLDOWN && now - lastRemoteSeekTime > SEEK_COOLDOWN) {
        seekInProgress = true;
        isSyncing = true;
        video.currentTime = player.time + latencyCompensation;
        lastSeekTime = now;
        lastRemoteSeekTime = now;
        // seeked event fires asynchronously; clear both flags when done
        video.addEventListener('seeked', () => {
          isSyncing = false;
          seekInProgress = false;
        }, { once: true });
        // Safety: if seeked never fires (e.g., video element destroyed), clear flags after timeout
        setTimeout(() => {
          if (seekInProgress) { seekInProgress = false; isSyncing = false; }
        }, 3000);
        correcting = false;
        video.playbackRate = hostSpeed;
      }
    } else if (!correcting && Math.abs(drift) > SOFT_DRIFT_ENTER) {
      // Hysteresis: only ENTER correction when drift exceeds the higher threshold
      correcting = true;
      // Proportional: correction strength scales with drift magnitude
      // 0.5s drift → 1.5% adjustment, 2s drift → 6%, 3s drift → 9% (clamped at 10%)
      const correction = Math.max(-CORRECTION_MAX, Math.min(CORRECTION_MAX, drift * CORRECTION_GAIN));
      video.playbackRate = hostSpeed + correction;
    } else if (correcting && Math.abs(drift) > SOFT_DRIFT_EXIT) {
      // Continue correcting — proportional rate tracks drift magnitude
      const correction = Math.max(-CORRECTION_MAX, Math.min(CORRECTION_MAX, drift * CORRECTION_GAIN));
      video.playbackRate = hostSpeed + correction;
    } else if (correcting && Math.abs(drift) <= SOFT_DRIFT_EXIT) {
      // Hysteresis: only EXIT correction when drift drops below the lower threshold
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

  // Reset correction state (called on WS reconnect to avoid lingering playbackRate)
  function resetCorrection() {
    correcting = false;
    seekInProgress = false;
    if (video && !isHost) video.playbackRate = hostSpeed;
  }

  // --- Constants exposed for UI (sync indicator thresholds) ---
  return {
    attach, detach, setHost, applyRemote,
    getLastDrift, isAttached, setClockOffset, resetCorrection,
    SOFT_DRIFT_ENTER, SOFT_DRIFT_MAX,
  };
})();
