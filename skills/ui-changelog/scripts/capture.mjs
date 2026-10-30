#!/usr/bin/env node
// Captures before/after screenshot pairs from a manifest, compares them, and writes the review report.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { captureOne, login, VIEWPORT_PRESETS } from './lib/browser.mjs';
import { compareShot } from './lib/compare.mjs';
import { writeReport } from './lib/report.mjs';
import { SCRIPTS_DIR, fail, firstLine, flag, loadDependency, readJson, slug } from './lib/util.mjs';

const USAGE = `Usage:
  node capture.mjs <manifest.json> --out <dir> [--only <id>[,<id>...]] [--headed] [--strict]
      Capture every shot on both sides, compare, and write index.html, report.md,
      results.json, unanswered.json and shots/ into <dir>. With --only, recapture
      those shot ids (or viewport groups) and merge them into the existing results.
      With --strict, exit 2 when the report has items that need attention.
  node capture.mjs compare --out <dir>     Re-diff the captured PNGs, then re-render.
  node capture.mjs report --out <dir>      Re-render index.html and report.md from results.json.
  node capture.mjs login <url> <state.json> Open a browser, log in, close the window to save the session.

Manifest fields: ${path.join(path.dirname(SCRIPTS_DIR), 'references', 'manifest.md')}`;

const TOP_KEYS = new Set(['title', 'before', 'after', 'shots', 'viewport', 'viewports', 'viewportPresets', 'deviceScaleFactor', 'colorScheme', 'locale', 'timezoneId', 'fixedTime', 'storageState', 'localStorage', 'extraHTTPHeaders', 'allowHosts', 'mask', 'hide', 'waitForHidden', 'settleMs', 'timeoutMs', 'networkIdleTimeoutMs', 'mocks', 'har', 'minDiffPixels', 'serviceWorkers', 'contextOptions', 'initScripts', 'placeholderImages', 'changedFiles', 'notCaptured', 'servicePolicy']);
const SIDE_KEYS = new Set(['baseURL', 'ref', 'storageState', 'dir']);
const SHOT_KEYS = new Set(['id', 'label', 'path', 'viewports', 'viewport', 'selector', 'padding', 'fullPage', 'new', 'removed', 'steps', 'waitFor', 'mask', 'hide', 'colorScheme', 'locale', 'deviceScaleFactor', 'har', 'networkIdleTimeoutMs', 'mocks', 'threshold', 'sources', 'note', 'expect', 'initScripts', 'contextOptions']);

const [command, ...rest] = process.argv.slice(2);
const strict = process.argv.includes('--strict');
if (!command || ['help', '--help', '-h'].includes(command)) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}
if (command === 'login') {
  if (!rest[0] || !rest[1]) fail('Usage: capture.mjs login <url> <storage-state.json>');
  mkdirSync(path.dirname(path.resolve(rest[1])), { recursive: true });
  await login(rest[0], rest[1]);
  console.log(path.resolve(rest[1]));
} else if (command === 'compare') {
  const run = readResults(flag(rest, '--out'));
  for (const shot of run.shots) {
    if (!shot.before?.file || !shot.after?.file) continue;
    Object.assign(shot, { diff: undefined, circled: undefined, regions: undefined, sizeChanged: undefined }, await compareShot(run.outDir, shot, shot, run.minDiffPixels ?? 0));
  }
  finish(run);
} else if (command === 'report') {
  finish(readResults(flag(rest, '--out')), { rewriteResults: false });
} else {
  await captureAll(command, rest);
}

