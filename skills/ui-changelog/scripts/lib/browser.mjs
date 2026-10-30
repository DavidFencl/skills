// Captures one side of one shot in a fresh browser context, and records what the page asked the
// network for: which mocks answered, which API calls went unanswered, what allowHosts blocked, and
// which errors the page logged.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { answer, createSession, frame, loadMocks, placeholderSvg, websocketPlan } from './mocks.mjs';
import { firstLine, loadDependency } from './util.mjs';

export const VIEWPORT_PRESETS = {
  mobile: { width: 390, height: 844, mobile: true },
  tablet: { width: 768, height: 1024, hasTouch: true },
  desktop: { width: 1280, height: 800 },
};

const API_TYPES = new Set(['xhr', 'fetch', 'eventsource']);
// Requests that stay open by design and must not hold up the wait for a quiet network.
const LONG_LIVED_TYPES = new Set(['eventsource', 'websocket']);

export async function captureOne(browser, manifest, side, shot, file) {
  const timeout = manifest.timeoutMs ?? 10_000;
  const settings = { timeout, idleMs: shot.networkIdleTimeoutMs ?? manifest.networkIdleTimeoutMs ?? 10_000, settleMs: manifest.settleMs ?? 300, waitForHidden: manifest.waitForHidden ?? [] };
  const viewport = shot.viewport ?? manifest.viewport ?? VIEWPORT_PRESETS.desktop;
  const mobile = viewport.mobile ?? viewport.isMobile ?? false;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: mobile,
    hasTouch: viewport.hasTouch ?? mobile,
    deviceScaleFactor: shot.deviceScaleFactor ?? manifest.deviceScaleFactor ?? 1,
    colorScheme: shot.colorScheme ?? manifest.colorScheme ?? 'light',
    locale: shot.locale ?? manifest.locale,
    timezoneId: manifest.timezoneId ?? 'UTC',
    reducedMotion: 'reduce',
    // A service worker can answer requests itself, out of reach of the mocks and allowHosts.
    serviceWorkers: manifest.serviceWorkers ?? 'block',
    storageState: storageStateFor(side.storageState ?? manifest.storageState, side.baseURL),
    extraHTTPHeaders: manifest.extraHTTPHeaders,
    ...manifest.contextOptions,
    ...shot.contextOptions,
  });
  const log = { unanswered: [], blocked: new Map(), errors: [], warnings: [] };
  const mocked = new WeakSet();
  const pendingByDesign = new WeakSet();
  const inflight = new Set();
  try {
    const session = createSession(loadMocks([...[].concat(manifest.mocks ?? []), ...[].concat(shot.mocks ?? [])], manifest.dir));
    const ownHost = new URL(side.baseURL).host;
    const allowed = manifest.allowHosts ? new Set([ownHost, ...manifest.allowHosts]) : null;
    const isAllowed = (url) => !allowed || allowed.has(url.host) || allowed.has(url.hostname);

    // Routes run newest first: mocks, then HAR replay, then the allowHosts guard, then the network.
    if (allowed) {
      await context.route('**/*', (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (!/^https?:$/.test(url.protocol) || isAllowed(url)) return route.continue();
        const key = `${url.host} ${request.resourceType()}`;
        log.blocked.set(key, { host: url.host, resourceType: request.resourceType(), count: (log.blocked.get(key)?.count ?? 0) + 1, example: request.url() });
        if (manifest.placeholderImages && request.resourceType() === 'image') {
          return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: placeholderSvg() }).catch(() => {});
        }
        return route.abort('blockedbyclient').catch(() => {});
      });
      // WebSockets bypass HTTP routing, so allowHosts needs its own guard for them.
      await context.routeWebSocket(() => true, (ws) => {
        const url = new URL(ws.url());
        if (isAllowed(url)) return ws.connectToServer();
        log.unanswered.push({ method: 'WS', url: ws.url(), resourceType: 'websocket', reason: 'blocked by allowHosts' });
        ws.close({ code: 1008, reason: 'blocked by ui-changelog allowHosts' });
      });
    }
    const har = shot.har ?? manifest.har;
    if (har) await context.routeFromHAR(path.resolve(manifest.dir, har), { notFound: 'fallback' });
    for (const mock of session.mocks.filter((candidate) => candidate.kind === 'websocket')) {
      await context.routeWebSocket((url) => mock.matchUrl(url), (ws) => {
        session.hits.set(mock.name, (session.hits.get(mock.name) ?? 0) + 1);
        const send = (frames) => frames.forEach((message) => ws.send(message));
        setTimeout(() => send([].concat(mock.spec.send ?? []).map(frame)), mock.spec.delayMs ?? 0);
        ws.onMessage((message) => send(websocketPlan(mock, message)));
      });
    }
    if (session.mocks.some((mock) => mock.kind === 'http')) {
      await context.route((url) => session.mocks.some((mock) => mock.kind === 'http' && mock.matchUrl(url)), async (route) => {
        const request = route.request();
        const response = await answer(session, { method: request.method(), url: new URL(request.url()), headers: await request.allHeaders(), body: request.postData(), resourceType: request.resourceType() });
        if (!response) return route.fallback();
        mocked.add(request);
        if (response.action === 'pending') {
          pendingByDesign.add(request);
          return;
        }
        if (response.action === 'abort') return route.abort(response.errorCode).catch(() => {});
        return route.fulfill({ status: response.status, headers: response.headers, body: response.body }).catch(() => {});
      });
    }
    for (const script of [...[].concat(manifest.initScripts ?? []), ...[].concat(shot.initScripts ?? [])]) {
      await context.addInitScript(typeof script === 'string' ? { path: path.resolve(manifest.dir, script) } : { content: script.content });
    }

    const page = await context.newPage();
    const unanswered = (request, reason) => {
      if (!API_TYPES.has(request.resourceType()) || mocked.has(request)) return;
      log.unanswered.push({ method: request.method(), url: request.url(), resourceType: request.resourceType(), reason, postData: request.postData()?.slice(0, 4000) ?? null });
    };
    page.on('request', (request) => {
      if (!LONG_LIVED_TYPES.has(request.resourceType())) inflight.add(request);
    });
    page.on('requestfinished', (request) => inflight.delete(request));
    page.on('requestfailed', (request) => {
      inflight.delete(request);
      unanswered(request, request.failure()?.errorText ?? 'failed');
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 500 || status === 404) unanswered(response.request(), String(status));
      else if (/text\/html/.test(response.headers()['content-type'] ?? '')) unanswered(response.request(), `${status} HTML (dev-server fallback page, not API data)`);
    });
    page.on('websocket', (ws) => ws.on('socketerror', (error) => log.unanswered.push({ method: 'WS', url: ws.url(), resourceType: 'websocket', reason: firstLine(error) })));
    page.on('pageerror', (error) => log.errors.push(`uncaught: ${firstLine(error)}`));
    page.on('console', (message) => {
      // Failed loads are already listed as unanswered or blocked requests.
      if (message.type() === 'error' && !/^Failed to load resource/.test(message.text())) log.errors.push(message.text().split('\n')[0].slice(0, 300));
    });
    const quiet = () => waitForQuiet(inflight, pendingByDesign, settings.idleMs);

    if (manifest.fixedTime) await page.clock.setFixedTime(new Date(manifest.fixedTime));
    for (const [key, value] of Object.entries(manifest.localStorage ?? {})) {
      await page.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [key, typeof value === 'string' ? value : JSON.stringify(value)]);
    }
    const url = new URL(shot.path ?? '/', side.baseURL).toString();
    await page.goto(url, { waitUntil: 'load', timeout: Math.max(timeout, 30_000) });
    await settle(page, settings, quiet);
    if (mobile) {
      const layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);
      if (layoutWidth > viewport.width) log.warnings.push(`laid out at ${layoutWidth}px on a ${viewport.width}px phone: the page has no width=device-width meta viewport, so mobile styles never apply`);
    }
    for (const [index, step] of (shot.steps ?? []).entries()) {
      await runStep(page, step, settings, quiet).catch((error) => {
        throw new Error(`step ${index + 1} ${JSON.stringify(step)}: ${firstLine(error)}`);
      });
    }
    if (shot.waitFor) await page.locator(shot.waitFor).first().waitFor({ state: 'visible', timeout }).catch((error) => {
      throw new Error(`waitFor ${shot.waitFor}: ${firstLine(error)}`);
    });
    await settle(page, settings, quiet);

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
    const { PNG } = loadDependency('pngjs');
    const png = PNG.sync.read(readFileSync(file));
    return {
      url,
      width: png.width,
      height: png.height,
      network: {
        mocked: [...session.hits].map(([name, count]) => ({ name, count })),
        unanswered: dedupe(log.unanswered),
        blocked: [...log.blocked.values()],
        skipped: [...session.skipped].map(([name, requests]) => ({ name, requests: [...new Set(requests)].slice(0, 5) })),
      },
      errors: [...new Set(log.errors)],
      warnings: log.warnings,
    };
  } finally {
    await context.close();
  }
}

