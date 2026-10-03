import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const landingRoot = path.resolve(__dirname, '..', 'landing');
const fixturesRoot = path.resolve(__dirname, '..', 'manual-fixtures');
const extensionRoot = path.resolve(__dirname, '..', 'extension');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function createLandingServer({ landingRoot: landingDir = landingRoot, fixturesRoot: fixturesDir = fixturesRoot, extensionRoot: extensionDir = extensionRoot } = {}) {
  const roots = { landing: path.resolve(landingDir), fixtures: path.resolve(fixturesDir), extension: path.resolve(extensionDir) };
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : message);
    };
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return send(405, 'Read-only local server');
    }
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(req.headers.host || '')) return send(403, 'Local server only');
    try {
      const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')) return send(403, 'Invalid path');
      let root = roots.landing;
      let relative = pathname.slice(1);
      if (pathname === '/' || /^\/r\/[a-z0-9-]+\/?$/.test(pathname)) relative = 'index.html';
      else if (pathname.startsWith('/__manual-fixtures/')) {
        root = roots.fixtures;
        relative = pathname.slice('/__manual-fixtures/'.length);
      } else if (pathname.startsWith('/__extension/')) {
        root = roots.extension;
        relative = pathname.slice('/__extension/'.length);
      }
      const candidate = path.resolve(root, relative);
      if (!isWithinRoot(root, candidate)) return send(403, 'Invalid path');
      const contentType = MIME.get(path.extname(candidate));
      if (!contentType) return send(404, 'Not found');
      // Check the real path too: a symlink must not expose files outside the asset root.
      const [actualRoot, actual] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
      if (!isWithinRoot(actualRoot, actual)) return send(403, 'Invalid path');
      if (!(await fs.stat(actual)).isFile()) return send(404, 'Not found');
      const body = await fs.readFile(actual);
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      send(error instanceof URIError ? 400 : 404, 'Not found');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WATCHPARTY_LANDING_PORT || 8090);
  const host = process.env.WATCHPARTY_LANDING_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid landing port');
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('Landing server must bind to loopback');
  const server = createLandingServer();
  server.on('error', error => { console.error(`Landing server could not start: ${error.code || error.message}`); process.exitCode = 1; });
  server.listen(port, host, () => process.stdout.write(`WATCHPARTY_LANDING_LOCAL_READY ${host}:${port}\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