async function captureAll(manifestPath, argv) {
  const manifest = readJson(manifestPath, 'manifest');
  if (!Array.isArray(manifest.shots)) fail('manifest.shots must be an array');
  manifest.dir = path.dirname(path.resolve(manifestPath));
  const outDir = path.resolve(flag(argv, '--out') ?? fail('--out <dir> is required'));
  warnUnknownKeys(manifest);
  const todos = findTodos(manifest);
  if (todos.length) fail(`The manifest still has TODO placeholders (from affected.mjs --manifest). Fill them in first:\n  ${todos.join('\n  ')}`);
  manifest.shots = expandViewports(manifest);
  assertUniqueIds(manifest.shots);
  const only = flag(argv, '--only')?.split(',');
  const shots = manifest.shots.filter((shot) => !only || only.includes(shot.id) || only.includes(shot.group));
  if (only && !shots.length) fail(`--only matched no shot ids: ${only.join(', ')}`);
  for (const side of ['before', 'after']) if (!manifest[side]?.baseURL) fail(`manifest.${side}.baseURL is required`);
  for (const side of ['before', 'after']) {
    await fetch(manifest[side].baseURL, { signal: AbortSignal.timeout(10_000) }).catch((error) => fail(`${side} server ${manifest[side].baseURL} is unreachable: ${firstLine(error.cause ?? error)}`));
  }
  mkdirSync(path.join(outDir, 'shots'), { recursive: true });

  const { chromium } = loadDependency('playwright');
  const browser = await chromium.launch({ headless: !argv.includes('--headed') });
  const previous = existsSync(path.join(outDir, 'results.json')) ? readResults(outDir).shots : [];
  const fingerprints = new Map(manifest.shots.map((shot) => [shot.id, fingerprint(manifest, shot)]));
  const results = new Map(previous.filter((result) => fingerprints.has(result.id)).map((result) => [result.id, { ...result, stale: result.fingerprint !== fingerprints.get(result.id) }]));
  try {
    for (const shot of shots) {
      const result = { ...describeShot(manifest, shot), fingerprint: fingerprints.get(shot.id) };
      for (const side of ['before', 'after']) {
        const file = path.join('shots', `${slug(shot.id)}-${side}.png`);
        if ((side === 'before' && shot.new) || (side === 'after' && shot.removed)) {
          result[side] = { absent: true };
          continue;
        }
        let retried;
        const attempt = () => captureOne(browser, manifest, manifest[side], shot, path.join(outDir, file));
        // One retry absorbs dev-server reloads, such as Vite's first dependency optimisation.
        result[side] = await attempt()
          .catch((error) => {
            retried = firstLine(error);
            return attempt();
          })
          .then(
            (info) => ({ file, ...info, ...(retried ? { retried } : {}) }),
            (error) => ({ error: firstLine(error), ...(error.network ? { network: error.network } : {}) }),
          );
      }
      Object.assign(result, await compareShot(outDir, shot, result, manifest.minDiffPixels ?? 0));
      results.set(shot.id, result);
      const unanswered = new Set(['before', 'after'].flatMap((side) => (result[side].network?.unanswered ?? []).map((call) => `${call.method} ${new URL(call.url).pathname}`)));
      console.error(`${(result.status === 'added' ? 'new' : result.status).padEnd(9)} ${result.label}${result.regions ? ` (${result.regions.length} region${result.regions.length > 1 ? 's' : ''})` : ''}`);
      for (const side of ['before', 'after']) if (result[side].error) console.error(`          ${side}: ${result[side].error}`);
      if (unanswered.size) console.error(`          unanswered API calls: ${[...unanswered].join(', ')}`);
    }
  } finally {
    await browser.close();
  }
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(redactManifest(readJson(manifestPath, 'manifest')), null, 2)}\n`);
  const run = {
    schemaVersion: 2,
    title: manifest.title ?? 'UI changelog',
    generatedAt: new Date().toISOString(),
    before: { ...manifest.before, git: gitState(manifest.before.dir && path.resolve(manifest.dir, manifest.before.dir)) },
    after: { ...manifest.after, git: gitState(manifest.after.dir && path.resolve(manifest.dir, manifest.after.dir)) },
    manifest: 'manifest.json',
    minDiffPixels: manifest.minDiffPixels ?? 0,
    changedFiles: manifest.changedFiles,
    notCaptured: manifest.notCaptured,
    shots: manifest.shots.map((shot) => results.get(shot.id) ?? { ...describeShot(manifest, shot), status: 'not-run' }),
    outDir,
  };
  finish(run);
}

function describeShot(manifest, shot) {
  return {
    id: shot.id,
    group: shot.group,
    label: shot.label ?? shot.id,
    path: shot.path,
    sources: shot.sources ?? [],
    note: shot.note,
    expect: shot.expect,
    threshold: shot.threshold,
    viewport: { name: shot.viewportName, ...(shot.viewport ?? manifest.viewport ?? VIEWPORT_PRESETS.desktop) },
    settings: {
      selector: shot.selector,
      padding: shot.padding,
      fullPage: shot.fullPage,
      steps: shot.steps,
      hide: [...(manifest.hide ?? []), ...(shot.hide ?? [])],
      mask: shot.mask ?? manifest.mask ?? [],
      initScripts: [...[].concat(manifest.initScripts ?? []), ...[].concat(shot.initScripts ?? [])].map((script) => (typeof script === 'string' ? script : 'inline script')),
    },
  };
}

function finish(run, { rewriteResults = true } = {}) {
  const { outDir, ...saved } = run;
  if (rewriteResults) writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(saved, null, 2)}\n`);
  const facts = writeReport(run);
  if (strict && facts.attention.length) process.exitCode = 2;
  const summary = [...facts.groups.map(([status, list]) => `${list.length} ${status === 'added' ? 'new' : status}`), facts.unchanged.length ? `${facts.unchanged.length} unchanged` : ''].filter(Boolean);
  console.error(`\n${summary.join(' · ') || 'no shots'}${facts.attention.length ? ` · ${facts.attention.length} need${facts.attention.length === 1 ? 's' : ''} attention` : ''}`);
  for (const item of facts.attention) console.error(`  ! ${item.label ? `${item.label}: ` : ''}${item.text}`);
  if (facts.unanswered.length) {
    console.error(`\n${facts.unanswered.length} unanswered endpoint${facts.unanswered.length > 1 ? 's are' : ' is'} listed in ${path.join(outDir, 'unanswered.json')}. Draft mocks for them with:\n  node ${path.join(SCRIPTS_DIR, 'mocks.mjs')} draft ${outDir} --project <tsconfig.json or jsconfig.json>`);
  }
  console.log(path.join(outDir, 'index.html'));
}

