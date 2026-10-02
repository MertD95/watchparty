// Run this function through the configured Playwright MCP browser_run_code_unsafe
// filename option. Every browser is launched by that MCP, headless, with a new
// temporary profile; no personal profiles or debugging ports are used.
// Requires memory-backed development watchparty-server on 127.0.0.1:8181.
// Repeated calls advance phases. No standalone watchparty-client is involved.
// After inspecting the complete result, set page.__installedExtensionAudit.phase
// to 'cleanup' and call again to leave rooms and close only these test profiles.
async (page) => {
  const extensionPath = 'C:/Users/mertd/WatchParty/watchparty/extension';
  const a = page.__installedExtensionAudit ||= { profiles: [], results: [], errors: [] };
  a.phase ||= 'fixture';
  const assert = (condition, label) => { if (!condition) throw new Error(label); };
  const result = (name, data = {}) => { const value = { name, ...data }; a.results.push(value); return value; };
  const worker = profile => profile.context.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${profile.id}/`));
  const read = async profile => {
    const background = worker(profile);
    if (!background) throw new Error(`${profile.label}: extension service worker is not attached`);
    const state = await background.evaluate(async () => {
      const local = await chrome.storage.local.get(['wpSessionId', 'wpUsername', 'wpBackendMode']);
      const session = await chrome.storage.session.get(['wpControllerTab', 'wpActiveVideoTab', 'wpRoomState', 'wpWsConnected', 'wpUserId']);
      return { ...local, ...session };
    });
    const video = profile.main && !profile.main.isClosed() ? await profile.main.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { time: v.currentTime, paused: v.paused, rate: v.playbackRate, duration: v.duration, ready: v.readyState } : null;
    }) : null;
    return { ...state, video };
  };
  const poll = async (test, label, timeout = 18000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await test(); if (value) return value;
      await page.waitForTimeout(150);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const server = async () => (await page.request.get('http://127.0.0.1:8181/__manual/state')).json();
  const roomReady = count => poll(async () => {
    const state = await server(); const room = state.rooms.find(r => r.id === a.roomId);
    return room?.users.length === count && state.websocket.activeClients === count && state.websocket.activeRoomSubscriptions === 1 ? room : false;
  }, `${count} independent installed-extension participants`);

  if (a.phase === 'fixture') {
    // Encode real VP8 frames, then stretch the Matroska time scale to obtain a
    // ~96-second seekable clip without downloading third-party content.
    const bytes = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const draw = canvas.getContext('2d'); const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = []; recorder.ondataavailable = e => chunks.push(e.data);
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      let frame = 0;
      const paint = () => { draw.fillStyle = '#18364c'; draw.fillRect(0, 0, 320, 180); draw.fillStyle = '#ffffff'; draw.font = '24px sans-serif'; draw.fillText(`Local test ${frame++}`, 30, 95); };
      paint(); recorder.start(); const timer = setInterval(paint, 100);
      await new Promise(resolve => setTimeout(resolve, 12000));
      recorder.stop(); clearInterval(timer); await stopped; stream.getTracks().forEach(track => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    });
    let media = Buffer.from(bytes);
    const scale = media.indexOf(Buffer.from([0x2a, 0xd7, 0xb1, 0x83]));
    assert(scale >= 0, 'Expected WebM time scale missing'); media.writeUIntBE(8000000, scale + 4, 3);
    const info = media.indexOf(Buffer.from([0x15, 0x49, 0xa9, 0x66]));
    assert(info >= 0, 'WebM Segment Info missing');
    let width = 1; while (!(media[info + 4] & (0x80 >> (width - 1)))) width++;
    let size = media[info + 4] & (0xff >> width);
    for (let i = 1; i < width; i++) size = size * 256 + media[info + 4 + i];
    const duration = Buffer.alloc(11); duration[0] = 0x44; duration[1] = 0x89; duration[2] = 0x88; duration.writeDoubleBE(12000, 3);
    const length = Buffer.alloc(width); let remaining = size + duration.length;
    for (let i = width - 1; i >= 0; i--) { length[i] = remaining & 255; remaining = Math.floor(remaining / 256); }
    assert(remaining === 0 && !(length[0] & (0xff << (8 - width))), 'WebM size overflow'); length[0] |= 0x80 >> (width - 1);
    const end = info + 4 + width + size;
    media = Buffer.concat([media.subarray(0, info + 4), length, media.subarray(info + 4 + width, end), duration, media.subarray(end)]);
    a.media = media;
    const encoded = await page.evaluate(async () => {
      const stream = { url: 'https://web.stremio.com/__wp_mcp__/fixture.webm', name: 'WatchParty local regression', description: 'Synthetic local media' };
      const compressed = await new Response(new Blob([JSON.stringify(stream)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
      return encodeURIComponent(btoa(String.fromCharCode(...new Uint8Array(compressed))));
    });
    a.playerUrl = `https://web.stremio.com/#/player/${encoded}`;
    a.phase = 'profiles'; return result('local real-media fixture', { bytes: media.length, expectedSeconds: 96, next: a.phase });
  }

  if (a.phase === 'profiles') {
    while (a.profiles.length < 3) {
      const context = await page.context().browser().browserType().launchPersistentContext('', {
        channel: 'chromium', headless: true, viewport: { width: 1440, height: 900 },
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
        ignoreDefaultArgs: ['--disable-extensions', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
      });
      const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
      const profile = { context, id: sw.url().split('/')[2], label: ['host', 'peer-a', 'peer-b'][a.profiles.length] };
      a.profiles.push(profile);
    }
    for (const profile of a.profiles) {
      await worker(profile).evaluate(label => chrome.storage.local.set({ wpBackendMode: 'local', wpUsername: `MCP ${label}` }), profile.label);
      // Chrome's local-network permission applies to content-script sockets.
      // Grant it only to the isolated test site's origin, not user profiles.
      await profile.context.grantPermissions(['local-network-access'], { origin: 'https://web.stremio.com' });
      await profile.context.routeWebSocket(/wss:\/\/ws\.mertd\.me/, ws => { a.errors.push('Blocked unexpected production socket'); ws.close(); });
      await profile.context.route('https://ws.mertd.me/**', route => route.abort());
      await profile.context.route('https://web.stremio.com/__wp_mcp__/fixture.webm*', async route => {
        if (profile.mediaDelayOnce) { const delay = profile.mediaDelayOnce; profile.mediaDelayOnce = 0; await new Promise(resolve => setTimeout(resolve, delay)); }
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), a.media.length - 1) : a.media.length - 1;
        await route.fulfill({ status: range ? 206 : 200, contentType: 'video/webm',
          headers: { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${a.media.length}` } : {}) },
          body: a.media.subarray(start, end + 1) });
      });
      // Use muted media to make test automation independent of audio gesture
      // permission; never replace play(), pause(), seeking, or media clocks.
      await profile.context.addInitScript(() => {
        new MutationObserver(() => document.querySelectorAll('video').forEach(v => { v.muted = true; }))
          .observe(document, { subtree: true, childList: true });
      });
      if (profile.main) await profile.main.close();
      profile.main = await profile.context.newPage();
      profile.main.on('pageerror', error => a.errors.push(`${profile.label}: ${error.message}`));
      await profile.main.goto(a.playerUrl, { waitUntil: 'domcontentloaded' });
      await profile.main.locator('#wp-sidebar').waitFor({ state: 'attached', timeout: 20000 });
      if (await profile.main.locator('#wp-sidebar').evaluate(e => e.classList.contains('wp-sidebar-hidden'))) await profile.main.locator('#wp-toggle-host').click();
      await profile.main.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2; }, null, { timeout: 20000 });
      await profile.main.locator('video').evaluate(v => { v.pause(); v.currentTime = 0; });
    }
    a.phase = 'join';
    return result('three actual installed-extension profiles', { states: await Promise.all(a.profiles.map(read)), next: a.phase });
  }

  if (a.phase === 'join') {
    const [host, ...peers] = a.profiles;
    const sidebar = host.main.locator('#wp-sidebar');
    for (const profile of a.profiles) {
      if (await profile.main.locator('#wp-sidebar').evaluate(e => e.classList.contains('wp-sidebar-hidden'))) await profile.main.locator('#wp-toggle-host').click();
    }
    if (!(await read(host)).wpRoomState?.id) {
      await host.main.locator('#wp-lobby-private').uncheck();
      await host.main.locator('#wp-lobby-create-btn').click();
    }
    a.roomId = (await poll(async () => (await read(host)).wpRoomState?.id, 'host overlay room creation'));
    for (const peer of peers) {
      await peer.main.locator('#wp-lobby-mode-join').click();
      await peer.main.locator('#wp-lobby-join-input').fill(a.roomId);
      await peer.main.locator('#wp-lobby-join-btn').click();
      await poll(async () => (await read(peer)).wpRoomState?.id === a.roomId, `${peer.label} overlay join`);
    }
    const room = await roomReady(3);
    const states = await Promise.all(a.profiles.map(read));
    assert(new Set(states.map(s => s.wpSessionId)).size === 3, 'Profiles did not isolate extension session identity');
    assert(states.every(s => s.wpBackendMode === 'local'), 'Non-local extension backend');
    assert(room.ownerSessionId === states[0].wpSessionId, 'Joining changed host authority');
    a.phase = 'playback';
    return result('overlay create and join', { members: room.users.length, independentIdentities: 3, next: a.phase });
  }

  const videos = () => Promise.all(a.profiles.map(p => p.main.locator('video').evaluate(v => ({ time: v.currentTime, paused: v.paused, rate: v.playbackRate, ready: v.readyState }))));
  const converged = (paused, target, rate = 1, tolerance = 0.7) => poll(async () => {
    const states = await videos();
    const spread = Math.max(...states.map(s => s.time)) - Math.min(...states.map(s => s.time));
    return states.every(s => s.paused === paused && s.ready >= 3 && Math.abs(s.rate - rate) < 0.12)
      && spread < tolerance && (target === undefined || states.every(s => Math.abs(s.time - target) < tolerance))
      ? { states, spread } : false;
  }, `real media convergence: paused=${paused}, time=${target}, rate=${rate}`);
  const mediaAction = (profile, action, value) => profile.main.locator('video').evaluate(async (v, args) => {
    if (args.action === 'play') await v.play();
    if (args.action === 'pause') v.pause();
    if (args.action === 'seek') v.currentTime = args.value;
    if (args.action === 'rate') v.playbackRate = args.value;
  }, { action, value });
  const tab = async (profile, name) => {
    if (await profile.main.locator('#wp-sidebar').evaluate(e => e.classList.contains('wp-sidebar-hidden'))) await profile.main.locator('#wp-toggle-host').click();
    await profile.main.locator(`.wp-tab-btn[data-panel="${name}"]`).click();
  };
  const leave = async profile => {
    await tab(profile, 'room'); await profile.main.locator('#wp-leave-room-btn').click();
    await poll(async () => !(await read(profile)).wpRoomState?.id, `${profile.label} leave acknowledged`);
  };

  if (a.phase === 'cleanup') {
    await page.request.post('http://127.0.0.1:8181/__manual/controls', { data: { wsSendDelayMs: 0 } });
    try {
      for (const profile of [...a.profiles].reverse()) {
        if ((await read(profile)).wpRoomState?.id) await leave(profile);
      }
    } finally {
      for (const profile of a.profiles) await profile.context.close();
      a.profiles = []; delete a.privateKeys; delete a.secretChat;
    }
    const clean = await poll(async () => {
      const state = await server(); return state.websocket.activeClients === 0 ? state : false;
    }, 'test sockets fully closed');
    a.phase = 'cleaned';
    return { profilesClosed: true, activeClients: clean.websocket.activeClients, roomSubscriptions: clean.websocket.activeRoomSubscriptions, delayMs: clean.controls.wsSendDelayMs, diagnostics: clean.diagnostics.summary };
  }

  if (a.phase === 'playback' || a.phase === 'delayed-playback') {
    const delayed = a.phase === 'delayed-playback'; const host = a.profiles[0];
    await page.request.post('http://127.0.0.1:8181/__manual/controls', { data: { wsSendDelayMs: delayed ? 400 : 0 } });
    try {
      await mediaAction(host, 'seek', delayed ? 35 : 12);
      const seek = await converged(true, delayed ? 35 : 12);
      await mediaAction(host, 'play'); const play = await converged(false);
      await mediaAction(host, 'rate', 1.5); const speed = await converged(false, undefined, 1.5);
      await page.waitForTimeout(2000);
      await mediaAction(host, 'pause'); const pause = await converged(true, undefined, 1.5);
      await mediaAction(host, 'rate', 1);
      await mediaAction(host, 'seek', delayed ? 45 : 20); await converged(true, delayed ? 45 : 20);
      a.phase = delayed ? 'tabs' : 'delayed-playback';
      return result(delayed ? '400ms transport delay playback' : 'three-profile real player synchronization', { seek, play, speed, pause, next: a.phase });
    } finally {
      await page.request.post('http://127.0.0.1:8181/__manual/controls', { data: { wsSendDelayMs: 0 } });
    }
  }

  if (a.phase === 'tabs') {
    const host = a.profiles[0]; const before = await read(host);
    host.previous = host.main; host.main = await host.context.newPage();
    await host.main.goto(a.playerUrl, { waitUntil: 'domcontentloaded' });
    await host.main.locator('#wp-sidebar').waitFor({ state: 'attached', timeout: 20000 });
    await poll(async () => {
      const state = await read(host);
      return state.wpRoomState?.id === a.roomId && state.wpControllerTab?.tabId !== before.wpControllerTab?.tabId;
    }, 'new tab becomes sole controller');
    await roomReady(3);
    await mediaAction(host, 'pause'); await mediaAction(host, 'seek', 52); await converged(true, 52);
    await host.previous.locator('video').evaluate(async v => { v.currentTime = 5; await v.play(); });
    await page.waitForTimeout(1800);
    const fenced = await converged(true, 52);
    const after = await read(host);
    assert(after.wpSessionId === before.wpSessionId, 'New tab changed stable user identity');
    await host.main.close(); host.main = host.previous; delete host.previous;
    await poll(async () => (await read(host)).wpControllerTab?.tabId === before.wpControllerTab?.tabId, 'closed controller transfers back to original tab');
    await roomReady(3);
    await mediaAction(host, 'pause'); await mediaAction(host, 'seek', 25); const handoff = await converged(true, 25);
    a.phase = 'reload';
    return result('same-profile controller fencing and close handoff', { stableIdentity: true, members: 3, fenced, handoff, next: a.phase });
  }

  if (a.phase === 'reload') {
    const host = a.profiles[0]; const before = await read(host);
    await host.main.reload({ waitUntil: 'domcontentloaded' });
    await host.main.locator('#wp-sidebar').waitFor({ state: 'attached', timeout: 20000 });
    await poll(async () => (await read(host)).wpRoomState?.id === a.roomId, 'host reload restores room');
    await roomReady(3);
    const restored = await converged(true, 25);
    const after = await read(host);
    assert(after.wpSessionId === before.wpSessionId, 'Reload changed extension user identity');
    assert((await roomReady(3)).ownerSessionId === before.wpSessionId, 'Reload stole host role');
    a.phase = 'slow-reload';
    return result('host reload restores canonical paused timeline', { restored, stableIdentity: true, next: a.phase });
  }

  if (a.phase === 'slow-reload') {
    const host = a.profiles[0];
    await mediaAction(host, 'seek', 10); await converged(true, 10);
    await mediaAction(host, 'play'); await converged(false);
    host.mediaDelayOnce = 15000;
    await host.main.reload({ waitUntil: 'domcontentloaded' });
    await host.main.locator('#wp-sidebar').waitFor({ state: 'attached', timeout: 20000 });
    const restored = await converged(false);
    assert(restored.states.every(s => s.time >= 23), 'Slow host startup reset canonical elapsed playback');
    await mediaAction(host, 'pause'); await converged(true);
    a.phase = 'worker';
    return result('15-second host media startup recovers a fresh playing timeline', { restored, next: a.phase });
  }

  if (a.phase === 'worker') {
    const host = a.profiles[0]; const before = await read(host);
    const debug = await host.context.newCDPSession(host.main);
    const versions = new Map();
    debug.on('ServiceWorker.workerVersionUpdated', event => event.versions.forEach(v => versions.set(v.versionId, v)));
    await debug.send('ServiceWorker.enable');
    const version = await poll(() => [...versions.values()].find(v => v.scriptURL === `chrome-extension://${host.id}/background.js` && v.runningStatus === 'running'), 'locate owned extension worker');
    await debug.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await poll(async () => {
      if (!worker(host)) return false;
      try {
        const state = await read(host);
        return state.wpRoomState?.id === a.roomId && state.wpControllerTab?.tabId === before.wpControllerTab?.tabId;
      } catch (error) {
        if (/worker.*(restarted|closed)|context was destroyed/i.test(error.message)) return false;
        throw error;
      }
    }, 'MV3 worker wake restores room projection', 20000);
    await debug.detach(); await roomReady(3);
    await mediaAction(host, 'seek', 30); const synchronized = await converged(true, 30);
    a.phase = 'reconnect';
    return result('actual MV3 worker stop and wake', { stableIdentity: (await read(host)).wpSessionId === before.wpSessionId, synchronized, next: a.phase });
  }

  if (a.phase === 'reconnect') {
    const peer = a.profiles[1]; const before = await read(peer);
    const debug = await peer.context.newCDPSession(peer.main); const contexts = [];
    debug.on('Runtime.executionContextCreated', event => contexts.push(event.context));
    await debug.send('Runtime.enable');
    const isolated = contexts.find(c => c.origin === `chrome-extension://${peer.id}`);
    assert(isolated, 'Native extension execution context missing');
    const prototype = await debug.send('Runtime.evaluate', { expression: 'WebSocket.prototype', contextId: isolated.id, objectGroup: 'wp-local-regression' });
    const sockets = await debug.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'wp-local-regression' });
    const closed = await debug.send('Runtime.callFunctionOn', { objectId: sockets.objects.objectId,
      functionDeclaration: 'function(){let count=0;for(const socket of this){if(socket.url === "ws://localhost:8181/" && socket.readyState === 1){socket.close(4001,"Local regression interruption");count++}}return count}', returnByValue: true });
    assert(closed.result.value === 1, 'Expected exactly one native extension socket to interrupt');
    await debug.send('Runtime.releaseObjectGroup', { objectGroup: 'wp-local-regression' });
    await poll(async () => (await read(peer)).wpUserId !== before.wpUserId && (await read(peer)).wpWsConnected, 'native extension reconnects interrupted socket');
    await debug.detach();
    await roomReady(3);
    await mediaAction(a.profiles[0], 'seek', 33); const synchronized = await converged(true, 33);
    const after = await read(peer);
    assert(after.wpSessionId === before.wpSessionId, 'Reconnect changed participant identity');
    a.phase = 'ready';
    return result('interrupted native extension socket reconnects once', { stableIdentity: true, members: 3, synchronized, next: a.phase });
  }

  if (a.phase === 'ready') {
    const host = a.profiles[0];
    await mediaAction(host, 'play'); await converged(false);
    await tab(host, 'room');
    await host.main.locator('#wp-ready-check-btn').click();
    await Promise.all(a.profiles.map(p => p.main.locator('#wp-ready-confirm').waitFor({ state: 'visible' })));
    const paused = await converged(true);
    for (const profile of a.profiles.slice(0, 2)) await profile.main.locator('#wp-ready-confirm').click();
    await page.waitForTimeout(1000); const waiting = await converged(true);
    await a.profiles[2].main.locator('#wp-ready-confirm').click();
    const started = await converged(false);
    await mediaAction(host, 'pause'); await converged(true);
    a.phase = 'private';
    return result('server-authoritative ready check pauses and starts all users', { paused, waiting, started, next: a.phase });
  }

  if (a.phase === 'private') {
    for (const profile of [...a.profiles].reverse()) await leave(profile);
    const host = a.profiles[0];
    await host.main.locator('#wp-lobby-mode-create').click();
    await host.main.locator('#wp-lobby-private').check();
    await host.main.locator('#wp-lobby-create-btn').click();
    a.roomId = await poll(async () => (await read(host)).wpRoomState?.id, 'private room creation');
    a.privateKeys = await worker(host).evaluate(async id => {
      const storage = await chrome.storage.session.get([`wpRoomAccessKey:${id}`, `wpRoomE2eKey:${id}`]);
      return { access: storage[`wpRoomAccessKey:${id}`], encryption: storage[`wpRoomE2eKey:${id}`] };
    }, a.roomId);
    assert(a.privateKeys.access && a.privateKeys.encryption, 'Private invitation keys were not persisted');
    a.phase = 'private-join';
    return result('public room leave and private create', { private: true, next: a.phase });
  }

  if (a.phase === 'private-join') {
    const [host, first, second] = a.profiles;
    await first.main.locator('#wp-lobby-mode-join').click();
    await first.main.locator('#wp-lobby-join-input').fill(a.roomId);
    await first.main.locator('#wp-lobby-join-btn').click();
    await page.waitForTimeout(700);
    assert(!(await read(first)).wpRoomState?.id, 'Private room admitted a user without an access key');
    const withoutKey = await first.main.locator('#wp-lobby-join-feedback').innerText();
    await first.main.locator('#wp-lobby-join-input').fill(`${a.roomId}#accessKey=${a.privateKeys.access}`);
    await first.main.locator('#wp-lobby-join-btn').click();
    await page.waitForTimeout(300);
    assert(!(await read(first)).wpRoomState?.id, 'Private room accepted an incomplete encryption invitation');
    const withoutEncryption = await first.main.locator('#wp-lobby-join-feedback').innerText();
    for (const peer of [first, second]) {
      await peer.main.locator('#wp-lobby-mode-join').click();
      await peer.main.locator('#wp-lobby-join-input').fill(`${a.roomId}#accessKey=${a.privateKeys.access}&e2eKey=${a.privateKeys.encryption}`);
      await peer.main.locator('#wp-lobby-join-btn').click();
      await poll(async () => (await read(peer)).wpRoomState?.id === a.roomId, `${peer.label} full private invite join`);
    }
    await roomReady(3); a.phase = 'private-chat';
    return result('private invitation boundary and three-user join', { withoutKey, withoutEncryption, next: a.phase });
  }

  if (a.phase === 'private-chat') {
    const [host, peer] = a.profiles;
    a.secretChat = `MCP ${'界'.repeat(296)}`;
    assert(a.secretChat.length === 300, 'Expected maximal input length');
    for (const profile of a.profiles) await tab(profile, 'chat');
    await host.main.locator('#wp-chat-input').fill(a.secretChat);
    await host.main.locator('#wp-chat-send').click();
    await poll(async () => (await host.main.locator('#wp-chat-input').inputValue()) === '', 'sender clears draft after server acknowledgment');
    for (const profile of a.profiles) await profile.main.getByText(a.secretChat, { exact: true }).waitFor({ state: 'visible', timeout: 12000 });
    const state = await server();
    const stored = state.rooms.find(r => r.id === a.roomId);
    assert(!JSON.stringify(stored).includes(a.secretChat), 'Private message appeared as plaintext in backend room state');
    await peer.main.reload({ waitUntil: 'domcontentloaded' });
    await peer.main.locator('#wp-sidebar').waitFor({ state: 'attached', timeout: 20000 });
    await roomReady(3); await tab(peer, 'chat');
    await peer.main.getByText(a.secretChat, { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    a.phase = 'private-companion';
    return result('300-character Unicode private chat live and reloaded history', { recipients: 3, plaintextCharacters: 300, backendContainsPlaintext: false, next: a.phase });
  }

  if (a.phase === 'private-companion') {
    const host = a.profiles[0];
    const companion = await host.context.newPage();
    try {
      await companion.goto(`chrome-extension://${host.id}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
      await companion.locator('#chat-input').waitFor({ state: 'visible' });
      // The companion was opened after the preceding overlay message, so it
      // has no echo-derived cooldown yet. Respect the server's send interval.
      await page.waitForTimeout(3100);
      const message = `Private companion ack ${Date.now()}`;
      await companion.locator('#chat-input').fill(message);
      await companion.locator('#chat-send').click();
      await poll(async () => await companion.locator('#chat-input').inputValue() === '', 'private companion correlated server acknowledgement');
      for (const profile of a.profiles) {
        await tab(profile, 'chat');
        await profile.main.getByText(message, { exact: true }).waitFor({ state: 'visible' });
      }
      assert(!JSON.stringify((await server()).rooms).includes(message), 'Private companion plaintext leaked to backend');
      a.phase = 'transfer';
      return result('private companion correlated acknowledgement and encryption', { recipients: 3, draftClearedAfterAck: true, backendContainsPlaintext: false, next: a.phase });
    } finally { await companion.close(); }
  }

  if (a.phase === 'transfer') {
    const host = a.profiles[0]; const nextHost = a.profiles[1];
    const room = await roomReady(3); const nextSession = (await read(nextHost)).wpSessionId;
    const nextUser = room.users.find(u => u.sessionId === nextSession);
    await tab(host, 'people');
    await host.main.locator(`.wp-transfer-btn[data-uid="${nextUser.id}"]`).click();
    await poll(async () => (await roomReady(3)).ownerSessionId === nextSession, 'host transfer acknowledged');
    await mediaAction(nextHost, 'pause'); await mediaAction(nextHost, 'seek', 40);
    const transferred = await converged(true, 40);
    await mediaAction(host, 'seek', 7); await mediaAction(host, 'play');
    await page.waitForTimeout(1800);
    const fenced = await converged(true, 40);
    a.phase = 'missing-chat-key';
    return result('ownership transfer gives only the new host playback authority', { transferred, fenced, next: a.phase });
  }

  if (a.phase === 'missing-chat-key') {
    const peer = a.profiles[2]; const storageKey = `wpRoomE2eKey:${a.roomId}`;
    // Fault injection clears the real key, not the crypto implementation.
    await worker(peer).evaluate(key => chrome.storage.session.remove(key), storageKey);
    const debug = await peer.context.newCDPSession(peer.main); const contexts = [];
    debug.on('Runtime.executionContextCreated', event => contexts.push(event.context));
    await debug.send('Runtime.enable');
    const isolated = contexts.find(c => c.origin === `chrome-extension://${peer.id}`);
    assert(isolated, 'Missing key fault-injection context not found');
    await debug.send('Runtime.evaluate', { expression: 'WPCrypto.clear()', contextId: isolated.id });
    await debug.detach(); await tab(peer, 'chat');
    const unsent = 'MCP missing key draft must never leave this browser';
    await peer.main.locator('#wp-chat-input').fill(unsent);
    await peer.main.locator('#wp-chat-send').click();
    await page.waitForTimeout(500);
    assert(await peer.main.locator('#wp-chat-input').inputValue() === unsent, 'Missing-key send discarded the draft');
    const state = await server();
    assert(!JSON.stringify(state.rooms).includes(unsent), 'Missing-key private message leaked plaintext to server');
    const feedback = await peer.main.locator('#wp-toast').innerText();
    await peer.main.reload({ waitUntil: 'domcontentloaded' });
    await peer.main.locator('#wp-sidebar').waitFor({ state: 'attached', timeout: 20000 });
    await peer.main.locator('#wp-lobby-mode-join').click();
    await peer.main.locator('#wp-lobby-join-input').waitFor({ state: 'visible', timeout: 15000 });
    assert(!(await read(peer)).wpRoomState?.id, 'Missing-key reload retained false room membership');
    await peer.main.locator('#wp-lobby-join-input').fill(`${a.roomId}#accessKey=${a.privateKeys.access}&e2eKey=${a.privateKeys.encryption}`);
    await peer.main.locator('#wp-lobby-join-btn').click();
    await roomReady(3); await tab(peer, 'chat');
    await peer.main.getByText(a.secretChat, { exact: true }).waitFor({ state: 'visible', timeout: 12000 });
    a.phase = 'cancel-ready';
    return result('missing private chat key fails closed and preserves draft', { feedback, backendContainsPlaintext: false, restoredHistory: true, next: a.phase });
  }

  if (a.phase === 'cancel-ready') {
    const host = a.profiles[1], peer = a.profiles[2];
    await mediaAction(host, 'seek', 15); await converged(true, 15);
    await tab(host, 'room'); await host.main.locator('#wp-ready-check-btn').click();
    for (const profile of a.profiles) await profile.main.locator('#wp-ready-confirm').click();
    await leave(peer);
    await page.waitForTimeout(4200);
    const room = (await server()).rooms.find(r => r.id === a.roomId);
    assert(!room.readyCheck && room.player.paused, 'Cancelled countdown resumed room playback');
    assert((await videos()).slice(0, 2).every(v => v.paused), 'A remaining user played after ready-check cancellation');
    await peer.main.locator('#wp-lobby-mode-join').click();
    await peer.main.locator('#wp-lobby-join-input').fill(`${a.roomId}#accessKey=${a.privateKeys.access}&e2eKey=${a.privateKeys.encryption}`);
    await peer.main.locator('#wp-lobby-join-btn').click();
    await roomReady(3); await converged(true, 15);
    a.phase = 'soak';
    return result('participant departure cancels authoritative ready countdown', { remainingPlayersStayedPaused: true, rejoinedMembers: 3, next: a.phase });
  }

  if (a.phase === 'soak') {
    const host = a.profiles[1];
    await mediaAction(host, 'seek', 10); await converged(true, 10);
    await mediaAction(host, 'play'); await converged(false);
    const background = await host.context.newPage(); await background.goto('about:blank'); await background.bringToFront();
    const visibility = await host.main.evaluate(() => document.visibilityState);
    const samples = [];
    try {
      for (let index = 0; index < 5; index++) {
        await page.waitForTimeout(5000);
        const state = await converged(false); samples.push(state.spread);
      }
    } finally { await background.close(); }
    await mediaAction(host, 'pause'); await converged(true);
    a.phase = 'autopause';
    return result('25-second playback sample with normal timer-throttling flags', { hostVisibility: visibility, maxObservedSpreadSeconds: Math.max(...samples), samples, next: a.phase });
  }

  if (a.phase === 'autopause') {
    const host = a.profiles[1], peer = a.profiles[2];
    await tab(host, 'room'); await host.main.locator('#wp-session-autopause').check();
    await poll(async () => (await roomReady(3)).settings?.autoPauseOnDisconnect, 'autopause setting reaches server');
    await mediaAction(host, 'seek', 20); await converged(true, 20);
    await mediaAction(host, 'play'); await converged(false);
    const before = await read(peer);
    const debug = await peer.context.newCDPSession(peer.main); const contexts = [];
    debug.on('Runtime.executionContextCreated', event => contexts.push(event.context));
    await debug.send('Runtime.enable');
    const isolated = contexts.find(c => c.origin === `chrome-extension://${peer.id}`);
    const prototype = await debug.send('Runtime.evaluate', { expression: 'WebSocket.prototype', contextId: isolated.id, objectGroup: 'wp-local-regression' });
    const sockets = await debug.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'wp-local-regression' });
    const closed = await debug.send('Runtime.callFunctionOn', { objectId: sockets.objects.objectId,
      functionDeclaration: 'function(){let count=0;for(const socket of this){if(socket.url === "ws://localhost:8181/" && socket.readyState === 1){socket.close(4001,"Local autopause interruption");count++}}return count}', returnByValue: true });
    assert(closed.result.value === 1, 'Expected exactly one peer socket');
    await debug.send('Runtime.releaseObjectGroup', { objectGroup: 'wp-local-regression' }); await debug.detach();
    await poll(async () => (await read(peer)).wpUserId !== before.wpUserId, 'autopaused peer reconnects');
    await roomReady(3); const paused = await converged(true);
    a.phase = 'visibility';
    return result('peer disconnect authoritatively auto-pauses the host and followers', { paused, reconnectedMembers: 3, next: a.phase });
  }

  if (a.phase === 'visibility') {
    const host = a.profiles[1];
    await tab(host, 'room'); await host.main.locator('#wp-session-private').uncheck();
    await poll(async () => (await roomReady(3)).public === true, 'private room converts to public');
    await host.main.locator('#wp-session-private').click();
    await page.waitForTimeout(500);
    assert((await roomReady(3)).public === true, 'Public-to-private conversion stranded existing peers without keys');
    const feedback = await host.main.locator('#wp-toast').innerText();
    const message = 'MCP public chat after private transition';
    for (const profile of a.profiles) await tab(profile, 'chat');
    await host.main.locator('#wp-chat-input').fill(message); await host.main.locator('#wp-chat-send').click();
    for (const profile of a.profiles) await profile.main.getByText(message, { exact: true }).waitFor({ state: 'visible', timeout: 12000 });
    a.phase = 'complete';
    return result('visibility transitions preserve accessible chat for all users', { privateConversionGuard: feedback, publicChatRecipients: 3, next: a.phase });
  }

  return { phase: a.phase, results: a.results, errors: a.errors };
}
