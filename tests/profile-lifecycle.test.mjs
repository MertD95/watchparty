import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension/stremio-profile.js'), 'utf8');

function runtime() {
  const listeners = new Set();
  const writes = [];
  let intervals = 0;
  const context = vm.createContext({
    document: { visibilityState: 'visible', addEventListener: (_type, callback) => listeners.add(callback), removeEventListener: (_type, callback) => listeners.delete(callback) },
    localStorage: { getItem: () => JSON.stringify({ addons: [{ transportUrl: 'https://example.test' }] }) },
    WPRuntimeState: { set: async values => { writes.push(values); } },
    WPConstants: { STORAGE: { STREMIO_PROFILE: 'stremioProfile' }, ACTION: { PROFILE_UPDATED: 'profile.updated' } },
    chrome: { runtime: { sendMessage: async () => ({}) } },
    setInterval: () => ++intervals, clearInterval() {},
  });
  vm.runInContext(source, context);
  return { context, api: vm.runInContext('WPProfile', context), writes, listeners, intervals: () => intervals };
}

test('profile start is idempotent and stop removes visibility-triggered writes', async () => {
  const app = runtime();
  app.api.start();
  app.api.start();
  assert.equal(app.intervals(), 1);
  assert.equal(app.listeners.size, 1);
  assert.equal(app.writes.length, 1);
  await app.api.stop({ forget: true });
  assert.equal(app.listeners.size, 0);
  app.api.readAndCache();
  assert.equal(app.writes.length, 1);
  app.api.start();
  assert.equal(app.writes.length, 2);
});

test('profile stop drains an already-started storage write before reset can delete it', async () => {
  const app = runtime();
  let finishWrite;
  app.context.WPRuntimeState.set = () => new Promise(resolve => { finishWrite = resolve; });
  app.api.start();
  let stopped = false;
  const stop = app.api.stop({ forget: true }).then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finishWrite();
  await stop;
  assert.equal(stopped, true);
});
