import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SYNC_PATH = path.resolve('extension', 'stremio-sync.js');

let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed++;
  } else {
    console.error(`  FAIL ${label}`);
    failed++;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadSyncEngine() {
  const source = `${fs.readFileSync(SYNC_PATH, 'utf8')}\n;globalThis.__WPSync = WPSync;`;
  const context = vm.createContext({
    console,
    setInterval,
    setTimeout,
    clearInterval,
    clearTimeout,
    Date,
  });
  new vm.Script(source, { filename: SYNC_PATH }).runInContext(context);
  return context.__WPSync;
}

class FakeVideo {
  constructor({ currentTime = 0, paused = true, readyState = 4, playbackRate = 1 } = {}) {
    this.currentTime = currentTime;
    this.paused = paused;
    this.readyState = readyState;
    this.playbackRate = playbackRate;
    this.volume = 0.42;
    this.muted = false;
    this.audioTrack = 1;
    this.subtitleTrack = -1;
    this.listeners = new Map();
  }

  addEventListener(type, handler, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({ handler, once: !!options.once });
    this.listeners.set(type, entries);
  }

  removeEventListener(type, handler) {
    const entries = this.listeners.get(type) || [];
    this.listeners.set(type, entries.filter((entry) => entry.handler !== handler));
  }

  dispatch(type) {
    const entries = [...(this.listeners.get(type) || [])];
    for (const entry of entries) {
      entry.handler();
      if (entry.once) {
        this.removeEventListener(type, entry.handler);
      }
    }
  }

  play() {
    this.paused = false;
    this.dispatch('play');
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatch('pause');
  }
}

async function testHostReportsPlaybackChanges() {
  console.log('\n-- Host reports playback changes --');
  const WPSync = loadSyncEngine();
  const events = [];
  const video = new FakeVideo({ paused: true, currentTime: 0, playbackRate: 1 });

  WPSync.attach(video, {
    isHost: true,
    onSync: (state) => events.push(state),
  });

  await video.play();
  video.currentTime = 42;
  video.dispatch('seeked');
  video.playbackRate = 1.5;
  video.dispatch('ratechange');
  await sleep(550);
  video.currentTime = 43;
  video.dispatch('timeupdate');
  video.pause();
  await sleep(0);

  const actions = events.map((event) => event.action);
  ok(actions.includes('play'), 'host emits a play action');
  ok(actions.includes('seek'), 'host emits a seek action');
  ok(actions.includes('speed'), 'host emits a speed action');
  ok(actions.includes('tick'), 'host emits periodic tick updates');
  ok(actions.includes('pause'), 'host emits a pause action');

  WPSync.detach();
}

async function testPeerHardSeekAndPlayPause() {
  console.log('\n-- Peer applies remote seek and play or pause --');
  const WPSync = loadSyncEngine();
  const video = new FakeVideo({ paused: true, currentTime: 0, readyState: 4, playbackRate: 1 });

  WPSync.attach(video, { isHost: false });
  WPSync.applyRemote({ paused: false, buffering: false, time: 10, speed: 1 });
  await sleep(0);

  ok(video.paused === false, 'remote play resumes the peer video');
  ok(video.currentTime === 10, 'large drift triggers a hard seek to the host time');
  ok(video.playbackRate === 1, 'hard seek resets playbackRate to the host speed');

  video.dispatch('seeked');
  WPSync.applyRemote({ paused: true, buffering: false, time: 10, speed: 1 });
  ok(video.paused === true, 'remote pause pauses the peer video');

  WPSync.detach();
}

async function testHostPausedHeartbeat() {
  console.log('\n-- Host reasserts pause while paused --');
  const WPSync = loadSyncEngine();
  const events = [];
  const video = new FakeVideo({ paused: true, currentTime: 21, playbackRate: 1 });

  WPSync.attach(video, {
    isHost: true,
    onSync: (state) => events.push(state),
  });

  await sleep(1700);

  ok(events.some((event) => event.action === 'tick' && event.paused === true), 'paused host emits heartbeat syncs');

  WPSync.detach();
}

async function testPeerSoftCorrectionAndExit() {
  console.log('\n-- Peer soft-corrects drift and exits cleanly --');
  const WPSync = loadSyncEngine();
  const video = new FakeVideo({ paused: false, currentTime: 8.5, readyState: 4, playbackRate: 1 });

  WPSync.attach(video, { isHost: false });
  WPSync.applyRemote({ paused: false, buffering: false, time: 10, speed: 1 });

  ok(video.playbackRate > 1 && video.playbackRate <= 1.1, `moderate positive drift speeds up playback (${video.playbackRate.toFixed(3)}x)`);

  video.currentTime = 9.98;
  WPSync.applyRemote({ paused: false, buffering: false, time: 10, speed: 1 });
  ok(Math.abs(video.playbackRate - 1) < 0.0001, 'playbackRate returns to the host speed once drift is tiny');

  WPSync.detach();
}

async function testPeerPausedDriftSeeksImmediately() {
  console.log('\n-- Peer seeks immediately when paused drift is meaningful --');
  const WPSync = loadSyncEngine();
  const video = new FakeVideo({ paused: true, currentTime: 0.1, readyState: 4, playbackRate: 1 });

  WPSync.attach(video, { isHost: false });
  WPSync.applyRemote({ paused: true, buffering: false, time: 2.8, speed: 1 });

  ok(Math.abs(video.currentTime - 2.8) < 0.0001, 'paused peer hard-seeks to the paused host position');

  WPSync.detach();
}

async function testInvalidRemoteStateIsIgnored() {
  console.log('\n-- Invalid remote state is ignored --');
  const WPSync = loadSyncEngine();
  const video = new FakeVideo({ paused: false, currentTime: 5, readyState: 4, playbackRate: 1 });

  WPSync.attach(video, { isHost: false });
  WPSync.applyRemote({ paused: false, buffering: false, time: -1, speed: 1 });
  ok(video.currentTime === 5, 'negative remote time does not mutate the peer video');

  WPSync.applyRemote({ paused: false, buffering: true, time: 20, speed: 1 });
  ok(video.currentTime === 5, 'buffering remote state skips drift correction');

  WPSync.detach();
}

async function testRemotePlaybackKeepsLocalOnlyControlsUntouched() {
  console.log('\n-- Remote playback leaves local-only controls untouched --');
  const WPSync = loadSyncEngine();
  const video = new FakeVideo({ paused: false, currentTime: 5, readyState: 4, playbackRate: 1 });

  WPSync.attach(video, { isHost: false });
  WPSync.applyRemote({
    paused: false,
    buffering: false,
    time: 5.5,
    speed: 1,
    volume: 0,
    muted: true,
    audioTrack: 9,
    subtitleTrack: 2,
  });

  ok(video.volume === 0.42, 'remote sync does not change local volume');
  ok(video.muted === false, 'remote sync does not change local mute state');
  ok(video.audioTrack === 1, 'remote sync does not change local audio track');
  ok(video.subtitleTrack === -1, 'remote sync does not change local subtitle track');

  WPSync.detach();
}

async function testClockOffsetAffectsSeekTarget() {
  console.log('\n-- Clock offset contributes to drift correction --');
  const WPSync = loadSyncEngine();
  const video = new FakeVideo({ paused: false, currentTime: 0, readyState: 4, playbackRate: 1 });

  WPSync.attach(video, { isHost: false });
  WPSync.setClockOffset(1000);
  WPSync.applyRemote({ paused: false, buffering: false, time: 4, speed: 1 });

  ok(video.currentTime === 5, 'remote hard seek includes the one-second clock offset');

  WPSync.detach();
}

async function main() {
  console.log('WatchParty Sync Engine Tests');
  console.log('============================');

  const tests = [
    testHostReportsPlaybackChanges,
    testHostPausedHeartbeat,
    testPeerHardSeekAndPlayPause,
    testPeerSoftCorrectionAndExit,
    testPeerPausedDriftSeeksImmediately,
    testInvalidRemoteStateIsIgnored,
    testRemotePlaybackKeepsLocalOnlyControlsUntouched,
    testClockOffsetAffectsSeekTarget,
  ];

  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      console.error(`  FAIL ${error.message}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
