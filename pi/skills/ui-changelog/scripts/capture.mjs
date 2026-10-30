#!/usr/bin/env node
// Captures before/after screenshot pairs from a manifest, pixel-diffs them, and writes an HTML + Markdown report.
// Usage:
//   node capture.mjs <manifest.json> --out <dir> [--only <id>[,<id>...]] [--headed]
//   node capture.mjs report --out <dir>                  (re-render the report from results.json)
//   node capture.mjs login <url> <storage-state.json>    (headed browser; log in, then close the window)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_HOME = process.env.UI_CHANGELOG_HOME ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'ui-changelog');
const requireFromTool = createRequire(path.join(TOOL_HOME, 'package.json'));

const [command, ...rest] = process.argv.slice(2);
if (!command) fail('Usage: capture.mjs <manifest.json> --out <dir> | report --out <dir> | login <url> <state.json>');

if (command === 'login') await login(rest[0], rest[1]);
else if (command === 'report') {
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
        result[side] = await captureOne(browser, manifest, manifest[side], shot, path.join(outDir, file)).then(
          (info) => ({ file, url: info.url, width: info.width, height: info.height }),
          (error) => ({ error: firstLine(error) }),
        );
      }
      Object.assign(result, await compare(outDir, shot, result, manifest.minDiffPixels ?? 0));
      results.set(shot.id, result);
      console.error(`${result.status.padEnd(9)} ${result.label}${result.diffRatio ? ` (${(result.diffRatio * 100).toFixed(2)}%)` : ''}`);
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

async function captureOne(browser, manifest, side, shot, file) {
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
  try {
    const page = await context.newPage();
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
    return { url, width: png.width, height: png.height };
  } finally {
    await context.close();
  }
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
  return { status: 'changed', diffPixels, diffRatio: diffPixels / (width * height), sizeChanged, diff: { file } };
}

function pad(PNG, image, width, height) {
  if (image.width === width && image.height === height) return image;
  const out = new PNG({ width, height, fill: true });
  PNG.bitblt(image, out, 0, 0, image.width, image.height, 0, 0);
  return out;
}

function writeReport(run) {
  const outDir = run.outDir;
  const groups = ['changed', 'added', 'removed', 'failed', 'unchanged'].map((status) => [status, run.shots.filter((shot) => shot.status === status)]);
  const counts = groups.filter(([, shots]) => shots.length).map(([status, shots]) => `${shots.length} ${status}`).join(' · ');
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
      ${shot.status === 'unchanged'
        ? `<div class="grid one">${img(shot.after, `${shot.label}`)}</div>`
        : `<div class="grid${shot.diff ? ' three' : ''}">
        <figure><figcaption>Before</figcaption>${img(shot.before, `${shot.label} before`)}</figure>
        <figure><figcaption>After</figcaption>${img(shot.after, `${shot.label} after`)}</figure>
        ${shot.diff ? `<figure class="diffcol"><figcaption>Diff</figcaption>${img(shot.diff, `${shot.label} diff`)}</figure>` : ''}
      </div>`}
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
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 10px; align-items: start; }
  .grid.three { grid-template-columns: 1fr 1fr 1fr; }
  .grid.one { grid-template-columns: minmax(0, 900px); }
  body.hide-diff .grid.three { grid-template-columns: 1fr 1fr; }
  body.hide-diff .diffcol { display: none; }
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
  <label><input type="checkbox" id="diff" checked> diff column</label>
</div>
<main>
  <nav>${groups.filter(([, shots]) => shots.length).map(([status, shots]) => `<a href="#${status}">${status} (${shots.length})</a>`).join('')}</nav>
  ${groups.filter(([, shots]) => shots.length).map(([status, shots]) => `<h2 id="${status}">${status}</h2>${shots.map(row).join('')}`).join('\n')}
</main>
<script>document.getElementById('diff').addEventListener('change', (e) => document.body.classList.toggle('hide-diff', !e.target.checked));</script>
</body></html>
`;
  writeFileSync(path.join(outDir, 'index.html'), html);

  const md = [`# ${run.title}`, '', `Before: ${run.before?.ref ?? run.before?.baseURL}. After: ${run.after?.ref ?? run.after?.baseURL}.`];
  const changed = run.shots.filter((shot) => ['changed', 'added', 'removed'].includes(shot.status));
  if (changed.length) {
    md.push('', '**Changed**', '', '| Location | Before | After |', '| --- | --- | --- |');
    for (const shot of changed) md.push(`| ${cell(shot.label)} | ${shot.status === 'added' ? '_new_' : mdImage(shot.before, `${shot.label} before`)} | ${shot.status === 'removed' ? '_removed_' : mdImage(shot.after, `${shot.label} after`)} |`);
  }
  const unchanged = run.shots.filter((shot) => shot.status === 'unchanged');
  if (unchanged.length) {
    md.push('', '**Unchanged**', '', '| Location | Before & After |', '| --- | --- |');
    for (const shot of unchanged) md.push(`| ${cell(shot.label)} | ${mdImage(shot.after, shot.label)} |`);
  }
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