// A shot with `viewports` (or the manifest-level default) becomes one shot per viewport.
function expandViewports(manifest) {
  const presets = { ...VIEWPORT_PRESETS, ...manifest.viewportPresets };
  return manifest.shots.flatMap((shot) => {
    const list = shot.viewport ? [] : (shot.viewports ?? manifest.viewports ?? []);
    const expectFor = (name) => (shot.expect && typeof shot.expect === 'object' ? (shot.expect[name] ?? shot.expect.default) : shot.expect);
    if (!list.length) return [{ ...shot, expect: expectFor(undefined) }];
    return list.map((entry) => {
      const viewport = typeof entry === 'string' ? presets[entry] : entry;
      const name = typeof entry === 'string' ? entry : (entry.name ?? `${entry.width}x${entry.height}`);
      if (!viewport?.width || !viewport?.height) fail(`unknown viewport ${JSON.stringify(entry)} in shot ${shot.id}`);
      const label = shot.label ?? shot.id;
      const expanded = { ...shot, viewport, viewportName: name, expect: expectFor(name) };
      return list.length === 1 ? expanded : { ...expanded, id: `${shot.id}-${name}`, label: `${label}, ${name}`, group: shot.id };
    });
  });
}

// Misspelled fields are ignored silently by JSON, so name them before a long capture runs.
function warnUnknownKeys(manifest) {
  const unknown = (object, known, where) => Object.keys(object ?? {}).filter((key) => !known.has(key) && !/^[$_]/.test(key)).map((key) => `${where}.${key}`);
  const found = [...unknown(manifest, new Set([...TOP_KEYS, 'dir']), 'manifest'), ...unknown(manifest.before, SIDE_KEYS, 'before'), ...unknown(manifest.after, SIDE_KEYS, 'after'), ...manifest.shots.flatMap((shot, index) => unknown(shot, SHOT_KEYS, `shots[${shot.id ?? index}]`))];
  if (found.length) console.error(`warning: unknown manifest fields, ignored: ${found.join(', ')}`);
}

function findTodos(value, where = 'manifest') {
  if (typeof value === 'string') return /\bTODO\b/.test(value) ? [`${where}: ${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findTodos(item, `${where}[${item?.id ?? index}]`));
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => key !== 'note').flatMap(([key, item]) => findTodos(item, `${where}.${key}`));
  return [];
}

function gitState(dir) {
  if (!dir) return undefined;
  try {
    const run = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
    return { commit: run(['rev-parse', '--short', 'HEAD']), dirty: run(['status', '--porcelain']).split('\n').filter(Boolean).length };
  } catch {
    return undefined;
  }
}

function readResults(outDir) {
  if (!outDir) fail('--out <dir> is required');
  const file = path.join(outDir, 'results.json');
  if (!existsSync(file)) fail(`No results.json in ${outDir}. Run a capture first.`);
  return { ...JSON.parse(readFileSync(file, 'utf8')), outDir: path.resolve(outDir) };
}

// File names come from slug(id), so ids that differ only in case or punctuation would overwrite each other's PNGs.
function assertUniqueIds(shots) {
  const seen = new Map();
  for (const shot of shots) {
    if (!shot.id) fail(`every shot needs an id: ${JSON.stringify(shot)}`);
    const name = slug(shot.id);
    if (seen.has(name)) fail(seen.get(name) === shot.id ? `duplicate shot id ${shot.id}` : `shot ids ${seen.get(name)} and ${shot.id} would share the file name ${name}-*.png`);
    seen.set(name, shot.id);
  }
}

// What a capture depended on: the shot, the shared settings, and the bytes of every file they name.
// A kept result whose fingerprint differs from the current manifest is marked stale.
function fingerprint(manifest, shot) {
  const { shots, title, changedFiles, notCaptured, dir, ...shared } = manifest;
  const { label, note, sources, expect, ...captured } = shot;
  const files = [...[].concat(shared.mocks ?? [], captured.mocks ?? [], shared.initScripts ?? [], captured.initScripts ?? []), shared.har, captured.har, shared.storageState]
    .filter((entry) => typeof entry === 'string')
    .map((file) => {
      const resolved = path.resolve(dir, file);
      return existsSync(resolved) && statSync(resolved).isFile() ? createHash('sha1').update(readFileSync(resolved)).digest('hex') : `missing ${file}`;
    });
  return createHash('sha1').update(JSON.stringify({ shared, captured, files })).digest('hex').slice(0, 16);
}

// The report copy of the manifest must not carry credentials.
function redactManifest(manifest) {
  const SECRET = /token|secret|password|passwd|authorization|cookie|session|jwt|api[-_]?key/i;
  const walk = (value, key = '', parent = '') => {
    if (typeof value === 'string' && (SECRET.test(key) || ['extraHTTPHeaders', 'localStorage'].includes(parent))) return '[redacted]';
    if (Array.isArray(value)) return value.map((item) => walk(item, '', parent));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name, key)]));
    return value;
  };
  return walk(manifest);
}
