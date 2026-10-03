import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

// Event-focused DOM adapter, not a visual browser substitute. It supports real
// parentage, attributes, multiple listeners and bubbling so tab/input tests run
// the shipped overlay code instead of copies of its navigation logic.
function overlayRuntime() {
  const ids = new Map();
  const storageListeners = [];
  const saved = [];
  const actions = [];
  const storage = {};
  const notices = [];
  const copied = [];
  const timers = new Map();
  let timerId = 0;
  let keyReader = async () => 'example-room-key-0123456789';
  let inviteBuilder = async (_id, url) => url;
  const camelCase = (key) => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  let document;
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
    children = [];
    listeners = new Map();
    attributes = new Map();
    style = {};
    dataset = {};
    value = '';
    textContent = '';
    disabled = false;
    checked = false;
    open = false;
    isConnected = true;
    className = '';
    classList = {
      contains: (value) => this.className.split(/\s+/).includes(value),
      add: (...values) => { this.className = [...new Set([...this.className.split(/\s+/), ...values])].filter(Boolean).join(' '); },
      remove: (...values) => { this.className = this.className.split(/\s+/).filter((entry) => !values.includes(entry)).join(' '); },
      toggle: (value, force) => {
        const include = force ?? !this.classList.contains(value);
        this.classList[include ? 'add' : 'remove'](value);
        return include;
      },
    };
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id || ''; }
    setAttribute(key, value) {
      value = String(value);
      this.attributes.set(key, value);
      if (key === 'id') this.id = value;
      else if (key === 'class') this.className = value;
      else if (key.startsWith('data-')) this.dataset[camelCase(key.slice(5))] = value;
      else if (['disabled', 'checked', 'hidden', 'open', 'inert'].includes(key)) this[key] = true;
      else if (key === 'tabindex') this.tabIndex = Number(value);
      else if (key === 'type') this.type = value;
    }
    getAttribute(key) {
      if (key === 'id') return this.id || null;
      if (key === 'class') return this.className;
      if (key.startsWith('data-')) return this.dataset[camelCase(key.slice(5))] ?? null;
      return this.attributes.get(key) ?? null;
    }
    hasAttribute(key) { return this.getAttribute(key) !== null; }
    set innerHTML(html) {
      this.replaceChildren();
      const stack = [this];
      const voidTags = new Set(['input', 'img', 'br', 'hr', 'link', 'meta']);
      for (const match of String(html).matchAll(/<(\/?)([a-z][a-z0-9-]*)([^>]*)>/gi)) {
        const [, closing, tag, attrs] = match;
        if (closing) {
          const index = stack.findLastIndex((node) => node.tagName === tag.toUpperCase());
          if (index > 0) stack.length = index;
          continue;
        }
        const child = new Element(tag);
        for (const attribute of attrs.matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
          child.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
        }
        stack.at(-1).appendChild(child);
        if (!voidTags.has(tag.toLowerCase()) && !attrs.endsWith('/')) stack.push(child);
      }
    }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    replaceChildren(...children) {
      for (const child of [...this.children]) child.remove();
      for (const child of children) this.appendChild(child);
    }
    get childElementCount() { return this.children.length; }
    get firstElementChild() { return this.children[0] || null; }
    removeChild(child) { child.remove(); }
    remove() {
      if (ids.get(this.id) === this) ids.delete(this.id);
      for (const child of [...this.children]) child.remove();
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((entry) => entry !== this);
      this.isConnected = false;
    }
    matches(selector) {
      if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()));
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      const attribute = selector.match(/^\[([^\]=*]+)(\*?=)?(?:"([^"]*)"|'([^']*)'|([^\]]*))?\]$/);
      if (attribute) {
        const value = this.getAttribute(attribute[1]);
        const expected = attribute[3] ?? attribute[4] ?? attribute[5];
        return !attribute[2] ? value !== null : attribute[2] === '*=' ? value?.includes(expected) === true : value === expected;
      }
      return this.tagName.toLowerCase() === selector.toLowerCase();
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    attachShadow() { return new Element('shadow'); }
    focus() { document.activeElement = this; }
    addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
    dispatch(type, properties = {}) {
      const event = {
        type, target: this, isTrusted: true, key: '', stopped: false, defaultPrevented: false,
        stopPropagation() { this.stopped = true; },
        preventDefault() { this.defaultPrevented = true; },
        composedPath: () => { const nodes = []; for (let node = this; node; node = node.parentElement) nodes.push(node); return nodes; },
        ...properties,
      };
      for (let node = this; node; node = node.parentElement) {
        event.currentTarget = node;
        for (const listener of node.listeners.get(type) || []) listener(event);
        node[`on${type}`]?.(event);
        if (event.stopped) break;
      }
      return event;
    }
    click() { return this.dispatch('click'); }
  }
  document = new Element('document');
  document.body = document.appendChild(new Element('body'));
  document.head = document.appendChild(new Element('head'));
  document.activeElement = null;
  document.getElementById = (id) => ids.get(id) || null;
  document.createElement = (tag) => new Element(tag);
  document.createTextNode = (text) => Object.assign(new Element('text'), { textContent: text });
  function save(values) {
    const plain = JSON.parse(JSON.stringify(values));
    saved.push(plain);
    const changes = Object.fromEntries(Object.entries(plain).map(([key, newValue]) => [key, { oldValue: storage[key], newValue }]));
    Object.assign(storage, plain);
    for (const listener of storageListeners) listener(changes, 'local');
    return Promise.resolve();
  }
  let storageWriter = save;
  const context = vm.createContext({
    document, Element, HTMLElement: Element, crypto: webcrypto, URLSearchParams, URL, AbortSignal, console,
    CSS: { escape: value => String(value) },
    fetch: async () => ({ ok: true, json: async () => ({ rooms: [] }) }),
    WPWS: { getActiveBackend: () => 'live' },
    AudioContext: class { state = 'running'; },
    window: { innerWidth: 1200, addEventListener() {} },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
    chrome: {
      runtime: { getURL: (file) => file },
      storage: { local: { get: (_keys, callback) => callback(storage), set: values => storageWriter(values) }, onChanged: { addListener: (listener) => storageListeners.push(listener) } },
    },
    WPUtils: {
      getUserColor: () => '#6366f1', escapeHtml: (value) => String(value), getDirectJoinUrl: () => '',
      getCanonicalOwnerUser: () => null, isCurrentSessionUser: () => false,
      copyTextDeferred: async loader => { const text = await loader(); copied.push(text); return true; },
    },
    WPDOM: {
      clear: (node) => node.replaceChildren(),
      el: (tag, options = {}) => Object.assign(new Element(tag), { className: options.className || '', textContent: options.text || '', style: options.style || {}, dataset: options.dataset || {} }),
      safeColor: (value) => value, safeUrl: (value) => value || '',
    },
    WPTheme: { startListening() {} },
    WPModals: { showToast: message => notices.push(message), showReadyCheck() {} },
    WPRuntimeState: { get: async () => storage, set: save },
    WPRoomKeys: { getAccessKey: (...args) => keyReader(...args), getE2eKey: async () => null, appendToInviteUrl: (...args) => inviteBuilder(...args) },
  });
  for (const file of ['wp-actions.js', 'constants.js', 'wp-protocol.js', 'runtime-clock.js', 'stremio-sync.js', 'stremio-overlay-shells.js', 'stremio-overlay.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'extension', file), 'utf8'), context, { filename: file });
  }
  const api = vm.runInContext('WPOverlay', context);
  const constants = vm.runInContext('WPConstants', context);
  api.setActionDispatcher((action) => { actions.push(JSON.parse(JSON.stringify(action))); return { handled: true, rooms: [] }; });
  api.create();
  api.updateState({ inRoom: false });
  api.initKeyboardShortcuts();
  const room = { id: 'test-room', public: false, listed: false, settings: {}, users: [] };
  return {
    api, nodes: ids, document, constants, saved, actions, room, notices, copied, timers,
    storageWriter: writer => { storageWriter = writer; }, save,
    keyReader: reader => { keyReader = reader; }, inviteBuilder: builder => { inviteBuilder = builder; },
    inRoom: (isHost = false, changes = {}, state = {}) => api.updateState({ inRoom: true, isHost, roomState: { ...room, ...changes }, hasVideo: false, wsConnected: true, ...state }),
    selected: (name) => ids.get(`wp-tab-${name}`).getAttribute('aria-selected') === 'true',
    hidden: (id) => ids.get(id).classList.contains('wp-hidden-el'),
  };
}

