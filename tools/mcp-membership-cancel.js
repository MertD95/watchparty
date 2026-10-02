// Run through the configured isolated Playwright MCP after the baseline suite.
// Races real extension bridge commands without replacing any app handler or
// socket. Exact delayed-snapshot ordering is covered by deterministic tests:
// Playwright WebSocket routes do not intercept isolated-world content sockets.
async page => {
  const a = page.__installedExtensionAudit;
  const [original, creator, peer] = a.profiles;
  const assert = (value, message) => { if (!value) throw Error(message); };
  const read = async p => p.context.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${p.id}/`)).evaluate(async () => ({
    ...await chrome.storage.local.get('wpSessionId'), ...await chrome.storage.session.get(['wpRoomState', 'wpWsConnected']),
  }));
  const state = async () => (await page.request.get('http://127.0.0.1:8181/__manual/state')).json();
  const poll = async (test, label) => { const start = Date.now(); while (Date.now() - start < 15000) { const value = await test(); if (value) return value; await page.waitForTimeout(100); } throw Error(`Timed out: ${label}`); };
  for (const p of [creator, peer]) {
    if (p.cancelPopup && !p.cancelPopup.isClosed()) await p.cancelPopup.close();
    p.cancelPopup = await p.context.newPage();
    await p.cancelPopup.goto(`chrome-extension://${p.id}/popup.html`, { waitUntil: 'domcontentloaded' });
  }
  const command = (p, action, data = {}) => p.cancelPopup.evaluate(async ({ action, data }) => chrome.runtime.sendMessage({ type: 'watchparty-ext', action, ...data }), { action, data });
  const previousRoom = (await read(creator)).wpRoomState;
  if (previousRoom.id === a.roomId) await command(creator, 'room.create', { public: true, listed: false, username: 'MCP peer-a', stream: previousRoom.stream, meta: previousRoom.meta });
  const target = await poll(async () => { const id = (await read(creator)).wpRoomState?.id; return id && id !== a.roomId ? id : false; }, 'second local room');
  const sessionId = (await read(peer)).wpSessionId;
  await poll(async () => (await read(peer)).wpWsConnected, 'peer connected');
  await command(peer, 'room.join', { roomId: target, username: 'MCP peer-b' });
  await command(peer, 'room.leave');
  await poll(async () => !(await read(peer)).wpRoomState?.id && !(await state()).rooms.some(r => r.users.some(u => u.sessionId === sessionId)), 'leave wins over late accepted join');
  await page.waitForTimeout(500);
  assert(!(await read(peer)).wpRoomState?.id, 'Late snapshot resurrected membership');
  for (const p of [creator, peer]) await command(p, 'room.join', { roomId: a.roomId, username: `MCP ${p.label}` });
  await poll(async () => (await state()).rooms.find(r => r.id === a.roomId)?.users.length === 3, 'restore original three participants');
  for (const p of [creator, peer]) await p.cancelPopup.close();
  const result = { name: 'rapid native join and leave does not resurrect membership', status: 'passed', localMembershipCleared: true, backendMembershipCleared: true, restoredMembers: 3, timingScope: 'Native wire timing uncontrolled; exact held-snapshot race validated separately by deterministic regressions' };
  (a.extraResults ||= []).push(result);
  return result;
}
