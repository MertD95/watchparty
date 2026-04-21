import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const landingRoot = path.resolve(__dirname, '..', 'landing');
const fixturesRoot = path.resolve(__dirname, '..', 'test-fixtures');
const extensionRoot = path.resolve(__dirname, '..', 'extension');
const port = Number(process.env.WATCHPARTY_LANDING_PORT || 8090);
const host = process.env.WATCHPARTY_LANDING_HOST || '127.0.0.1';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

function safeResolve(root, requestPath) {
  const normalized = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const resolved = path.resolve(root, normalized);
  return resolved.startsWith(root) ? resolved : null;
}

function sendFile(filePath, res) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME.get(path.extname(filePath)) || 'application/octet-stream',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0] || '/';
  let requestedPath = null;
  let fallbackPath = path.resolve(landingRoot, 'index.html');

  if (pathname.startsWith('/__fixtures/')) {
    requestedPath = safeResolve(fixturesRoot, pathname.replace(/^\/__fixtures\//, ''));
    fallbackPath = null;
  } else if (pathname.startsWith('/__extension/')) {
    requestedPath = safeResolve(extensionRoot, pathname.replace(/^\/__extension\//, ''));
    fallbackPath = null;
  } else {
    requestedPath = safeResolve(landingRoot, pathname);
  }

  if (!requestedPath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }

  fs.stat(requestedPath, (error, stats) => {
    if (!error && stats.isFile()) {
      sendFile(requestedPath, res);
      return;
    }
    if (fallbackPath) {
      sendFile(fallbackPath, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
});

server.listen(port, host, () => {
  process.stdout.write(`WATCHPARTY_LANDING_LOCAL_READY ${host}:${port}\n`);
});

function shutdown(signal) {
  server.close(() => {
    process.stdout.write(`WATCHPARTY_LANDING_LOCAL_STOPPED ${signal}\n`);
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