test('personal settings are available before joining, with room-only tabs hidden', () => {
  const ui = overlayRuntime();
  ui.nodes.get('wp-tab-prefs').click();
  assert.equal(ui.selected('prefs'), true);
  assert.equal(ui.hidden('wp-panel-prefs'), false);
  for (const name of ['chat', 'people']) {
    assert.equal(ui.hidden(`wp-tab-${name}`), true);
    assert.equal(ui.nodes.get(`wp-tab-${name}`).disabled, true);
  }
  const compact = ui.nodes.get('wp-settings-compact');
  compact.checked = true;
  compact.dispatch('change');
  assert.deepEqual(ui.saved.at(-1), { [ui.constants.STORAGE.COMPACT_CHAT]: true });
});

test('closed sidebar starts inert and hidden from accessibility, opening restores its controls', () => {
  const ui = overlayRuntime(); const sidebar = ui.nodes.get('wp-sidebar');
  const launcher = ui.nodes.get('wp-toggle-host')._wpShadowBtn;
  assert.equal(sidebar.inert, true);
  assert.equal(sidebar.getAttribute('aria-hidden'), 'true');
  assert.equal(launcher.getAttribute('aria-expanded'), 'false');
  ui.api.openSidebar('prefs');
  assert.equal(sidebar.inert, false);
  assert.equal(sidebar.getAttribute('aria-hidden'), 'false');
  assert.equal(launcher.getAttribute('aria-expanded'), 'true');
});

test('closing from inside restores focus to the actual shadow launcher and keeps later refreshes inert', () => {
  const ui = overlayRuntime(); const sidebar = ui.nodes.get('wp-sidebar');
  const launcher = ui.nodes.get('wp-toggle-host')._wpShadowBtn;
  ui.api.openSidebar('prefs'); ui.nodes.get('wp-settings-username').focus();
  ui.nodes.get('wp-close-sidebar').click();
  assert.equal(ui.document.activeElement, launcher, 'the focus target is the button, not its unfocusable wrapper');
  assert.equal(sidebar.inert, true);
  assert.equal(sidebar.getAttribute('aria-hidden'), 'true');
  assert.equal(launcher.getAttribute('aria-expanded'), 'false');
  ui.inRoom(false);
  assert.equal(sidebar.inert, true, 'room snapshots must not reopen closed controls');
  launcher.click();
  assert.equal(sidebar.inert, false);
  assert.equal(sidebar.getAttribute('aria-hidden'), 'false');
});

test('closing a sidebar does not steal focus from the Stremio page', () => {
  const ui = overlayRuntime();
  const outside = ui.document.body.appendChild(ui.document.createElement('button'));
  ui.api.openSidebar('prefs'); outside.focus();
  ui.nodes.get('wp-close-sidebar').click();
  assert.equal(ui.document.activeElement, outside);
  assert.equal(ui.nodes.get('wp-sidebar').inert, true);
});

test('room setting rejection restores controls and canonical values, including synchronous dispatcher exceptions', async () => {
  for (const id of ['wp-session-private', 'wp-session-listed', 'wp-session-autopause']) {
    const ui = overlayRuntime(); ui.inRoom(true);
    ui.api.setActionDispatcher(() => { throw new Error('closed'); });
    const toggle = ui.nodes.get(id); const original = toggle.checked; toggle.checked = !original;
    await toggle.onchange({ isTrusted: true, target: toggle });
    assert.equal(ui.nodes.get(id).disabled, false);
    assert.equal(ui.nodes.get(id).checked, original);
    assert.match(ui.notices.at(-1), /Could not update/);
  }
});

