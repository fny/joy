// Dependency-free dev gateway: same-origin relay API and exported Expo web app.
import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.env.WEB_ROOT || '/web');
const relay = new URL(process.env.RELAY_URL || 'http://joy-pocket-relay:3105');
const hosts = new Set((process.env.ALLOWED_HOSTS || 'agent-01,localhost,127.0.0.1').split(','));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const handleRequest = async (req, res) => {
  try {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); } catch { res.writeHead(400).end(); return; }
    if (!hosts.has(url.hostname)) { res.writeHead(403).end('Unknown host'); return; }
    if (url.pathname === '/joy/v2' || url.pathname.startsWith('/joy/v2/')) {
      const headers = { ...req.headers, host: relay.host };
      // Never forward a caller-provided client address to the trusted relay.
      delete headers.forwarded;
      headers['x-forwarded-for'] = req.socket.remoteAddress;
      const upstream = http.request({ hostname: relay.hostname, port: relay.port, path: url.pathname + url.search, method: req.method, headers }, reply => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
        reply.on('error', () => res.destroy());
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Relay unavailable'); });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    // Enable shared WASM memory for Pocket's CPU thread pool, including workers.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const name = decodeURIComponent(url.pathname);
    let file = path.resolve(root, '.' + name);
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(404).end(); return; }
    let info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      if (path.extname(name)) { res.writeHead(404).end(); return; }
      file = path.join(root, 'index.html');
      info = await stat(file);
    }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    if (file === path.join(root, 'index.html')) {
      const html = (await readFile(file, 'utf8')).replace('<head>', '<head><script>globalThis.__JOY_CONFIG__={serverUrl:location.origin};</script>');
      res.setHeader('Content-Length', Buffer.byteLength(html));
      res.end(req.method === 'HEAD' ? undefined : html);
    } else {
      res.setHeader('Content-Length', info.size);
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
  } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
};
// Optional direct HTTPS, with the private key supplied as a container secret.
if (process.env.TLS_CERT || process.env.TLS_KEY) {
  const [cert, key] = await Promise.all([readFile(process.env.TLS_CERT), readFile(process.env.TLS_KEY)]);
  const secureServer = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, handleRequest);
  secureServer.requestTimeout = 0;
  secureServer.listen(Number(process.env.HTTPS_PORT || 8443), '0.0.0.0');
}
const server = http.createServer(handleRequest);
server.requestTimeout = 0; // Relay streams and long polls can remain open.
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
