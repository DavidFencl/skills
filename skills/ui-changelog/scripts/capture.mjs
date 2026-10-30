#!/usr/bin/env node
// Captures before/after screenshot pairs from a manifest, pixel-diffs them, and writes an HTML + Markdown report.
// Usage:
//   node capture.mjs <manifest.json> --out <dir> [--only <id>[,<id>...]] [--headed]
//   node capture.mjs report --out <dir>                  (re-render the report from results.json)
//   node capture.mjs compare --out <dir>                 (re-diff the captured PNGs, then re-render)
//   node capture.mjs login <url> <storage-state.json>    (headed browser; log in, then close the window)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_HOME = process.env.UI_CHANGELOG_HOME ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'ui-changelog');
const requireFromTool = createRequire(path.join(TOOL_HOME, 'package.json'));

const [command, ...rest] = process.argv.slice(2);
if (!command) fail('Usage: capture.mjs <manifest.json> --out <dir> | report --out <dir> | login <url> <state.json>');

if (command === 'login') await login(rest[0], rest[1]);
else if (command === 'compare') {
  const run = readResults(flag(rest, '--out'));
  for (const shot of run.shots) if (shot.before?.file && shot.after?.file) Object.assign(shot, { diff: undefined, circled: undefined, regions: undefined, sizeChanged: undefined }, await compare(run.outDir, shot, shot, 0));
  const { outDir, ...saved } = run;
  writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(saved, null, 2)}\n`);
  writeReport(run);
  console.log(path.join(outDir, 'index.html'));
} else if (command === 'report') {
  const run = readResults(flag(rest, '--out'));
  writeReport(run);
  console.log(path.join(run.outDir, 'index.html'));
}
else await captureAll(command, rest);

async function captureAll(manifestPath, argv) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`Cannot read manifest ${manifestPath}: ${firstLine(error)}`);
  }
  if (!Array.isArray(manifest.shots)) fail('manifest.shots must be an array');
  manifest.dir = path.dirname(path.resolve(manifestPath));
  const outDir = path.resolve(flag(argv, '--out') ?? fail('--out <dir> is required'));
  const only = flag(argv, '--only')?.split(',');
  const shots = manifest.shots.filter((shot) => !only || only.includes(shot.id));
  for (const side of ['before', 'after']) if (!manifest[side]?.baseURL) fail(`manifest.${side}.baseURL is required`);
  assertUniqueIds(manifest.shots);
  for (const side of ['before', 'after']) {
    await fetch(manifest[side].baseURL, { signal: AbortSignal.timeout(10_000) }).catch((error) => fail(`${side} server ${manifest[side].baseURL} is unreachable: ${firstLine(error.cause ?? error)}`));
  }
  mkdirSync(path.join(outDir, 'shots'), { recursive: true });

  const { chromium } = await loadDependency('playwright');
  const browser = await chromium.launch({ headless: !argv.includes('--headed') });
  const previous = existsSync(path.join(outDir, 'results.json')) ? readResults(outDir).shots : [];
  const results = new Map(previous.map((result) => [result.id, result]));
  try {
    for (const shot of shots) {
      const result = { id: shot.id, label: shot.label ?? shot.id, path: shot.path, sources: shot.sources ?? [], note: shot.note };
      for (const side of ['before', 'after']) {
        const file = path.join('shots', `${slug(shot.id)}-${side}.png`);
        if ((side === 'before' && shot.new) || (side === 'after' && shot.removed)) {
          result[side] = { absent: true };
          continue;
        }
        const attempt = () => captureOne(browser, manifest, manifest[side], shot, path.join(outDir, file));
        result[side] = await attempt()
          .catch(attempt)
          .then(
            (info) => ({ file, url: info.url, width: info.width, height: info.height, unmocked: info.unmocked }),
            (error) => ({ error: firstLine(error) }),
          );
      }
      Object.assign(result, await compare(outDir, shot, result, manifest.minDiffPixels ?? 0));
      results.set(shot.id, result);
      console.error(`${result.status.padEnd(9)} ${result.label}${result.diffRatio ? ` (${(result.diffRatio * 100).toFixed(2)}%)` : ''}`);
      const unmocked = [...new Set([...(result.before.unmocked ?? []), ...(result.after.unmocked ?? [])])];
      if (unmocked.length) console.error(`          unanswered API calls: ${unmocked.join(', ')}`);
    }
  } finally {
    await browser.close();
  }
  const ordered = manifest.shots.map((shot) => results.get(shot.id)).filter(Boolean);
  const run = { title: manifest.title ?? 'UI changelog', generatedAt: new Date().toISOString(), before: manifest.before, after: manifest.after, shots: ordered };
  writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(run, null, 2)}\n`);
  writeReport({ ...run, outDir });
  console.log(path.join(outDir, 'index.html'));
}