test('pending room settings stay disabled during refresh and late failures cannot affect another membership', async () => {
  const ui = overlayRuntime(); ui.inRoom(true); let finish; const sent = [];
  ui.api.setActionDispatcher(message => { sent.push(message); return new Promise(resolve => { finish = resolve; }); });
  const toggle = ui.nodes.get('wp-session-listed'); toggle.checked = true;
  const work = toggle.onchange({ isTrusted: true, target: toggle });
  ui.inRoom(true);
  assert.equal(ui.nodes.get('wp-session-listed').disabled, true);
  assert.equal(sent[0].roomId, 'test-room');
  ui.inRoom(true, { id: 'other-room' });
  finish({ handled: false, error: 'old room failure' }); await work;
  assert.equal(ui.notices.includes('old room failure'), false);
  assert.equal(ui.nodes.get('wp-session-listed').disabled, false);
});

test('a room setting transport timeout restores usable controls', async () => {
  const ui = overlayRuntime(); ui.inRoom(true);
  ui.api.setActionDispatcher(() => new Promise(() => {}));
  const toggle = ui.nodes.get('wp-session-listed'); toggle.checked = true;
  const work = toggle.onchange({ isTrusted: true, target: toggle });
  [...ui.timers.values()].find(timer => timer.ms === 8000).callback(); await work;
  assert.equal(ui.nodes.get('wp-session-listed').disabled, false);
  assert.match(ui.notices.at(-1), /No response/);
});

test('private key save failure releases Updating state and key read cannot target a later room', async () => {
  const flush = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };
  const ui = overlayRuntime(); ui.inRoom(true); await flush();
  ui.api.setActionDispatcher(() => Promise.reject(new Error('closed')));
  const input = ui.nodes.get('wp-room-key-input'); input.value = 'new-private-key-123456789';
  ui.nodes.get('wp-room-key-save').click(); await flush();
  assert.equal(ui.nodes.get('wp-room-key-save').disabled, false);
  assert.equal(ui.nodes.get('wp-room-key-save').textContent, 'Update');
  assert.match(ui.notices.at(-1), /Could not update/);
  let finish; ui.keyReader(() => new Promise(resolve => { finish = resolve; }));
  input.value = 'another-private-key-123456789'; ui.nodes.get('wp-room-key-save').click();
  const finishOldRead = finish;
  ui.inRoom(true, { id: 'room-b' });
  finishOldRead('previous-private-key-123456789'); await flush();
  assert.equal(ui.actions.filter(action => action.action === ui.constants.ACTION.ROOM_VISIBILITY_UPDATE).length, 0);
});

test('copying an invite or restoring copied header text cannot cross a room change', async () => {
  const ui = overlayRuntime(); ui.inRoom(true);
  ui.api.bindRoomCodeCopy(ui.room);
  const chip = ui.nodes.get('wp-room-code');
  await chip.onclick({ isTrusted: true });
  assert.equal(chip.textContent, 'Link copied!');
  const oldTimer = [...ui.timers.values()].find(timer => timer.ms === 1500);
  ui.inRoom(true, { id: 'new-room' }); oldTimer.callback();
  assert.equal(chip.textContent, 'new-room');

  let finish;
  ui.inviteBuilder(() => new Promise(resolve => { finish = resolve; }));
  const copy = ui.nodes.get('wp-copy-invite-btn').onclick({ isTrusted: true });
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  ui.inRoom(true, { id: 'third-room' });
  finish('https://example.com/r/new-room#accessKey=old'); await copy;
  assert.equal(ui.copied.length, 1, 'only the first current-room invite reached the clipboard');
});

test('panel arrow keys wrap over enabled tabs with one tab stop and matching ARIA', () => {
  const ui = overlayRuntime();
  const roomTab = ui.nodes.get('wp-tab-room');
  const prefsTab = ui.nodes.get('wp-tab-prefs');
  const event = roomTab.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
  assert.equal(ui.document.activeElement, prefsTab);
  assert.equal(ui.selected('prefs'), true);
  assert.equal(prefsTab.tabIndex, 0);
  assert.equal(roomTab.tabIndex, -1);
  prefsTab.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(ui.selected('room'), true);
  ui.inRoom();
  ui.nodes.get('wp-tab-chat').dispatch('keydown', { key: 'End' });
  assert.equal(ui.selected('prefs'), true);
  prefsTab.dispatch('keydown', { key: 'Home' });
  assert.equal(ui.selected('chat'), true);
  assert.equal(ui.document.querySelectorAll('.wp-tab-btn').filter((tab) => tab.tabIndex === 0).length, 1);
  for (const tab of ui.document.querySelectorAll('.wp-tab-btn')) {
    assert.equal(ui.nodes.get(tab.getAttribute('aria-controls')).getAttribute('aria-labelledby'), tab.id);
  }
});

test('create/join keyboard navigation changes its panel without submitting a room request', () => {
  const ui = overlayRuntime();
  const createTab = ui.nodes.get('wp-lobby-mode-create');
  const joinTab = ui.nodes.get('wp-lobby-mode-join');
  createTab.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(ui.hidden('wp-lobby-create-panel'), true);
  assert.equal(ui.hidden('wp-lobby-join-panel'), false);
  assert.equal(ui.document.activeElement, joinTab);
  assert.equal(joinTab.getAttribute('aria-selected'), 'true');
  assert.equal(createTab.tabIndex, -1);
  assert.equal(joinTab.tabIndex, 0);
  assert.equal(ui.actions.some((action) => [ui.constants.ACTION.ROOM_JOIN, ui.constants.ACTION.ROOM_CREATE].includes(action.action)), false);
  joinTab.dispatch('keydown', { key: 'Home' });
  assert.equal(ui.hidden('wp-lobby-create-panel'), false);
});

