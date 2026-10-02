import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadSyncRuntime() {
  const context = vm.createContext({
    console,
    Date,
    Number,
    Math,
    Promise,
    Set,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  for (const filename of ['runtime-clock.js', 'playback-timeline.js', 'stremio-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'extension', filename), 'utf8'), context, { filename });
  }
  vm.runInContext(`
    let __testNow = 0;
    let __nextTimer = 0;
    const __timers = new Map();
    WPRuntimeClock.configureForTests({
      now: () => __testNow,
      setTimeout: (callback) => { const id = ++__nextTimer; __timers.set(id, callback); return id; },
      clearTimeout: (id) => __timers.delete(id),
      setInterval: () => 0,
      clearInterval: () => {},
    });
  `, context);
  return {
    context,
    timeline: vm.runInContext('WPPlaybackTimeline', context),
    sync: vm.runInContext('WPSync', context),
    setNow(value) { vm.runInContext(`__testNow = ${Number(value)}`, context); },
    pendingTimers() { return vm.runInContext('__timers.size', context); },
  };
}

class FakeVideo {
  #currentTime = 0;
  #listeners = new Map();

  paused = true;
  playbackRate = 1;
  readyState = 4;
  autoSeeked = true;

  get currentTime() { return this.#currentTime; }
  set currentTime(value) {
    this.#currentTime = Number(value);
    if (this.autoSeeked) queueMicrotask(() => this.dispatch('seeked'));
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.#listeners.get(type) || [];
    entries.push({ listener, once: options?.once === true });
    this.#listeners.set(type, entries);
  }

  removeEventListener(type, listener) {
    this.#listeners.set(type, (this.#listeners.get(type) || []).filter((entry) => entry.listener !== listener));
  }

  dispatch(type) {
    const entries = [...(this.#listeners.get(type) || [])];
    for (const entry of entries) entry.listener({ type });
    this.#listeners.set(type, (this.#listeners.get(type) || []).filter((entry) => !entry.once));
  }

  async play() {
    this.paused = false;
    this.dispatch('play');
  }

  pause() {
    this.paused = true;
    this.dispatch('pause');
  }
}

function frame(overrides = {}) {
  return {
    paused: false,
    buffering: false,
    time: 1,
    speed: 1,
    timeline: {
      epoch: '11111111-1111-4111-8111-111111111111',
      sequence: 1,
      sampledAtServer: 1000,
    },
    ...overrides,
  };
}

test('playing frames extrapolate by their server-observed age', () => {
  const { timeline } = loadSyncRuntime();
  const target = timeline.resolveTarget(frame(), { localNow: 1700, clockOffset: 0 });
  assert.equal(target.time, 1.7);
  assert.equal(target.frameAgeMs, 700);
});

test('paused frames remain exact even when clocks differ', () => {
  const { timeline } = loadSyncRuntime();
  const target = timeline.resolveTarget(frame({ paused: true }), { localNow: 1500, clockOffset: 500 });
  assert.equal(target.time, 1);
  assert.equal(target.frameAgeMs, 0);
});

test('room projection may refresh an equal sequence but never accepts an older one', () => {
  const { timeline } = loadSyncRuntime();
  const current = frame({ timeline: { ...frame().timeline, sequence: 4 } });
  assert.equal(timeline.isNewerFrame(current, current), false);
  assert.equal(timeline.isNewerFrame(current, current, { allowSameSequence: true }), true);
  assert.equal(timeline.isNewerFrame(frame(), current, { allowSameSequence: true }), false);
});

test('a delayed initial play frame seeks before starting playback', async () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  runtime.setNow(1700);
  runtime.sync.attach(video, { isHost: false });
  runtime.sync.setClockOffset(0);

  assert.equal(runtime.sync.applyRemote(frame()), true);
  await Promise.resolve();

  assert.equal(video.paused, false);
  assert.ok(Math.abs(video.currentTime - 1.7) < 0.001);
});

test('duplicate sequence numbers cannot rewind an applied timeline', async () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  runtime.setNow(3000);
  runtime.sync.attach(video, { isHost: false });

  const first = frame({ paused: true, time: 5, timeline: { ...frame().timeline, sequence: 2, sampledAtServer: 3000 } });
  const duplicate = frame({ paused: true, time: 7, timeline: { ...frame().timeline, sequence: 2, sampledAtServer: 3000 } });
  assert.equal(runtime.sync.applyRemote(first), true);
  await Promise.resolve();
  assert.equal(runtime.sync.applyRemote(duplicate), false);
  assert.equal(video.currentTime, 5);
});

test('a newer play transition supersedes an immediately preceding catch-up seek', async () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  runtime.setNow(2000);
  runtime.sync.attach(video, { isHost: false });
  runtime.sync.setClockOffset(0);

  runtime.sync.applyRemote(frame({
    paused: true,
    time: 2,
    timeline: { ...frame().timeline, sequence: 1, sampledAtServer: 2000 },
  }));
  // No seeked event has completed yet when the next authoritative frame arrives.
  assert.equal(video.currentTime, 2);

  runtime.sync.applyRemote(frame({
    paused: false,
    time: 0,
    timeline: { ...frame().timeline, sequence: 2, sampledAtServer: 2000 },
  }));
  await Promise.resolve();

  assert.equal(video.paused, false);
  assert.equal(video.currentTime, 0);
});

test('newer pause and seek frames supersede a pending media seek immediately', () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  video.autoSeeked = false;
  runtime.sync.attach(video, { isHost: false });
  assert.equal(runtime.sync.applyRemote(frame({ time: 20 })), true);
  assert.equal(runtime.pendingTimers(), 1);
  assert.equal(runtime.sync.applyRemote(frame({ paused: true, time: 40, timeline: { ...frame().timeline, sequence: 2 } })), true);
  assert.equal(video.currentTime, 40);
  assert.equal(video.paused, true);
  assert.equal(runtime.pendingTimers(), 1, 'superseded seek timer was removed');
  video.dispatch('seeked');
  assert.equal(runtime.pendingTimers(), 0);
});

test('detaching cancels seek callbacks and restores the uncorrected playback rate', () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  video.autoSeeked = false;
  video.paused = false;
  runtime.sync.attach(video, { isHost: false });
  runtime.sync.applyRemote(frame({ time: 0 }));
  runtime.sync.applyRemote(frame({ time: 1, timeline: { ...frame().timeline, sequence: 2 } }));
  assert.ok(video.playbackRate > 1);
  runtime.sync.detach();
  assert.equal(video.playbackRate, 1);
  runtime.sync.attach(video, { isHost: false });
  runtime.sync.applyRemote(frame({ time: 20 }));
  assert.equal(runtime.pendingTimers(), 1);
  runtime.sync.detach();
  assert.equal(runtime.pendingTimers(), 0);
  const host = new FakeVideo();
  const reports = [];
  runtime.sync.attach(host, { isHost: true, onSync: (state) => reports.push(state) });
  video.dispatch('seeked');
  host.dispatch('play');
  assert.equal(reports.length, 1);
});

test('force synchronization cannot resurrect retired epochs or rewind sequences', async () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  runtime.sync.attach(video, { isHost: false });
  runtime.sync.applyRemote(frame({ paused: true, time: 3, timeline: { ...frame().timeline, sequence: 3 } }));
  await Promise.resolve();
  assert.equal(runtime.sync.applyRemote(frame({ paused: true }), { force: true }), false);
  runtime.sync.applyRemote(frame({ paused: true, time: 7, timeline: { ...frame().timeline, epoch: 'new-epoch', sequence: 0 } }));
  await Promise.resolve();
  assert.equal(runtime.sync.applyRemote(frame({ paused: true }), { force: true }), false);
  assert.equal(video.currentTime, 7);
});

