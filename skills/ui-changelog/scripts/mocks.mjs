#!/usr/bin/env node
// Turns "the page shows errors" into "the page shows realistic data": drafts mocks for the API calls a
// capture left unanswered, typed from the project's own source, and serves mocks over real HTTP.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { answer, createSession, graphqlOperation, loadMocks } from './lib/mocks.mjs';
import { findCallSites, findNamedType, isDataType, loadTypeScript, openProject, sampleType } from './lib/types.mjs';
import { fail, firstLine, flag, readJson } from './lib/util.mjs';

const USAGE = `Usage:
  node mocks.mjs draft <report-dir> [--project <tsconfig.json|jsconfig.json>] [--out <file>] [--items <n>] [--now <iso>]
      Read <report-dir>/unanswered.json from a capture and write a mock file with one entry per
      endpoint (default <report-dir>/mocks.draft.json). With --project, each response body is
      built from the type the calling code expects, using the project's TypeScript compiler.
  node mocks.mjs sample <TypeName> --project <tsconfig.json> [--items <n>] [--now <iso>]
      Print a realistic value of a named type, for per-state variants (empty lists, errors).
  node mocks.mjs find <url-or-path> [--project <tsconfig.json>] [--method GET] [--graphql <operation>]
      Show the code that calls an endpoint, the type it expects, and fixtures that mention it.
  node mocks.mjs serve <mocks.json|manifest.json> --port <n> [--host 127.0.0.1]
      Answer the same mocks over real HTTP, for server-side rendering or other non-browser callers.`;

const [command, ...rest] = process.argv.slice(2);
if (!command || ['help', '--help', '-h'].includes(command)) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}
const items = Number(flag(rest, '--items') ?? 3);
if (command === 'draft') draft(rest[0]);
else if (command === 'sample') sample(rest[0]);
else if (command === 'find') find(rest[0]);
else if (command === 'serve') serve(rest[0]);
else fail(`Unknown command ${command}\n\n${USAGE}`);

