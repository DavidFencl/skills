#!/usr/bin/env node
// Dev server for the Riverside Running Club site.
//   node server.mjs --port 5173 [--host 127.0.0.1] [--api https://api.riverside-run.example/api]
// Serves the files in this directory, writes /config.js from the flags, and falls back to
// index.html for unknown paths like a single-page-app dev server does.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const port = Number(option('--port', 5173));
const host = option('--host', 'localhost');
const api = option('--api', process.env.API_URL ?? 'https://api.riverside-run.example/api');
const version = buildVersion();

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

http
  .createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    if (pathname === '/config.js') {
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      response.end(`window.APP_CONFIG = ${JSON.stringify({ apiUrl: api, version })};\n`);
      return;
    }
    const file = path.join(root, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    try {
      const body = await readFile(file === root || pathname.endsWith('/') ? path.join(root, 'index.html') : file);
      response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'text/html', 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      response.end(await readFile(path.join(root, 'index.html')));
    }
  })
  .listen(port, host, () => console.log(`Riverside dev server: http://${host}:${port}/ (API ${api})`));

// Like most build tools, stamp the commit into the version so support can tell builds apart.
function buildVersion() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return `1.8.0+${commit}${dirty ? '.dirty' : ''}`;
  } catch {
    return '1.8.0+dev';
  }
}
