import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../landing/index.html', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../landing/landing.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function landing({ installed = true, pathname = '/', hash = '', fetchResult, fetchError, fetchHandler, storageBlocked = false,
  actionResults = true, acknowledgeActions = true, actionHandler } = {}) {
  const nodes = new Map();
  const sent = [];
  const navigated = [];
  const alerts = [];
  const timers = new Map();
  const streams = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  let timerId = 0;
  let document;
  class Element {
    constructor(tagName = 'div', attributes = '') {
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
      this.id = this.attributes.get('id');
      this.className = this.attributes.get('class') || '';
      this.classList = {
        add: value => this.classes.add(value), remove: value => this.classes.delete(value),
        contains: value => this.classes.has(value),
        toggle: (value, force) => {
          if (force ?? !this.classes.has(value)) this.classes.add(value); else this.classes.delete(value);
        },
      };
      this.style = {};
      this.dataset = {};
      this.children = [];
      this.listeners = new Map();
      this.textContent = ''; this.value = ''; this.hidden = false;
    }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    get isConnected() { return nodes.has(this.id) || !!this.parentElement?.isConnected; }
    get firstElementChild() { return this.children[0]; }
    get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); }
    insertBefore(child, anchor) {
      child.remove();
      this.children.splice(anchor ? this.children.indexOf(anchor) : this.children.length, 0, child);
      child.parentElement = this;
    }
    remove() {
      if (this.contains(document.activeElement)) document.activeElement = null;
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return all;
      if (selector.startsWith('.')) return all.filter(child => child.classList.contains(selector.slice(1)));
      return all.filter(child => ['INPUT', 'BUTTON', 'A'].includes(child.tagName) && !child.disabled);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { document.activeElement = this; }
    select() {}
    click() { this.listeners.get('click')?.({ target: this, currentTarget: this, preventDefault() {} }); }
  }
  for (const match of html.matchAll(/<([\w-]+)\b[^>]*\bid="[^"]+"[^>]*>/g)) {
    const node = new Element(match[1], match[0]); nodes.set(node.id, node);
  }
  const skipLinks = [...html.matchAll(/<a\b[^>]*class="skip-link"[^>]*>/g)].map(match => new Element('a', match[0]));
  const root = new Element('html');
  if (installed) root.setAttribute('data-watchparty-ext', '1');
  if (actionResults) root.setAttribute('data-watchparty-action-results', '1');
  nodes.get('rooms-list').appendChild(nodes.get('rooms-empty'));
  for (const id of ['uuid-input', 'uuid-cancel-btn', 'uuid-submit-btn']) nodes.get('uuid-modal').appendChild(nodes.get(id));
  document = {
    documentElement: root, activeElement: null, title: 'WatchParty', hidden: false,
    getElementById: id => nodes.get(id) || null,
    querySelectorAll: selector => selector === '.skip-link' ? skipLinks : [],
    createElement: tagName => new Element(tagName),
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(handler);
    },
  };
  const location = { origin: 'http://localhost:8090', hostname: 'localhost', pathname, search: '', hash,
    reload() { navigated.push('reload'); } };
  const storage = new Map([['watchparty.website.username', 'Movie Fan']]);
  const window = {
    document, location,
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { windowListeners.get(type)?.delete(handler); },
    postMessage: (message, origin) => {
      sent.push({ ...message, targetOrigin: origin });
      if (acknowledgeActions && message.requestId && message.type !== 'watchparty-ext-request') {
        Promise.resolve().then(async () => {
          const result = actionHandler ? await actionHandler(message) : { ok: true };
          if (!result) return;
          for (const listener of [...(windowListeners.get('message') || [])]) listener({ source: window, origin,
            data: { type: 'watchparty-ext-action-result', requestId: message.requestId, action: message.type, ...result } });
        });
      }
    },
    __watchpartyCaptureNavigation: url => navigated.push(url),
    __watchpartyCaptureAlert: message => alerts.push(message),
  };
  const context = vm.createContext({
    console, document, window, location, URL, URLSearchParams, AbortSignal,
    localStorage: {
      getItem: key => { if (storageBlocked) throw new Error('Storage blocked'); return storage.get(key) || null; },
      setItem: (key, value) => { if (storageBlocked) throw new Error('Storage blocked'); storage.set(key, value); },
      removeItem: key => { if (storageBlocked) throw new Error('Storage blocked'); storage.delete(key); },
    },
    history: { state: null, replaceState(_state, _title, path) { location.hash = new URL(path, location.origin).hash; navigated.push(path); } },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++timerId, clearInterval() {},
    fetch: (...args) => fetchHandler ? fetchHandler(...args) : fetchError ? Promise.reject(new Error('offline'))
      : fetchResult ? Promise.resolve(fetchResult) : new Promise(() => {}),
    EventSource: class {
      constructor() { streams.push(this); }
      close() {}
      message(data) { this.onmessage?.({ data: JSON.stringify(data), lastEventId: '' }); }
    },
  });
  vm.runInContext(source, context, { filename: 'landing.js' });
  const emit = (listeners, type, event) => { for (const listener of [...(listeners.get(type) || [])]) listener(event); };
  return {
    context, nodes, skipLinks, sent, navigated, alerts, streams, storage, document, window, location,
    status: value => context.updateLandingPresence(value),
    snapshot: value => context.applyRoomsSnapshot(value),
    message: (data, overrides = {}) => emit(windowListeners, 'message', { source: window, origin: location.origin, data, ...overrides }),
    confirmMembership: roomId => emit(windowListeners, 'message', { source: window, origin: location.origin,
      data: { type: 'watchparty-ext-status', data: { room: { id: roomId, users: [{ id: 'member', sessionId: 'session' }] },
        userId: 'member', sessionId: 'session', wsConnected: true, bootstrapPending: false } } }),
    windowEvent: (type, event = {}) => emit(windowListeners, type, event),
    documentEvent: (type, event = {}) => emit(documentListeners, type, event),
    timers: delay => {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    },
  };
}

const room = (id, overrides = {}) => ({ id, public: true, owner: 'Host', users: 2, time: 45,
  meta: { id: 'tt123', type: 'movie', name: 'Movie' }, ...overrides });