async function captureOne(browser, baseManifest, side, shot, file) {
  const manifest = { ...baseManifest, networkIdleTimeoutMs: shot.networkIdleTimeoutMs ?? baseManifest.networkIdleTimeoutMs };
  const timeout = manifest.timeoutMs ?? 10_000;
  const viewport = shot.viewport ?? manifest.viewport ?? { width: 1280, height: 800 };
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: shot.deviceScaleFactor ?? manifest.deviceScaleFactor ?? 1,
    colorScheme: shot.colorScheme ?? manifest.colorScheme ?? 'light',
    locale: shot.locale ?? manifest.locale,
    timezoneId: manifest.timezoneId ?? 'UTC',
    reducedMotion: 'reduce',
    storageState: storageStateFor(side.storageState ?? manifest.storageState, side.baseURL),
    extraHTTPHeaders: manifest.extraHTTPHeaders,
  });
  const unmocked = new Set();
  const mocked = new WeakSet();
  try {
    if (manifest.allowHosts) {
      const allowed = new Set([new URL(side.baseURL).host, ...manifest.allowHosts]);
      await context.route('**/*', (route) => {
        const { protocol, host, hostname } = new URL(route.request().url());
        return !/^https?:$/.test(protocol) || allowed.has(host) || allowed.has(hostname) ? route.continue() : route.abort('blockedbyclient');
      });
    }
    const har = shot.har ?? manifest.har;
    if (har) await context.routeFromHAR(path.resolve(manifest.dir, har), { notFound: 'fallback' });
    for (const mock of [...(manifest.mocks ?? []), ...(shot.mocks ?? [])]) await installMock(context, mock, manifest.dir, mocked);
    const page = await context.newPage();
    const isApiCall = (request) => ['xhr', 'fetch'].includes(request.resourceType()) && !mocked.has(request);
    page.on('requestfailed', (request) => {
      if (isApiCall(request)) unmocked.add(`${request.method()} ${new URL(request.url()).pathname} (${request.failure()?.errorText ?? 'failed'})`);
    });
    page.on('response', (response) => {
      if (isApiCall(response.request()) && response.status() >= 500) unmocked.add(`${response.request().method()} ${new URL(response.url()).pathname} (${response.status()})`);
    });
    if (manifest.fixedTime) await page.clock.setFixedTime(new Date(manifest.fixedTime));
    for (const [key, value] of Object.entries(manifest.localStorage ?? {})) {
      await page.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [key, typeof value === 'string' ? value : JSON.stringify(value)]);
    }
    const url = new URL(shot.path ?? '/', side.baseURL).toString();
    await page.goto(url, { waitUntil: 'load', timeout: Math.max(timeout, 30_000) });
    await settle(page, manifest);
    for (const step of shot.steps ?? []) await runStep(page, step, manifest);
    if (shot.waitFor) await page.locator(shot.waitFor).first().waitFor({ state: 'visible', timeout });
    await settle(page, manifest);

    const options = {
      path: file,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      timeout,
      mask: (shot.mask ?? manifest.mask ?? []).map((selector) => page.locator(selector)),
      style: [...(manifest.hide ?? []), ...(shot.hide ?? [])].map((selector) => `${selector} { visibility: hidden !important; }`).join('\n'),
    };
    if (shot.selector) {
      const target = page.locator(shot.selector).first();
      await target.waitFor({ state: 'visible', timeout });
      await target.scrollIntoViewIfNeeded({ timeout });
      if (shot.padding) {
        const box = await target.boundingBox();
        if (!box) throw new Error(`selector ${shot.selector} is not visible`);
        const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
        const pad = shot.padding;
        const x = Math.max(0, box.x + scroll.x - pad);
        const y = Math.max(0, box.y + scroll.y - pad);
        await page.screenshot({ ...options, fullPage: true, clip: { x, y, width: box.x + scroll.x + box.width + pad - x, height: box.y + scroll.y + box.height + pad - y } });
      } else {
        await target.screenshot(options);
      }
    } else {
      await page.screenshot({ ...options, fullPage: shot.fullPage ?? false });
    }
    const { PNG } = await loadDependency('pngjs');
    const png = PNG.sync.read(readFileSync(file));
    return { url, width: png.width, height: png.height, unmocked: [...unmocked] };
  } finally {
    await context.close();
  }
}

