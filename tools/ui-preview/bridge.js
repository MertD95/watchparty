/* Development-only localhost UI adapter. Never included in the extension package. */
(() => {
  'use strict';
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    throw new Error('The UI preview is only available on localhost.');
  }
  const preferencesKey = 'watchparty-ui-preview:v1:preferences';
  const parameters = new URLSearchParams(location.search);
  let scenario = ['idle', 'host', 'guest'].includes(parameters.get('scenario')) ? parameters.get('scenario') : 'host';
  const event = () => {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
      hasListener: fn => listeners.has(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } };
  };
  const storageChanged = event();
  const messages = event();
  const statusChanges = event();
  let persisted = {};
  try { persisted = JSON.parse(localStorage.getItem(preferencesKey) || '{}'); } catch { /* Fresh preview. */ }
  const local = { wpUsername: 'You', wpBackendMode: 'auto', wpAccentColor: '#6366f1',
    wpCompactChat: false, wpReactionSound: true, wpFloatingReactions: true, ...persisted,
    wpSessionId: 'preview-session' };
  const session = {};
  let room = null;
  const userId = 'preview-you';
  let localAccessGranted = false;
  function makeRoom(role, input = {}) {
    return { id: input.roomId || 'preview-room', name: input.roomName || input.name || 'Friday movie night (sample)',
      public: input.public !== false, listed: input.listed !== false,
      owner: role === 'host' ? userId : 'preview-alex',
      ownerSessionId: role === 'host' ? local.wpSessionId : 'preview-alex-session',
      users: [{ id: userId, sessionId: local.wpSessionId, name: local.wpUsername || 'You', status: 'active' },
        { id: 'preview-alex', sessionId: 'preview-alex-session', name: 'Alex (sample)', status: 'active' }],
      settings: { autoPauseOnDisconnect: true }, bookmarks: [], player: { paused: true, time: 0 },
      meta: { name: 'Sample video', type: 'movie', id: 'pending' } };
  }
  function seedRoom() { room = scenario === 'idle' ? null : makeRoom(scenario); syncSession(); }
  function syncSession() {
    Object.assign(session, { wpRoomState: room, currentRoom: room?.id || null, wpUserId: userId,
      wpWsConnected: !!room, wpActiveBackend: 'local', wpActiveBackendUrl: 'UI simulation (no connection)' });
  }
  function getStatus() {
    return structuredClone({ room, userId, sessionId: local.wpSessionId, bgVersion: '2.0.4',
      wsConnected: !!room, backendMode: local.wpBackendMode, activeBackend: 'local',
      activeBackendUrl: 'UI simulation (no connection)', hasStremioTab: true, stremioRunning: true,
      currentRoomId: room?.id || null, bootstrapPending: false, isDevInstall: true,
      coordinatorMode: 'preview', controllerRuntime: { phase: room ? 'in-room' : 'idle' },
      adapterState: { route: 'board', availability: 'none' }, invariants: [],
      localLandingAccess: { available: true, granted: localAccessGranted, enabled: localAccessGranted, origins: [location.origin + '/*'] } });
  }
  function publish() {
    syncSession();
    const status = getStatus();
    messages.emit({ type: 'watchparty-ext', action: 'status.updated', payload: status });
    statusChanges.emit(status);
  }
  function complete(value, callback) {
    const promise = Promise.resolve(value);
    if (typeof callback === 'function') promise.then(callback);
    return promise;
  }
  function storageArea(name, values) {
    return {
      get(keys, callback) {
        const result = keys == null ? { ...values } : {};
        if (keys != null) {
          for (const key of typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)) {
            if (Object.hasOwn(values, key)) result[key] = values[key];
            else if (typeof keys === 'object' && !Array.isArray(keys)) result[key] = keys[key];
          }
        }
        return complete(structuredClone(result), callback);
      },
      set(next, callback) { return mutate(next, [], callback); },
      remove(keys, callback) { return mutate({}, typeof keys === 'string' ? [keys] : keys, callback); },
      clear(callback) { return mutate({}, Object.keys(values), callback); },
    };
    function mutate(next, removed, callback) {
      const changes = {};
      for (const [key, value] of Object.entries(next)) {
        if (JSON.stringify(values[key]) !== JSON.stringify(value)) changes[key] = { oldValue: values[key], newValue: value };
        values[key] = structuredClone(value);
      }
      for (const key of removed || []) {
        if (Object.hasOwn(values, key)) changes[key] = { oldValue: values[key] };
        delete values[key];
      }
      if (name === 'local') localStorage.setItem(preferencesKey, JSON.stringify(local));
      if (name === 'session' && removed?.includes('wpRoomState')) room = null;
      queueMicrotask(() => { storageChanged.emit(changes, name); if (Object.keys(changes).length) publish(); });
      return complete(undefined, callback);
    }
  }
  function navigate(path) {
    const url = new URL(path, location.origin);
    url.searchParams.set('scenario', scenario);
    location.assign(url.href);
  }
  function previewClipboardText(value) {
    const text = String(value || '');
    try {
      const invite = new URL(text);
      if (['http:', 'https:'].includes(invite.protocol) && /^\/r\/[a-z0-9-]+$/i.test(invite.pathname)) {
        return new URL('/preview/overlay.html?scenario=guest', location.origin).href;
      }
    } catch { /* Diagnostics and plain text are copied unchanged. */ }
    return text;
  }
  function emit(action, payload) { messages.emit({ type: 'watchparty-ext', action, payload }); }
  async function dispatch(message) {
    switch (message.action) {
      case 'status.get': return getStatus();
      case 'room.create':
      case 'room.join':
        scenario = message.action === 'room.create' ? 'host' : 'guest';
        if (message.username) local.wpUsername = message.username;
        room = makeRoom(scenario, message);
        publish();
        return { ok: true, handled: true, room };
      case 'room.leave': scenario = 'idle'; room = null; publish(); break;
      case 'room.settings.update': if (room && scenario === 'host') Object.assign(room.settings, message.settings); publish(); break;
      case 'room.visibility.update':
        if (room && scenario === 'host') {
          if (typeof message.public === 'boolean') room.public = message.public;
          if (typeof message.listed === 'boolean') room.listed = message.listed;
        }
        publish(); break;
      case 'room.ownership.transfer':
        if (room && scenario === 'host') {
          const target = room.users.find(member => member.id === message.targetUserId);
          if (target) { room.owner = target.id; room.ownerSessionId = target.sessionId; scenario = 'guest'; }
        }
        publish(); break;
      case 'session.username.update':
        local.wpUsername = message.username;
        localStorage.setItem(preferencesKey, JSON.stringify(local));
        if (room) room.users.find(member => member.id === userId).name = message.username;
        publish(); break;
      case 'room.chat.send': {
        if (!room) return { ok: false, error: 'Join a sample room first.' };
        const payload = { id: crypto.randomUUID(), roomId: room.id, user: userId,
          sessionId: local.wpSessionId, userName: local.wpUsername, content: message.content,
          clientMessageId: message.clientMessageId, date: Date.now() };
        setTimeout(() => emit('room.chat.appended', payload), 30);
        break;
      }
      case 'room.reaction.send': if (room) emit('room.reaction.appended', { ...message, roomId: room.id, user: userId, userName: local.wpUsername }); break;
      case 'room.typing.send': break;
      case 'room.resume':
      case 'app.stremio.open': navigate('/preview/overlay.html'); break;
      case 'app.options.open': navigate('/extension/options.html'); break;
      case 'clipboard.copy':
        try { await navigator.clipboard.writeText(previewClipboardText(message.text)); return { ok: true, copied: true }; }
        catch { return { ok: false, copied: false }; }
      case 'localBackend.get': return { ok: true, data: message.resource === 'rooms' ? { rooms: sampleDirectory() } : { ready: true } };
      case 'server.diagnostics.get': return { ok: true, serverDiagnostics: null };
      case 'localLandingAccess.sync': return { ok: true };
      case 'session.recovery.request':
        return { ok: false, handled: false,
          error: 'Recovery must be tested in the installed extension. This sample preview has no real Stremio tabs or saved room keys.' };
      case 'auth.key.clear': break;
      default: return { ok: false, handled: false, error: 'This action needs the installed extension, not the UI preview.' };
    }
    return { ok: true, handled: true };
  }
  function sampleDirectory() {
    return [{ id: 'preview-room', name: 'Friday movie night (sample)', public: true, listed: true, users: 2, time: 0,
      meta: { name: 'Sample video' }, hasDirectJoin: false }];
  }
  seedRoom();
  window.chrome = { runtime: {
    id: 'watchparty-local-ui-preview', lastError: undefined,
    getManifest: () => ({ version: '2.0.4', name: 'WatchParty UI preview', host_permissions: ['http://localhost:8181/*'] }),
    getURL: path => new URL('/extension/' + path.replace(/^\//, ''), location.origin).href,
    sendMessage: (message, callback) => { const work = dispatch(message); if (callback) work.then(callback); return work; },
    onMessage: messages,
    openOptionsPage: () => { navigate('/extension/options.html'); return Promise.resolve(); },
    connect: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} }),
  }, storage: { local: storageArea('local', local), session: storageArea('session', session), onChanged: storageChanged },
  tabs: { create: () => { navigate('/preview/overlay.html'); return Promise.resolve({ id: 1 }); },
    query: (_query, callback) => complete([], callback) },
  permissions: { request: () => { localAccessGranted = true; return Promise.resolve(true); },
    remove: () => { localAccessGranted = false; return Promise.resolve(true); }, contains: () => Promise.resolve(localAccessGranted) } };
  window.WPPreview = { getStatus, dispatch, subscribe: fn => statusChanges.addListener(fn),
    onMessage: fn => messages.addListener(fn), get scenario() { return scenario; },
    reset() { localStorage.removeItem(preferencesKey); location.reload(); } };
  // Keep every preview action local, including directory fetches in the real UI code.
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (url.origin === location.origin) return originalFetch(input, options);
    if (url.pathname === '/rooms') return Promise.resolve(Response.json({ rooms: sampleDirectory() }));
    return Promise.reject(new Error('External services are disabled in the localhost UI preview.'));
  };
  window.WebSocket = class { constructor() { throw new Error('Real WebSocket connections are disabled in the UI preview.'); } };
  // Native UI clipboard fallbacks must not turn sample room IDs into real invites.
  if (navigator.clipboard?.writeText) {
    const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = value => writeText(previewClipboardText(value));
  }
  if (navigator.clipboard?.write) {
    const write = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = items => write(items.map(item => {
      if (!item.types.includes('text/plain')) return item;
      const contents = {};
      for (const type of item.types) {
        contents[type] = type === 'text/plain'
          ? item.getType(type).then(blob => blob.text()).then(value => new Blob([previewClipboardText(value)], { type }))
          : item.getType(type);
      }
      return new ClipboardItem(contents);
    }));
  }
  document.addEventListener('copy', event => {
    const active = document.activeElement;
    const selected = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? active.value.slice(active.selectionStart || 0, active.selectionEnd ?? active.value.length)
      : window.getSelection()?.toString() || '';
    const translated = previewClipboardText(selected);
    if (translated !== selected && event.clipboardData) {
      event.clipboardData.setData('text/plain', translated);
      event.preventDefault();
    }
  });
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) { event.preventDefault(); navigate('/preview/overlay.html'); }
  }, true);
  window.addEventListener('storage', event => {
    if (event.key !== preferencesKey) return;
    let next = {};
    try { next = JSON.parse(event.newValue || '{}'); } catch { return; }
    const changes = {};
    for (const key of ['wpUsername', 'wpAccentColor', 'wpCompactChat', 'wpReactionSound', 'wpFloatingReactions']) {
      if (JSON.stringify(next[key]) !== JSON.stringify(local[key])) {
        changes[key] = { oldValue: local[key], newValue: next[key] }; local[key] = next[key];
      }
    }
    storageChanged.emit(changes, 'local');
  });
  document.addEventListener('DOMContentLoaded', () => {
    if (!location.pathname.startsWith('/extension/')) return;
    const banner = document.createElement('aside');
    banner.style.cssText = 'font:12px/1.5 system-ui;background:#27233b;color:#eee;padding:12px;border-bottom:1px solid #575064;position:relative;z-index:10';
    const back = document.createElement('a'); back.href = '/'; back.target = '_top'; back.textContent = '← Preview home';
    back.style.cssText = 'color:#c4b5fd;display:block;margin-bottom:4px';
    banner.append(back, document.createTextNode('Local UI preview · Sample data. No real room, server connection, or playback sync.'));
    document.body.prepend(banner);
    document.title += ' — Local UI preview';
  });
})();