test('typing spaces and later extension status cannot overwrite a local display-name draft', () => {
  const ui = landing();
  const input = ui.nodes.get('profile-name-input');
  input.focus(); input.value = 'New ';
  input.listeners.get('input')({ target: input });
  assert.equal(input.value, 'New ');
  assert.equal(ui.storage.get('watchparty.website.username'), 'New');
  ui.document.activeElement = null;
  ui.status({ username: 'Old extension name' });
  assert.equal(input.value, 'New ');
  input.value = 'New Person '; input.listeners.get('blur')({ target: input });
  assert.equal(input.value, 'New Person');
});

test('both invite entry buttons open the same dialog, and a public room ID needs no key', async () => {
  const ui = landing();
  ui.nodes.get('hero-private-btn').focus(); ui.nodes.get('hero-private-btn').click();
  assert.equal(ui.nodes.get('uuid-modal').style.display, 'flex');
  ui.nodes.get('uuid-input').value = 'public-night';
  ui.nodes.get('uuid-submit-btn').click();
  await flush();
  ui.confirmMembership('public-night');
  const join = ui.sent.find(message => message.type === 'watchparty-join-room');
  assert.equal(join.roomId, 'public-night'); assert.equal(join.accessKey, undefined);
  assert.equal(ui.document.activeElement, ui.nodes.get('hero-private-btn'));
  ui.nodes.get('rooms-private-btn').click();
  assert.equal(ui.nodes.get('uuid-modal').style.display, 'flex');
});

test('clearing a local name does not silently reuse an older extension identity', async () => {
  const ui = landing(); ui.status({ username: 'Old name' });
  const input = ui.nodes.get('profile-name-input'); input.value = '';
  input.listeners.get('input')({ target: input });
  await ui.context.joinRoom('public-night', '', '');
  assert.equal(ui.sent.filter(message => message.type === 'watchparty-join-room').length, 0);
  assert.equal(ui.document.activeElement, input);
  assert.match(ui.nodes.get('hero-profile-note').textContent, /display name/);
});

test('private joins reject another room invite or malformed URL, and preserve matching encryption keys', async () => {
  const ui = landing();
  ui.context.openPrivateJoinModal({ roomId: 'private-night', metaId: 'tt123', metaType: 'movie' });
  const input = ui.nodes.get('uuid-input');
  input.value = 'https://watchparty.mertd.me/r/other-room#accessKey=secret'; ui.context.submitUuid();
  assert.match(ui.nodes.get('uuid-error').textContent, /different room/);
  input.value = 'https://example.com/not-an-invite'; ui.context.submitUuid();
  assert.equal(ui.sent.filter(message => message.type === 'watchparty-join-room').length, 0);
  input.value = 'https://watchparty.mertd.me/r/private-night#accessKey=secret&e2eKey=cipher'; ui.context.submitUuid();
  await flush();
  ui.confirmMembership('private-night');
  const join = ui.sent.find(message => message.type === 'watchparty-join-room');
  assert.equal(join.roomId, 'private-night'); assert.equal(join.accessKey, 'secret'); assert.equal(join.e2eKey, 'cipher');
  assert.equal(input.value, '', 'close removes the pasted secret from the field');
});

