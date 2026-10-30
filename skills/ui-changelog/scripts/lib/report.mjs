// Renders a capture run (results.json) as index.html, report.md and unanswered.json.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { graphqlOperation } from './mocks.mjs';
import { escapeHtml as esc, mdCell, slug } from './util.mjs';

const TITLES = { changed: 'Changed', added: 'New', removed: 'Removed', failed: 'Not captured' };
const MAX_ZOOMS = 12;

// Everything a reviewer should look at before trusting the report, derived from the results.
export function analyze(run) {
  const shots = run.shots;
  const groups = Object.keys(TITLES).map((status) => [status, shots.filter((shot) => shot.status === status)]).filter(([, list]) => list.length);
  const unchanged = shots.filter((shot) => shot.status === 'unchanged');
  const attention = [];
  const add = (shot, text) => attention.push({ id: shot?.id, label: shot?.label, text });

  if (run.before?.baseURL && run.before.baseURL === run.after?.baseURL) add(null, 'Before and after use the same server, so every pair compares the code with itself.');
  if (run.before?.git && run.after?.git && run.before.git.commit === run.after.git.commit && !run.before.git.dirty && !run.after.git.dirty) {
    add(null, `Before and after are the same commit (${run.before.git.commit}) with no local changes.`);
  }
  for (const shot of shots) {
    if (shot.status === 'not-run') add(shot, `Not run: the shot is in the manifest but has no result. Capture it with --only ${shot.id}.`);
    if (shot.stale) add(shot, `Captured with an earlier version of the manifest, mocks or fixtures. Recapture it with --only ${shot.id}.`);
    const mismatch = expectationMismatch(shot);
    if (mismatch) add(shot, mismatch);
    if (shot.status === 'failed') add(shot, `Not captured: ${sideErrors(shot).join('; ')}`);
    const newErrors = errorsOnlyAfter(shot);
    if (newErrors.length) add(shot, `Errors logged only on the after side: ${newErrors.slice(0, 2).join(' | ')}`);
    for (const warning of new Set(['before', 'after'].flatMap((side) => shot[side]?.warnings ?? []))) add(shot, warning);
    for (const skipped of uniqueBy(['before', 'after'].flatMap((side) => shot[side]?.network?.skipped ?? []), (entry) => entry.name)) {
      add(shot, `Mock "${skipped.name}" also matched non-API requests (${skipped.requests.join(', ')}), which were left alone. Pin its URL to the API origin.`);
    }
  }
  const unanswered = aggregateUnanswered(run);
  if (unanswered.length) {
    const listed = unanswered.slice(0, 4).map((call) => `${call.method} ${call.path} (${call.shots.length} shot${call.shots.length > 1 ? 's' : ''})`);
    add(null, `${unanswered.length} API endpoint${unanswered.length > 1 ? 's' : ''} went unanswered, so data on those screens may be missing: ${listed.join(', ')}${unanswered.length > 4 ? ', …' : ''}. The full list is in unanswered.json.`);
  }
  const coverage = coverageOf(run);
  const uncovered = coverage.filter((row) => !row.shots.length && !row.reason);
  if (uncovered.length) add(null, `${uncovered.length} changed file${uncovered.length > 1 ? 's have' : ' has'} no shot and no reason: ${uncovered.map((row) => row.file).join(', ')}`);
  return { groups, unchanged, attention, coverage, unanswered };
}

export function expectationMismatch(shot) {
  if (!shot.expect || !['changed', 'unchanged'].includes(shot.status)) return null;
  if (shot.expect === 'changed' && shot.status === 'unchanged') return 'Expected a visible change, but before and after are identical. The shot may show the wrong place or state.';
  if (shot.expect === 'unchanged' && shot.status === 'changed') return `Expected no change, but ${shot.regions?.length ?? 0} region${shot.regions?.length === 1 ? '' : 's'} differ. Mask the noise, or report it as a side effect.`;
  return null;
}

function coverageOf(run) {
  const files = run.changedFiles ?? [];
  const reasons = new Map((run.notCaptured ?? []).filter((entry) => entry.file).map((entry) => [entry.file, entry.reason]));
  return files.map((file) => ({ file, shots: run.shots.filter((shot) => (shot.sources ?? []).includes(file)), reason: reasons.get(file) }));
}