// Later mocks win: Playwright runs the most recently registered matching route first.
async function installMock(context, mock, manifestDir, mocked) {
  if (!mock.url && !mock.urlRegex) fail(`mock needs url or urlRegex: ${JSON.stringify(mock)}`);
  const pattern = mock.urlRegex ? new RegExp(mock.urlRegex) : globToRegExp(mock.url);
  const matcher = (url) => pattern.test(mock.urlRegex || mock.url.includes('?') ? url.href : url.origin + url.pathname);
  const methods = [].concat(mock.method ?? []).map((method) => method.toUpperCase());
  const body = mock.file ? readFileSync(path.resolve(manifestDir, mock.file)) : mock.json !== undefined ? JSON.stringify(mock.json) : mock.body;
  let remaining = mock.times ?? Infinity;
  await context.route(matcher, async (route) => {
    const request = route.request();
    const origin = (await request.headerValue('origin')) ?? '*';
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if ((methods.length && !methods.includes(request.method())) || remaining <= 0) return route.fallback();
    remaining -= 1;
    mocked.add(request);
    if (mock.pending) return;
    if (mock.delayMs) await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
    if (mock.abort) return route.abort(typeof mock.abort === 'string' ? mock.abort : 'connectionrefused').catch(() => {});
    return route.fulfill({
      status: mock.status ?? 200,
      headers: { ...cors, 'content-type': mock.contentType ?? (mock.json !== undefined || mock.file?.endsWith('.json') ? 'application/json' : 'text/plain'), ...mock.headers },
      body: body ?? '',
    }).catch(() => {});
  });
}

function globToRegExp(glob) {
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*').replace(/\?/g, '\\?');
  return new RegExp(`^${source}$`);
}

async function runStep(page, step, manifest) {
  const timeout = manifest.timeoutMs ?? 10_000;
  const locate = (selector) => page.locator(selector).first();
  if (step.click) await locate(step.click).click({ timeout });
  else if (step.hover) await locate(step.hover).hover({ timeout });
  else if (step.focus) await locate(step.focus).focus({ timeout });
  else if (step.fill) await locate(step.fill).fill(step.value ?? '', { timeout });
  else if (step.select) await locate(step.select).selectOption(step.value, { timeout });
  else if (step.check) await locate(step.check).check({ timeout });
  else if (step.press) await (step.selector ? locate(step.selector).press(step.press, { timeout }) : page.keyboard.press(step.press));
  else if (step.scroll) await locate(step.scroll).scrollIntoViewIfNeeded({ timeout });
  else if (step.waitFor) await locate(step.waitFor).waitFor({ state: 'visible', timeout });
  else if (step.waitForHidden) await locate(step.waitForHidden).waitFor({ state: 'hidden', timeout });
  else if (step.goto) await page.goto(new URL(step.goto, page.url()).toString(), { waitUntil: 'load', timeout: Math.max(timeout, 30_000) });
  else if (step.wait) await page.waitForTimeout(step.wait);
  else throw new Error(`unknown step ${JSON.stringify(step)}`);
  if (!step.wait) await settle(page, manifest);
}