function project() {
  const config = flag(rest, '--project');
  if (!config) return null;
  if (!existsSync(config)) fail(`--project ${config} does not exist`);
  const ts = loadTypeScript(path.dirname(path.resolve(config)));
  if (ts.error) {
    console.error(`warning: ${ts.error} Falling back to text search.`);
    return null;
  }
  try {
    const started = Date.now();
    const opened = openProject(ts, config);
    console.error(`Read ${opened.files.length} source files with TypeScript ${ts.version} in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    return opened;
  } catch (error) {
    console.error(`warning: cannot open ${config}: ${firstLine(error)}. Falling back to text search.`);
    return null;
  }
}

function nowFrom(reportDir) {
  const explicit = flag(rest, '--now');
  if (explicit) return new Date(explicit);
  const manifest = reportDir && path.join(reportDir, 'manifest.json');
  if (manifest && existsSync(manifest)) {
    const fixed = JSON.parse(readFileSync(manifest, 'utf8')).fixedTime;
    if (fixed) return new Date(fixed);
  }
  return new Date();
}

function draft(reportDir) {
  if (!reportDir) fail(USAGE);
  const list = readJson(path.join(reportDir, 'unanswered.json'), 'unanswered list');
  if (!list.length) {
    console.error('Nothing to draft: the capture left no API call unanswered.');
    return;
  }
  const typed = project();
  const now = nowFrom(reportDir);
  const searchRoot = typed?.root ?? process.cwd();
  const mocks = [];
  const summary = [];
  for (const entry of list) {
    const operation = entry.method === 'WS' ? null : graphqlOperation({ body: entry.postData, url: new URL(entry.examples?.[0] ?? `http://localhost${entry.path}`) });
    // A call to the frontend's own origin has no fixed origin (each side has its own port).
    const target = entry.origin ? `${entry.origin}${entry.path}` : `**${entry.path}`;
    const sites = typed ? uniqueSites(findCallSites(typed, { pathname: entry.path, operation, method: entry.method === 'WS' ? undefined : entry.method })) : [];
    const site = sites.find((candidate) => (entry.method === 'WS' ? candidate.messageType : candidate.type && (candidate.method === entry.method || isDataType(typed, candidate.type))));
    const where = site ? `${site.function ? `${site.function}() in ` : ''}${site.file}:${site.line}` : '';
    const seen = `Seen in: ${entry.shots.join(', ')}.`;
    const mentions = site ? [] : textMentions(searchRoot, entry.path);
    const todo = site ? '' : `TODO: no response type found${sites.length ? `; called from ${sites.map((s) => `${s.file}:${s.line}`).join(', ')}` : ''}${mentions.length ? `; mentioned in ${mentions.join(', ')}` : ''}. Write the body from the code that reads it.`;
    const name = `${entry.method} ${entry.path}${operation ? ` (${operation})` : ''}`;
    if (entry.method === 'WS') {
      const message = site ? sampleType(typed, site.messageType, { items, now }) : undefined;
      mocks.push({ name, websocket: target, send: message === undefined ? [] : [message], note: site ? `${typed.checker.typeToString(site.messageType)}, the message type ${where} hands to its callback. ${seen}` : `${todo} ${seen}` });
    } else {
      const body = site ? sampleType(typed, site.type, { items, now }) : {};
      mocks.push({ name, url: target, method: entry.method, ...(operation ? { graphql: operation } : {}), json: body ?? {}, note: site ? `${site.typeName}, from ${where}. ${seen}` : `${todo} ${seen}` });
    }
    summary.push(`${site ? 'typed ' : 'TODO  '} ${name}${site ? ` → ${entry.method === 'WS' ? typed.checker.typeToString(site.messageType) : site.typeName}` : ''}`);
  }
  const out = path.resolve(flag(rest, '--out') ?? path.join(reportDir, 'mocks.draft.json'));
  writeFileSync(out, `${JSON.stringify(mocks, null, 2)}\n`);
  console.error(summary.join('\n'));
  console.error(`\nReview the values (flags that hide whole screens, enum variants, list lengths), add the file to the manifest's "mocks" list, and recapture.`);
  console.log(out);
}

function uniqueSites(sites) {
  const seen = new Map();
  for (const site of sites) if (!seen.has(`${site.file}:${site.line}`)) seen.set(`${site.file}:${site.line}`, site);
  return [...seen.values()];
}

function sample(typeName) {
  if (!typeName) fail(USAGE);
  const typed = project() ?? fail('sample needs --project <tsconfig.json> and the TypeScript compiler.');
  const found = findNamedType(typed, typeName) ?? fail(`No type named ${typeName} in the project.`);
  console.error(`${typeName} from ${found.file}`);
  console.log(JSON.stringify(sampleType(typed, found.type, { items, now: nowFrom(null) }), null, 2));
}

function find(target) {
  if (!target) fail(USAGE);
  const url = /^[a-z]+:\/\//.test(target) ? new URL(target) : new URL(target, 'http://localhost');
  const typed = project();
  const operation = flag(rest, '--graphql');
  if (typed) {
    const sites = uniqueSites(findCallSites(typed, { pathname: url.pathname, operation, method: flag(rest, '--method')?.toUpperCase() }));
    if (!sites.length) console.log('No call site found in the TypeScript program.');
    for (const site of sites) console.log(`${site.file}:${site.line}  ${site.method ?? ''} ${site.function ? `${site.function}()` : ''}  ${site.typeName ? `→ ${site.typeName}` : '(response type unknown)'}${site.messageType ? `  messages: ${typed.checker.typeToString(site.messageType)}` : ''}`);
  }
  const mentions = textMentions(typed?.root ?? process.cwd(), url.pathname);
  if (mentions.length) console.log(`Mentioned in: ${mentions.join(', ')}`);
}

// Files that mention the endpoint's last path segments: call sites, and fixtures worth reusing.
function textMentions(root, pathname, limit = 8) {
  const segments = pathname.split('/').filter((segment) => segment && !/^\d+$|^[0-9a-f-]{16,}$/i.test(segment));
  const needles = [segments.slice(-2).join('/'), segments.at(-1)].filter((needle) => needle && needle.length >= 4);
  if (!needles.length) return [];
  const hits = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'dev-dist', 'out']);
  const walk = (dir, depth) => {
    if (hits.length >= limit || depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !entry.name.startsWith('.')) walk(full, depth + 1);
      } else if (/\.(m?[jt]sx?|cjs|vue|svelte|json|ya?ml|graphql|gql|har)$/.test(entry.name) && statSync(full).size < 1_000_000) {
        const lines = readFileSync(full, 'utf8').split('\n');
        const needle = needles.find((candidate) => lines.some((line) => line.includes(candidate)));
        if (!needle) continue;
        const line = lines.findIndex((text) => text.includes(needle)) + 1;
        hits.push(`${path.relative(root, full)}:${line}`);
      }
    }
  };
  walk(root, 0);
  return hits;
}

function serve(file) {
  if (!file) fail(USAGE);
  const port = Number(flag(rest, '--port') ?? fail('serve needs --port <n>'));
  const host = flag(rest, '--host') ?? '127.0.0.1';
  const data = readJson(file, 'mock file');
  const dir = path.dirname(path.resolve(file));
  const mocks = loadMocks(Array.isArray(data) ? data : data.mocks ?? [], dir).filter((mock) => {
    if (mock.kind !== 'websocket') return true;
    console.error(`warning: ${mock.name} is a WebSocket mock; serve answers HTTP only, so it is skipped.`);
    return false;
  });
  const session = createSession(mocks);
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
    const requestFor = (origin) => ({ method: request.method, url: new URL(request.url, origin), headers: request.headers, body });
    // Mock URLs are pinned to the API origin; a caller may reach this server under another host name.
    let result = await answer(session, requestFor(`http://${request.headers.host ?? `${host}:${port}`}`));
    if (!result) result = await answer(session, requestFor(`http://127.0.0.1:${port}`));
    const label = `${request.method} ${request.url}`;
    if (!result) {
      console.error(`404 ${label} (no mock)`);
      response.writeHead(404, { 'content-type': 'application/json', 'access-control-allow-origin': request.headers.origin ?? '*' });
      response.end(JSON.stringify({ error: `no mock for ${request.method} ${new URL(request.url, 'http://x').pathname}` }));
      return;
    }
    if (result.action === 'pending') return console.error(`... ${label} (held open)`);
    if (result.action === 'abort') {
      console.error(`ERR ${label} (${result.errorCode})`);
      request.socket.destroy();
      return;
    }
    console.error(`${result.status} ${label}`);
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });
  server.listen(port, host, () => console.error(`Serving ${mocks.length} mock${mocks.length === 1 ? '' : 's'} at http://${host}:${port}/ (Ctrl+C to stop)`));
}