test('room refreshes and leaving preserve the selected settings tab and focused name draft', () => {
  const ui = overlayRuntime();
  ui.inRoom();
  ui.nodes.get('wp-tab-prefs').click();
  const input = ui.nodes.get('wp-settings-username');
  input.focus();
  input.value = 'Not saved yet';
  ui.inRoom(false, { listed: true });
  assert.equal(ui.selected('prefs'), true);
  assert.equal(ui.nodes.get('wp-settings-username'), input, 'periodic updates must not replace focused input');
  assert.equal(input.value, 'Not saved yet');
  ui.api.updateState({ inRoom: false });
  assert.equal(ui.selected('prefs'), true);
  assert.equal(input.value, 'Not saved yet');
  assert.equal(ui.hidden('wp-tab-chat'), true);
});

test('host details stay expanded during refresh, and losing host removes mutation controls', async () => {
  const ui = overlayRuntime();
  ui.inRoom(true);
  await Promise.resolve();
  const details = ui.nodes.get('wp-room-settings-details');
  const inviteDetails = ui.nodes.get('wp-room-key-section');
  assert.equal(details.open, false);
  assert.equal(inviteDetails.open, false);
  details.open = true;
  inviteDetails.open = true;
  ui.inRoom(true, { listed: true });
  assert.equal(ui.nodes.get('wp-room-settings-details'), details);
  assert.equal(details.open, true);
  assert.equal(inviteDetails.open, true);
  ui.inRoom(false);
  await Promise.resolve();
  for (const id of ['wp-session-private', 'wp-session-listed', 'wp-session-autopause', 'wp-room-key-save']) assert.equal(ui.nodes.has(id), false, id);
  assert.equal(ui.nodes.get('wp-room-key-input').readOnly, true);
  assert.equal(ui.nodes.get('wp-copy-invite-btn').disabled, false);
  assert.equal(ui.nodes.get('wp-leave-room-btn').disabled, false);
});

test('public rooms hide advanced invite controls without hiding normal room actions', () => {
  const ui = overlayRuntime();
  ui.inRoom(true, { public: true });
  assert.equal(ui.hidden('wp-room-key-section'), true);
  assert.equal(ui.nodes.get('wp-copy-invite-btn').disabled, false);
  ui.nodes.get('wp-leave-room-btn').click();
  assert.equal(ui.actions.at(-1).action, ui.constants.ACTION.ROOM_LEAVE);
});

test('preferences save on Enter once and reject synthetic setting mutations', () => {
  const ui = overlayRuntime();
  const input = ui.nodes.get('wp-settings-username');
  input.value = '  Sam  ';
  input.dispatch('keydown', { key: 'Enter' });
  assert.equal(ui.saved.filter((entry) => ui.constants.STORAGE.USERNAME in entry).length, 1);
  assert.equal(ui.saved.at(-1)[ui.constants.STORAGE.USERNAME], 'Sam');
  const before = ui.saved.length;
  ui.nodes.get('wp-settings-compact').dispatch('change', { isTrusted: false });
  ui.nodes.get('wp-settings-save-name').dispatch('click', { isTrusted: false });
  ui.document.querySelector('.wp-color-btn').dispatch('click', { isTrusted: false });
  assert.equal(ui.saved.length, before);
});

test('accent selection updates accessible pressed state without rebuilding preferences', () => {
  const ui = overlayRuntime();
  const input = ui.nodes.get('wp-settings-username');
  const swatches = ui.document.querySelectorAll('.wp-color-btn');
  assert.equal(swatches.length, 6);
  swatches[2].click();
  assert.equal(swatches[2].getAttribute('aria-pressed'), 'true');
  assert.equal(swatches.filter((button) => button.getAttribute('aria-pressed') === 'true').length, 1);
  assert.equal(swatches[2].getAttribute('aria-label'), 'Green accent');
  assert.equal(ui.nodes.get('wp-settings-username'), input);
});

test('a name saved in preferences is used when returning to create a room', async () => {
  const ui = overlayRuntime();
  ui.api.openSidebar('prefs');
  const input = ui.nodes.get('wp-settings-username');
  input.focus();
  input.value = 'Sam';
  input.dispatch('keydown', { key: 'Enter' });
  await flush();
  ui.nodes.get('wp-tab-room').click();
  assert.equal(ui.nodes.get('wp-lobby-username').value, 'Sam');
  ui.nodes.get('wp-lobby-create-btn').click();
  await flush();
  const request = ui.actions.find((action) => action.action === ui.constants.ACTION.ROOM_CREATE);
  assert.equal(request.username, 'Sam');
});

test('settings and lobby text-input keyboard events cannot reach Stremio hotkeys', () => {
  const ui = overlayRuntime();
  ui.api.openSidebar('prefs');
  const escaped = [];
  for (const type of ['keydown', 'keyup', 'keypress']) ui.document.addEventListener(type, (event) => escaped.push(event));
  for (const id of ['wp-settings-username', 'wp-lobby-username', 'wp-lobby-room-name', 'wp-lobby-join-input']) {
    const input = ui.nodes.get(id);
    input.focus();
    for (const type of ['keydown', 'keyup', 'keypress']) {
      for (const properties of [{ key: ' ' }, { key: 'ArrowRight' }, { key: 'w', altKey: true }, { key: 'Escape' }]) {
        const event = input.dispatch(type, properties);
        assert.equal(event.stopped, true, `${id} must isolate ${type} ${properties.key}`);
      }
    }
  }
  assert.equal(escaped.length, 0);
  assert.equal(ui.nodes.get('wp-sidebar').classList.contains('wp-sidebar-hidden'), false);
});

test('global sidebar shortcuts recognize preference and lobby focus even for retargeted events', () => {
  const ui = overlayRuntime();
  ui.api.openSidebar('prefs');
  for (const id of ['wp-settings-username', 'wp-lobby-username', 'wp-lobby-room-name', 'wp-lobby-join-input']) {
    ui.nodes.get(id).focus();
    ui.document.dispatch('keydown', { key: 'Escape' });
    ui.document.dispatch('keydown', { key: 'w', altKey: true });
    assert.equal(ui.nodes.get('wp-sidebar').classList.contains('wp-sidebar-hidden'), false, id);
  }
});