function dedupe(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.method} ${entry.url} ${entry.reason}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

// Network is quiet once nothing has been in flight for 500 ms. Requests a mock holds open on
// purpose (`pending`) and streaming connections do not count. The wait is capped, because apps
// that poll never go quiet.
async function waitForQuiet(inflight, ignored, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let quietSince = null;
  while (Date.now() < deadline) {
    const busy = [...inflight].some((request) => !ignored.has(request));
    if (busy) quietSince = null;
    else if ((quietSince ??= Date.now()) <= Date.now() - 500) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function settle(page, settings, quiet) {
  await quiet();
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  for (const selector of settings.waitForHidden) {
    await page.locator(selector).first().waitFor({ state: 'hidden', timeout: settings.timeout }).catch(() => {});
  }
  if (settings.settleMs !== 0) await page.waitForTimeout(settings.settleMs);
}

async function runStep(page, step, settings, quiet) {
  const { timeout } = settings;
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
  if (!step.wait) await settle(page, settings, quiet);
}

// A state saved on one origin is re-keyed to the side's origin, because before and after run on different ports.
function storageStateFor(statePath, baseURL) {
  if (!statePath) return undefined;
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const origin = new URL(baseURL).origin;
  if (state.origins?.length === 1) state.origins = [{ ...state.origins[0], origin }];
  return state;
}

export async function login(url, statePath) {
  const { chromium } = loadDependency('playwright');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto(url);
  console.error('Log in, then close the browser window. The session is saved when the page closes.');
  await page.waitForEvent('close', { timeout: 0 });
  await context.storageState({ path: statePath });
  await browser.close();
}
