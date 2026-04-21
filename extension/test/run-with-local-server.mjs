import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { delay, pollUntil } from './assertions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHPARTY_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_ROOT = path.resolve(WATCHPARTY_ROOT, '..', 'watchparty-server');
const LOCAL_SERVER_PORT = Number(process.env.WATCHPARTY_TEST_SERVER_PORT || 8181);
const LOCAL_READY_URL = `http://localhost:${LOCAL_SERVER_PORT}/ready`;
const LOCAL_HEALTH_URL = `http://localhost:${LOCAL_SERVER_PORT}/health`;
const TARGET_SCRIPT = process.argv[2];
const TARGET_ARGS = process.argv.slice(3);
const REUSE_EXISTING = process.env.WATCHPARTY_REUSE_LOCAL_SERVER === '1';
const VERBOSE_SERVER = process.env.WATCHPARTY_VERBOSE_LOCAL_SERVER === '1';
const SERVER_LOG_LIMIT = 200;

if (!TARGET_SCRIPT) {
  console.error('Usage: node extension/test/run-with-local-server.mjs <script> [...args]');
  process.exit(1);
}

function bufferLine(lines, line) {
  lines.push(line);
  if (lines.length > SERVER_LOG_LIMIT) lines.shift();
}

async function isEndpointReady(url) {
  try {
    const response = await fetch(url, {
      headers: { 'cache-control': 'no-cache' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function isPortBusy(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function ensureManagedServerCanStart() {
  const ready = await isEndpointReady(LOCAL_READY_URL);
  if (ready && REUSE_EXISTING) return { reuse: true };
  if (ready && !REUSE_EXISTING) {
    throw new Error(
      `A WatchParty server is already running on localhost:${LOCAL_SERVER_PORT}. `
      + 'Stop it before running the managed test suite, or set WATCHPARTY_REUSE_LOCAL_SERVER=1 to reuse it explicitly.'
    );
  }

  const portBusy = await isPortBusy(LOCAL_SERVER_PORT);
  if (portBusy) {
    throw new Error(`Port ${LOCAL_SERVER_PORT} is already in use by another process. Stop it before running the managed test suite.`);
  }

  return { reuse: false };
}

function createLineReader(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buffer) onLine(buffer);
  });
}

async function startManagedServer() {
  const stdoutLines = [];
  const stderrLines = [];
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(LOCAL_SERVER_PORT),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  createLineReader(child.stdout, (line) => {
    bufferLine(stdoutLines, line);
    if (VERBOSE_SERVER) console.log(`[watchparty-server] ${line}`);
  });
  createLineReader(child.stderr, (line) => {
    bufferLine(stderrLines, line);
    if (VERBOSE_SERVER) console.error(`[watchparty-server] ${line}`);
  });

  let exited = false;
  let exitCode = null;
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  try {
    await pollUntil(async () => {
      if (exited) {
        const combinedLogs = [...stdoutLines, ...stderrLines].join('\n');
        throw new Error(
          `Managed WatchParty server exited before becoming ready (code ${exitCode ?? 'unknown'}).`
          + (combinedLogs ? `\n${combinedLogs}` : '')
        );
      }
      return (await isEndpointReady(LOCAL_READY_URL)) || false;
    }, {
      timeout: 20000,
      intervalMs: 150,
      label: `local WatchParty server on port ${LOCAL_SERVER_PORT}`,
    });
  } catch (error) {
    child.kill();
    throw error;
  }

  return { child, stdoutLines, stderrLines };
}

async function stopManagedServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGINT');
  for (let attempt = 0; attempt < 20; attempt++) {
    if (child.exitCode !== null) return;
    await delay(100);
  }
  child.kill();
}

async function runTargetScript() {
  const child = spawn(process.execPath, [TARGET_SCRIPT, ...TARGET_ARGS], {
    cwd: WATCHPARTY_ROOT,
    env: {
      ...process.env,
      WATCHPARTY_MANAGED_LOCAL_SERVER: '1',
      WATCHPARTY_TEST_SERVER_PORT: String(LOCAL_SERVER_PORT),
    },
    stdio: 'inherit',
  });

  const code = await new Promise((resolve, reject) => {
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
    child.once('error', reject);
  });
  return code;
}

async function main() {
  let managedServer = null;
  try {
    const { reuse } = await ensureManagedServerCanStart();
    if (reuse) {
      const code = await runTargetScript();
      process.exit(code);
    }

    managedServer = await startManagedServer();
    const healthOk = await isEndpointReady(LOCAL_HEALTH_URL);
    if (!healthOk) {
      throw new Error(`Managed WatchParty server never reported healthy on ${LOCAL_HEALTH_URL}.`);
    }

    const code = await runTargetScript();
    process.exitCode = code;
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  } finally {
    await stopManagedServer(managedServer?.child);
  }
}

main();
