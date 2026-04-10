/**
 * Test the WatchParty extension by launching Chrome with it loaded
 * and verifying CORS headers are injected on Stremio requests.
 *
 * Usage: node watchparty-extension/test-extension.mjs
 */
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const EXT_DIR = join(import.meta.dirname);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9333;
const TEMP_PROFILE = mkdtempSync(join(tmpdir(), 'wp-ext-test-'));

console.log('=== WatchParty Extension Test ===\n');
console.log('Extension:', EXT_DIR);
console.log('Temp profile:', TEMP_PROFILE);

// 1. Check Stremio is running
try {
  await fetchJSON('http://localhost:11470/stats.json');
  console.log('Stremio: running\n');
} catch {
  console.error('ERROR: Stremio is not running on localhost:11470');
  process.exit(1);
}

// 2. Launch Chrome with extension
console.log('Launching Chrome with extension...');
const chrome = execFile(CHROME, [
  `--load-extension=${EXT_DIR}`,
  `--disable-extensions-except=${EXT_DIR}`,
  `--user-data-dir=${TEMP_PROFILE}`,
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
]);

// Give Chrome time to start
await sleep(3000);

// 3. Connect via CDP and run tests
try {
  // Get CDP websocket URL
  const targets = await fetchJSON(`http://localhost:${DEBUG_PORT}/json`);
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No page target found');

  const ws = await connectCDP(page.webSocketDebuggerUrl);

  // Enable Runtime
  await cdpSend(ws, 'Runtime.enable');

  // Navigate to a test page on localhost:8080 (WatchParty dev)
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Page.navigate', { url: 'http://localhost:8080' });
  await sleep(3000);

  console.log('\n--- Test Results ---\n');

  // Test 1: Extension detection
  const extResult = await cdpEval(ws, `document.documentElement.getAttribute('data-watchparty-ext')`);
  const extDetected = extResult === '1';
  console.log(`Extension detected: ${extDetected ? 'PASS' : 'FAIL'} (attribute=${extResult})`);

  // Test 2: CORS on /stats.json (has unconditional CORS anyway)
  const statsResult = await cdpEval(ws, `
    fetch('http://localhost:11470/stats.json')
      .then(r => ({ status: r.status, cors: r.headers.get('access-control-allow-origin') }))
      .catch(e => ({ error: e.message }))
  `, true);
  console.log(`CORS /stats.json: ${statsResult.error ? 'FAIL - ' + statsResult.error : 'PASS'} (status=${statsResult.status})`);

  // Test 3: CORS on /hlsv2/probe (behind whitelist - extension must fix this)
  const probeResult = await cdpEval(ws, `
    fetch('http://localhost:11470/hlsv2/probe?mediaURL=test')
      .then(r => ({ status: r.status, cors: r.headers.get('access-control-allow-origin') }))
      .catch(e => ({ error: e.message }))
  `, true);
  const probePass = !probeResult.error;
  console.log(`CORS /hlsv2/probe: ${probePass ? 'PASS' : 'FAIL'}${probeResult.error ? ' - ' + probeResult.error : ''} (status=${probeResult.status})`);

  // Test 4: CORS on /opensubHash (behind whitelist)
  const hashResult = await cdpEval(ws, `
    fetch('http://localhost:11470/opensubHash?videoUrl=test')
      .then(r => ({ status: r.status, cors: r.headers.get('access-control-allow-origin') }))
      .catch(e => ({ error: e.message }))
  `, true);
  const hashPass = !hashResult.error;
  console.log(`CORS /opensubHash: ${hashPass ? 'PASS' : 'FAIL'}${hashResult.error ? ' - ' + hashResult.error : ''} (status=${hashResult.status})`);

  // Test 5: Check declarativeNetRequest matched rules
  const rulesResult = await cdpEval(ws, `
    (async () => {
      // This only works from extension context, will fail from page — that's OK
      return 'page-context (cannot query rules from here)';
    })()
  `, true);

  console.log(`\n--- Summary ---`);
  const allPass = extDetected && probePass && hashPass;
  console.log(allPass ? '\nALL TESTS PASSED' : '\nSOME TESTS FAILED');

  ws.close();
} catch (e) {
  console.error('Test error:', e.message);
} finally {
  chrome.kill();
}

// --- Helpers ---

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function connectCDP(url) {
  return new Promise((resolve, reject) => {
    // Dynamic import for WebSocket
    import('ws').then(({ default: WS }) => {
      const ws = new WS(url);
      ws._id = 0;
      ws._pending = new Map();
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      ws.on('message', data => {
        const msg = JSON.parse(data);
        if (msg.id && ws._pending.has(msg.id)) {
          ws._pending.get(msg.id)(msg);
          ws._pending.delete(msg.id);
        }
      });
    }).catch(() => {
      // Fallback: use Node's built-in WebSocket if available (Node 22+)
      const ws = new WebSocket(url);
      ws._id = 0;
      ws._pending = new Map();
      ws.onopen = () => resolve(ws);
      ws.onerror = reject;
      ws.onmessage = event => {
        const msg = JSON.parse(event.data);
        if (msg.id && ws._pending.has(msg.id)) {
          ws._pending.get(msg.id)(msg);
          ws._pending.delete(msg.id);
        }
      };
    });
  });
}

function cdpSend(ws, method, params = {}) {
  return new Promise(resolve => {
    const id = ++ws._id;
    ws._pending.set(id, resolve);
    const msg = JSON.stringify({ id, method, params });
    if (ws.send) ws.send(msg);
    else ws.send(msg);
  });
}

async function cdpEval(ws, expression, awaitPromise = false) {
  const result = await cdpSend(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.result?.result?.value !== undefined) return result.result.result.value;
  if (result.result?.exceptionDetails) return { error: result.result.exceptionDetails.text };
  return result.result?.result;
}
