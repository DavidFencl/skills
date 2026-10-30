#!/usr/bin/env node
// Serves a fixture directory like a single-page-app dev server: files as they are, index.html for
// every unknown path. Usage: node serve-fixture.mjs <dir> <port>
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function serveFixture(dir, port) {
  const server = http.createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const file = path.join(dir, path.normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, ''));
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      response.end(await readFile(path.join(dir, 'index.html')));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new Error(`cannot serve ${dir} on port ${port}: ${error.message}`)));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [dir, port] = process.argv.slice(2);
  await serveFixture(path.resolve(dir), Number(port));
  console.error(`serving ${dir} at http://127.0.0.1:${port}/`);
}