async function settle(page, manifest) {
  await page.waitForLoadState('networkidle', { timeout: manifest.networkIdleTimeoutMs ?? 10_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  for (const selector of manifest.waitForHidden ?? []) {
    await page.locator(selector).first().waitFor({ state: 'hidden', timeout: manifest.timeoutMs ?? 10_000 }).catch(() => {});
  }
  if (manifest.settleMs !== 0) await page.waitForTimeout(manifest.settleMs ?? 300);
}

// A state saved on one origin is re-keyed to the side's origin, because before and after run on different ports.
function storageStateFor(statePath, baseURL) {
  if (!statePath) return undefined;
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const origin = new URL(baseURL).origin;
  if (state.origins?.length === 1) state.origins = [{ ...state.origins[0], origin }];
  return state;
}

async function compare(outDir, shot, result, minDiffPixels) {
  const { before, after } = result;
  if (before.absent && after.file) return { status: 'added' };
  if (after.absent && before.file) return { status: 'removed' };
  if (!before.file || !after.file) return { status: 'failed' };

  const { PNG } = await loadDependency('pngjs');
  const pixelmatch = (await loadDependency('pixelmatch')).default;
  const a = PNG.sync.read(readFileSync(path.join(outDir, before.file)));
  const b = PNG.sync.read(readFileSync(path.join(outDir, after.file)));
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(pad(PNG, a, width, height).data, pad(PNG, b, width, height).data, diff.data, width, height, {
    threshold: shot.threshold ?? 0.1,
    includeAA: false,
    alpha: 0.2,
  });
  const sizeChanged = a.width !== b.width || a.height !== b.height;
  if (!sizeChanged && diffPixels <= minDiffPixels) return { status: 'unchanged', diffPixels, diffRatio: 0 };
  const file = path.join('shots', `${slug(shot.id)}-diff.png`);
  writeFileSync(path.join(outDir, file), PNG.sync.write(diff));

  let mask = a.width === b.width ? shiftAwareMask(PNG, a, b) : null;
  if (!mask) {
    mask = new PNG({ width, height });
    pixelmatch(pad(PNG, a, width, height).data, pad(PNG, b, width, height).data, mask.data, width, height, { threshold: shot.threshold ?? 0.1, includeAA: false, diffMask: true, diffColor: [255, 0, 0], aaColor: [0, 0, 0] });
  }
  if (process.env.UI_CHANGELOG_DEBUG) writeFileSync(path.join(outDir, 'shots', `${slug(shot.id)}-mask.png`), PNG.sync.write(mask));
  const regions = changedRegions(mask, b.width, b.height);
  const circledFile = path.join('shots', `${slug(shot.id)}-circled.png`);
  writeFileSync(path.join(outDir, circledFile), PNG.sync.write(drawOutlines(PNG, b, regions)));
  return { status: 'changed', diffPixels, diffRatio: diffPixels / (width * height), sizeChanged, diff: { file }, circled: { file: circledFile }, regions };
}

// Marks after-pixels that are new or modified, treating content that only moved as unchanged.
// Rows are aligned like lines in a text diff. Inside a band that does not align, the band is split at
// empty vertical gutters and each column is aligned on its own, so multi-column layouts that shift
// by different amounts still match. Pixels left over are compared with their counterpart row, or with
// the row's dominant color when the row was inserted.
function shiftAwareMask(PNG, a, b) {
  const mask = new PNG({ width: b.width, height: b.height });
  return alignBlock(a, b, mask, { x0: 0, x1: b.width, a0: 0, a1: a.height, b0: 0, b1: b.height }, 0) ? mask : null;
}

function alignBlock(a, b, mask, { x0, x1, a0, a1, b0, b1 }, depth) {
  const ids = new Map();
  const rowIds = (image, from, to) =>
    Array.from({ length: to - from }, (_, i) => {
      const y = from + i;
      const hash = createHash('sha1').update(image.data.subarray((y * image.width + x0) * 4, (y * image.width + x1) * 4)).digest('base64');
      if (!ids.has(hash)) ids.set(hash, ids.size);
      return ids.get(hash);
    });
  const pairs = myersMatches(rowIds(a, a0, a1), rowIds(b, b0, b1));
  if (!pairs) return false;
  const bounds = [[-1, -1], ...pairs, [a1 - a0, b1 - b0]];
  const bands = [];
  for (let p = 0; p < bounds.length - 1; p++) {
    const band = { x0, x1, aStart: a0 + bounds[p][0] + 1, aEnd: a0 + bounds[p + 1][0], bStart: b0 + bounds[p][1] + 1, bEnd: b0 + bounds[p + 1][1] };
    if (band.aEnd <= band.aStart && band.bEnd <= band.bStart) continue;
    const last = bands.at(-1);
    // Blank rows match by chance and fragment one change into many hunks; nearby hunks are one change.
    if (last && band.aStart - last.aEnd <= 24 && band.bStart - last.bEnd <= 24) Object.assign(last, { aEnd: band.aEnd, bEnd: band.bEnd });
    else bands.push(band);
  }
  for (const band of bands) {
    if (band.bEnd <= band.bStart) {
      if (!isPlain(a, band.aStart, band.aEnd, x0, x1)) markRemoval(b, mask, band);
      continue;
    }
    const strips = depth < 3 ? splitAtGutters(a, b, band) : [];
    if (strips.length > 1) {
      for (const [s0, s1] of strips) {
        const sub = { x0: s0, x1: s1, a0: band.aStart, a1: band.aEnd, b0: band.bStart, b1: band.bEnd };
        if (!alignBlock(a, b, mask, sub, depth + 1)) markPixels(a, b, mask, { ...band, x0: s0, x1: s1 });
      }
    } else {
      markPixels(a, b, mask, band);
    }
  }
  return true;
}

function markPixels(a, b, mask, { x0, x1, aStart, aEnd, bStart, bEnd }) {
  const background = contextBackground(b, { x0, x1, bStart, bEnd });
  for (let y = bStart; y < bEnd; y++) {
    const counterpart = aStart + (y - bStart) < aEnd ? aStart + (y - bStart) : -1;
    for (let x = x0; x < x1; x++) {
      const i = (y * b.width + x) * 4;
      const changed = counterpart === -1 ? colorDistance(b.data, i, background, 0) > 48 : colorDistance(b.data, i, a.data, (counterpart * a.width + x) * 4) > 48;
      if (changed) setMask(mask, x, y);
    }
  }
}

function markRemoval(b, mask, { x0, x1, bStart }) {
  const y = Math.min(Math.max(bStart, 0), b.height - 1);
  for (let dy = -2; dy <= 2; dy++) for (let x = x0; x < x1; x++) if (y + dy >= 0 && y + dy < b.height) setMask(mask, x, y + dy);
}

// The page color around a band: the row just above it, or just below when the band starts at the top.
function contextBackground(b, { x0, x1, bStart, bEnd }) {
  return dominantColor(b, bStart > 0 ? bStart - 1 : Math.min(bEnd, b.height - 1), x0, x1);
}

function splitAtGutters(a, b, { x0, x1, aStart, aEnd, bStart, bEnd }, minGutter = 12) {
  const background = contextBackground(b, { x0, x1, bStart, bEnd });
  const allowed = Math.max(2, Math.floor((aEnd - aStart + bEnd - bStart) * 0.03));
  const isGutter = (x) => {
    let foreground = 0;
    for (const [image, from, to] of [[a, aStart, aEnd], [b, bStart, bEnd]]) {
      for (let y = from; y < to; y++) if (colorDistance(image.data, (y * image.width + x) * 4, background, 0) > 24 && ++foreground > allowed) return false;
    }
    return true;
  };
  const strips = [];
  let stripStart = -1;
  let gap = 0;
  for (let x = x0; x <= x1; x++) {
    if (x < x1 && !isGutter(x)) {
      if (stripStart === -1) stripStart = x;
      else if (gap >= minGutter) {
        strips.push([stripStart, x - gap]);
        stripStart = x;
      }
      gap = 0;
    } else if (stripStart !== -1) {
      gap++;
      if (x === x1) strips.push([stripStart, x - gap + 1]);
    }
  }
  return strips.map(([s0, s1]) => [Math.max(x0, s0 - 2), Math.min(x1, s1 + 2)]);
}

// Rows that are one color, such as blank space or a border line, carry no content worth flagging when removed.
function isPlain(image, from, to, x0, x1) {
  const allowed = Math.floor((x1 - x0) * 0.03);
  for (let y = from; y < to; y++) {
    const background = dominantColor(image, y, x0, x1);
    let other = 0;
    for (let x = x0; x < x1; x++) if (colorDistance(image.data, (y * image.width + x) * 4, background, 0) > 24 && ++other > allowed) return false;
  }
  return true;
}

function setMask(mask, x, y) {
  const i = (y * mask.width + x) * 4;
  mask.data[i] = 255;
  mask.data[i + 3] = 255;
}

function colorDistance(data1, i1, data2, i2) {
  return Math.abs(data1[i1] - data2[i2]) + Math.abs(data1[i1 + 1] - data2[i2 + 1]) + Math.abs(data1[i1 + 2] - data2[i2 + 2]);
}

function dominantColor(image, y, x0 = 0, x1 = image.width) {
  const counts = new Map();
  let best = [0, 0, 0];
  let bestCount = 0;
  for (let x = x0; x < x1; x += 2) {
    const i = (y * image.width + x) * 4;
    const key = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > bestCount) [best, bestCount] = [[image.data[i], image.data[i + 1], image.data[i + 2]], count];
  }
  return best;
}

// Myers diff over row ids; returns matched [aIndex, bIndex] pairs in order, or null when the rows differ too much.
function myersMatches(a, b, maxEdits = 4000) {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace = [];
  for (let d = 0; d <= Math.min(n + m, maxEdits); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) [x, y] = [x + 1, y + 1];
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace, n, m) {
  const pairs = [];
  let [x, y] = [n, m];
  for (let d = trace.length - 1; d >= 0; d--) {
    const saved = trace[d];
    const at = (k) => saved[k + d + 1];
    const k = x - y;
    const prevK = d === 0 ? 0 : k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      [x, y] = [x - 1, y - 1];
      pairs.push([x, y]);
    }
    [x, y] = [prevX, prevY];
  }
  return pairs.reverse();
}

