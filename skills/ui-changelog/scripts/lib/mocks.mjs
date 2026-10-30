// Mock definitions: loading, matching and response building. Shared by the in-browser routes
// (lib/browser.mjs) and the standalone mock server (mocks.mjs serve), so one mock file answers both.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail } from './util.mjs';

// Resource types a data mock never answers: a broad glob such as **/api/** would otherwise
// also catch dev-server source modules like /src/app/api/user.api.ts and break the app.
const NON_DATA_TYPES = new Set(['document', 'script', 'stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack']);

// Entries are mock objects or paths to JSON files holding arrays of entries, relative to baseDir.
export function loadMocks(entries, baseDir, seen = new Set()) {
  const out = [];
  for (const entry of [].concat(entries ?? [])) {
    if (typeof entry === 'string') {
      const file = path.resolve(baseDir, entry);
      if (seen.has(file)) continue;
      seen.add(file);
      if (!existsSync(file)) fail(`mock file not found: ${file}`);
      let list;
      try {
        list = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        fail(`cannot parse mock file ${file}: ${error.message}`);
      }
      out.push(...loadMocks(Array.isArray(list) ? list : list.mocks ?? [list], path.dirname(file), seen));
    } else if (entry && typeof entry === 'object') {
      out.push(compileMock(entry, baseDir));
    }
  }
  return out;
}

const MOCK_KEYS = new Set(['url', 'urlRegex', 'websocket', 'method', 'query', 'graphql', 'requestJson', 'requestText', 'resourceTypes', 'json', 'file', 'body', 'contentType', 'headers', 'status', 'delayMs', 'pending', 'abort', 'times', 'sse', 'image', 'handler', 'send', 'onMessage', 'name', 'note']);
const warned = new Set();

export function compileMock(spec, dir) {
  for (const key of Object.keys(spec).filter((candidate) => !MOCK_KEYS.has(candidate) && !/^[$_]/.test(candidate))) {
    const message = `warning: unknown mock field "${key}" in ${spec.name ?? spec.url ?? spec.websocket ?? spec.urlRegex}, ignored`;
    if (!warned.has(message)) console.error(message);
    warned.add(message);
  }
  const target = spec.websocket ?? spec.url;
  if (!target && !spec.urlRegex) fail(`mock needs url, urlRegex or websocket: ${JSON.stringify(spec)}`);
  const pattern = spec.urlRegex ? new RegExp(spec.urlRegex) : globToRegExp(target);
  const fullUrl = Boolean(spec.urlRegex) || target.includes('?');
  const methods = [].concat(spec.method ?? []).map((method) => method.toUpperCase());
  const kind = spec.websocket ? 'websocket' : 'http';
  const dataOnly = kind === 'http' && !spec.contentType && !spec.image && !spec.resourceTypes;
  return {
    spec,
    dir,
    kind,
    name: spec.name ?? `${kind === 'websocket' ? 'WS' : methods.join('|') || 'ANY'} ${spec.websocket ?? spec.url ?? spec.urlRegex}${spec.graphql ? ` (${spec.graphql})` : ''}`,
    methods,
    dataOnly,
    resourceTypes: spec.resourceTypes ? new Set([].concat(spec.resourceTypes)) : null,
    matchUrl: (url) => pattern.test(fullUrl ? url.href : url.origin + url.pathname),
  };
}

// `*` stays within one path segment, `**` crosses segments, `?` is a literal query separator.
export function globToRegExp(glob) {
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*').replace(/\?/g, '\\?');
  return new RegExp(`^${source}$`);
}

// One session per browser context (or per server): `times` counters, handler state and hit counts
// start fresh, so the before and after sides see identical mock behavior.
export function createSession(mocks) {
  return { mocks, remaining: new Map(mocks.map((mock) => [mock, mock.spec.times ?? Infinity])), state: {}, hits: new Map(), skipped: new Map() };
}

// request: { method, url: URL, headers: { lowercased: value }, body: string | null, resourceType? }
// Returns the response to send, or null when no mock answers. Later mocks win.
export async function answer(session, request) {
  const http = session.mocks.filter((mock) => mock.kind === 'http' && mock.matchUrl(request.url));
  if (!http.length) return null;
  if (request.method === 'OPTIONS') return { action: 'fulfill', status: 204, headers: corsHeaders(request), body: '' };
  for (const mock of [...http].reverse()) {
    if (!requestMatches(mock, request)) continue;
    if (mock.dataOnly && NON_DATA_TYPES.has(request.resourceType)) {
      session.skipped.set(mock.name, [...(session.skipped.get(mock.name) ?? []), `${request.resourceType} ${request.url.pathname}`]);
      continue;
    }
    if (mock.resourceTypes && request.resourceType && !mock.resourceTypes.has(request.resourceType)) continue;
    if (session.remaining.get(mock) <= 0) continue;
    const response = await respond(mock.spec, mock.dir, request, session);
    if (response.action === 'fallback') continue;
    session.remaining.set(mock, session.remaining.get(mock) - 1);
    session.hits.set(mock.name, (session.hits.get(mock.name) ?? 0) + 1);
    return response;
  }
  return null;
}

