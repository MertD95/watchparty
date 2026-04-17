// Dev file watcher - sends SSE "reload" events when extension files change.
// Usage: npm run dev
// The extension's background.js connects to this and calls chrome.runtime.reload().

import { watch } from 'chokidar';
import { createServer } from 'http';

const PORT = 5111;
const EXT_DIR = './extension';
let clients = [];

function isIgnoredPath(changedPath) {
  return /(^|[\\/])(\.git|node_modules|_metadata)([\\/]|$)/.test(changedPath);
}

function broadcastReload(reason, changedPath) {
  const source = changedPath.replaceAll('\\', '/');
  console.log(`  ${reason}: ${source} -> reloading extension`);
  clients = clients.filter((res) => {
    try {
      res.write('data: reload\n\n');
      return true;
    } catch {
      return false;
    }
  });
}

const server = createServer((req, res) => {
  if (req.url !== '/reload') {
    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: connected\n\n');
  clients.push(res);
  req.on('close', () => {
    clients = clients.filter((client) => client !== res);
  });
});

const watcher = watch(EXT_DIR, {
  ignored: isIgnoredPath,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 300 },
});

let debounce = null;

function queueReload(reason, changedPath) {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    broadcastReload(reason, changedPath);
  }, 200);
}

watcher.on('change', (changedPath) => {
  queueReload('Changed', changedPath);
});

watcher.on('add', (changedPath) => {
  queueReload('Added', changedPath);
});

watcher.on('unlink', (changedPath) => {
  queueReload('Removed', changedPath);
});

watcher.on('error', (error) => {
  console.warn(`Watcher error: ${error.message}`);
});

server.listen(PORT, () => {
  console.log(`WatchParty dev reload server on http://localhost:${PORT}`);
  console.log(`Watching ${EXT_DIR} for changes...`);
});