// Groups changed pixels into boxes: mark 8px cells, join cells closer than 3 cells, drop specks.
function changedRegions(mask, width, height, cell = 8, gap = 3, minPixels = 4) {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * mask.width + x) * 4;
      if (mask.data[i + 3] && mask.data[i] === 255 && mask.data[i + 1] === 0) counts[Math.floor(y / cell) * cols + Math.floor(x / cell)]++;
    }
  }
  const seen = new Uint8Array(cols * rows);
  const boxes = [];
  for (let start = 0; start < counts.length; start++) {
    if (!counts[start] || seen[start]) continue;
    const box = { c0: cols, r0: rows, c1: 0, r1: 0, pixels: 0 };
    const queue = [start];
    seen[start] = 1;
    while (queue.length) {
      const index = queue.pop();
      const c = index % cols;
      const r = Math.floor(index / cols);
      Object.assign(box, { c0: Math.min(box.c0, c), r0: Math.min(box.r0, r), c1: Math.max(box.c1, c), r1: Math.max(box.r1, r), pixels: box.pixels + counts[index] });
      for (let dr = -gap; dr <= gap; dr++) {
        for (let dc = -gap; dc <= gap; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          const next = nr * cols + nc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || seen[next] || !counts[next]) continue;
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    if (box.pixels >= minPixels) boxes.push(box);
  }
  const margin = 10;
  return boxes.map(({ c0, r0, c1, r1 }) => {
    const x = Math.max(0, c0 * cell - margin);
    const y = Math.max(0, r0 * cell - margin);
    return { x, y, width: Math.min(width, (c1 + 1) * cell + margin) - x, height: Math.min(height, (r1 + 1) * cell + margin) - y };
  });
}

function drawOutlines(PNG, image, regions) {
  const out = new PNG({ width: image.width, height: image.height });
  image.data.copy(out.data);
  const paint = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    const i = (y * out.width + x) * 4;
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
    out.data[i + 3] = 255;
  };
  const radius = 8;
  const ring = (box, inset, color) => {
    const x0 = box.x + inset;
    const y0 = box.y + inset;
    const x1 = box.x + box.width - 1 - inset;
    const y1 = box.y + box.height - 1 - inset;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (x > x0 && x < x1 && y > y0 && y < y1) {
          y = y1 - 1;
          continue;
        }
        const cx = x < x0 + radius ? x0 + radius : x > x1 - radius ? x1 - radius : x;
        const cy = y < y0 + radius ? y0 + radius : y > y1 - radius ? y1 - radius : y;
        if ((cx !== x || cy !== y) && Math.hypot(x - cx, y - cy) > radius) continue;
        paint(x, y, color);
      }
    }
    for (let k = 0; k <= 90; k++) {
      const angle = (k / 90) * (Math.PI / 2);
      const dx = Math.round(Math.cos(angle) * radius);
      const dy = Math.round(Math.sin(angle) * radius);
      paint(x0 + radius - dx, y0 + radius - dy, color);
      paint(x1 - radius + dx, y0 + radius - dy, color);
      paint(x0 + radius - dx, y1 - radius + dy, color);
      paint(x1 - radius + dx, y1 - radius + dy, color);
    }
  };
  for (const box of regions) {
    ring(box, -1, [255, 255, 255]);
    for (let inset = 0; inset < 3; inset++) ring(box, inset, [255, 45, 85]);
    ring(box, 3, [255, 255, 255]);
  }
  return out;
}