test('private invite-key typing stays isolated from playback and sidebar hotkeys', async () => {
  const ui = overlayRuntime();
  ui.inRoom(true);
  await Promise.resolve();
  ui.api.openSidebar('room');
  const input = ui.nodes.get('wp-room-key-input');
  input.focus();
  for (const type of ['keydown', 'keyup', 'keypress']) {
    for (const key of [' ', 'ArrowRight', 'Escape']) {
      assert.equal(input.dispatch(type, { key }).stopped, true, `invite key ${type} ${key}`);
    }
  }
  assert.equal(ui.nodes.get('wp-sidebar').classList.contains('wp-sidebar-hidden'), false);
});

test('room membership without a video never displays a misleading synced indicator', () => {
  const ui = overlayRuntime();
  ui.inRoom();
  ui.api.updateSyncIndicator(false, 0);
  assert.equal(ui.hidden('wp-sync-indicator'), true);
  ui.inRoom(false, {}, { hasVideo: true });
  ui.api.updateSyncIndicator(false, 0);
  assert.equal(ui.hidden('wp-sync-indicator'), false);
  ui.inRoom(false, {}, { hasVideo: false });
  assert.equal(ui.hidden('wp-sync-indicator'), true, 'removing video immediately clears previous sync status');
  ui.api.updateSyncIndicator(false, 0);
  assert.equal(ui.hidden('wp-sync-indicator'), true, 'late drift callbacks cannot restore a stale synced badge');
});

test('losing the connection hides sync status until a connected video resumes', () => {
  const ui = overlayRuntime();
  ui.inRoom(false, {}, { hasVideo: true });
  ui.api.updateSyncIndicator(false, 0);
  assert.equal(ui.hidden('wp-sync-indicator'), false);
  for (const wsConnected of [false, undefined]) {
    ui.inRoom(false, {}, { hasVideo: true, wsConnected });
    assert.equal(ui.hidden('wp-sync-indicator'), true);
    ui.api.updateSyncIndicator(false, 0);
    assert.equal(ui.hidden('wp-sync-indicator'), true);
  }
  ui.inRoom(false, {}, { hasVideo: true, wsConnected: true });
  ui.api.updateSyncIndicator(false, 0);
  assert.equal(ui.hidden('wp-sync-indicator'), false);
  assert.ok(ui.nodes.get('wp-sync-indicator').querySelector('.wp-sync-ok'));
});

test('media mismatch warning survives drift callbacks and clears when matching playback resumes', () => {
  const ui = overlayRuntime();
  ui.inRoom(false, {}, { hasVideo: true });
  ui.api.updateSyncIndicator(false, 0);
  ui.inRoom(false, {}, { hasVideo: true, mediaMismatch: true });
  const indicator = ui.nodes.get('wp-sync-indicator');
  assert.equal(ui.hidden('wp-sync-indicator'), false);
  assert.match(indicator.textContent, /Different video/);
  for (const drift of [0, 1, 10, NaN]) {
    ui.api.updateSyncIndicator(false, drift);
    assert.equal(ui.hidden('wp-sync-indicator'), false);
    assert.match(indicator.textContent, /Different video/);
  }
  ui.inRoom(false, {}, { hasVideo: true, mediaMismatch: false });
  ui.api.updateSyncIndicator(false, 0);
  assert.equal(ui.hidden('wp-sync-indicator'), false);
  assert.ok(indicator.querySelector('.wp-sync-ok'));
  ui.api.updateState({ inRoom: false, mediaMismatch: true });
  ui.api.updateSyncIndicator(false, 0);
  assert.equal(ui.hidden('wp-sync-indicator'), true, 'leaving hides even a previous mismatch warning');
});

test('connected guest drift renders sync, correction and seeking states but rejects unknown drift', () => {
  const ui = overlayRuntime();
  ui.inRoom(false, {}, { hasVideo: true });
  const indicator = ui.nodes.get('wp-sync-indicator');
  for (const [drift, expectedClass] of [[0, '.wp-sync-ok'], [0.2, '.wp-sync-ok'], [1, '.wp-sync-drift'], [-1, '.wp-sync-drift'], [4, '.wp-sync-seek']]) {
    ui.api.updateSyncIndicator(false, drift);
    assert.equal(ui.hidden('wp-sync-indicator'), false);
    assert.ok(indicator.querySelector(expectedClass), `drift ${drift}`);
  }
  for (const drift of [undefined, null, NaN, Infinity, -Infinity, '0']) {
    ui.api.updateSyncIndicator(false, drift);
    assert.equal(ui.hidden('wp-sync-indicator'), true, `unknown drift ${String(drift)}`);
  }
});

test('becoming host or leaving immediately clears a guest sync indicator', () => {
  const ui = overlayRuntime();
  ui.inRoom(false, {}, { hasVideo: true });
  ui.api.updateSyncIndicator(false, 0);
  ui.inRoom(true, {}, { hasVideo: true });
  assert.equal(ui.hidden('wp-sync-indicator'), true);
  ui.api.updateSyncIndicator(true, 0);
  assert.equal(ui.hidden('wp-sync-indicator'), true);
  ui.inRoom(false, {}, { hasVideo: true });
  ui.api.updateSyncIndicator(false, 0);
  assert.equal(ui.hidden('wp-sync-indicator'), false);
  ui.api.updateState({ inRoom: false });
  assert.equal(ui.hidden('wp-sync-indicator'), true);
  ui.api.updateSyncIndicator(false, 0);
  assert.equal(ui.hidden('wp-sync-indicator'), true);
});