test('a stale rejected frame does not poison the timeline ordering', () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  runtime.sync.attach(video, { isHost: false });
  runtime.sync.setClockOffset(0);
  runtime.setNow(20000);
  assert.equal(runtime.sync.applyRemote(frame({ timeline: { ...frame().timeline, sequence: 99 } })), false);
  assert.equal(runtime.sync.applyRemote(frame({ time: 9, timeline: { ...frame().timeline, sequence: 2, sampledAtServer: 20000 } })), true);
  assert.equal(video.currentTime, 9);
});

test('promotion to host restores authoritative speed and accepts local controls during a seek', () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  video.autoSeeked = false;
  const reports = [];
  runtime.sync.attach(video, { isHost: false, onSync: (state) => reports.push(state) });
  runtime.sync.applyRemote(frame({ paused: true, time: 8 }));
  runtime.sync.setHost(true);
  assert.equal(runtime.pendingTimers(), 0);
  video.dispatch('play');
  assert.equal(reports.length, 1);
  runtime.sync.setHost(false);
  assert.equal(runtime.sync.applyRemote(frame({ paused: true, time: 9 })), true);
  assert.equal(video.currentTime, 9);
});

test('clock offset never shifts an exact paused position', async () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  runtime.setNow(1500);
  runtime.sync.attach(video, { isHost: false });
  runtime.sync.setClockOffset(500);

  runtime.sync.applyRemote(frame({ paused: true }));
  await Promise.resolve();
  assert.equal(video.currentTime, 1);
});

