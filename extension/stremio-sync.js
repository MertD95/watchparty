// WatchParty sync engine.
// Hooks into a <video> element and applies server-stamped playback frames.

const WPSync = (() => {
  'use strict';

  const SOFT_DRIFT_ENTER = 0.35;
  const SOFT_DRIFT_EXIT = 0.05;
  const SOFT_DRIFT_MAX = 3.0;
  const PAUSED_SEEK_THRESHOLD = 0.15;
  const PLAY_TRANSITION_SEEK_THRESHOLD = 0.15;
  const CORRECTION_GAIN = 0.03;
  const CORRECTION_MAX = 0.10;
  const SYNC_REPORT_INTERVAL = 500;
  const PAUSED_HEARTBEAT_INTERVAL = 1500;

  let video = null;
  let isHost = false;
  let isSyncing = false;
  let seekInProgress = false;
  let cancelPendingSeek = null;
  let pendingPlay = null;
  let remotePlayEventPending = false;
  let remotePauseEventPending = false;
  let remoteRatePending = null;
  let lastReportTime = 0;
  let hostSpeed = 1;
  let correcting = false;
  let lastDrift = 0;
  let clockOffset = 0;
  let clockSynchronized = false;
  let lastRemoteEffectivePaused = null;
  let lastTimeline = null;
  let retiredTimelineEpochs = new Set();
  let onSyncOut = null;
  let pausedHeartbeat = null;

  function normalizeRemotePlayer(player) {
    if (!player || typeof player !== 'object') return null;
    if (typeof player.time !== 'number' || !Number.isFinite(player.time) || player.time < 0) return null;
    if (typeof player.paused !== 'boolean') return null;
    return {
      paused: player.paused,
      buffering: player.buffering ?? false,
      time: player.time,
      speed: (typeof player.speed === 'number' && Number.isFinite(player.speed) && player.speed >= 0.25 && player.speed <= 4)
        ? player.speed
        : 1,
      timeline: WPPlaybackTimeline.normalizeTimeline(player),
    };
  }

  function resetRemoteAuthority() {
    lastRemoteEffectivePaused = null;
    lastTimeline = null;
    retiredTimelineEpochs = new Set();
  }

  function acceptRemoteTimeline(timeline, force = false) {
    if (!timeline) return true;
    if (retiredTimelineEpochs.has(timeline.epoch)) return false;
    if (lastTimeline?.epoch === timeline.epoch && (
      timeline.sequence < lastTimeline.sequence || (!force && timeline.sequence === lastTimeline.sequence)
    )) return false;
    if (lastTimeline && lastTimeline.epoch !== timeline.epoch) {
      retiredTimelineEpochs.add(lastTimeline.epoch);
      if (retiredTimelineEpochs.size > 8) {
        retiredTimelineEpochs.delete(retiredTimelineEpochs.values().next().value);
      }
    }
    lastTimeline = timeline;
    return true;
  }

  function attach(videoEl, options) {
    detach();
    video = videoEl;
    isHost = options.isHost || false;
    hostSpeed = video.playbackRate || 1;
    lastReportTime = 0;
    onSyncOut = options.onSync || null;

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('ratechange', onRateChange);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('waiting', onBufferStateChange);
    video.addEventListener('stalled', onBufferStateChange);
    video.addEventListener('playing', onBufferStateChange);
    video.addEventListener('canplay', onBufferStateChange);
    restartPausedHeartbeat();
  }

  function detach() {
    cancelPendingSeek?.();
    pendingPlay = null;
    remotePlayEventPending = false;
    remotePauseEventPending = false;
    remoteRatePending = null;
    if (video) {
      if (correcting) video.playbackRate = hostSpeed;
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('ratechange', onRateChange);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('waiting', onBufferStateChange);
      video.removeEventListener('stalled', onBufferStateChange);
      video.removeEventListener('playing', onBufferStateChange);
      video.removeEventListener('canplay', onBufferStateChange);
    }
    video = null;
    onSyncOut = null;
    correcting = false;
    seekInProgress = false;
    isSyncing = false;
    lastDrift = 0;
    resetRemoteAuthority();
    stopPausedHeartbeat();
  }

  function setHost(value) {
    const nextHost = value === true;
    if (isHost !== nextHost) {
      cancelPendingSeek?.();
      pendingPlay = null;
      remotePlayEventPending = false;
      remotePauseEventPending = false;
      remoteRatePending = null;
      isSyncing = false;
      if (correcting) setPlaybackRate(hostSpeed);
      correcting = false;
      resetRemoteAuthority();
    }
    isHost = nextHost;
    restartPausedHeartbeat();
  }

  function getLastDrift() { return lastDrift; }
  function isAttached() { return video !== null; }
  function setClockOffset(offset) {
    if (!Number.isFinite(offset)) return;
    clockOffset = offset;
    clockSynchronized = true;
  }

  function setPlaybackRate(rate) {
    if (!video || Math.abs(video.playbackRate - rate) < 0.001) return;
    const nextRate = Math.max(0.25, Math.min(4, rate));
    if (isHost) remoteRatePending = nextRate;
    video.playbackRate = nextRate;
  }

  function playPeer() {
    if (!video || !video.paused) return;
    const request = {};
    pendingPlay = request;
    isSyncing = true;
    remotePlayEventPending = true;
    video.play()
      .then(() => {
        if (pendingPlay !== request) return;
        pendingPlay = null;
        isSyncing = seekInProgress;
      })
      .catch((error) => {
        if (pendingPlay !== request) return;
        pendingPlay = null;
        remotePlayEventPending = false;
        isSyncing = seekInProgress;
        if (error?.name !== 'AbortError') console.warn('[WPSync] play() failed:', error?.message || error);
      });
  }

  function pausePeer() {
    if (!video || video.paused) return;
    isSyncing = true;
    remotePauseEventPending = true;
    video.pause();
    isSyncing = seekInProgress || pendingPlay !== null;
  }

  function hardSeek(targetTime) {
    if (!video) return false;
    cancelPendingSeek?.();
    const targetVideo = video;
    seekInProgress = true;
    isSyncing = true;
    let timeout = null;
    const completeSeek = () => {
      if (cancelPendingSeek !== completeSeek) return;
      targetVideo.removeEventListener('seeked', completeSeek);
      if (timeout !== null) WPRuntimeClock.clearTimeout(timeout);
      cancelPendingSeek = null;
      seekInProgress = false;
      isSyncing = pendingPlay !== null;
    };
    cancelPendingSeek = completeSeek;
    targetVideo.addEventListener('seeked', completeSeek);
    timeout = WPRuntimeClock.setTimeout(completeSeek, 3000);
    try {
      targetVideo.currentTime = Math.max(0, targetTime);
    } catch {
      completeSeek();
      return false;
    }
    correcting = false;
    setPlaybackRate(hostSpeed);
    return true;
  }

  function applyRemote(player, options = {}) {
    if (!video || (isHost && options.authoritative !== true)) return false;
    const remote = normalizeRemotePlayer(player);
    if (!remote) return false;
    if (isHost && !remote.timeline) return false;

    const target = clockSynchronized
      ? WPPlaybackTimeline.resolveTarget(player, {
          localNow: WPRuntimeClock.now(),
          clockOffset,
        })
      : { time: remote.time, frameAgeMs: 0, stale: false };
    if (target.stale) return false;
    if (!acceptRemoteTimeline(remote.timeline, options.force === true)) return false;

    const previousHostSpeed = hostSpeed;
    hostSpeed = remote.speed;
    const peerBuffering = video.readyState < 3;
    const effectivePaused = remote.paused || remote.buffering;
    const playTransition = lastRemoteEffectivePaused !== false && !effectivePaused;
    lastRemoteEffectivePaused = effectivePaused;

    const drift = target.time - video.currentTime;
    lastDrift = drift;
    const shouldHardSeek = (
      (effectivePaused && Math.abs(drift) > PAUSED_SEEK_THRESHOLD)
      || (playTransition && Math.abs(drift) > PLAY_TRANSITION_SEEK_THRESHOLD)
      || Math.abs(drift) > SOFT_DRIFT_MAX
      || (isHost && Math.abs(drift) > PLAY_TRANSITION_SEEK_THRESHOLD)
    );

    const didHardSeek = shouldHardSeek && hardSeek(target.time);

    if (effectivePaused) pausePeer();
    else playPeer();

    if (isHost || effectivePaused) setPlaybackRate(hostSpeed);
    if (isHost) return true;
    if (effectivePaused || peerBuffering || didHardSeek) return true;

    if (!correcting && Math.abs(drift) > SOFT_DRIFT_ENTER) {
      correcting = true;
    } else if (correcting && Math.abs(drift) <= SOFT_DRIFT_EXIT) {
      correcting = false;
    }

    if (correcting) {
      const correction = Math.max(-CORRECTION_MAX, Math.min(CORRECTION_MAX, drift * CORRECTION_GAIN));
      setPlaybackRate(hostSpeed + correction);
    } else if (previousHostSpeed !== hostSpeed || Math.abs(video.playbackRate - hostSpeed) >= 0.001) {
      setPlaybackRate(hostSpeed);
    }
    return true;
  }

  function onPlay() {
    remotePauseEventPending = false;
    if (remotePlayEventPending) {
      remotePlayEventPending = false;
      if (video && !video.paused) return;
    }
    if (!isSyncing && isHost) report({ action: 'play' });
  }
  function onPause() {
    remotePlayEventPending = false;
    if (remotePauseEventPending) {
      remotePauseEventPending = false;
      if (video?.paused) return;
    }
    if (!isSyncing && isHost) report({ action: 'pause' });
  }
  function onSeeked() { if (!isSyncing && isHost) report({ action: 'seek' }); }
  function onBufferStateChange() { if (!isSyncing && isHost) report({ action: 'buffer' }); }

  function onRateChange() {
    if (remoteRatePending !== null) {
      const expectedRate = remoteRatePending;
      remoteRatePending = null;
      if (video && Math.abs(video.playbackRate - expectedRate) < 0.001) return;
    }
    if (isSyncing || !isHost || correcting) return;
    hostSpeed = video.playbackRate;
    report({ action: 'speed' });
  }

  function onTimeUpdate() {
    if (!isHost || isSyncing) return;
    const now = WPRuntimeClock.now();
    if (now - lastReportTime < SYNC_REPORT_INTERVAL) return;
    lastReportTime = now;
    report({ action: 'tick' });
  }

  function restartPausedHeartbeat() {
    stopPausedHeartbeat();
    if (!video || !isHost) return;
    pausedHeartbeat = WPRuntimeClock.setInterval(() => {
      if (!video || !isHost || isSyncing || !video.paused) return;
      const now = WPRuntimeClock.now();
      if (now - lastReportTime < PAUSED_HEARTBEAT_INTERVAL - 50) return;
      lastReportTime = now;
      report({ action: 'tick' });
    }, PAUSED_HEARTBEAT_INTERVAL);
  }

  function stopPausedHeartbeat() {
    if (!pausedHeartbeat) return;
    WPRuntimeClock.clearInterval(pausedHeartbeat);
    pausedHeartbeat = null;
  }

  function report(extra) {
    if (!video || !onSyncOut) return;
    const now = WPRuntimeClock.now();
    onSyncOut({
      ...extra,
      paused: video.paused,
      time: video.currentTime,
      speed: correcting ? hostSpeed : video.playbackRate,
      buffering: video.readyState < 3,
      ...(clockSynchronized ? { sampledAtServer: now + clockOffset } : {}),
    });
  }

  function resetCorrection() {
    cancelPendingSeek?.();
    pendingPlay = null;
    remotePlayEventPending = false;
    remotePauseEventPending = false;
    remoteRatePending = null;
    correcting = false;
    seekInProgress = false;
    isSyncing = false;
    clockOffset = 0;
    clockSynchronized = false;
    resetRemoteAuthority();
    if (video && !isHost) setPlaybackRate(hostSpeed);
  }

  return {
    attach, detach, setHost, applyRemote,
    getLastDrift, isAttached, setClockOffset, resetCorrection,
    SOFT_DRIFT_ENTER, SOFT_DRIFT_MAX,
  };
})();