test('invite dialog traps Tab in both directions and Escape from a button restores the opener', () => {
  const ui = landing();
  const opener = ui.nodes.get('rooms-private-btn'); opener.focus(); opener.click();
  const input = ui.nodes.get('uuid-input'); const submit = ui.nodes.get('uuid-submit-btn');
  ui.documentEvent('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(ui.document.activeElement, submit);
  ui.documentEvent('keydown', { key: 'Tab', shiftKey: false, preventDefault() {} });
  assert.equal(ui.document.activeElement, input);
  submit.focus(); ui.documentEvent('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(ui.document.activeElement, opener);
  assert.equal(ui.nodes.get('page-landing').inert, false);
});

test('unrelated page-fragment secrets are never included in public room joins', async () => {
  const ui = landing({ hash: '#accessKey=wrong-room&e2eKey=wrong-key' });
  await ui.context.joinRoom('public-night', '', '');
  const join = ui.sent.find(message => message.type === 'watchparty-join-room');
  assert.equal(join.accessKey, undefined); assert.equal(join.e2eKey, undefined);
});

test('offline and HTTP errors show retry feedback rather than an empty-room claim', async () => {
  for (const config of [{ fetchError: true }, { fetchResult: { ok: false } }]) {
    const ui = landing(config); await flush();
    assert.match(ui.nodes.get('rooms-status').textContent, /couldn’t load/);
    assert.equal(ui.nodes.get('rooms-empty').style.display, 'none');
    assert.equal(ui.nodes.get('rooms-refresh-btn').hidden, false);
    assert.equal(ui.nodes.get('rooms-refresh-btn').classList.contains('hidden'), false);
    assert.equal(ui.nodes.get('rooms-list').getAttribute('aria-busy'), 'false');
  }
});

test('a successful empty snapshot replaces the loading copy with an honest empty state', () => {
  const ui = landing(); ui.snapshot({ revision: 0, rooms: [] });
  assert.match(ui.nodes.get('rooms-empty').textContent, /No rooms right now/);
  assert.equal(ui.nodes.get('rooms-empty').style.display, 'block');
  assert.equal(ui.nodes.get('rooms-status').textContent, '');
});

test('cards hide unavailable stream actions, render untrusted text safely and keep keyboard focus on reorder', () => {
  const ui = landing();
  ui.snapshot({ revision: 1, rooms: [room('a', { owner: '<img src=x onerror=alert(1)>' }), room('b')] });
  const first = ui.nodes.get('rooms-list').children[1];
  const second = ui.nodes.get('rooms-list').children[2];
  assert.equal(first.__elements.directBtn.hidden, true);
  assert.match(first.__elements.metaLine1.textContent, /<img/);
  second.__elements.joinBtn.focus();
  ui.snapshot({ revision: 2, rooms: [room('b'), room('a')] });
  assert.equal(ui.document.activeElement, second.__elements.joinBtn);
  assert.equal(ui.nodes.get('rooms-list').children[1], second);
});

test('debrid streams always warn and join the title rather than requesting direct playback', () => {
  const ui = landing();
  ui.snapshot({ revision: 1, rooms: [room('a', { hasDirectJoin: true, directJoinType: 'debrid-url' })] });
  const card = ui.nodes.get('rooms-list').children[1];
  assert.equal(card.__elements.directBtn.textContent, 'Choose a stream');
  card.__elements.directBtn.click();
  assert.match(ui.alerts[0], /debrid/);
  assert.equal(ui.sent.find(message => message.type === 'watchparty-join-room').preferDirectJoin, false);
});

test('a reconnected SSE stream accepts reset server revisions and ignores old-stream callbacks', () => {
  const ui = landing(); const old = ui.streams[0];
  old.message({ revision: 40, rooms: [room('old')] });
  ui.context.ensureRoomsStream({ force: true });
  ui.streams[1].message({ revision: 0, rooms: [room('new')] });
  old.message({ revision: 41, rooms: [room('old')] });
  assert.equal(ui.nodes.get('rooms-list').children[1].dataset.roomId, 'new');
});

test('a paginated HTTP snapshot cannot truncate an equal-revision full SSE list', () => {
  const ui = landing();
  ui.streams[0].message({ revision: 8, rooms: [room('a'), room('b')], total: 2 });
  ui.snapshot({ revision: 8, rooms: [room('a')], total: 2 });
  assert.equal(ui.nodes.get('rooms-list').children.length, 3);
});

test('redirect validates origin/source and joins only once across duplicate readiness events', async () => {
  const ui = landing({ installed: false, pathname: '/r/movie-night', hash: '#accessKey=secret&e2eKey=cipher' });
  assert.equal(ui.location.hash, '#accessKey=secret&e2eKey=cipher');
  ui.document.documentElement.setAttribute('data-watchparty-ext', '1');
  ui.message({ type: 'watchparty-ext-ready' }, { origin: 'https://evil.example' });
  ui.message({ type: 'watchparty-ext-ready' }, { source: {} });
  assert.equal(ui.sent.filter(message => message.type === 'watchparty-join-room').length, 0);
  ui.documentEvent('watchparty-ext-ready');
  ui.message({ type: 'watchparty-ext-ready' }); ui.message({ type: 'watchparty-ext-profile' });
  await flush();
  ui.confirmMembership('movie-night');
  ui.timers(500);
  const joins = ui.sent.filter(message => message.type === 'watchparty-join-room');
  assert.equal(joins.length, 1); assert.equal(joins[0].accessKey, 'secret'); assert.equal(joins[0].e2eKey, 'cipher');
  assert.equal(ui.location.hash, '', 'keys leave the address bar after the extension receives the join');
  assert.equal(ui.sent.filter(message => message.type === 'watchparty-open-stremio').length, 1);
});

test('install help points to the store and explicit retry preserves invite keys only in the fragment', () => {
  const ui = landing({ installed: false, pathname: '/r/movie-night', hash: '#accessKey=secret&e2eKey=cipher' });
  ui.timers(1200);
  assert.match(ui.nodes.get('redirect-btn').href, /^https:\/\/chromewebstore.google.com\//);
  assert.equal(ui.nodes.get('redirect-btn').target, '_blank');
  ui.nodes.get('redirect-retry-btn').click();
  assert.equal(ui.location.hash, '#accessKey=secret&e2eKey=cipher');
  assert.equal(ui.navigated.at(-1), 'reload');
  assert.equal(ui.storage.size, 1, 'invite keys never enter local storage');
});

test('normal refresh before installation preserves an invite and the eventual handoff scrubs it', async () => {
  const original = landing({ installed: false, pathname: '/r/movie-night', hash: '#accessKey=secret&e2eKey=cipher' });
  original.timers(1200);
  assert.equal(original.sent.filter(message => message.type === 'watchparty-join-room').length, 0);
  assert.equal(original.storage.size, 1);
  const refreshed = landing({ pathname: '/r/movie-night', hash: original.location.hash });
  await flush();
  refreshed.confirmMembership('movie-night');
  const join = refreshed.sent.find(message => message.type === 'watchparty-join-room');
  assert.equal(join.accessKey, 'secret'); assert.equal(join.e2eKey, 'cipher');
  assert.equal(refreshed.location.hash, '');
});

test('skip navigation focuses the route content without replacing a pending invite fragment', () => {
  for (const [pathname, targetId] of [['/', 'main-content'], ['/r/movie-night', 'redirect-title']]) {
    const ui = landing({ installed: false, pathname, hash: '#accessKey=secret&e2eKey=cipher' });
    const link = ui.skipLinks.find(item => item.getAttribute('href') === `#${targetId}`);
    let prevented = false;
    link.listeners.get('click')({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(ui.document.activeElement, ui.nodes.get(targetId));
    assert.equal(ui.location.hash, '#accessKey=secret&e2eKey=cipher');
    assert.equal(ui.navigated.length, 0);
  }
});

test('an updated same-route invite starts a fresh handoff, without intercepting normal section anchors', async () => {
  const ui = landing({ pathname: '/r/movie-night', hash: '#accessKey=old&e2eKey=old-cipher' });
  await flush();
  ui.confirmMembership('movie-night');
  assert.equal(ui.location.hash, '');
  ui.location.hash = '#rooms'; ui.windowEvent('hashchange');
  assert.equal(ui.navigated.includes('reload'), false);
  ui.location.hash = '#accessKey=new&e2eKey=new-cipher'; ui.windowEvent('hashchange');
  assert.equal(ui.navigated.at(-1), 'reload');
  const refreshed = landing({ pathname: '/r/movie-night', hash: ui.location.hash });
  await flush();
  refreshed.confirmMembership('movie-night');
  const join = refreshed.sent.find(message => message.type === 'watchparty-join-room');
  assert.equal(join.accessKey, 'new'); assert.equal(join.e2eKey, 'new-cipher');
  assert.equal(refreshed.location.hash, '');
  const home = landing(); home.location.hash = '#accessKey=unused'; home.windowEvent('hashchange');
  assert.equal(home.navigated.includes('reload'), false, 'only room routes reload for new invite keys');
});

test('HTTP fallback reads all pages before replacing the room list', async () => {
  const offsets = [];
  const rooms = Array.from({ length: 55 }, (_, index) => room(`room-${index}`));
  const ui = landing({ fetchHandler: async url => {
    const offset = Number(new URL(url).searchParams.get('offset')); offsets.push(offset);
    return { ok: true, json: async () => ({ rooms: rooms.slice(offset, offset + 50), offset, total: 55, revision: 3 }) };
  } });
  await flush(); await flush();
  assert.deepEqual(offsets, [0, 50]);
  assert.equal(ui.nodes.get('rooms-list').children.length, 56);
  assert.equal(ui.nodes.get('rooms-status').textContent, '');
});

test('HTTP pagination retries changed revisions once, without combining different snapshots', async () => {
  let calls = 0;
  const ui = landing({ fetchHandler: async url => {
    calls += 1;
    const offset = Number(new URL(url).searchParams.get('offset'));
    const changed = calls > 1;
    return { ok: true, json: async () => ({ rooms: [room(`${changed ? 'new' : 'old'}-${offset}`)],
      offset, total: 2, revision: changed ? 2 : 1 }) };
  } });
  await flush(); await flush();
  assert.equal(calls, 4);
  assert.deepEqual(ui.nodes.get('rooms-list').children.slice(1).map(card => card.dataset.roomId), ['new-0', 'new-1']);
});

test('a delayed HTTP fallback cannot overwrite a newer SSE snapshot', async () => {
  let finish;
  const ui = landing({ fetchHandler: () => new Promise(resolve => { finish = resolve; }) });
  ui.streams[0].message({ revision: 4, rooms: [room('latest')] });
  finish({ ok: true, json: async () => ({ revision: 3, rooms: [room('old')], total: 1 }) });
  await flush();
  assert.equal(ui.nodes.get('rooms-list').children[1].dataset.roomId, 'latest');
});

test('late extension responses cannot restore an old room after a pushed leave update', async () => {
  const ui = landing();
  const request = ui.sent.find(message => message.type === 'watchparty-ext-request');
  ui.message({ type: 'watchparty-ext-status', data: { room: null } });
  ui.message({ type: 'watchparty-ext-response', requestId: request.requestId, data: { room: room('old') } });
  await flush();
  assert.equal(ui.nodes.get('hero-room-card').classList.contains('hidden'), true);
});

test('primary, settings and resume controls use the extension bridge with safe install fallbacks', () => {
  const installed = landing();
  installed.status({ room: room('visible-room') });
  installed.nodes.get('hero-primary-btn').click();
  installed.nodes.get('hero-settings-btn').click();
  installed.nodes.get('hero-resume-btn').click();
  assert.equal(installed.sent.find(message => message.type === 'watchparty-open-stremio').url, 'https://web.stremio.com');
  assert.equal(installed.sent.filter(message => message.type === 'watchparty-open-options').length, 1);
  assert.equal(installed.sent.filter(message => message.type === 'watchparty-resume-room').length, 1);
  for (const message of installed.sent) assert.equal(message.targetOrigin, 'http://localhost:8090');

  for (const id of ['hero-primary-btn', 'hero-settings-btn', 'hero-private-btn', 'rooms-private-btn']) {
    const visitor = landing({ installed: false }); visitor.nodes.get(id).click();
    assert.match(visitor.navigated.at(-1), /^https:\/\/chromewebstore.google.com\/detail\//, id);
    assert.equal(visitor.sent.filter(message => message.type === 'watchparty-join-room').length, 0);
  }
});

test('public room actions distinguish choosing a title from watching the host stream', async () => {
  for (const direct of [false, true]) {
    const ui = landing();
    ui.snapshot({ revision: 1, rooms: [room('watch-night', { hasDirectJoin: true, directJoinType: 'web-url',
      meta: { id: 'title/id', type: 'movie', name: 'Movie' } })] });
    const card = ui.nodes.get('rooms-list').children[1];
    card.__elements[direct ? 'directBtn' : 'joinBtn'].click();
    await flush();
    const join = ui.sent.find(message => message.type === 'watchparty-join-room');
    assert.equal(join.roomId, 'watch-night'); assert.equal(join.preferDirectJoin, direct);
    assert.equal(ui.sent.find(message => message.type === 'watchparty-open-stremio').url,
      direct ? 'https://web.stremio.com' : 'https://web.stremio.com/#/detail/movie/title%2Fid');
  }
});

test('private room direct action waits for the correct full invite and cancel/backdrop never joins', () => {
  const ui = landing();
  ui.snapshot({ revision: 1, rooms: [room('private-night', { public: false, hasDirectJoin: true })] });
  const card = ui.nodes.get('rooms-list').children[1];
  card.__elements.directBtn.focus(); card.__elements.directBtn.click();
  assert.equal(ui.sent.filter(message => message.type === 'watchparty-join-room').length, 0);
  ui.nodes.get('uuid-cancel-btn').click();
  assert.equal(ui.document.activeElement, card.__elements.directBtn);
  assert.equal(ui.nodes.get('page-landing').inert, false);
  card.__elements.directBtn.click(); ui.nodes.get('uuid-modal').click();
  assert.equal(ui.nodes.get('uuid-modal').style.display, 'none');
  card.__elements.directBtn.click();
  ui.nodes.get('uuid-input').value = 'https://watchparty.mertd.me/r/private-night#accessKey=access&e2eKey=cipher';
  ui.nodes.get('uuid-submit-btn').click();
  const join = ui.sent.find(message => message.type === 'watchparty-join-room');
  assert.equal(join.preferDirectJoin, true); assert.equal(join.accessKey, 'access'); assert.equal(join.e2eKey, 'cipher');
});

test('retry reloads the room list after an error and restores a ready empty state', async () => {
  let online = false;
  const ui = landing({ fetchHandler: async () => {
    if (!online) throw new Error('offline');
    return { ok: true, json: async () => ({ revision: 1, total: 0, rooms: [] }) };
  } });
  await flush();
  assert.equal(ui.nodes.get('rooms-refresh-btn').hidden, false);
  online = true; ui.nodes.get('rooms-refresh-btn').click(); await flush();
  assert.equal(ui.nodes.get('rooms-refresh-btn').hidden, true);
  assert.equal(ui.nodes.get('rooms-status').textContent, '');
  assert.match(ui.nodes.get('rooms-empty').textContent, /No rooms right now/);
});

test('blocked browser storage does not break controls, name entry or invite handoff', async () => {
  const ui = landing({ storageBlocked: true });
  const input = ui.nodes.get('profile-name-input'); input.value = 'New name';
  input.listeners.get('input')({ target: input }); input.listeners.get('blur')({ target: input });
  await ui.context.joinRoom('public-night', '', '');
  assert.equal(ui.sent.find(message => message.type === 'watchparty-join-room').username, 'New name');
  const redirect = landing({ storageBlocked: true, pathname: '/r/private-night', hash: '#accessKey=access&e2eKey=cipher' });
  await flush();
  redirect.confirmMembership('private-night');
  const join = redirect.sent.find(message => message.type === 'watchparty-join-room');
  assert.equal(join.accessKey, 'access'); assert.equal(join.e2eKey, 'cipher');
  assert.equal(redirect.location.hash, '');
});

test('extension actions require matching request, action, source and origin before accepting a reply', async () => {
  const ui = landing({ acknowledgeActions: false });
  const pending = ui.context.requestExtensionAction('watchparty-open-options');
  const request = ui.sent.at(-1);
  let settled = false; pending.then(() => { settled = true; });
  const reply = { type: 'watchparty-ext-action-result', action: request.type, requestId: request.requestId, ok: true };
  ui.message(reply, { origin: 'https://evil.example' }); ui.message(reply, { source: {} });
  ui.message({ ...reply, requestId: 'wrong-request' }); ui.message({ ...reply, action: 'watchparty-join-room' });
  await flush(); assert.equal(settled, false);
  ui.message(reply); assert.equal((await pending).ok, true);
});

test('primary and settings buttons suppress duplicate clicks and surface rejection or missing acknowledgments', async () => {
  for (const id of ['hero-primary-btn', 'hero-settings-btn']) {
    const ui = landing({ acknowledgeActions: false });
    const button = ui.nodes.get(id); button.click(); button.click();
    const requests = ui.sent.filter(message => message.type !== 'watchparty-ext-request');
    assert.equal(requests.length, 1);
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    ui.message({ type: 'watchparty-ext-action-result', action: requests[0].type, requestId: requests[0].requestId,
      ok: false, error: 'Stremio could not be opened.' });
    await flush(); assert.equal(button.disabled, false);
    assert.match(ui.nodes.get('website-action-status').textContent, /could not be opened/);
    button.click(); ui.timers(9000); await flush();
    assert.equal(button.disabled, false);
    assert.match(ui.nodes.get('website-action-status').textContent, /No reply.*Check Stremio/);
  }
});

test('return to room captures the displayed room and cannot invoke an unscoped resume', async () => {
  const ui = landing(); ui.nodes.get('hero-resume-btn').click();
  assert.equal(ui.sent.some(message => message.type === 'watchparty-resume-room'), false);
  ui.status({ room: room('displayed-room'), wsConnected: false });
  assert.match(ui.nodes.get('hero-room-pill').textContent, /Reconnecting/);
  ui.nodes.get('hero-resume-btn').click();
  const request = ui.sent.find(message => message.type === 'watchparty-resume-room');
  assert.equal(request.roomId, 'displayed-room');
  await flush();
});

test('public join rejection or timeout never opens Stremio and concurrent joins cannot replace its target', async () => {
  const ui = landing({ acknowledgeActions: false });
  const joining = ui.context.joinRoom('first-room', 'tt1', 'movie');
  await ui.context.joinRoom('second-room', 'tt2', 'movie');
  assert.equal(ui.sent.filter(message => message.type === 'watchparty-join-room').length, 1);
  const request = ui.sent.find(message => message.type === 'watchparty-join-room');
  ui.message({ type: 'watchparty-ext-action-result', action: request.type, requestId: request.requestId, ok: false, error: 'Room request rejected.' });
  assert.equal(await joining, false);
  assert.match(ui.nodes.get('rooms-action-status').textContent, /rejected/);
  assert.equal(ui.sent.some(message => message.type === 'watchparty-open-stremio'), false);
  const retrying = ui.context.joinRoom('first-room', '', ''); ui.timers(9000);
  assert.equal(await retrying, false);
  assert.equal(ui.sent.some(message => message.type === 'watchparty-open-stremio'), false);
});

test('private invite dispatch failure retains its keys and re-enables editing and explicit retry', async () => {
  let reject = true;
  const ui = landing({ actionHandler: message => message.type === 'watchparty-join-room' && reject
    ? { ok: false, error: 'Could not contact the extension controller.' } : { ok: true } });
  ui.nodes.get('hero-private-btn').click();
  const input = ui.nodes.get('uuid-input');
  input.value = 'https://watchparty.mertd.me/r/private-room#accessKey=key&e2eKey=cipher';
  ui.nodes.get('uuid-submit-btn').click();
  assert.equal(input.disabled, true); await flush();
  assert.match(input.value, /accessKey=key/);
  assert.equal(input.disabled, false); assert.equal(ui.nodes.get('uuid-submit-btn').disabled, false);
  assert.equal(ui.nodes.get('uuid-modal').style.display, 'flex');
  assert.match(ui.nodes.get('uuid-error').textContent, /controller/);
  assert.equal(ui.sent.some(message => message.type === 'watchparty-open-stremio'), false);
  reject = false; ui.nodes.get('uuid-submit-btn').click(); await flush();
  ui.confirmMembership('private-room');
  assert.equal(input.value, ''); assert.equal(ui.nodes.get('uuid-modal').style.display, 'none');
});

test('closing an in-flight invite prevents a late acknowledgment from navigating or changing a later dialog', async () => {
  const ui = landing({ acknowledgeActions: false });
  ui.nodes.get('hero-private-btn').click(); ui.nodes.get('uuid-input').value = 'first-room';
  ui.nodes.get('uuid-submit-btn').click();
  const request = ui.sent.find(message => message.type === 'watchparty-join-room');
  ui.nodes.get('uuid-cancel-btn').click();
  ui.message({ type: 'watchparty-ext-action-result', action: request.type, requestId: request.requestId, ok: true });
  await flush();
  assert.equal(ui.sent.some(message => message.type === 'watchparty-open-stremio'), false);
  ui.nodes.get('rooms-private-btn').click();
  assert.equal(ui.nodes.get('uuid-modal').style.display, 'flex');
  assert.equal(ui.nodes.get('uuid-input').disabled, false);
});

test('redirect failures preserve fragment keys and retry only after an explicit user action', async () => {
  let reject = true;
  const ui = landing({ pathname: '/r/private-room', hash: '#accessKey=key&e2eKey=cipher',
    actionHandler: message => message.type === 'watchparty-join-room' && reject ? { ok: false, error: 'No available controller.' } : { ok: true } });
  await flush();
  assert.equal(ui.location.hash, '#accessKey=key&e2eKey=cipher');
  assert.match(ui.nodes.get('redirect-status').textContent, /No available controller/);
  assert.equal(ui.nodes.get('redirect-retry-btn').hidden, false);
  ui.message({ type: 'watchparty-ext-ready' }); ui.documentEvent('watchparty-ext-ready');
  await flush(); assert.equal(ui.sent.filter(message => message.type === 'watchparty-join-room').length, 1);
  reject = false; ui.nodes.get('redirect-retry-btn').click(); await flush();
  ui.confirmMembership('private-room');
  assert.equal(ui.sent.filter(message => message.type === 'watchparty-join-room').length, 2);
  assert.equal(ui.location.hash, '');
  assert.equal(ui.sent.filter(message => message.type === 'watchparty-open-stremio').length, 1);
});

test('redirect open failure offers a repeatable open control without repeating its accepted join', async () => {
  const ui = landing({ pathname: '/r/movie-night', actionHandler: message => message.type === 'watchparty-open-stremio'
    ? { ok: false, error: 'Opening Stremio failed.' } : { ok: true } });
  await flush(); assert.match(ui.nodes.get('redirect-status').textContent, /Opening Stremio failed/);
  ui.nodes.get('redirect-btn').click(); await flush();
  assert.equal(ui.sent.filter(message => message.type === 'watchparty-join-room').length, 1);
  assert.equal(ui.sent.filter(message => message.type === 'watchparty-open-stremio').length, 2);
});

test('missing action-result contract blocks all redirect mutations and preserves the invite for an update', async () => {
  const ui = landing({ actionResults: false, pathname: '/r/private-room', hash: '#accessKey=key&e2eKey=cipher' });
  await flush();
  assert.equal(ui.location.hash, '#accessKey=key&e2eKey=cipher');
  assert.equal(ui.sent.some(message => message.type === 'watchparty-join-room'), false);
  assert.equal(ui.sent.some(message => message.type === 'watchparty-open-stremio'), false);
  assert.match(ui.nodes.get('redirect-status').textContent, /Update WatchParty.*refresh this page/);
  assert.equal(ui.nodes.get('redirect-retry-btn').textContent, 'Refresh this page');
  ui.message({ type: 'watchparty-ext-ready' }); await flush();
  assert.equal(ui.sent.some(message => message.type === 'watchparty-join-room'), false);
  ui.nodes.get('redirect-retry-btn').click();
  assert.equal(ui.navigated.at(-1), 'reload');
  assert.match(ui.location.hash, /accessKey=key/);
});

test('the homepage requires current action acknowledgments for opening, settings, resume and joins', async () => {
  const ui = landing({ actionResults: false });
  ui.status({ room: room('existing-room'), wsConnected: true });
  assert.equal(ui.nodes.get('hero-extension-pill').textContent, 'Extension update needed');
  assert.match(ui.nodes.get('hero-profile-note').textContent, /Update WatchParty/);
  for (const id of ['hero-primary-btn', 'hero-settings-btn', 'hero-resume-btn']) {
    ui.nodes.get(id).click(); await flush();
    assert.equal(ui.nodes.get(id).disabled, false);
    assert.match(ui.nodes.get('website-action-status').textContent, /Update WatchParty.*refresh/);
  }
  assert.equal(await ui.context.joinRoom('target-room', '', ''), false);
  assert.match(ui.nodes.get('rooms-action-status').textContent, /Update WatchParty/);
  ui.nodes.get('hero-private-btn').click();
  const input = ui.nodes.get('uuid-input'); input.value = 'https://watchparty.mertd.me/r/private-room#accessKey=key&e2eKey=cipher';
  ui.nodes.get('uuid-submit-btn').click(); await flush();
  assert.match(ui.nodes.get('uuid-error').textContent, /Update WatchParty/);
  assert.equal(input.disabled, false); assert.match(input.value, /accessKey=key/);
  assert.equal(ui.sent.some(message => message.type !== 'watchparty-ext-request'), false);
  assert.equal(ui.navigated.length, 0, 'an installed incompatible extension is not sent to installation or Stremio');
});

test('invalidated extension contexts require refreshing and never misdirect an installed user to the store', async () => {
  for (const pathname of ['/', '/r/movie-night']) {
    const ui = landing({ pathname }); await flush();
    ui.document.documentElement.removeAttribute('data-watchparty-ext');
    ui.document.documentElement.removeAttribute('data-watchparty-action-results');
    ui.message({ type: 'watchparty-ext-unavailable', error: 'Extension context invalidated.' });
    if (pathname === '/') {
      ui.nodes.get('hero-primary-btn').click();
      assert.match(ui.nodes.get('website-action-status').textContent, /Refresh this page/);
      assert.equal(ui.navigated.length, 0);
    } else {
      assert.match(ui.nodes.get('redirect-status').textContent, /Refresh this page/);
      ui.nodes.get('redirect-retry-btn').click();
      assert.equal(ui.navigated.at(-1), 'reload');
    }
  }
});

test('correcting invite validation clears stale invalid state, and foreign-site invite URLs are rejected', () => {
  const ui = landing(); ui.nodes.get('hero-private-btn').click();
  const input = ui.nodes.get('uuid-input'); input.value = 'https://evil.example/r/movie-night#accessKey=secret';
  ui.nodes.get('uuid-submit-btn').click();
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  input.value = 'movie-night'; input.listeners.get('input')({ target: input });
  assert.equal(input.hasAttribute('aria-invalid'), false);
  assert.equal(ui.nodes.get('uuid-error').style.display, 'none');
  assert.equal(ui.sent.some(message => message.type === 'watchparty-join-room'), false);
});

test('name validation remains described through status refreshes until the user fixes the name', () => {
  const ui = landing(); const input = ui.nodes.get('profile-name-input');
  input.value = ''; input.listeners.get('input')({ target: input });
  ui.nodes.get('hero-private-btn').click(); ui.status({ username: 'Old name' });
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.match(ui.nodes.get('hero-profile-note').textContent, /Add a display name/);
});

test('room posters reject unsafe URLs, omit the page referrer and fall back after image failure', () => {
  const ui = landing();
  for (const poster of ['javascript:alert(1)', 'data:image/svg+xml,unsafe', 'http://example.com/poster.jpg', 'https://secret@example.com/poster.jpg']) {
    ui.snapshot({ rooms: [room('room', { meta: { poster } })] });
    assert.equal(ui.nodes.get('rooms-list').children[1].__elements.posterSlot.firstElementChild.tagName, 'DIV');
  }
  ui.snapshot({ rooms: [room('room', { meta: { poster: 'https://example.com/poster.jpg' } })] });
  const slot = ui.nodes.get('rooms-list').children[1].__elements.posterSlot;
  const image = slot.firstElementChild; assert.equal(image.referrerPolicy, 'no-referrer');
  image.listeners.get('error')(); assert.equal(slot.firstElementChild.tagName, 'DIV');
});

test('malformed or duplicate streamed rooms cannot partially replace a valid directory', () => {
  const ui = landing(); ui.snapshot({ revision: 1, rooms: [room('valid')] });
  for (const rooms of [[room('replacement'), null], [room('repeated'), room('repeated')], [room('invalid/id')]]) {
    ui.snapshot({ revision: 2, rooms });
    assert.equal(ui.nodes.get('rooms-list').children[1].dataset.roomId, 'valid');
    assert.match(ui.nodes.get('rooms-status').textContent, /may be out of date/);
    assert.equal(ui.nodes.get('rooms-refresh-btn').hidden, false);
  }
});

test('pending joins keep every card disabled through live refresh without hiding its direct action', async () => {
  const ui = landing({ acknowledgeActions: false });
  ui.snapshot({ revision: 1, rooms: [room('first', { hasDirectJoin: true }), room('second')] });
  const joining = ui.context.joinRoom('first', '', '');
  ui.snapshot({ revision: 2, rooms: [room('first', { hasDirectJoin: true }), room('second')] });
  const first = ui.nodes.get('rooms-list').children[1];
  assert.equal(first.__elements.joinBtn.disabled, true);
  assert.equal(first.__elements.directBtn.disabled, true);
  assert.equal(first.__elements.directBtn.hidden, false);
  assert.equal(ui.nodes.get('hero-private-btn').disabled, true);
  ui.timers(9000); await joining;
  assert.equal(first.__elements.joinBtn.disabled, false);
  assert.equal(first.__elements.directBtn.disabled, false);
  assert.equal(ui.nodes.get('hero-private-btn').disabled, false);
});

test('fresh server join errors are reported only for the last requested room and join command', async () => {
  const ui = landing(); await ui.context.joinRoom('requested-room', '', '');
  const status = ui.nodes.get('rooms-action-status'); const accepted = status.textContent;
  for (const error of [{ roomId: 'other-room', command: 'room.join', message: 'Wrong room error' },
    { roomId: 'requested-room', command: 'room.chat.send', message: 'Unrelated action error' }]) {
    ui.message({ type: 'watchparty-ext-status', data: { lastRoomError: error } });
    assert.equal(status.textContent, accepted);
  }
  ui.message({ type: 'watchparty-ext-status', data: { lastRoomError: {
    roomId: 'requested-room', command: 'room.join', message: 'The private room key was rejected.' } } });
  assert.match(status.textContent, /Stremio reported: The private room key was rejected/);
  ui.status({ room: room('requested-room'), username: 'Member' });
  assert.match(status.textContent, /key was rejected/, 'ordinary status hydration must not silently replace actionable feedback');
});

test('a disappearing or newly hidden card control returns keyboard focus to a usable join action', () => {
  const ui = landing(); ui.snapshot({ revision: 1, rooms: [room('first'), room('second', { hasDirectJoin: true })] });
  ui.nodes.get('rooms-list').children[2].__elements.directBtn.focus();
  ui.snapshot({ revision: 2, rooms: [room('first'), room('second')] });
  assert.equal(ui.document.activeElement, ui.nodes.get('rooms-list').children[1].__elements.joinBtn);
  ui.snapshot({ revision: 3, rooms: [] });
  assert.equal(ui.document.activeElement, ui.nodes.get('rooms-private-btn'));
});

test('private debrid choice warns, requires an invite and never asks to play the host stream', async () => {
  const ui = landing();
  ui.snapshot({ revision: 1, rooms: [room('private-room', { public: false, hasDirectJoin: true, directJoinType: 'debrid-url' })] });
  ui.nodes.get('rooms-list').children[1].__elements.directBtn.click();
  assert.match(ui.alerts[0], /debrid/);
  ui.nodes.get('uuid-input').value = 'https://watchparty.mertd.me/r/private-room#accessKey=key&e2eKey=cipher';
  ui.nodes.get('uuid-input').listeners.get('keydown')({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(ui.sent.find(message => message.type === 'watchparty-join-room').preferDirectJoin, false);
  assert.match(ui.sent.find(message => message.type === 'watchparty-open-stremio').url, /#\/detail\/movie\//);
});

test('an invalidated extension immediately releases pending buttons instead of waiting for timeout', async () => {
  const ui = landing({ acknowledgeActions: false });
  ui.nodes.get('hero-settings-btn').click();
  ui.document.documentElement.removeAttribute('data-watchparty-ext');
  ui.message({ type: 'watchparty-ext-unavailable' }); await flush();
  assert.equal(ui.nodes.get('hero-settings-btn').disabled, false);
  assert.match(ui.nodes.get('website-action-status').textContent, /Refresh this page/);
});

test('a delayed server join denial keeps redirect invite keys and exposes a real join retry', async () => {
  const ui = landing({ pathname: '/r/private-room', hash: '#accessKey=key&e2eKey=cipher' });
  await flush();
  assert.equal(ui.location.hash, '#accessKey=key&e2eKey=cipher', 'dispatch acknowledgment is not membership');
  ui.message({ type: 'watchparty-ext-status', data: { lastRoomError: {
    command: 'room.join', roomId: 'private-room', message: 'Invalid room key.' } } });
  assert.equal(ui.nodes.get('redirect-retry-btn').hidden, false);
  ui.nodes.get('redirect-retry-btn').click(); await flush();
  const joins = ui.sent.filter(message => message.type === 'watchparty-join-room');
  assert.equal(joins.length, 2);
  assert.equal(joins[1].accessKey, 'key'); assert.equal(joins[1].e2eKey, 'cipher');
  assert.equal(ui.location.hash, '#accessKey=key&e2eKey=cipher');
});

test('private dialog keeps the invite through dispatch acceptance and late server rejection', async () => {
  const ui = landing(); ui.nodes.get('hero-private-btn').click();
  const input = ui.nodes.get('uuid-input'); input.value = 'https://watchparty.mertd.me/r/private-room#accessKey=key&e2eKey=cipher';
  ui.nodes.get('uuid-submit-btn').click(); await flush();
  assert.equal(ui.nodes.get('uuid-modal').style.display, 'flex');
  assert.match(input.value, /accessKey=key/);
  ui.message({ type: 'watchparty-ext-status', data: { lastRoomError: {
    command: 'room.join', roomId: 'private-room', message: 'Invalid room key.' } } });
  assert.match(ui.nodes.get('uuid-error').textContent, /Invalid room key/);
  assert.equal(ui.nodes.get('uuid-submit-btn').disabled, false);
  assert.equal(input.disabled, false);
});

test('only fresh connected membership for this session scrubs the redirect fragment', async () => {
  const ui = landing({ pathname: '/r/private-room', hash: '#accessKey=key&e2eKey=cipher' }); await flush();
  for (const data of [
    { room: { id: 'private-room', users: [{ id: 'other-user' }] }, userId: 'me', wsConnected: true },
    { room: { id: 'private-room', users: [{ id: 'me' }] }, userId: 'me', wsConnected: false },
    { room: { id: 'private-room', users: [{ id: 'me' }] }, userId: 'me', wsConnected: true, bootstrapPending: true },
    { wsConnected: true },
  ]) {
    ui.message({ type: 'watchparty-ext-status', data });
    assert.equal(ui.location.hash, '#accessKey=key&e2eKey=cipher');
  }
  ui.confirmMembership('private-room');
  assert.equal(ui.location.hash, '');
  assert.match(ui.nodes.get('redirect-status').textContent, /connected in Stremio/);
  ui.timers(15000); assert.equal(ui.nodes.get('redirect-retry-btn').hidden, true);
});

test('late join dispatch acknowledgments cannot erase an earlier server rejection or open Stremio', async () => {
  const ui = landing({ pathname: '/r/private-room', hash: '#accessKey=key&e2eKey=cipher', acknowledgeActions: false });
  const join = ui.sent.find(message => message.type === 'watchparty-join-room');
  ui.message({ type: 'watchparty-ext-status', data: { lastRoomError: {
    command: 'room.join', roomId: 'private-room', message: 'Private chat key required.' } } });
  ui.message({ type: 'watchparty-ext-action-result', action: join.type, requestId: join.requestId, ok: true });
  await flush();
  assert.match(ui.nodes.get('redirect-status').textContent, /Private chat key required/);
  assert.equal(ui.nodes.get('redirect-retry-btn').hidden, false);
  assert.equal(ui.sent.some(message => message.type === 'watchparty-open-stremio'), false);
});

test('late Stremio-open acceptance cannot hide a server rejection or its redirect retry', async () => {
  let finishOpen;
  const ui = landing({ pathname: '/r/private-room', actionHandler: message => message.type === 'watchparty-open-stremio'
    ? new Promise(resolve => { finishOpen = resolve; }) : { ok: true } });
  await flush(); assert.equal(typeof finishOpen, 'function');
  ui.message({ type: 'watchparty-ext-status', data: { lastRoomError: {
    command: 'room.join', roomId: 'private-room', message: 'Invalid room key.' } } });
  finishOpen({ ok: true }); await flush();
  assert.match(ui.nodes.get('redirect-status').textContent, /Invalid room key/);
  assert.equal(ui.nodes.get('redirect-retry-btn').hidden, false);
});

test('unconfirmed membership times out with explicit retry and retains redirect and modal credentials', async () => {
  const redirect = landing({ pathname: '/r/private-room', hash: '#accessKey=key&e2eKey=cipher' }); await flush();
  redirect.timers(15000);
  assert.match(redirect.nodes.get('redirect-status').textContent, /membership was not confirmed/);
  assert.equal(redirect.nodes.get('redirect-retry-btn').hidden, false);
  assert.equal(redirect.location.hash, '#accessKey=key&e2eKey=cipher');
  assert.equal(redirect.sent.filter(message => message.type === 'watchparty-join-room').length, 1);
  const modal = landing(); modal.nodes.get('hero-private-btn').click();
  const input = modal.nodes.get('uuid-input'); input.value = 'https://watchparty.mertd.me/r/private-room#accessKey=key&e2eKey=cipher';
  modal.nodes.get('uuid-submit-btn').click(); await flush();
  assert.equal(modal.nodes.get('uuid-submit-btn').disabled, true);
  modal.nodes.get('uuid-submit-btn').click();
  assert.equal(modal.sent.filter(message => message.type === 'watchparty-join-room').length, 1);
  modal.timers(15000);
  assert.match(modal.nodes.get('uuid-error').textContent, /membership was not confirmed/);
  assert.equal(input.disabled, false); assert.match(input.value, /accessKey=key/);
  assert.equal(modal.nodes.get('uuid-submit-btn').disabled, false);
});
