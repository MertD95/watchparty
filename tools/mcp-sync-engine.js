// Run only through the configured headless Playwright MCP:
// browser_run_code_unsafe(filename=".../watchparty/tools/mcp-sync-engine.js").
// Requires page.__watchpartyAudit.media from the web multiplayer MCP fixture.
// This exercises real extension sync scripts + real media, NOT an installed
// extension's controller election, service worker, permissions, or overlay.
async (page) => {
  const media = page.__watchpartyAudit?.media;
  if (!media?.length) throw new Error('Run the multiplayer fixture first and retain page.__watchpartyAudit.media.');
  const extensionRoot = page.__watchpartySyncExtensionRoot || 'C:/Users/mertd/WatchParty/watchparty/extension';
  const origin = 'http://127.0.0.1:8080';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const results = [];
  const errors = [];
  const context = await page.context().browser().newContext();
  try {
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { await route.abort(); return; }
      if (url.pathname === '/__sync-engine.html') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Local sync-engine regression</title></head><body><video id="old" muted playsinline preload="auto" src="/__sync-engine.webm"></video><video id="next" muted playsinline preload="auto" src="/__sync-engine.webm"></video></body></html>' });
      } else if (url.pathname === '/__sync-engine.webm') {
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
        await route.fulfill({ status: range ? 206 : 200, contentType: 'video/webm',
          headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${media.length}` } : {}) },
          body: media.subarray(start, end + 1) });
      } else await route.fulfill({ status: 404, body: '' });
    });
    const testPage = await context.newPage();
    testPage.on('pageerror', error => errors.push(error.message));
    await testPage.goto(`${origin}/__sync-engine.html`);
    await testPage.waitForFunction(() => [...document.querySelectorAll('video')].every(v => v.readyState >= 3 && Number.isFinite(v.duration) && v.duration > 25), null, { timeout: 10000 });
    for (const filename of ['runtime-clock.js', 'playback-timeline.js', 'stremio-sync.js']) {
      await testPage.addScriptTag({ path: `${extensionRoot}/${filename}` });
    }
    await testPage.evaluate(() => {
      const timeouts = new Set();
      const intervals = new Set();
      window.__syncAudit = { timeouts, intervals, reports: [], seeked: 0 };
      document.querySelector('#old').addEventListener('seeked', () => window.__syncAudit.seeked++);
      // Track the engine's actual browser timers, without replacing the media
      // clock or synthesizing play/pause/seeked events.
      WPRuntimeClock.configureForTests({
        now: () => Date.now(),
        setTimeout: (callback, delay) => {
          const id = setTimeout(() => { timeouts.delete(id); callback(); }, delay);
          timeouts.add(id); return id;
        },
        clearTimeout: id => { timeouts.delete(id); clearTimeout(id); },
        setInterval: (callback, delay) => { const id = setInterval(callback, delay); intervals.add(id); return id; },
        clearInterval: id => { intervals.delete(id); clearInterval(id); },
      });
      WPSync.attach(document.querySelector('#old'), { isHost: false });
      WPSync.setClockOffset(0);
    });

    const rapid = await testPage.evaluate(() => {
      const v = document.querySelector('#old');
      const frame = (sequence, time) => ({ paused: true, buffering: false, time, speed: 1, timeline: { epoch: 'rapid', sequence, sampledAtServer: Date.now() } });
      const before = window.__syncAudit.seeked;
      const accepted = [WPSync.applyRemote(frame(1, 4))];
      const pendingBeforeNextFrame = v.seeking;
      accepted.push(WPSync.applyRemote(frame(2, 8)), WPSync.applyRemote(frame(3, 12)));
      return { accepted, pendingBeforeNextFrame, seekedDuringApply: window.__syncAudit.seeked - before, time: v.currentTime, timers: window.__syncAudit.timeouts.size };
    });
    assert(rapid.pendingBeforeNextFrame && rapid.seekedDuringApply === 0, 'Rapid frames did not arrive during a real pending seek');
    assert(rapid.accepted.every(Boolean) && Math.abs(rapid.time - 12) < 0.02 && rapid.timers === 1, `Pending seek dropped a newer frame: ${JSON.stringify(rapid)}`);
    await testPage.waitForFunction(() => !document.querySelector('#old').seeking && window.__syncAudit.timeouts.size === 0);
    results.push({ name: 'rapid paused seeks before seeked', latestTime: rapid.time, acceptedFrames: rapid.accepted.length });

    const ordering = await testPage.evaluate(() => {
      const frame = (epoch, sequence, time) => ({ paused: true, buffering: false, time, speed: 1, timeline: { epoch, sequence, sampledAtServer: Date.now() } });
      const oldSequence = WPSync.applyRemote(frame('rapid', 2, 1), { force: true });
      const newEpoch = WPSync.applyRemote(frame('new-content', 0, 6));
      const retiredEpoch = WPSync.applyRemote(frame('rapid', 99, 2), { force: true });
      return { oldSequence, newEpoch, retiredEpoch, time: document.querySelector('#old').currentTime };
    });
    assert(!ordering.oldSequence && ordering.newEpoch && !ordering.retiredEpoch && Math.abs(ordering.time - 6) < 0.02, `Forced sync accepted stale authority: ${JSON.stringify(ordering)}`);
    await testPage.waitForFunction(() => !document.querySelector('#old').seeking);
    results.push({ name: 'forced stale sequence and retired epoch rejected', finalTime: ordering.time });

    const detach = await testPage.evaluate(() => {
      const old = document.querySelector('#old');
      WPSync.applyRemote({ paused: true, buffering: false, time: 18, speed: 1, timeline: { epoch: 'new-content', sequence: 1, sampledAtServer: Date.now() } });
      const pendingBeforeDetach = old.seeking;
      WPSync.detach();
      const timersAfterDetach = window.__syncAudit.timeouts.size;
      WPSync.attach(document.querySelector('#next'), { isHost: true, onSync: state => window.__syncAudit.reports.push(state) });
      return { pendingBeforeDetach, timersAfterDetach };
    });
    assert(detach.pendingBeforeDetach && detach.timersAfterDetach === 0, 'Detach did not cancel pending seek timer');
    await testPage.waitForFunction(() => !document.querySelector('#old').seeking);
    const detachedReports = await testPage.evaluate(() => window.__syncAudit.reports.filter(r => r.action !== 'tick').length);
    assert(detachedReports === 0, 'Old media callbacks published through the newly attached host');
    await testPage.locator('#next').evaluate(v => v.play());
    await testPage.waitForFunction(() => window.__syncAudit.reports.some(r => r.action === 'play'));
    results.push({ name: 'detach pending seek and reattach host', canceledSeekTimers: true, newHostControlReported: true });

    await testPage.evaluate(() => {
      const v = document.querySelector('#next'); v.pause();
      WPSync.attach(v, { isHost: false }); WPSync.setClockOffset(0);
      WPSync.applyRemote({ paused: true, buffering: false, time: 3, speed: 1, timeline: { epoch: 'speed', sequence: 1, sampledAtServer: Date.now() } });
    });
    await testPage.waitForFunction(() => !document.querySelector('#next').seeking && document.querySelector('#next').readyState >= 3);
    await testPage.evaluate(() => WPSync.applyRemote({ paused: false, buffering: false, time: 3, speed: 1.25, timeline: { epoch: 'speed', sequence: 2, sampledAtServer: Date.now() } }));
    await testPage.waitForFunction(() => !document.querySelector('#next').paused && document.querySelector('#next').readyState >= 3 && Math.abs(document.querySelector('#next').playbackRate - 1.25) < 0.001);
    const speed = await testPage.evaluate(() => {
      const v = document.querySelector('#next');
      const previousRate = v.playbackRate;
      const accepted = WPSync.applyRemote({ paused: false, buffering: false, time: v.currentTime, speed: 0.75, timeline: { epoch: 'speed', sequence: 3, sampledAtServer: Date.now() } });
      return { accepted, previousRate, nextRate: v.playbackRate };
    });
    assert(speed.accepted && speed.previousRate === 1.25 && speed.nextRate === 0.75, `Speed transition failed: ${JSON.stringify(speed)}`);
    results.push({ name: 'playing speed transitions', rates: [speed.previousRate, speed.nextRate] });

    const transit = await testPage.evaluate(() => {
      const v = document.querySelector('#next'); v.pause();
      WPSync.attach(v, { isHost: false }); WPSync.setClockOffset(0);
      const sampledAtServer = Date.now() - 400;
      window.__syncAudit.transitSample = sampledAtServer;
      const accepted = WPSync.applyRemote({ paused: false, buffering: false, time: 5, speed: 1, timeline: { epoch: 'transit', sequence: 1, sampledAtServer } });
      return { accepted, appliedTime: v.currentTime, expected: 5 + (Date.now() - sampledAtServer) / 1000 };
    });
    assert(transit.accepted && Math.abs(transit.appliedTime - transit.expected) < 0.06 && transit.appliedTime >= 5.39, `Frame transit age not compensated: ${JSON.stringify(transit)}`);
    await testPage.waitForFunction(() => !document.querySelector('#next').paused && !document.querySelector('#next').seeking && document.querySelector('#next').readyState >= 3);
    await testPage.waitForTimeout(600);
    const catchUp = await testPage.evaluate(() => {
      const v = document.querySelector('#next');
      return { time: v.currentTime, expected: 5 + (Date.now() - window.__syncAudit.transitSample) / 1000, paused: v.paused };
    });
    assert(!catchUp.paused && catchUp.time > transit.appliedTime + 0.3 && Math.abs(catchUp.time - catchUp.expected) < 0.35, `Playback did not catch up after delayed frame: ${JSON.stringify(catchUp)}`);
    results.push({ name: '400ms-old playing frame catches up', initialTarget: transit.appliedTime, driftSeconds: Math.abs(catchUp.time - catchUp.expected) });

    const cleanup = await testPage.evaluate(() => {
      WPSync.detach(); document.querySelectorAll('video').forEach(v => v.pause());
      return { timeouts: window.__syncAudit.timeouts.size, intervals: window.__syncAudit.intervals.size };
    });
    assert(cleanup.timeouts === 0 && cleanup.intervals === 0, `Sync engine timers leaked: ${JSON.stringify(cleanup)}`);
    assert(errors.length === 0, `Browser exceptions: ${errors.join('; ')}`);
    return { suite: 'real extension sync scripts and media (not installed-extension lifecycle)', passed: results.length, results, errors };
  } finally {
    await context.close();
  }
}