test('catch-up waits for dispatch acceptance and failed requests remain usable', async () => {
  const ui = overlayRuntime(); ui.inRoom(false, {}, { hasVideo: true });
  let finish; const sent = [];
  ui.api.setActionDispatcher(action => { sent.push(action); return new Promise(resolve => { finish = resolve; }); });
  ui.api.showCatchUpButton(-12);
  const button = ui.nodes.get('wp-catchup-btn');
  assert.match(button.textContent, /12s ahead/);
  button.click(); button.click();
  assert.equal(button.isConnected, true);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].roomId, 'test-room');
  ui.inRoom(false, {}, { hasVideo: true }); ui.api.showCatchUpButton(13);
  assert.equal(button.disabled, true, 'status refresh cannot release an in-flight request');
  finish({ handled: false, error: 'Sync request failed' }); await flush();
  assert.equal(button.disabled, false);
  assert.equal(button.isConnected, true);
  assert.match(ui.notices.at(-1), /Sync request failed/);
  button.click(); finish({ handled: true }); await flush();
  assert.equal(ui.nodes.has('wp-catchup-btn'), false);
});

test('catch-up timeout is retryable and late results cannot alter another room', async () => {
  const ui = overlayRuntime(); ui.inRoom(false, {}, { hasVideo: true });
  let finish;
  ui.api.setActionDispatcher(() => new Promise(resolve => { finish = resolve; }));
  ui.api.showCatchUpButton(12); ui.nodes.get('wp-catchup-btn').click();
  [...ui.timers.values()].find(timer => timer.ms === 8000).callback(); await flush();
  assert.equal(ui.nodes.get('wp-catchup-btn').disabled, false);
  assert.match(ui.notices.at(-1), /No response/);
  ui.nodes.get('wp-catchup-btn').click();
  ui.inRoom(false, { id: 'second-room' }, { hasVideo: true }); ui.api.showCatchUpButton(15);
  const replacement = ui.nodes.get('wp-catchup-btn'); const notices = ui.notices.length;
  finish({ handled: false, error: 'Old room failure' }); await flush();
  assert.equal(replacement.disabled, false);
  assert.equal(replacement.isConnected, true);
  assert.equal(ui.notices.length, notices);
  for (const drift of [NaN, Infinity, 2]) {
    ui.api.showCatchUpButton(drift); assert.equal(ui.nodes.has('wp-catchup-btn'), false);
  }
  for (const state of [{ hasVideo: false }, { hasVideo: true, wsConnected: false }, { hasVideo: true, mediaMismatch: true }]) {
    ui.inRoom(false, {}, state); ui.api.showCatchUpButton(15);
    assert.equal(ui.nodes.has('wp-catchup-btn'), false);
  }
  ui.inRoom(true, {}, { hasVideo: true }); ui.api.showCatchUpButton(15);
  assert.equal(ui.nodes.has('wp-catchup-btn'), false);
});

test('personal checkbox storage failures restore confirmed values and report errors', async () => {
  for (const id of ['wp-settings-compact', 'wp-settings-sound', 'wp-settings-floating']) {
    const ui = overlayRuntime();
    ui.storageWriter(() => Promise.reject(new Error('Storage unavailable')));
    const checkbox = ui.nodes.get(id); const original = checkbox.checked;
    checkbox.checked = !original; checkbox.dispatch('change');
    assert.equal(checkbox.disabled, true);
    await flush();
    assert.equal(checkbox.checked, original, id);
    assert.equal(checkbox.disabled, false);
    assert.match(ui.notices.at(-1), /Could not confirm.*saved/);
  }
});

test('pending personal saves survive refresh, deduplicate attempts, and time out visibly', async () => {
  const ui = overlayRuntime(); let writes = 0;
  ui.storageWriter(() => { writes += 1; return new Promise(() => {}); });
  const checkbox = ui.nodes.get('wp-settings-compact'); checkbox.checked = true;
  checkbox.dispatch('change'); checkbox.dispatch('change');
  ui.api.updateState({ inRoom: false });
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.disabled, true);
  assert.equal(writes, 1);
  [...ui.timers.values()].find(timer => timer.ms === 8000).callback(); await flush();
  assert.equal(checkbox.checked, false);
  assert.equal(checkbox.disabled, false);
  assert.match(ui.notices.at(-1), /Could not confirm.*saved/);
});

test('accent failures do not pretend the requested color was saved', async () => {
  const ui = overlayRuntime(); let finish;
  ui.storageWriter(() => new Promise((_, reject) => { finish = reject; }));
  const swatches = ui.document.querySelectorAll('.wp-color-btn');
  const active = swatches.find(button => button.getAttribute('aria-pressed') === 'true');
  swatches[2].click();
  assert.equal(swatches.every(button => button.disabled), true);
  assert.equal(swatches[2].getAttribute('aria-pressed'), 'false');
  finish(new Error('No storage')); await flush();
  assert.equal(active.getAttribute('aria-pressed'), 'true');
  assert.equal(swatches.every(button => !button.disabled), true);
  assert.match(ui.notices.at(-1), /Could not confirm.*saved/);
});

test('failed name saves retain drafts and do not dispatch room-name changes', async () => {
  const ui = overlayRuntime(); ui.inRoom();
  ui.storageWriter(() => Promise.reject(new Error('No storage')));
  const name = ui.nodes.get('wp-settings-username'); name.value = 'Unsaved name'; name.dispatch('input');
  name.dispatch('keydown', { key: 'Enter' }); await flush();
  ui.inRoom();
  assert.equal(name.value, 'Unsaved name');
  assert.equal(ui.nodes.get('wp-settings-save-name').disabled, false);
  assert.equal(ui.actions.some(action => action.action === ui.constants.ACTION.SESSION_USERNAME_UPDATE), false);
  assert.match(ui.notices.at(-1), /Could not confirm.*saved/);
});

