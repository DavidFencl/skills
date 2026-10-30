// Small helpers shared by the ui-changelog scripts. No dependencies.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const TOOL_HOME = process.env.UI_CHANGELOG_HOME ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'ui-changelog');
const requireFromTool = createRequire(path.join(TOOL_HOME, 'package.json'));

// Playwright, pngjs and pixelmatch live in the per-user tool cache, never in the project under review.
export function loadDependency(name) {
  try {
    return requireFromTool(name);
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    fail(`Missing dependency "${name}" in ${TOOL_HOME}. Run: bash ${path.join(SCRIPTS_DIR, 'setup.sh')}`);
  }
}

export function readJson(file, what = 'file') {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Cannot read ${what} ${file}: ${firstLine(error)}`);
  }
}

export function flag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function firstLine(error) {
  return String(error?.message ?? error).split('\n')[0];
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}

export function unique(values) {
  return [...new Set(values)];
}

// URLs and request bodies land in results.json and unanswered.json, which get shared. Keep what
// drafting mocks needs (paths, query keys, the GraphQL operation and document, the JSON shape) and
// replace every other value, because query strings and bodies carry tokens and passwords.
const KEPT_FIELDS = new Set(['operationName', 'query']);

export function redactUrl(raw) {
  const url = new URL(raw);
  for (const key of new Set(url.searchParams.keys())) if (!KEPT_FIELDS.has(key)) url.searchParams.set(key, '_');
  return url.toString();
}

export function redactBody(text) {
  if (text == null || text === '') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return `[${text.length} bytes, not JSON]`;
  }
  const shape = (item, key) => {
    if (KEPT_FIELDS.has(key) && typeof item === 'string') return item;
    if (Array.isArray(item)) return item.slice(0, 3).map((entry) => shape(entry));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, shape(entry, name)]));
    return item === null ? null : `<${typeof item}>`;
  };
  return JSON.stringify(shape(value)).slice(0, 4000);
}