function pad(PNG, image, width, height) {
  if (image.width === width && image.height === height) return image;
  const out = new PNG({ width, height, fill: true });
  PNG.bitblt(image, out, 0, 0, image.width, image.height, 0, 0);
  return out;
}

function writeReport(run) {
  const outDir = run.outDir;
  const titles = { changed: 'Changed', added: 'New', removed: 'Removed', failed: 'Not captured' };
  const groups = Object.keys(titles).map((status) => [status, run.shots.filter((shot) => shot.status === status)]).filter(([, shots]) => shots.length);
  const unchanged = run.shots.filter((shot) => shot.status === 'unchanged');
  const counts = [...groups.map(([status, shots]) => `${shots.length} ${titles[status].toLowerCase()}`), unchanged.length ? `${unchanged.length} checked unchanged` : ''].filter(Boolean).join(' · ');
  const sideLabel = (side) => [side?.ref, side?.baseURL].filter(Boolean).map(escape).join(' · ');

  const img = (side, alt) => (side?.file ? `<a href="${escape(side.file)}" target="_blank"><img loading="lazy" src="${escape(side.file)}" alt="${escape(alt)}"></a>` : `<div class="missing">${side?.absent ? 'Not present on this side (expected).' : escape(side?.error ?? 'not captured')}</div>`);
  const row = (shot) => `
    <section class="shot ${shot.status}" id="${escape(slug(shot.id))}">
      <header>
        <h3><a href="#${escape(slug(shot.id))}">${escape(shot.label)}</a></h3>
        <span class="meta">${escape(shot.path ?? '')}${shot.diffRatio ? ` · ${(shot.diffRatio * 100).toFixed(2)}% pixels` : ''}${shot.sizeChanged ? ` · size ${shot.before.width}×${shot.before.height} → ${shot.after.width}×${shot.after.height}` : ''}</span>
        ${shot.note ? `<p class="note">${escape(shot.note)}</p>` : ''}
        ${shot.sources.length ? `<p class="sources">${shot.sources.map((source) => `<code>${escape(source)}</code>`).join(' ')}</p>` : ''}
      </header>
      ${{
        changed: () => `<div class="grid">
        <figure><figcaption>Before</figcaption>${img(shot.before, `${shot.label} before`)}</figure>
        <figure><figcaption>After</figcaption>${img(shot.after, `${shot.label} after`)}</figure>
        ${shot.circled ? `<figure class="circledcol"><figcaption>Circled changes (${shot.regions.length})</figcaption>${img(shot.circled, `${shot.label} changes circled`)}</figure>` : ''}
        <figure class="diffcol"><figcaption>Diff</figcaption>${img(shot.diff, `${shot.label} diff`)}</figure>
      </div>`,
        added: () => `<div class="grid single"><figure><figcaption>New</figcaption>${img(shot.after, `${shot.label}`)}</figure></div>`,
        removed: () => `<div class="grid single"><figure><figcaption>Removed</figcaption>${img(shot.before, `${shot.label}`)}</figure></div>`,
        failed: () => `<div class="grid">${['before', 'after'].map((side) => `<figure><figcaption>${side}</figcaption>${img(shot[side], `${shot.label} ${side}`)}</figure>`).join('')}</div>`,
      }[shot.status]()}
    </section>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(run.title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --fg: #1b1f24; --muted: #5b6470; --line: #d9dee4; --accent: #0b62d6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111418; --card: #1a1f25; --fg: #e8ebef; --muted: #9aa4b0; --line: #2c333b; --accent: #6aa8ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  .top { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 24px; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  .top h1 { font-size: 18px; margin: 0; }
  .top .meta, .meta { color: var(--muted); }
  .top label { margin-left: auto; color: var(--muted); }
  main { padding: 16px 24px 48px; max-width: 1800px; margin: 0 auto; }
  h2 { font-size: 15px; text-transform: capitalize; margin: 28px 0 8px; }
  nav a { color: var(--accent); margin-right: 12px; text-decoration: none; }
  .shot { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px 16px; margin: 12px 0; }
  .shot header { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  .shot h3 { font-size: 14px; margin: 0; }
  .shot h3 a { color: inherit; text-decoration: none; }
  .note, .sources { flex-basis: 100%; margin: 2px 0 0; color: var(--muted); }
  code { font-size: 12px; background: color-mix(in srgb, var(--line) 50%, transparent); padding: 1px 4px; border-radius: 4px; }
  .grid { display: flex; gap: 12px; margin-top: 10px; align-items: flex-start; }
  .grid > figure { flex: 1 1 0; }
  .grid.single > figure { flex: 0 1 900px; }
  body.hide-diff .diffcol, body.hide-circled .circledcol { display: none; }
  .checked { color: var(--muted); margin-top: 28px; }
  figure { margin: 0; min-width: 0; }
  figcaption { font-weight: 600; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 4px; background: repeating-conic-gradient(#8881 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
  .missing { padding: 24px; border: 1px dashed var(--line); border-radius: 4px; color: var(--muted); }
  .shot.failed { border-color: #c0392b; }
</style></head>
<body>
<div class="top">
  <h1>${escape(run.title)}</h1>
  <span class="meta">${counts || 'no shots'} · before: ${sideLabel(run.before)} · after: ${sideLabel(run.after)}</span>
  <label><input type="checkbox" data-toggle="hide-circled" checked> circled</label>
  <label style="margin-left:0"><input type="checkbox" data-toggle="hide-diff" checked> diff</label>
</div>
<main>
  <nav>${groups.map(([status, shots]) => `<a href="#${status}">${titles[status]} (${shots.length})</a>`).join('')}</nav>
  ${groups.map(([status, shots]) => `<h2 id="${status}">${titles[status]}</h2>${shots.map(row).join('')}`).join('\n') || '<p>No visual changes found.</p>'}
  ${unchanged.length ? `<p class="checked">Checked and unchanged: ${unchanged.map((shot) => escape(shot.label)).join(', ')}.</p>` : ''}
</main>
<script>for (const box of document.querySelectorAll('[data-toggle]')) box.addEventListener('change', () => document.body.classList.toggle(box.dataset.toggle, !box.checked));</script>
</body></html>
`;
  writeFileSync(path.join(outDir, 'index.html'), html);

  const md = [`# ${run.title}`, '', `Before: ${run.before?.ref ?? run.before?.baseURL}. After: ${run.after?.ref ?? run.after?.baseURL}.`];
  const changed = run.shots.filter((shot) => shot.status === 'changed');
  if (changed.length) {
    md.push('', '**Changed**', '', '| Location | Before | After | Changes circled |', '| --- | --- | --- | --- |');
    for (const shot of changed) md.push(`| ${cell(shot.label)} | ${mdImage(shot.before, `${shot.label} before`)} | ${mdImage(shot.after, `${shot.label} after`)} | ${mdImage(shot.circled, `${shot.label} changes circled`)} |`);
  }
  for (const [status, side, heading] of [['added', 'after', 'New'], ['removed', 'before', 'Removed']]) {
    const shots = run.shots.filter((shot) => shot.status === status);
    if (!shots.length) continue;
    md.push('', `**${heading}**`, '', '| Location | Screenshot |', '| --- | --- |');
    for (const shot of shots) md.push(`| ${cell(shot.label)} | ${mdImage(shot[side], shot.label)} |`);
  }
  if (unchanged.length) md.push('', `Checked and unchanged: ${unchanged.map((shot) => shot.label).join(', ')}.`);
  const failed = run.shots.filter((shot) => shot.status === 'failed');
  if (failed.length) md.push('', '**Not captured**', '', ...failed.map((shot) => `- ${shot.label}: ${['before', 'after'].filter((side) => shot[side].error).map((side) => `${side}: ${shot[side].error}`).join('; ')}`));
  writeFileSync(path.join(outDir, 'report.md'), `${md.join('\n')}\n`);
}