test('frames from a retired epoch are rejected after a timeline reset', async () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  runtime.sync.attach(video, { isHost: false });
  runtime.sync.setClockOffset(0);

  runtime.setNow(1000);
  runtime.sync.applyRemote(frame({ paused: true }));
  await Promise.resolve();
  runtime.setNow(4000);
  runtime.sync.applyRemote(frame({
    paused: true,
    time: 2,
    timeline: {
      epoch: '22222222-2222-4222-8222-222222222222',
      sequence: 0,
      sampledAtServer: 4000,
    },
  }));
  await Promise.resolve();

  assert.equal(runtime.sync.applyRemote(frame({
    paused: true,
    time: 3,
    timeline: { ...frame().timeline, sequence: 2, sampledAtServer: 4000 },
  })), false);
  assert.equal(video.currentTime, 2);
});

test('host speed changes apply even when drift is already small', () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  video.paused = false;
  video.currentTime = 2;
  runtime.setNow(2000);
  runtime.sync.attach(video, { isHost: false });

  runtime.sync.applyRemote(frame({ time: 2, speed: 1.25, timeline: { ...frame().timeline, sampledAtServer: 2000 } }));
  assert.equal(video.playbackRate, 1.25);
});

test('host ignores ordinary playback echoes but follows explicit server authority', async () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  video.paused = false;
  const reports = [];
  runtime.sync.attach(video, { isHost: true, onSync: (state) => reports.push(state) });
  const paused = frame({ paused: true, time: 5 });
  assert.equal(runtime.sync.applyRemote(paused, { force: true }), false);
  assert.equal(video.paused, false);
  assert.equal(runtime.sync.applyRemote(paused, { authoritative: true }), true);
  await Promise.resolve();
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 5);
  assert.equal(reports.length, 0, 'server pause and seek must not echo as local controls');

  const resumed = frame({ time: 5, timeline: { ...frame().timeline, sequence: 2 } });
  assert.equal(runtime.sync.applyRemote(resumed, { authoritative: true }), true);
  await Promise.resolve();
  assert.equal(video.paused, false);
  assert.equal(reports.length, 0);
  assert.equal(runtime.sync.applyRemote(paused, { authoritative: true, force: true }), false);
  video.pause();
  assert.equal(reports.length, 1, 'the host retains normal controls after applying authority');
  assert.equal(reports[0].action, 'pause');
});

test('server-applied host controls suppress asynchronous media events without swallowing later user controls', async () => {
  const runtime = loadSyncRuntime();
  class AsyncVideo extends FakeVideo {
    pause() { this.paused = true; queueMicrotask(() => this.dispatch('pause')); }
    async play() { this.paused = false; queueMicrotask(() => this.dispatch('play')); }
  }
  const video = new AsyncVideo();
  video.paused = false;
  video.currentTime = 1;
  await Promise.resolve();
  const reports = [];
  runtime.sync.attach(video, { isHost: true, onSync: (state) => reports.push(state) });
  runtime.sync.applyRemote(frame({ paused: true, time: 1, speed: 1.25 }), { authoritative: true });
  video.dispatch('ratechange');
  await Promise.resolve();
  assert.equal(video.playbackRate, 1.25);
  assert.equal(reports.length, 0, 'pause events run after pause() returns in real browsers');
  runtime.sync.applyRemote(frame({ time: 1, speed: 1.25, timeline: { ...frame().timeline, sequence: 2 } }), { authoritative: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reports.length, 0);
  video.pause();
  await Promise.resolve();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].paused, true);
});

test('host rejects unstamped authority and does not publish mid-seek timeupdate', () => {
  const runtime = loadSyncRuntime();
  const video = new FakeVideo();
  video.autoSeeked = false;
  const reports = [];
  runtime.sync.attach(video, { isHost: true, onSync: (state) => reports.push(state) });
  assert.equal(runtime.sync.applyRemote({ paused: true, time: 4 }, { authoritative: true }), false);
  runtime.sync.applyRemote(frame({ paused: true, time: 4 }), { authoritative: true });
  runtime.setNow(1000);
  video.dispatch('timeupdate');
  assert.equal(reports.length, 0);
});
