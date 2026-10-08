// Minimal static file server for local play. No dependencies.
// Usage: node scripts/serve.js [port]   (default 8080)
// If the port is taken (often an earlier `npm start` still running), the
// next ports are tried.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);
const PORT_TRIES = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let filePath = normalize(join(ROOT, urlPath));
    const outsideRoot = filePath !== ROOT && !filePath.startsWith(ROOT + sep);
    const dotfile = filePath.slice(ROOT.length).split(sep).some((part) => part.startsWith('.'));
    if (outsideRoot || dotfile) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if ((await stat(filePath)).isDirectory()) filePath = join(filePath, 'index.html');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

let port = PORT;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < PORT + PORT_TRIES - 1) {
    console.log(`Port ${port} is in use (is another \`npm start\` still running?). Trying ${port + 1}.`);
    port += 1;
    server.listen(port);
    return;
  }
  console.error(err.code === 'EADDRINUSE'
    ? `Ports ${PORT}-${port} are all in use. Close the other server or run: npm start -- <port>`
    : err.message);
  process.exit(1);
});
server.on('listening', () => {
  console.log(`Fix and Flank: http://localhost:${port}/`);
});
server.listen(port);