function mdImage(side, alt) {
  return side?.file ? `![${cell(alt)}](./${side.file})` : `_${cell(side?.error ?? 'none')}_`;
}

async function login(url, statePath) {
  if (!url || !statePath) fail('Usage: capture.mjs login <url> <storage-state.json>');
  const { chromium } = await loadDependency('playwright');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto(url);
  console.error('Log in, then close the browser window. The session is saved when the page closes.');
  await page.waitForEvent('close', { timeout: 0 });
  mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true });
  await context.storageState({ path: statePath });
  await browser.close();
  console.log(path.resolve(statePath));
}

async function loadDependency(name) {
  try {
    return requireFromTool(name);
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    fail(`Missing dependency "${name}" in ${TOOL_HOME}. Run: bash ${path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup.sh')}`);
  }
}

function readResults(outDir) {
  if (!outDir) fail('--out <dir> is required');
  return { ...JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8')), outDir: path.resolve(outDir) };
}

function assertUniqueIds(shots) {
  const seen = new Set();
  for (const shot of shots) {
    if (!shot.id) fail(`every shot needs an id: ${JSON.stringify(shot)}`);
    if (seen.has(shot.id)) fail(`duplicate shot id ${shot.id}`);
    seen.add(shot.id);
  }
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function cell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function firstLine(error) {
  return String(error?.message ?? error).split('\n')[0];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
