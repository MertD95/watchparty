// WatchParty playback timeline helpers.
// Server-owned timeline metadata lets peers distinguish wall-clock skew from
// actual frame age and reject duplicate/out-of-order playback frames.

const WPPlaybackTimeline = (() => {
  'use strict';

  const MAX_APPLICABLE_FRAME_AGE_MS = 10_000;

  function normalizeTimeline(player) {
    const timeline = player?.timeline;
    if (!timeline || typeof timeline !== 'object') return null;
    if (typeof timeline.epoch !== 'string' || !timeline.epoch) return null;
    if (!Number.isSafeInteger(timeline.sequence) || timeline.sequence < 0) return null;
    if (!Number.isFinite(timeline.sampledAtServer) || timeline.sampledAtServer < 0) return null;
    return {
      epoch: timeline.epoch,
      sequence: timeline.sequence,
      sampledAtServer: timeline.sampledAtServer,
    };
  }

  function isNewerFrame(nextPlayer, currentPlayer, options = {}) {
    const next = normalizeTimeline(nextPlayer);
    const current = normalizeTimeline(currentPlayer);
    if (!next || !current || next.epoch !== current.epoch) return true;
    return next.sequence > current.sequence || (options.allowSameSequence === true && next.sequence === current.sequence);
  }

  function resolveTarget(player, options = {}) {
    const baseTime = Number.isFinite(player?.time) ? Math.max(0, player.time) : 0;
    const speed = Number.isFinite(player?.speed) ? Math.max(0.25, Math.min(4, player.speed)) : 1;
    const timeline = normalizeTimeline(player);
    if (!timeline || player?.paused === true || player?.buffering === true) {
      return { time: baseTime, frameAgeMs: 0, stale: false };
    }

    const localNow = Number.isFinite(options.localNow) ? options.localNow : Date.now();
    const clockOffset = Number.isFinite(options.clockOffset) ? options.clockOffset : 0;
    const serverNow = localNow + clockOffset;
    const frameAgeMs = Math.max(0, serverNow - timeline.sampledAtServer);
    if (frameAgeMs > MAX_APPLICABLE_FRAME_AGE_MS) {
      return { time: baseTime, frameAgeMs, stale: true };
    }
    return {
      time: baseTime + (frameAgeMs / 1000) * speed,
      frameAgeMs,
      stale: false,
    };
  }

  return {
    MAX_APPLICABLE_FRAME_AGE_MS,
    normalizeTimeline,
    isNewerFrame,
    resolveTarget,
  };
})();
