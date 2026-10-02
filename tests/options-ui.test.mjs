import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markup = fs.readFileSync(path.join(root, 'extension/options.html'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

// Event-focused adapter: the MCP browser checks actual layout and keyboard use.
function optionsRuntime({ installed = true, initialStatus = null, preferenceRead = async () => ({}) } = {}) {
  const nodes = new Map();
  const removed = [];
  const messages = [];
  const confirmations = [];
  let confirmed = false;
  let keysCleared = 0;
  class Element {
    className = '';
    textContent = '';
    children = [];
    dataset = {};
    listeners = new Map();
    disabled = false;
    hidden = false;
    classList = {
      contains: value => this.className.split(' ').includes(value),
      add: value => { this.className = [...new Set([...this.className.split(' '), value])].join(' '); },
      remove: value => { this.className = this.className.split(' ').filter(part => part !== value).join(' '); },
      toggle: (value, force) => {
        const include = force ?? !this.classList.contains(value);
        this.classList[include ? 'add' : 'remove'](value);
        return include;
      },
    };
    setAttribute(key, value) { this[key] = value; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    replaceChildren() { this.children = []; }
    appendChild(child) { this.children.push(child); }
    append(value) { this.children.push(value); }
  }
  class Button extends Element {}
  for (const match of markup.matchAll(/<([a-z][a-z0-9-]*)([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const node = new (match[1] === 'button' ? Button : Element)();
    node.className = match[2].match(/\bclass="([^"]*)"/)?.[1] || '';
    const mode = match[2].match(/\bdata-mode="([^"]+)"/)?.[1];
    if (mode) node.dataset.mode = mode;
    nodes.set(match[3], node);
  }
  const context = vm.createContext({
    console,
    HTMLButtonElement: Button,
    document: {
      readyState: 'loading', hidden: false,
      getElementById: id => nodes.get(id) || null,
      querySelectorAll: () => [...nodes.values()].filter(node => node instanceof Button && node.dataset.mode),
      createElement: () => new Element(), addEventListener() {},
    },
    window: { addEventListener() {}, confirm(message) { confirmations.push(message); return confirmed; } },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    navigator: { clipboard: { writeText: async () => {} } },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '2.0.2', ...(installed ? { update_url: 'https://example.com/update' } : {}) }),
        sendMessage: async message => { messages.push(message); return message.action === 'status.get' ? initialStatus : { ok: true }; },
      },
      storage: { onChanged: { addListener() {} } },
      tabs: { create() {} },
    },
    WPRuntimeState: { get: preferenceRead, set: async () => {}, remove: async keys => { removed.push(...keys); } },
    WPRoomKeys: { clearAll: async () => { keysCleared += 1; return { count: 2 }; } },
  });
  for (const file of ['wp-actions.js', 'constants.js', 'options.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'extension', file), 'utf8'), context, { filename: file });
  }
  // Read the action constant from production code instead of duplicating its value.
  const statusAction = vm.runInContext('WPConstants.ACTION.STATUS_GET', context);
  context.chrome.runtime.sendMessage = async message => {
    messages.push(message);
    return message.action === statusAction ? initialStatus : { ok: true };
  };
  return {
    nodes, removed, messages, confirmations,
    get keysCleared() { return keysCleared; },
    confirm(value) { confirmed = value; },
    run: code => vm.runInContext(code, context),
    render(status) { context.fixture = status; vm.runInContext('renderStatus(fixture)', context); },
    click: id => nodes.get(id).listeners.get('click')(),
    visible: id => !nodes.get(id).classList.contains('hidden') && !nodes.get(id).hidden,
  };
}

test('settings starts with three closed, accessible native disclosures', () => {
  const details = [...markup.matchAll(/<details\b([^>]*)>/g)];
  assert.equal(details.length, 3);
  for (const [, attributes] of details) assert.doesNotMatch(attributes, /\bopen\b/);
  assert.equal([...markup.matchAll(/<summary>/g)].length, 3);
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(markup, /WatchParty → Settings/);
  assert.match(markup, /button:focus-visible, summary:focus-visible/);
});

test('settings presents one primary Stremio action for idle, active and pending rooms', () => {
  const ui = optionsRuntime();
  ui.render({ backendMode: 'auto', wsConnected: false });
  assert.equal(ui.visible('btn-open-stremio'), true);
  assert.equal(ui.visible('btn-resume-room'), false);
  assert.equal(ui.nodes.get('btn-resume-room').disabled, true);
  ui.render({ room: { id: 'room-1', name: 'Movie night', users: [{}] }, wsConnected: true });
  assert.equal(ui.visible('btn-open-stremio'), false);
  assert.equal(ui.visible('btn-resume-room'), true);
  assert.equal(ui.nodes.get('btn-resume-room').textContent, 'Return to room');
  assert.equal(ui.nodes.get('session-title').textContent, 'Movie night');
  ui.render({ bootstrapPending: true, wsConnected: false });
  assert.equal(ui.nodes.get('btn-resume-room').textContent, 'Continue in Stremio');
  assert.equal(ui.nodes.get('btn-resume-room').disabled, false);
  assert.match(ui.nodes.get('hero-note').textContent, /room setup/);
  ui.render({ currentRoomId: 'abcdefgh1234', wsConnected: false });
  assert.match(ui.nodes.get('hero-note').textContent, /saved room/);
  assert.match(ui.nodes.get('session-title').textContent, /abcdefgh/);
});

test('installed settings hides development-only connection and localhost permission controls', () => {
  const ui = optionsRuntime();
  ui.render({ backendMode: 'auto', wsConnected: false });
  assert.equal(ui.visible('backend-local'), false);
  assert.equal(ui.nodes.get('backend-local').disabled, true);
  assert.equal(ui.nodes.get('backend-auto')['aria-pressed'], 'true');
  assert.equal(ui.visible('dev-localhost-block'), false);
  const dev = optionsRuntime({ installed: false });
  dev.render({ backendMode: 'local', isDevInstall: true, localLandingAccess: { available: true, granted: false } });
  assert.equal(dev.visible('backend-local'), true);
  assert.equal(dev.visible('dev-localhost-block'), true);
  assert.equal(dev.nodes.get('backend-local')['aria-pressed'], 'true');
});

test('missing status and server diagnostics are not shown as verified healthy', () => {
  const ui = optionsRuntime();
  ui.render(null);
  assert.equal(ui.nodes.get('diag-issue-summary').textContent, 'Unavailable');
  assert.equal(ui.nodes.get('diag-ws').textContent, 'Unavailable');
  assert.equal(ui.nodes.get('pill-extension').textContent, 'Status unavailable');
  ui.render({ wsConnected: true, invariants: [] });
  assert.equal(ui.nodes.get('diag-issue-summary').textContent, 'No warnings reported');
  assert.match(ui.nodes.get('diag-server-generated').textContent, /Extension checks only/);
  assert.match(ui.nodes.get('diag-server-issue-list').children[0].textContent, /not available/);
});

test('cancelling recovery confirmations never removes saved state or room keys', async () => {
  const ui = optionsRuntime();
  ui.run('bindRecoveryButtons()');
  for (const id of ['btn-clear-bootstrap', 'btn-clear-room-keys', 'btn-reset-runtime']) ui.click(id);
  await flush();
  assert.equal(ui.confirmations.length, 3);
  assert.deepEqual(ui.removed, []);
  assert.equal(ui.keysCleared, 0);
  assert.equal(ui.messages.length, 0);
});

test('confirmed reset clears runtime data but preserves appearance and connection preferences', async () => {
  const ui = optionsRuntime();
  ui.run('bindRecoveryButtons()');
  ui.confirm(true);
  ui.click('btn-reset-runtime');
  await flush();
  assert.equal(ui.keysCleared, 1);
  assert.ok(ui.removed.includes('wpUsername'));
  assert.ok(ui.removed.includes('wpSessionToken'));
  assert.ok(ui.removed.includes('currentRoom'));
  for (const retained of ['wpAccentColor', 'wpCompactChat', 'wpReactionSound', 'wpFloatingReactions', 'wpBackendMode']) {
    assert.equal(ui.removed.includes(retained), false, `${retained} must be retained`);
  }
  assert.match(ui.nodes.get('recovery-feedback').textContent, /preferences were kept/);
  assert.equal(ui.nodes.get('btn-reset-runtime').disabled, false);
});

test('late saved preference read does not replace a newer live room snapshot', async () => {
  let finishPreferenceRead;
  const preferenceRead = () => new Promise(resolve => { finishPreferenceRead = resolve; });
  const ui = optionsRuntime({
    initialStatus: { room: { id: 'current-room', name: 'Live room', users: [] }, wsConnected: true },
    preferenceRead,
  });
  ui.run('init()');
  await flush();
  assert.equal(ui.nodes.get('session-title').textContent, 'Live room');
  finishPreferenceRead({ wpBackendMode: 'auto' });
  await flush();
  assert.equal(ui.visible('session-card'), true);
  assert.equal(ui.nodes.get('session-title').textContent, 'Live room');
  assert.equal(ui.visible('btn-resume-room'), true);
});