function requestMatches(mock, request) {
  const { spec } = mock;
  if (mock.methods.length && !mock.methods.includes(request.method)) return false;
  if (spec.query && !Object.entries(spec.query).every(([key, value]) => {
    const actual = request.url.searchParams.getAll(key);
    return value === null ? actual.length === 0 : [].concat(value).every((expected) => actual.includes(String(expected)));
  })) return false;
  if (spec.graphql && graphqlOperation(request) !== spec.graphql) return false;
  if (spec.requestJson !== undefined && !partialMatch(parseJson(request.body), spec.requestJson)) return false;
  if (spec.requestText !== undefined && !(request.body ?? '').includes(spec.requestText)) return false;
  return true;
}

export function graphqlOperation(request) {
  let payload = parseJson(request.body);
  if (Array.isArray(payload)) payload = payload[0];
  const fromQuery = request.url.searchParams;
  const name = payload?.operationName ?? fromQuery.get('operationName');
  if (name) return name;
  const document = payload?.query ?? fromQuery.get('query') ?? '';
  return document.match(/\b(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/)?.[1] ?? null;
}

// Every key in `expected` must equal the value in `actual`; arrays compare element-wise.
export function partialMatch(actual, expected) {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((item, index) => partialMatch(actual[index], item));
  return Object.entries(expected).every(([key, value]) => partialMatch(actual[key], value));
}

function parseJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const handlerCache = new Map();

async function respond(spec, dir, request, session) {
  if (spec.handler) {
    const [file, exportName = 'default'] = spec.handler.split('#');
    const resolved = path.resolve(dir, file);
    if (!handlerCache.has(resolved)) handlerCache.set(resolved, import(pathToFileURL(resolved).href));
    const module = await handlerCache.get(resolved);
    const fn = module[exportName];
    if (typeof fn !== 'function') fail(`mock handler ${spec.handler} does not export a function "${exportName}"`);
    const result = await fn(handlerRequest(request), session.state);
    if (result === undefined || result === null) return { action: 'fallback' };
    const { handler: _ignored, ...response } = result;
    return respond(response, dir, request, session);
  }
  if (spec.pending) return { action: 'pending' };
  if (spec.delayMs) await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
  if (spec.abort) return { action: 'abort', errorCode: typeof spec.abort === 'string' ? spec.abort : 'connectionrefused' };
  const headers = { ...corsHeaders(request) };
  let body = '';
  let contentType = spec.contentType;
  if (spec.sse) {
    body = sseBody(spec.sse);
    contentType ??= 'text/event-stream';
    headers['cache-control'] = 'no-cache';
  } else if (spec.image) {
    body = placeholderSvg(spec.image === true ? {} : spec.image);
    contentType ??= 'image/svg+xml';
  } else if (spec.file) {
    body = readFileSync(path.resolve(dir, spec.file));
    contentType ??= spec.file.endsWith('.json') ? 'application/json' : 'text/plain';
  } else if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    contentType ??= 'application/json';
  } else if (spec.body !== undefined) {
    body = spec.body;
  }
  headers['content-type'] = contentType ?? 'text/plain';
  return { action: 'fulfill', status: spec.status ?? 200, headers: { ...headers, ...spec.headers }, body };
}

function handlerRequest(request) {
  return {
    method: request.method,
    url: request.url.href,
    path: request.url.pathname,
    query: Object.fromEntries(request.url.searchParams),
    headers: request.headers,
    body: request.body,
    json: parseJson(request.body),
  };
}

export function corsHeaders(request) {
  const origin = request.headers?.origin;
  return {
    'access-control-allow-origin': origin ?? '*',
    ...(origin ? { 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}),
    'access-control-allow-headers': request.headers?.['access-control-request-headers'] ?? '*',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  };
}

// A long retry keeps EventSource from reconnecting (and re-sending the events) during the capture.
export function sseBody(events) {
  const lines = ['retry: 86400000', ''];
  for (const event of [].concat(events)) {
    const item = typeof event === 'object' && event !== null && 'data' in event ? event : { data: event };
    if (item.id !== undefined) lines.push(`id: ${item.id}`);
    if (item.event) lines.push(`event: ${item.event}`);
    const data = typeof item.data === 'string' ? item.data : JSON.stringify(item.data);
    for (const line of data.split('\n')) lines.push(`data: ${line}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// A neutral picture: soft background, a sun and two hills, and an optional label. Same bytes every time.
export function placeholderSvg({ width = 640, height = 400, label = '', background = '#d7dce3', foreground = '#aab3bf' } = {}) {
  const text = String(label).replace(/[<>&"]/g, '');
  const size = Math.max(10, Math.round(Math.min(width, height) / 9));
  const at = (fraction, of) => Math.round(fraction * of);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice"><rect width="100%" height="100%" fill="${background}"/><circle cx="${at(0.72, width)}" cy="${at(0.32, height)}" r="${at(0.09, Math.min(width, height))}" fill="${foreground}"/><path d="M0 ${height}L${at(0.32, width)} ${at(0.5, height)}L${at(0.55, width)} ${at(0.78, height)}L${at(0.7, width)} ${at(0.62, height)}L${width} ${height}Z" fill="${foreground}"/>${text ? `<text x="50%" y="${height - size}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${size}" fill="#5d6673">${text}</text>` : ''}</svg>`;
}

// WebSocket mocks: messages to send on connect, and replies to client messages that match.
export function websocketPlan(mock, message) {
  const replies = [];
  for (const rule of [].concat(mock.spec.onMessage ?? [])) {
    const match = rule.match;
    const parsed = parseJson(message);
    const hit = match === undefined || (typeof match === 'string' ? String(message).includes(match) : partialMatch(parsed, match));
    if (hit) replies.push(...[].concat(rule.send ?? []));
  }
  return replies.map(frame);
}

export function frame(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
