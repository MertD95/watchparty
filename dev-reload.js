// Dev file watcher — sends SSE "reload" events when extension files change.
// Usage: npm run dev
// The extension's background.js connects to this and calls chrome.runtime.reload().

import { watch } from 'chokidar';
import { createServer } from 'http';

const PORT = 5111;
const EXT_DIR = './extension';
let clients = [];

const server = createServer((req, res) => {
  if (req.url !== '/reload') {
    res.writeHead(404);
    res.end();
    return;
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: connected\n\n');
  clients.push(res);
  req.on('close', () => { clients = clients.filter(c => c !== res); });
});

// Watch extension directory for changes
const watcher = watch(EXT_DIR, {
  ignored: /(^|[\\/])\.git|node_modules/,
  awaitWriteFinish: { stabilityThreshold: 300 },
});

let debounce = null;
watcher.on('change', (path) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    console.log(`  Changed: ${path} → reloading extension`);
    clients.forEach(res => res.write('data: reload\n\n'));
  }, 200);
});

server.listen(PORT, () => {
  console.log(`WatchParty dev reload server on http://localhost:${PORT}`);
  console.log(`Watching ${EXT_DIR} for changes...`);
});
