// Extension hardening regressions. Run via the headless Playwright MCP after
// mcp-installed-extension.js has created three participants in its public room.
// Uses real installed extension pages, server acknowledgments and native media.
// Assertions fail on the previously reproduced faults. No production access.
async (page) => {
  const a = page.__installedExtensionAudit;
  if (!a?.profiles?.length) throw new Error('Run the installed-extension setup first');
  const b = page.__extensionAdversarial ||= { phase: 'reload-repeat', evidence: [] };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const poll = async (test, label, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { const value = await test(); if (value) return value; await page.waitForTimeout(100); }
    throw new Error(`Precondition timed out: ${label}`);
  };
  const server = async () => (await page.request.get('http://127.0.0.1:8181/__manual/state')).json();
  const room = async () => (await server()).rooms.find(r => r.id === a.roomId);
  const worker = p => p.context.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${p.id}/`));
  const read = async p => worker(p).evaluate(async () => ({
    ...await chrome.storage.local.get(['wpSessionId']),
    ...await chrome.storage.session.get(['wpControllerTab', 'wpRoomState', 'wpWsConnected', 'wpUserId']),
  }));
  const inspect = p => p.main.locator('video').evaluate(v => ({ source: v.currentSrc, time: v.currentTime, paused: v.paused, ready: v.readyState }));
  const tab = async (p, name) => {
    if (await p.main.locator('#wp-sidebar').evaluate(e => e.classList.contains('wp-sidebar-hidden'))) await p.main.locator('#wp-toggle-host').click();
    await p.main.locator(`.wp-tab-btn[data-panel="${name}"]`).click();
  };
  const record = (name, status, details) => { const item = { name, status, ...details }; b.evidence.push(item); return { ...item, next: b.phase }; };
  const host = a.profiles[0];
  const makeOriginalHost = async () => {
    const canonical = await room(); const original = (await read(host)).wpSessionId;
    if (canonical.ownerSessionId === original) return;
    const states = await Promise.all(a.profiles.map(read));
    const current = a.profiles[states.findIndex(s => s.wpSessionId === canonical.ownerSessionId)];
    assert(current, 'Cannot locate current owner');
    await tab(current, 'people');
    const target = canonical.users.find(u => u.sessionId === original);
    await current.main.locator(`.wp-transfer-btn[data-uid="${target.id}"]`).click();
    await poll(async () => (await room()).ownerSessionId === original, 'restore original host through actual UI');
  };

  if (b.phase === 'reload-repeat') {
    b.initialReloadOwnerMismatch = (await room()).ownerSessionId !== (await read(host)).wpSessionId;
    await makeOriginalHost();
    const expected = (await read(host)).wpSessionId; const runs = [];
    for (let i = 0; i < 2; i++) {
      const start = Date.now();
      await host.main.reload({ waitUntil: 'domcontentloaded' });
      await poll(async () => (await room()).users.length === 3 && (await inspect(host)).ready >= 3, 'reloaded host returns');
      const canonical = await room();
      runs.push({ elapsedMs: Date.now() - start, retainedHost: canonical.ownerSessionId === expected, paused: canonical.player.paused });
      if (canonical.ownerSessionId !== expected) await makeOriginalHost();
    }
    assert(runs.every(r => r.retainedHost), 'Reload lost host ownership');
    b.phase = 'sidepanel';
    return record('repeat host reload with measured duration', 'passed', { restoredOriginalHostAfterPriorTransfer: b.initialReloadOwnerMismatch, runs });
  }

  if (b.phase === 'sidepanel') {
    for (const previous of [host.companion, host.secondCompanion]) if (previous && !previous.isClosed()) await previous.close();
    host.companion = await host.context.newPage();
    await host.companion.goto(`chrome-extension://${host.id}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    await host.companion.locator('#chat-input').waitFor({ state: 'visible' });
    b.sidepanelSnapshot = await host.companion.locator('body').ariaSnapshot();
    await tab(host, 'chat');
    const ownMessage = `Audit main-sidebar ${Date.now()}`;
    await host.main.locator('#wp-chat-input').fill(ownMessage); await host.main.locator('#wp-chat-send').click();
    await poll(async () => (await host.main.locator('#wp-chat-input').inputValue()) === '', 'main sidebar server echo');
    await tab(a.profiles[1], 'chat');
    await a.profiles[1].main.getByText(ownMessage, { exact: true }).waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    const ownDisplayed = await host.companion.getByText(ownMessage, { exact: true }).count();
    assert(ownDisplayed === 1, 'Own overlay message missing or duplicated in companion');
    host.secondCompanion = await host.context.newPage();
    await host.secondCompanion.goto(`chrome-extension://${host.id}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    const companions = [host.companion, host.secondCompanion];
    await poll(async () => (await Promise.all(companions.map(p => p.locator('#chat-send').isEnabled()))).every(Boolean), 'both companions ready');
    const messages = companions.map((_, i) => `Companion concurrent ${Date.now()}-${i}`);
    for (let i = 0; i < 2; i++) await companions[i].locator('#chat-input').fill(messages[i]);
    await page.request.post('http://127.0.0.1:8181/__manual/controls', { data: { wsSendDelayMs: 400 } });
    let observations;
    try {
      // Playwright click() may wait for a button re-enabled after an incoming
      // echo, serializing the intended race. CDP sends native trusted pointer
      // events to both owned pages without retrying disabled controls.
      const inputs = await Promise.all(companions.map(async p => ({ session: await host.context.newCDPSession(p), box: await p.locator('#chat-send').boundingBox() })));
      try {
        await Promise.all(inputs.map(async ({ session, box }) => {
          const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: 'left', clickCount: 1 };
          await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
          await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
        }));
      } finally { await Promise.all(inputs.map(i => i.session.detach())); }
      await poll(async () => (await Promise.all(companions.map(p => p.locator('#chat-input').inputValue()))).some(v => !v), 'accepted concurrent send clears only its draft');
      await page.waitForTimeout(700);
      const persisted = JSON.stringify(await room());
      observations = await Promise.all(companions.map(async (p, i) => ({
        text: messages[i], inBackend: persisted.includes(messages[i]),
        shownAsSent: await p.getByText(messages[i], { exact: true }).count() > 0,
        draft: await p.locator('#chat-input').inputValue(), toast: await p.locator('#toast').innerText(),
      })));
      assert(observations.filter(o => o.inBackend).length === 1, 'Expected one accepted and one cooldown-rejected concurrent send');
      assert(observations.every(o => o.inBackend ? o.shownAsSent && o.draft === '' : !o.shownAsSent && o.draft === o.text), 'False delivery or lost rejected draft');
      for (const p of companions) for (const o of observations) assert(await p.getByText(o.text, { exact: true }).count() === (o.inBackend ? 1 : 0), 'Companion surfaces disagree or duplicate chat');
    } finally {
      await page.request.post('http://127.0.0.1:8181/__manual/controls', { data: { wsSendDelayMs: 0 } });
    }
    b.phase = 'episode';
    return record('actual extension companion chat acknowledgement and cross-surface consistency', 'passed', {
      mainSidebarMessageDeliveredToPeer: true, mainSidebarMessageVisibleInOwnCompanion: !!ownDisplayed,
      concurrentSends: observations,
    });
  }

  if (b.phase === 'episode') {
    await makeOriginalHost();
    b.originalUrl = host.main.url();
    const encoded = await page.evaluate(async () => {
      const stream = { url: 'https://web.stremio.com/__wp_mcp__/fixture.webm?episode=B', name: 'Second synthetic episode', description: 'Distinct source regression' };
      const data = await new Response(new Blob([JSON.stringify(stream)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
      return encodeURIComponent(btoa(String.fromCharCode(...new Uint8Array(data))));
    });
    b.episodeUrl = `https://web.stremio.com/#/player/${encoded}`;
    await host.main.goto(b.episodeUrl, { waitUntil: 'domcontentloaded' });
    await poll(async () => (await inspect(host)).source.includes('episode=B') && (await room()).stream.resolvedUrl?.includes('episode=B'), 'host native and canonical new episode');
    await host.main.locator('video').evaluate(v => { v.pause(); v.currentTime = 8; });
    await poll(async () => (await Promise.all(a.profiles.map(inspect))).every(s => s.source.includes('episode=B') && s.paused && Math.abs(s.time - 8) < 0.7), 'all users change source and synchronize new episode');
    const states = await Promise.all(a.profiles.map(async p => ({ profile: p.label, route: p.main.url(), ...await inspect(p), contentLinkHidden: await p.main.locator('#wp-content-link').evaluate(e => getComputedStyle(e).display === 'none').catch(() => null) })));
    b.phase = 'cache-handoff';
    return record('host episode changes media identity as well as playback time', states.slice(1).some(s => !s.source.includes('episode=B')) ? 'bug-reproduced' : 'passed', { canonicalSource: (await room()).stream.resolvedUrl, states });
  }

  if (b.phase === 'cache-handoff') {
    // The original host page now last published B. A sibling publishes A and
    // closes; return to B must repair canonical content, not deduplicate B.
    const prior = await read(host); const original = host.main;
    const sibling = await host.context.newPage();
    await sibling.goto(b.originalUrl, { waitUntil: 'domcontentloaded' });
    await poll(async () => (await read(host)).wpControllerTab?.tabId !== prior.wpControllerTab?.tabId && !(await room()).stream.resolvedUrl?.includes('episode=B'), 'sibling takes controller and publishes A');
    await sibling.close();
    await poll(async () => (await read(host)).wpControllerTab?.tabId === prior.wpControllerTab?.tabId, 'controller returns to original B page');
    await poll(async () => (await inspect(host)).source === (await room()).stream.resolvedUrl, 'restored host republishes its actual source');
    const local = await inspect(host); const canonical = (await room()).stream.resolvedUrl;
    b.phase = 'missing-room';
    return record('content publication cache after sibling controller handoff', local.source !== canonical ? 'bug-reproduced' : 'passed', { localSource: local.source, canonicalSource: canonical, samePage: original === host.main });
  }

  if (b.phase === 'missing-room') {
    await makeOriginalHost(); const before = await read(host); const missing = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    // Exercise the real extension bridge; no app handlers are replaced.
    host.popup = await host.context.newPage();
    await host.popup.goto(`chrome-extension://${host.id}/popup.html`, { waitUntil: 'domcontentloaded' });
    const response = await host.popup.evaluate(async roomId => chrome.runtime.sendMessage({ type: 'watchparty-ext', action: WPConstants.ACTION.ROOM_JOIN, roomId, username: 'MCP host' }), missing);
    await page.waitForTimeout(700);
    const state = await read(host); const canonical = await room();
    const retained = canonical.users.some(u => u.sessionId === before.wpSessionId);
    assert(retained && state.wpRoomState?.id === a.roomId && canonical.ownerSessionId === before.wpSessionId, 'Rejected join changed original membership or host');
    b.phase = 'suspension';
    return record('failed room switch preserves current canonical membership', retained && !state.wpRoomState?.id ? 'bug-reproduced' : 'passed', { bridgeResponse: response, clientRoom: state.wpRoomState?.id || null, backendStillListsOriginalSession: retained, backendOwnerStillOriginalSession: canonical.ownerSessionId === before.wpSessionId, socketConnected: state.wpWsConnected });
  }

  if (b.phase === 'suspension') {
    assert((await read(host)).wpRoomState?.id === a.roomId, 'Original room was not retained');
    await host.main.goto(a.playerUrl, { waitUntil: 'domcontentloaded' });
    await poll(async () => (await inspect(host)).ready >= 3 && (await room()).users.length === 3, 'original media available');
    await makeOriginalHost();
    await host.main.locator('video').evaluate(v => { v.pause(); v.currentTime = 20; });
    await page.waitForTimeout(500);
    const peer = a.profiles[2], debug = await peer.context.newCDPSession(peer.main);
    await debug.send('Page.setWebLifecycleState', { state: 'frozen' });
    try {
      await host.main.locator('video').evaluate(async v => { v.currentTime = 30; await v.play(); });
      await page.waitForTimeout(16000);
    } finally { await debug.send('Page.setWebLifecycleState', { state: 'active' }); await debug.detach(); }
    let recovered = null;
    try {
      recovered = await poll(async () => {
        const states = await Promise.all(a.profiles.map(inspect));
        const spread = Math.max(...states.map(s => s.time)) - Math.min(...states.map(s => s.time));
        return states.every(s => !s.paused && s.ready >= 3) && spread < 0.7 ? { states, spread } : false;
      }, 'follower catches up after explicit16second suspension', 10000);
    } catch { recovered = { states: await Promise.all(a.profiles.map(inspect)), failed: true }; }
    await host.main.locator('video').evaluate(v => v.pause());
    assert(!recovered.failed, 'Suspended follower did not catch up');
    b.phase = 'media-end';
    return record('explicitly frozen follower catches up after queued playback updates', recovered.failed ? 'recovery-failed' : 'passed', { ...recovered, scope: 'CDP lifecycle freeze; not a real background-tab throttling policy test' });
  }

  if (b.phase === 'media-end') {
    await makeOriginalHost();
    const initial = await host.main.evaluate(() => { const v = document.querySelector('video'); return v ? { duration: v.duration } : null; });
    const duration = initial?.duration || a.results.find(r => r.name === 'three actual installed-extension profiles')?.states?.[0]?.video.duration;
    if (initial) await host.main.locator('video').evaluate(async v => { v.currentTime = v.duration - 10; await v.play(); });
    const ending = await poll(async () => {
      const states = await Promise.all(a.profiles.map(p => p.main.evaluate(() => {
        const v = document.querySelector('video'); return { route: location.hash, video: v ? { time: v.currentTime, duration: v.duration, paused: v.paused, ended: v.ended } : null };
      })));
      const player = (await room()).player;
      return player.paused && Math.abs(player.time - duration) < 0.2 && states.every(s => !s.video || (s.video.paused && Math.abs(s.video.duration - s.video.time) < 0.2)) ? states : false;
    }, 'natural end of real media pauses all participants', 18000);
    b.phase = 'complete';
    return record('natural media end reaches all users', 'passed', { states: ending, canonicalPaused: (await room()).player.paused, note: 'Stremio removes its video and returns to #/ at natural completion; DOM removal is expected, not an extension failure.' });
  }

  return { phase: b.phase, evidence: b.evidence };
}