test('saved local names distinguish rejected live-room updates and never retarget after a room change', async () => {
  const ui = overlayRuntime(); ui.inRoom(); const sent = [];
  ui.api.setActionDispatcher(action => { sent.push(action); return { handled: false }; });
  const name = ui.nodes.get('wp-settings-username'); name.value = 'Saved locally';
  name.dispatch('keydown', { key: 'Enter' }); await flush();
  assert.equal(sent[0].roomId, 'test-room');
  assert.equal(ui.saved.at(-1)[ui.constants.STORAGE.USERNAME], 'Saved locally');
  assert.match(ui.notices.at(-1), /saved for this browser.*room update failed/);
  let finish; ui.storageWriter(() => new Promise(resolve => { finish = resolve; }));
  name.value = 'Second name'; name.dispatch('keydown', { key: 'Enter' });
  ui.inRoom(false, { id: 'new-room' }); finish(); await flush();
  assert.equal(sent.length, 1, 'storage completion cannot issue a name mutation in a later room');
});

test('lobby name save failures block create and join, preserve drafts, and never claim success', async () => {
  for (const buttonId of ['wp-lobby-create-btn', 'wp-lobby-join-btn']) {
    const ui = overlayRuntime();
    ui.storageWriter(() => Promise.reject(new Error('No storage')));
    const name = ui.nodes.get('wp-lobby-username'); name.value = 'Unsaved lobby name'; name.dispatch('input');
    ui.nodes.get('wp-lobby-join-input').value = 'test-room-id';
    ui.nodes.get(buttonId).click(); await flush(); ui.api.updateState({ inRoom: false });
    assert.equal(name.value, 'Unsaved lobby name');
    assert.equal(ui.actions.some(action => [ui.constants.ACTION.ROOM_JOIN, ui.constants.ACTION.ROOM_CREATE].includes(action.action)), false);
    assert.match(ui.nodes.get('wp-lobby-create-feedback').textContent, /Could not save/);
    assert.equal(ui.notices.includes('Display name saved.'), false);
  }
});

function reactionControl(ui) {
  ui.inRoom(false, { public: true }, { userId: 'me' });
  ui.api.appendChatMessage({ id: 'message-1', user: 'peer', content: 'hello' }, { ...ui.room, public: true }, 'me');
  const trigger = ui.document.querySelector('.wp-msg-react-trigger');
  const pills = ui.document.querySelector('.wp-msg-pills');
  return { pills, send() { trigger.click(); ui.document.dispatch('wp-emoji-selected', { detail: '👍' }); } };
}

test('reaction rejection is visible, retryable, room-scoped, and never adds a false reaction', async () => {
  const ui = overlayRuntime(); const reaction = reactionControl(ui); let finish; const sent = [];
  ui.api.setActionDispatcher(action => { sent.push(action); return new Promise(resolve => { finish = resolve; }); });
  reaction.send(); reaction.send();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].roomId, 'test-room');
  assert.equal(reaction.pills.childElementCount, 0);
  finish({ handled: false, error: 'Reaction not sent' }); await flush();
  assert.match(ui.notices.at(-1), /Reaction not sent/);
  reaction.send(); assert.equal(sent.length, 2);
  finish({ handled: true }); await flush();
  assert.equal(reaction.pills.childElementCount, 0, 'only an actual server event may add a reaction count');
});

test('reaction exceptions and timeouts report failure, but stale results do not affect another room', async () => {
  const ui = overlayRuntime(); const reaction = reactionControl(ui);
  ui.api.setActionDispatcher(() => { throw new Error('Disconnected'); });
  reaction.send(); await flush(); assert.match(ui.notices.at(-1), /Could not send reaction/);
  let finish; ui.api.setActionDispatcher(() => new Promise(resolve => { finish = resolve; }));
  reaction.send(); [...ui.timers.values()].find(timer => timer.ms === 8000).callback(); await flush();
  assert.match(ui.notices.at(-1), /No response/);
  reaction.send(); const notices = ui.notices.length;
  ui.inRoom(false, { id: 'another-room' }); finish({ handled: false, error: 'Stale error' }); await flush();
  assert.equal(ui.notices.length, notices);
});

test('Make Host stays disabled through pending refresh and surfaces failed scoped requests', async () => {
  const ui = overlayRuntime(); const room = { owner: 'me', users: [{ id: 'me', name: 'Me' }, { id: 'peer', name: 'Peer' }] };
  ui.inRoom(true, room, { userId: 'me' }); let finish; const sent = [];
  ui.api.setActionDispatcher(action => { sent.push(action); return new Promise(resolve => { finish = resolve; }); });
  const button = ui.document.querySelector('.wp-transfer-btn'); button.click(); button.click();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].roomId, 'test-room'); assert.equal(sent[0].targetUserId, 'peer');
  assert.equal(button.disabled, true);
  ui.inRoom(true, { ...room, users: room.users.map(user => ({ ...user, playbackTime: 10 })) }, { userId: 'me' });
  assert.equal(ui.document.querySelector('.wp-transfer-btn').disabled, true);
  finish({ handled: false, error: 'Transfer rejected' }); await flush();
  assert.equal(ui.document.querySelector('.wp-transfer-btn').disabled, false);
  assert.match(ui.notices.at(-1), /Transfer rejected/);
  ui.document.querySelector('.wp-transfer-btn').click(); finish({ handled: true }); await flush();
  assert.equal(ui.notices.at(-1), 'Host transfer requested.');
});

test('Make Host handles timeout and disconnect without affecting replacement memberships', async () => {
  const ui = overlayRuntime(); const room = { owner: 'me', users: [{ id: 'peer', name: 'Peer' }] };
  ui.inRoom(true, room, { userId: 'me' }); let finish;
  ui.api.setActionDispatcher(() => new Promise(resolve => { finish = resolve; }));
  ui.document.querySelector('.wp-transfer-btn').click();
  [...ui.timers.values()].find(timer => timer.ms === 8000).callback(); await flush();
  assert.equal(ui.document.querySelector('.wp-transfer-btn').disabled, false);
  assert.match(ui.notices.at(-1), /No response/);
  ui.document.querySelector('.wp-transfer-btn').click(); const notices = ui.notices.length;
  ui.inRoom(true, { ...room, id: 'replacement-room' }, { userId: 'me' });
  finish({ handled: false, error: 'Old room rejected' }); await flush();
  assert.equal(ui.notices.length, notices);
  assert.equal(ui.document.querySelector('.wp-transfer-btn').disabled, false);
  ui.inRoom(true, { ...room, id: 'replacement-room' }, { userId: 'me', wsConnected: false });
  assert.equal(ui.document.querySelector('.wp-transfer-btn').disabled, true);
});

