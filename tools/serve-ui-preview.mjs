import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(toolsRoot, '../extension');
const previewRoot = path.join(toolsRoot, 'ui-preview');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const extensionPages = new Set(['options.html', 'popup.html', 'sidepanel.html']);

export function createPreviewServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
    const send = (code, message) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : message); };
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'Read-only preview server');
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(req.headers.host || '')) return send(403, 'Local preview only');
    try {
      const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      if (pathname.includes('\\') || pathname.includes('\0')) return send(403, 'Invalid path');
      let root;
      let relative;
      if (pathname === '/') { root = previewRoot; relative = 'index.html'; }
      else if (pathname.startsWith('/preview/')) { root = previewRoot; relative = pathname.slice('/preview/'.length); }
      else if (pathname.startsWith('/extension/')) { root = extensionRoot; relative = pathname.slice('/extension/'.length); }
      else return send(404, 'Not found');
      const candidate = path.resolve(root, relative);
      if (!candidate.startsWith(root + path.sep) || !mime[path.extname(candidate)]) return send(403, 'Invalid path');
      const actual = await fs.realpath(candidate);
      if (!actual.startsWith(root + path.sep)) return send(403, 'Invalid path');
      let body = await fs.readFile(actual);
      if (root === extensionRoot && extensionPages.has(path.relative(extensionRoot, actual))) {
        // Only the local preview response receives the shim. Release sources
        // and packaged extension files stay untouched.
        body = Buffer.from(body.toString('utf8').replace('<head>', '<head>\n  <script src="/preview/bridge.js"></script>'));
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(actual)], 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      send(error instanceof URIError ? 400 : 404, 'Not found');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WATCHPARTY_UI_PREVIEW_PORT || 8091);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid preview port');
  const server = createPreviewServer();
  server.on('error', error => { console.error(`UI preview could not start: ${error.code || error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`WatchParty UI playground: http://localhost:${port}/ (sample data, no real syncing)`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