function unansweredOf(shot) {
  return uniqueBy(['before', 'after'].flatMap((side) => shot[side]?.network?.unanswered ?? []), (call) => `${call.method} ${pathOf(call.url)}`);
}

// Messages differ only by the side's own origin (port), so compare them without it.
function errorsOnlyAfter(shot) {
  const normalize = (message) => message.replace(/\b(?:https?|wss?):\/\/[^\s/'")]+/g, '<origin>');
  const before = new Set((shot.before?.errors ?? []).map(normalize));
  return (shot.after?.errors ?? []).filter((message) => !before.has(normalize(message)));
}

// One entry per endpoint. Calls to the frontend's own origin differ in port between the sides, so
// they are keyed by path alone and get an empty origin.
function aggregateUnanswered(run) {
  const byKey = new Map();
  for (const shot of run.shots) {
    for (const side of ['before', 'after']) {
      const own = run[side]?.baseURL ? new URL(run[side].baseURL).origin : null;
      for (const call of shot[side]?.network?.unanswered ?? []) {
        const url = new URL(call.url);
        const origin = url.origin === own ? '' : url.origin;
        // GraphQL operations share one URL, so each operation is its own endpoint.
        const operation = call.method === 'WS' ? null : graphqlOperation({ body: call.postData, url });
        const key = `${call.method} ${origin}${url.pathname}${operation ? ` ${operation}` : ''}`;
        const entry = byKey.get(key) ?? { method: call.method, origin, path: url.pathname, ...(operation ? { operation } : {}), resourceType: call.resourceType, reasons: [], examples: [], postData: call.postData ?? null, shots: [] };
        if (!entry.reasons.includes(call.reason)) entry.reasons.push(call.reason);
        if (!entry.examples.includes(call.url) && entry.examples.length < 3) entry.examples.push(call.url);
        if (!entry.shots.includes(shot.id)) entry.shots.push(shot.id);
        entry.postData ??= call.postData ?? null;
        byKey.set(key, entry);
      }
    }
  }
  return [...byKey.values()];
}

export function writeReport(run) {
  const facts = analyze(run);
  writeFileSync(path.join(run.outDir, 'index.html'), renderHtml(run, facts));
  writeFileSync(path.join(run.outDir, 'report.md'), renderMarkdown(run, facts));
  writeFileSync(path.join(run.outDir, 'unanswered.json'), `${JSON.stringify(facts.unanswered, null, 2)}\n`);
  return facts;
}

function sideLabel(side) {
  if (!side) return '';
  const parts = [side.ref];
  if (side.git && !String(side.ref ?? '').includes(side.git.commit)) parts.push(side.git.commit);
  if (side.git?.dirty) parts.push(`${side.git.dirty} uncommitted file${side.git.dirty > 1 ? 's' : ''}`);
  return parts.filter(Boolean).join(' · ') || side.baseURL || '';
}

function counts(facts) {
  return [...facts.groups.map(([status, list]) => [status, `${list.length} ${TITLES[status].toLowerCase()}`]), ...(facts.unchanged.length ? [['unchanged', `${facts.unchanged.length} unchanged`]] : [])];
}

function renderHtml(run, facts) {
  const mockedEndpoints = new Set(run.shots.flatMap((shot) => ['before', 'after'].flatMap((side) => (shot[side]?.network?.mocked ?? []).map((hit) => hit.name))));
  const blocked = run.shots.flatMap((shot) => ['before', 'after'].flatMap((side) => shot[side]?.network?.blocked ?? []));
  const blockedHosts = new Set(blocked.map((entry) => entry.host));
  const setup = [
    `captured ${esc(run.generatedAt?.replace('T', ' ').slice(0, 16) ?? '')} UTC`,
    mockedEndpoints.size ? `API mocked: ${mockedEndpoints.size} endpoint${mockedEndpoints.size > 1 ? 's' : ''} answered with fictional data` : 'no mocks answered',
    blockedHosts.size ? `blocked ${blocked.reduce((sum, entry) => sum + entry.count, 0)} requests to ${blockedHosts.size} other host${blockedHosts.size > 1 ? 's' : ''}` : '',
    run.manifest ? `<a href="${esc(run.manifest)}">manifest</a>` : '',
  ].filter(Boolean);
  const chips = counts(facts).map(([status, text]) => (status === 'unchanged' ? `<a class="chip unchanged" href="#unchanged">${esc(text)}</a>` : `<a class="chip ${status}" href="#${status}">${esc(text)}</a>`));
  if (facts.attention.length) chips.push(`<a class="chip attention" href="#attention">${facts.attention.length} need${facts.attention.length === 1 ? 's' : ''} attention</a>`);

  const attention = facts.attention.length
    ? `<section id="attention" class="panel attention-panel"><h2>Needs attention</h2><ul>${facts.attention.map((item) => `<li>${item.id ? `<a href="#${esc(slug(item.id))}">${esc(item.label)}</a>: ` : ''}${esc(item.text)}</li>`).join('')}</ul></section>`
    : '';
  const multiViewport = new Set(run.shots.map(viewportText)).size > 1;
  const overview = run.shots.length > 3
    ? `<section class="panel"><h2>All shots</h2><table class="overview"><thead><tr><th>Status</th><th>Location and state</th>${multiViewport ? '<th>Viewport</th>' : ''}<th>Changes</th></tr></thead><tbody>${run.shots.map((shot) => `<tr><td><span class="dot ${shot.status}"></span>${esc(shot.status === 'added' ? 'new' : shot.status)}${expectationMismatch(shot) ? ' <span class="flag">unexpected</span>' : ''}</td><td><a href="#${esc(slug(shot.id))}">${esc(shot.label)}</a></td>${multiViewport ? `<td>${esc(viewportText(shot))}</td>` : ''}<td>${shot.regions ? `${shot.regions.length} region${shot.regions.length > 1 ? 's' : ''}` : ''}</td></tr>`).join('')}</tbody></table></section>`
    : '';
  const coverage = facts.coverage.length
    ? `<section class="panel"><h2>Changed files</h2><table class="overview"><thead><tr><th>File</th><th>Covered by</th></tr></thead><tbody>${facts.coverage.map((row) => `<tr><td><code>${esc(row.file)}</code></td><td>${row.shots.length ? row.shots.map((shot) => `<a href="#${esc(slug(shot.id))}">${esc(shot.label)}</a>`).join(', ') : row.reason ? `<span class="muted">not captured: ${esc(row.reason)}</span>` : '<span class="flag">no shot</span>'}</td></tr>`).join('')}${(run.notCaptured ?? []).filter((entry) => !entry.file).map((entry) => `<tr><td>${esc(entry.location ?? '')}</td><td><span class="muted">not captured: ${esc(entry.reason ?? '')}</span></td></tr>`).join('')}</tbody></table></section>`
    : '';
  const sections = facts.groups.map(([status, list]) => `<h2 id="${status}">${TITLES[status]}</h2>${list.map((shot) => renderShot(shot, multiViewport)).join('')}`).join('\n');
  const unchanged = facts.unchanged.length
    ? `<section id="unchanged" class="checked"><h2>Checked and unchanged</h2><p>${facts.unchanged.map((shot) => `<span class="unchanged-item" id="${esc(slug(shot.id))}">${esc(shot.label)}${multiViewport ? ` <span class="muted">${esc(viewportText(shot))}</span>` : ''} <a href="${esc(shot.after.file)}">view</a>${expectationMismatch(shot) ? ' <span class="flag">unexpected</span>' : ''}</span>`).join('')}</p></section>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(run.title)}</title>
<style>${CSS}</style></head>
<body>
<header class="top">
  <div class="title"><h1>${esc(run.title)}</h1>
  <p class="refs">Before <b>${esc(sideLabel(run.before))}</b> <span class="muted">${esc(run.before?.baseURL ?? '')}</span> → After <b>${esc(sideLabel(run.after))}</b> <span class="muted">${esc(run.after?.baseURL ?? '')}</span></p></div>
  <div class="chips">${chips.join('') || '<span class="chip">no shots</span>'}</div>
  <div class="controls">
    <span class="segmented"><label><input type="radio" name="mode" value="columns" checked> Columns</label><label><input type="radio" name="mode" value="swipe"> Swipe</label></span>
    <label class="colopt"><input type="checkbox" data-toggle="hide-circled" checked> circled</label>
    <label class="colopt"><input type="checkbox" data-toggle="hide-diff" checked> diff</label>
    <span class="muted keys" title="j and k jump between shots">j / k</span>
  </div>
</header>
<main>
  <p class="setup muted">${setup.join(' · ')}</p>
  ${attention}
  ${overview}
  ${coverage}
  ${sections || '<p class="panel">No visual changes found.</p>'}
  ${unchanged}
  <details class="help"><summary>How to read this report</summary><p><b>Circled changes</b> outlines what is new or modified on the after side; content that only moved, such as rows pushed down by an inserted element, is not circled. <b>Diff</b> marks every differing pixel, moved content included. Each numbered box has a close-up below the row, before and after at readable size. <b>Swipe</b> overlays the two sides: move the pointer across the image. Each row's capture details list the URL, viewport, steps, hidden and masked elements, and which mocks answered, so nothing on screen is unexplained.</p></details>
</main>
<script>${SCRIPT}</script>
</body></html>
`;
}

function renderShot(shot, multiViewport) {
  const id = slug(shot.id);
  const chips = [
    multiViewport ? viewportText(shot) : '',
    shot.regions ? `${shot.regions.length} change${shot.regions.length > 1 ? 's' : ''}` : '',
    shot.diffRatio ? `${(shot.diffRatio * 100).toFixed(2)}% pixels` : '',
    shot.sizeChanged ? `size ${shot.before.width}×${shot.before.height} → ${shot.after.width}×${shot.after.height}` : '',
    ['before', 'after'].some((side) => shot[side]?.network?.mocked?.length) ? 'mocked data' : '',
  ].filter(Boolean);
  const warnings = [expectationMismatch(shot), unansweredOf(shot).length ? `${unansweredOf(shot).length} unanswered API call${unansweredOf(shot).length > 1 ? 's' : ''}` : '', errorsOnlyAfter(shot).length ? 'new errors on after' : ''].filter(Boolean);
  const body = {
    changed: () => `${renderColumns(shot)}${renderSwipe(shot)}${renderZooms(shot)}`,
    added: () => `<div class="grid single"><figure><figcaption>New</figcaption>${img(shot.after, `${shot.label}`)}</figure></div>`,
    removed: () => `<div class="grid single"><figure><figcaption>Removed</figcaption>${img(shot.before, `${shot.label}`)}</figure></div>`,
    failed: () => `<div class="grid">${['before', 'after'].map((side) => `<figure><figcaption>${side === 'before' ? 'Before' : 'After'}</figcaption>${img(shot[side], `${shot.label} ${side}`)}</figure>`).join('')}</div>`,
  }[shot.status];
  return `
<section class="shot ${shot.status}" id="${esc(id)}">
  <header>
    <h3><a href="#${esc(id)}">${esc(shot.label)}</a></h3>
    <span class="meta">${esc(shot.path ?? '')}</span>
    ${chips.map((chip) => `<span class="tag">${esc(chip)}</span>`).join('')}
    ${warnings.map((warning) => `<span class="tag warn">${esc(warning)}</span>`).join('')}
    ${shot.note ? `<p class="note">${esc(shot.note)}</p>` : ''}
    ${shot.sources?.length ? `<p class="sources">${shot.sources.map((source) => `<code>${esc(source)}</code>`).join(' ')}</p>` : ''}
  </header>
  ${body()}
  ${renderDetails(shot)}
</section>`;
}

// Wide, short shots (a footer, a toolbar) become unreadable in four columns, so they wrap to two.
function renderColumns(shot) {
  const wide = Math.min(shot.before.width / shot.before.height, shot.after.width / shot.after.height) > 2.5;
  return `<div class="grid columns${wide ? ' wide' : ''}">
    <figure><figcaption>Before</figcaption>${img(shot.before, `${shot.label} before`)}</figure>
    <figure><figcaption>After</figcaption>${img(shot.after, `${shot.label} after`)}</figure>
    ${shot.circled ? `<figure class="circledcol"><figcaption>Circled changes (${shot.regions.length})</figcaption>${img(shot.circled, `${shot.label} changes circled`)}</figure>` : ''}
    <figure class="diffcol"><figcaption>Diff</figcaption>${img(shot.diff, `${shot.label} diff`)}</figure>
  </div>`;
}

// Both images share one scale, so the overlay lines up even when the sizes differ.
function renderSwipe(shot) {
  const width = Math.max(shot.before.width, shot.after.width);
  const height = Math.max(shot.before.height, shot.after.height);
  const pct = (value) => `${((value / width) * 100).toFixed(4)}%`;
  return `<div class="swipe-wrap"><div class="swipe" style="--split:50%;max-width:${width}px;aspect-ratio:${width} / ${height}">
    <img class="swipe-img" src="${esc(shot.before.file)}" style="width:${pct(shot.before.width)}" alt="${esc(shot.label)} before" loading="lazy">
    <div class="swipe-after"><img class="swipe-img" src="${esc(shot.after.file)}" style="width:${pct(shot.after.width)}" alt="${esc(shot.label)} after" loading="lazy"></div>
    <div class="swipe-handle"><span>Before</span><span>After</span></div>
  </div></div>`;
}

function renderZooms(shot) {
  const regions = shot.regions ?? [];
  if (!regions.length) return '';
  const zooms = regions.slice(0, MAX_ZOOMS).map((region) => {
    const box = region.before;
    const scale = Math.max(0.2, Math.min(2, 400 / Math.max(region.width, box?.width ?? 0), 300 / Math.max(region.height, box?.height ?? 0)));
    return `<figure class="zoom"><figcaption><span class="num">${region.n}</span></figcaption><div class="zoom-pair">
      <div class="zoom-side"><span class="muted">Before</span>${box ? crop(shot.before, box, scale) : `<div class="crop empty" style="width:${Math.round(region.width * scale)}px;height:${Math.round(Math.min(region.height, 120) * scale)}px">Not on the before side</div>`}</div>
      <div class="zoom-side"><span class="muted">After</span>${crop(shot.after, region, scale)}</div>
    </div></figure>`;
  });
  const more = regions.length > MAX_ZOOMS ? `<p class="muted">${regions.length - MAX_ZOOMS} more regions are circled on the image above.</p>` : '';
  return `<div class="zooms"><p class="zooms-title muted">Close-ups of each circled change</p>${zooms.join('')}${more}</div>`;
}

function crop(side, box, scale) {
  const px = (value) => `${Math.round(value * scale)}px`;
  return `<a class="crop${scale > 1 ? ' pixelated' : ''}" href="${esc(side.file)}" style="width:${px(box.width)};height:${px(box.height)}"><img src="${esc(side.file)}" alt="" loading="lazy" style="width:${px(side.width)};left:${px(-box.x)};top:${px(-box.y)}"></a>`;
}

function renderDetails(shot) {
  const rows = [];
  const list = (items) => items.map((item) => `<code>${esc(item)}</code>`).join(' ');
  for (const side of ['before', 'after']) {
    const data = shot[side];
    if (!data || data.absent) continue;
    const name = side === 'before' ? 'Before' : 'After';
    if (data.url) rows.push([`${name} URL`, `<a href="${esc(data.url)}">${esc(data.url)}</a>`]);
    if (data.retried) rows.push([`${name} retry`, `first attempt failed: ${esc(data.retried)}`]);
    if (data.network?.mocked?.length) rows.push([`${name} mocks answered`, list(data.network.mocked.map((hit) => `${hit.name} ×${hit.count}`))]);
    if (data.network?.unanswered?.length) rows.push([`${name} unanswered`, list(data.network.unanswered.map((call) => `${call.method} ${call.url} (${call.reason})`))]);
    if (data.network?.blocked?.length) rows.push([`${name} blocked`, list(data.network.blocked.map((entry) => `${entry.host} ${entry.resourceType} ×${entry.count}`))]);
    if (data.errors?.length) rows.push([`${name} errors`, list(data.errors)]);
  }
  const settings = shot.settings ?? {};
  if (settings.selector) rows.push(['Element', list([settings.selector + (settings.padding ? ` + ${settings.padding}px` : '')])]);
  if (settings.steps?.length) rows.push(['Steps', list(settings.steps.map((step) => JSON.stringify(step)))]);
  if (settings.hide?.length) rows.push(['Hidden', list(settings.hide)]);
  if (settings.mask?.length) rows.push(['Masked', list(settings.mask)]);
  if (settings.initScripts?.length) rows.push(['Init scripts', list(settings.initScripts)]);
  if (shot.expect) rows.push(['Expected', esc(shot.expect)]);
  if (!rows.length) return '';
  return `<details class="details"><summary>Capture details</summary><table>${rows.map(([key, value]) => `<tr><th>${esc(key)}</th><td>${value}</td></tr>`).join('')}</table></details>`;
}

function img(side, alt) {
  return side?.file ? `<a href="${esc(side.file)}" target="_blank"><img loading="lazy" src="${esc(side.file)}" alt="${esc(alt)}"></a>` : `<div class="missing">${side?.absent ? 'Not present on this side (expected).' : esc(side?.error ?? 'not captured')}</div>`;
}

function viewportText(shot) {
  const viewport = shot.viewport;
  if (!viewport) return '';
  return `${viewport.name ? `${viewport.name} ` : ''}${viewport.width}×${viewport.height}`;
}

function sideErrors(shot) {
  return ['before', 'after'].filter((side) => shot[side]?.error).map((side) => `${side}: ${shot[side].error}`);
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function uniqueBy(items, key) {
  const seen = new Map();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
}

function renderMarkdown(run, facts) {
  const md = [`# ${run.title}`, '', `Before: ${sideLabel(run.before)}. After: ${sideLabel(run.after)}.`, '', counts(facts).map(([, text]) => text).join(' · ') || 'No shots.'];
  if (facts.attention.length) md.push('', '**Needs attention**', '', ...facts.attention.map((item) => `- ${item.label ? `${item.label}: ` : ''}${item.text}`));
  const image = (side, alt) => (side?.file ? `![${mdCell(alt)}](./${side.file})` : `_${mdCell(side?.error ?? 'none')}_`);
  const changed = run.shots.filter((shot) => shot.status === 'changed');
  if (changed.length) {
    md.push('', '**Changed**', '', '| Location | Before | After | Changes circled |', '| --- | --- | --- | --- |');
    for (const shot of changed) md.push(`| ${mdCell(shot.label)} | ${image(shot.before, `${shot.label} before`)} | ${image(shot.after, `${shot.label} after`)} | ${image(shot.circled, `${shot.label} changes circled`)} |`);
  }
  for (const [status, side, heading] of [['added', 'after', 'New'], ['removed', 'before', 'Removed']]) {
    const shots = run.shots.filter((shot) => shot.status === status);
    if (!shots.length) continue;
    md.push('', `**${heading}**`, '', '| Location | Screenshot |', '| --- | --- |');
    for (const shot of shots) md.push(`| ${mdCell(shot.label)} | ${image(shot[side], shot.label)} |`);
  }
  if (facts.unchanged.length) md.push('', `Checked and unchanged: ${facts.unchanged.map((shot) => shot.label).join(', ')}.`);
  const failed = run.shots.filter((shot) => shot.status === 'failed');
  if (failed.length) md.push('', '**Not captured**', '', ...failed.map((shot) => `- ${shot.label}: ${sideErrors(shot).join('; ')}`));
  const notCaptured = [...facts.coverage.filter((row) => !row.shots.length).map((row) => `- \`${row.file}\`: ${row.reason ?? 'no shot'}`), ...(run.notCaptured ?? []).filter((entry) => !entry.file).map((entry) => `- ${entry.location}: ${entry.reason}`)];
  if (notCaptured.length) md.push('', '**Changed but not captured**', '', ...notCaptured);
  if (run.shots.some((shot) => ['before', 'after'].some((side) => shot[side]?.network?.mocked?.length))) md.push('', '_API responses in these screenshots are mocked with fictional data._');
  return `${md.join('\n')}\n`;
}

const CSS = `
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --fg: #1b1f24; --muted: #5b6470; --line: #d9dee4; --accent: #0b62d6; --changed: #d97706; --added: #15803d; --removed: #b91c1c; --failed: #b91c1c; --mark: #ff2d55; --warn-bg: #fff4e5; --warn-fg: #8a4b00; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111418; --card: #1a1f25; --fg: #e8ebef; --muted: #9aa4b0; --line: #2c333b; --accent: #6aa8ff; --warn-bg: #3a2a12; --warn-fg: #ffcf8a; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  a { color: var(--accent); }
  .muted { color: var(--muted); }
  .top { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line); padding: 10px 24px; display: flex; gap: 10px 24px; align-items: center; flex-wrap: wrap; }
  .top .title { flex: 1 1 480px; min-width: 0; }
  .top h1 { font-size: 17px; margin: 0; }
  .refs { margin: 2px 0 0; font-size: 13px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; text-decoration: none; border: 1px solid var(--line); color: var(--fg); background: var(--card); }
  .chip.changed { border-color: var(--changed); color: var(--changed); }
  .chip.added { border-color: var(--added); color: var(--added); }
  .chip.removed, .chip.failed { border-color: var(--removed); color: var(--removed); }
  .chip.attention { background: var(--warn-bg); color: var(--warn-fg); border-color: transparent; }
  .controls { display: flex; gap: 12px; align-items: center; font-size: 13px; }
  .segmented { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .segmented label { padding: 2px 10px; cursor: pointer; }
  .segmented input { display: none; }
  .segmented label:has(input:checked) { background: var(--accent); color: #fff; }
  main { padding: 12px 24px 48px; max-width: 1800px; margin: 0 auto; }
  .setup { margin: 0 0 8px; font-size: 13px; }
  h2 { font-size: 15px; margin: 24px 0 8px; }
  .panel { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 16px 12px; margin: 12px 0; }
  .panel h2 { margin: 0 0 6px; }
  .attention-panel { border-color: var(--changed); background: var(--warn-bg); color: var(--warn-fg); }
  .attention-panel ul { margin: 0; padding-left: 18px; }
  .attention-panel a { color: inherit; font-weight: 600; }
  table.overview { border-collapse: collapse; width: 100%; font-size: 13px; }
  table.overview th, table.overview td { text-align: left; padding: 4px 8px; border-top: 1px solid var(--line); vertical-align: top; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--muted); }
  .dot.changed { background: var(--changed); } .dot.added { background: var(--added); } .dot.removed, .dot.failed { background: var(--removed); }
  .flag { color: var(--warn-fg); background: var(--warn-bg); border-radius: 4px; padding: 0 6px; font-size: 12px; font-weight: 600; }
  .shot { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px 16px; margin: 12px 0; scroll-margin-top: 120px; }
  .shot.failed { border-color: var(--failed); }
  .shot header { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .shot h3 { font-size: 14px; margin: 0; }
  .shot h3 a { color: inherit; text-decoration: none; }
  .meta { color: var(--muted); }
  .tag { font-size: 12px; padding: 0 8px; border-radius: 4px; background: color-mix(in srgb, var(--line) 60%, transparent); color: var(--muted); }
  .tag.warn { background: var(--warn-bg); color: var(--warn-fg); font-weight: 600; }
  .note, .sources { flex-basis: 100%; margin: 2px 0 0; color: var(--muted); }
  code { font-size: 12px; background: color-mix(in srgb, var(--line) 50%, transparent); padding: 1px 4px; border-radius: 4px; word-break: break-all; }
  .grid { display: flex; gap: 12px; margin-top: 10px; align-items: flex-start; }
  .grid > figure { flex: 1 1 0; }
  .grid.single > figure { flex: 0 1 900px; }
  .grid.columns.wide { flex-wrap: wrap; }
  .grid.columns.wide > figure { flex: 1 1 calc(50% - 6px); }
  body.hide-diff .diffcol, body.hide-circled .circledcol { display: none; }
  figure { margin: 0; min-width: 0; }
  figcaption { font-weight: 600; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 4px; background: repeating-conic-gradient(#8881 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
  .missing { padding: 24px; border: 1px dashed var(--line); border-radius: 4px; color: var(--muted); }
  .swipe-wrap { display: none; margin-top: 10px; }
  body.mode-swipe .swipe-wrap { display: block; }
  body.mode-swipe .grid.columns { display: none; }
  .swipe { position: relative; width: 100%; overflow: hidden; border: 1px solid var(--line); border-radius: 4px; cursor: ew-resize; touch-action: none; }
  .swipe-img { position: absolute; top: 0; left: 0; max-width: none; height: auto; border: 0; border-radius: 0; }
  .swipe-after { position: absolute; inset: 0; clip-path: inset(0 0 0 var(--split)); }
  .swipe-handle { position: absolute; top: 0; bottom: 0; left: var(--split); width: 2px; background: var(--mark); pointer-events: none; }
  .swipe-handle span { position: absolute; top: 6px; font-size: 11px; font-weight: 700; color: #fff; background: rgb(0 0 0 / 60%); padding: 1px 6px; border-radius: 4px; white-space: nowrap; }
  .swipe-handle span:first-child { right: 8px; } .swipe-handle span:last-child { left: 8px; }
  .zooms { display: flex; flex-wrap: wrap; gap: 12px 20px; margin-top: 12px; align-items: flex-start; }
  .zooms-title { flex-basis: 100%; margin: 0; font-size: 12px; font-weight: 600; }
  .zoom { display: flex; gap: 8px; align-items: flex-start; }
  .zoom .num { display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 4px; border-radius: 6px; background: var(--mark); color: #fff; font-weight: 700; font-size: 12px; }
  .zoom-pair { display: flex; gap: 8px; align-items: flex-start; }
  .zoom-side { display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
  .crop { position: relative; display: block; overflow: hidden; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); }
  .crop img { position: absolute; max-width: none; height: auto; border: 0; border-radius: 0; background: none; }
  .crop.pixelated img { image-rendering: pixelated; }
  .crop.empty { display: grid; place-items: center; color: var(--muted); font-size: 12px; border-style: dashed; min-height: 32px; text-align: center; }
  .details { margin-top: 10px; font-size: 12px; }
  .details summary { cursor: pointer; color: var(--muted); }
  .details table { border-collapse: collapse; margin-top: 6px; }
  .details th { text-align: left; padding: 2px 12px 2px 0; color: var(--muted); font-weight: 600; vertical-align: top; white-space: nowrap; }
  .details td { padding: 2px 0; }
  .checked .unchanged-item { display: inline-block; margin: 0 16px 6px 0; scroll-margin-top: 120px; }
  .help { margin-top: 28px; color: var(--muted); }
  @media (max-width: 900px) { .grid { flex-direction: column; } .top { position: static; } }
`;

const SCRIPT = `
  const body = document.body;
  for (const box of document.querySelectorAll('[data-toggle]')) box.addEventListener('change', () => body.classList.toggle(box.dataset.toggle, !box.checked));
  const setMode = (mode) => { body.classList.toggle('mode-swipe', mode === 'swipe'); try { localStorage.setItem('ui-changelog-mode', mode); } catch {} };
  for (const radio of document.querySelectorAll('input[name=mode]')) radio.addEventListener('change', () => setMode(radio.value));
  try { const saved = localStorage.getItem('ui-changelog-mode'); if (saved === 'swipe') { document.querySelector('input[value=swipe]').checked = true; setMode('swipe'); } } catch {}
  for (const swipe of document.querySelectorAll('.swipe')) {
    const move = (event) => { const rect = swipe.getBoundingClientRect(); swipe.style.setProperty('--split', Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)) + '%'); };
    swipe.addEventListener('pointermove', move);
    swipe.addEventListener('pointerdown', move);
  }
  const shots = [...document.querySelectorAll('section.shot')];
  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea') || !['j', 'k'].includes(event.key) || !shots.length) return;
    const offset = 130;
    const current = shots.findIndex((shot) => shot.getBoundingClientRect().top > offset + 4);
    const index = event.key === 'j' ? (current === -1 ? shots.length - 1 : current) : Math.max(0, (current === -1 ? shots.length : current) - 2);
    shots[index].scrollIntoView({ block: 'start' });
  });
`;