test('lobby create and join handle dispatcher refusal, exception and rejection without losing drafts', async () => {
  for (const mode of ['create', 'join']) for (const failure of ['refused', 'thrown', 'rejected']) {
    const ui = overlayRuntime();
    const input = ui.nodes.get('wp-lobby-join-input'); input.value = 'private-room#accessKey=preserved-key&e2eKey=preserved-cipher';
    ui.api.setActionDispatcher(() => {
      if (failure === 'thrown') throw new Error('No transport');
      if (failure === 'rejected') return Promise.reject(new Error('No transport'));
      return { handled: false, error: 'Controller unavailable' };
    });
    ui.nodes.get(`wp-lobby-${mode}-btn`).click(); await flush();
    assert.equal(ui.nodes.get('wp-lobby-create-btn').disabled, false);
    assert.equal(ui.nodes.get('wp-lobby-join-btn').disabled, false);
    assert.match(ui.nodes.get(`wp-lobby-${mode}-feedback`).textContent, /Controller unavailable|Could not send room request/);
    assert.equal(input.value, 'private-room#accessKey=preserved-key&e2eKey=preserved-cipher');
  }
});

test('pending lobby requests suppress cross-action duplicates and become retryable on transport timeout', async () => {
  const ui = overlayRuntime(); const sent = [];
  ui.api.setActionDispatcher(action => { sent.push(action); return new Promise(() => {}); });
  ui.nodes.get('wp-lobby-create-btn').click();
  ui.nodes.get('wp-lobby-join-input').value = 'other-room'; ui.nodes.get('wp-lobby-join-btn').click();
  await flush(); ui.api.updateState({ inRoom: false });
  assert.equal(sent.length, 1);
  assert.equal(ui.nodes.get('wp-lobby-create-btn').disabled, true);
  assert.equal(ui.nodes.get('wp-lobby-join-btn').disabled, true);
  [...ui.timers.values()].find(timer => timer.ms === 8000).callback(); await flush();
  assert.equal(ui.nodes.get('wp-lobby-create-btn').disabled, false);
  assert.match(ui.nodes.get('wp-lobby-create-feedback').textContent, /No response/);
});

test('accepted lobby dispatch waits for membership and missing confirmation offers explicit retry', async () => {
  for (const mode of ['create', 'join']) {
    const ui = overlayRuntime(); ui.nodes.get('wp-lobby-join-input').value = 'target-room';
    ui.nodes.get(`wp-lobby-${mode}-btn`).click(); await flush();
    assert.equal(ui.nodes.get(`wp-lobby-${mode}-btn`).disabled, true);
    const timeout = [...ui.timers.values()].find(timer => timer.ms === 15000);
    timeout.callback(); await flush();
    assert.equal(ui.nodes.get(`wp-lobby-${mode}-btn`).disabled, false);
    assert.match(ui.nodes.get(`wp-lobby-${mode}-feedback`).textContent, /membership was not confirmed/);
    const action = mode === 'create' ? ui.constants.ACTION.ROOM_CREATE : ui.constants.ACTION.ROOM_JOIN;
    assert.equal(ui.actions.filter(message => message.action === action).length, 1, 'no automatic mutation retry');
  }
});

test('lobby server rejection and connected room replacement invalidate late dispatch and timers', async () => {
  const ui = overlayRuntime(); let finish;
  ui.api.setActionDispatcher(() => new Promise(resolve => { finish = resolve; }));
  ui.nodes.get('wp-lobby-join-input').value = 'target-room';
  ui.nodes.get('wp-lobby-join-btn').click(); await flush();
  ui.api.showRoomError({ code: 'INVALID_ROOM_KEY' });
  assert.equal(ui.nodes.get('wp-lobby-join-btn').disabled, false);
  finish({ handled: true }); await flush();
  assert.match(ui.nodes.get('wp-lobby-join-feedback').textContent, /fresh full invite/);
  ui.nodes.get('wp-lobby-join-btn').click(); await flush();
  const timeout = [...ui.timers.values()].find(timer => timer.ms === 15000);
  ui.inRoom(false, { id: 'target-room' });
  finish({ handled: false, error: 'Old dispatch failure' }); timeout.callback(); await flush();
  assert.equal(ui.notices.includes('Old dispatch failure'), false);
  ui.api.updateState({ inRoom: false });
  assert.equal(ui.nodes.get('wp-lobby-join-btn').disabled, false);
});

test('lobby storage completion cannot issue an old request after joining another room', async () => {
  const ui = overlayRuntime(); let finish;
  ui.storageWriter(() => new Promise(resolve => { finish = resolve; }));
  ui.nodes.get('wp-lobby-create-btn').click();
  ui.inRoom(false, { id: 'joined-elsewhere' }); finish(); await flush();
  assert.equal(ui.actions.some(action => action.action === ui.constants.ACTION.ROOM_CREATE), false);
});

test('an incomplete private lobby invite remains intact for correction instead of dropping its access key', async () => {
  const ui = overlayRuntime(); const input = ui.nodes.get('wp-lobby-join-input');
  input.value = 'private-room#accessKey=preserved-key';
  ui.nodes.get('wp-lobby-join-btn').click(); await flush();
  assert.equal(input.value, 'private-room#accessKey=preserved-key');
  assert.equal(ui.nodes.get('wp-lobby-join-btn').disabled, false);
  assert.match(ui.nodes.get('wp-lobby-join-feedback').textContent, /full invite link.*e2eKey/);
  assert.equal(ui.actions.some(action => action.action === ui.constants.ACTION.ROOM_JOIN), false);
});
