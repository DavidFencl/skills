// Tests for the ui-changelog scripts. Run from the repository root:
//   node --test tests/ui-changelog.test.mjs
// Browser tests need the tool cache (bash skills/ui-changelog/scripts/setup.sh) and ports 47020-47049
// and 47097-47098 free. TypeScript tests need UI_CHANGELOG_TYPESCRIPT=<path to a typescript package>.
// Scratch files go to UI_CHANGELOG_TEST_TMP (default: the system temp dir) and are deleted afterwards.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join(ROOT, 'skills', 'ui-changelog');
const SCRIPTS = path.join(SKILL, 'scripts');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const TOOL_HOME = process.env.UI_CHANGELOG_HOME ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'ui-changelog');
const toolRequire = createRequire(path.join(TOOL_HOME, 'package.json'));
const HAS_BROWSER_DEPS = ['playwright', 'pngjs', 'pixelmatch'].every((name) => {
  try {
    toolRequire.resolve(name);
    return true;
  } catch {
    return false;
  }
});
const TYPESCRIPT = process.env.UI_CHANGELOG_TYPESCRIPT && existsSync(process.env.UI_CHANGELOG_TYPESCRIPT) ? process.env.UI_CHANGELOG_TYPESCRIPT : null;
const NO_BROWSER = HAS_BROWSER_DEPS ? false : `tool cache ${TOOL_HOME} lacks playwright/pngjs/pixelmatch; run setup.sh`;
const NO_TYPESCRIPT = TYPESCRIPT ? false : 'set UI_CHANGELOG_TYPESCRIPT to a typescript package directory';

const TMP = mkdtempSync(path.join(process.env.UI_CHANGELOG_TEST_TMP ?? os.tmpdir(), 'ui-changelog-test-'));
after(() => {
  if (!process.env.UI_CHANGELOG_KEEP) rmSync(TMP, { recursive: true, force: true });
});

function run(script, args, options = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', timeout: 600_000, ...options, env: { ...process.env, ...options.env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('mock matching and responses', async () => {
  const { answer, compileMock, createSession, globToRegExp, sseBody } = await import(path.join(SCRIPTS, 'lib', 'mocks.mjs'));
  const session = (...specs) => createSession(specs.map((spec) => compileMock(spec, path.join(FIXTURES, 'mock-kinds'))));
  const request = (method, url, extra = {}) => ({ method, url: new URL(url), headers: {}, body: null, resourceType: 'fetch', ...extra });
  const bodyOf = (response) => JSON.parse(String(response.body));

  test('globs ignore the query unless they contain "?", and * stays within a segment', async () => {
    assert.ok(await answer(session({ url: 'http://api.test/api/items', json: 1 }), request('GET', 'http://api.test/api/items?locale=en')));
    assert.equal(await answer(session({ url: 'http://api.test/api/*', json: 1 }), request('GET', 'http://api.test/api/a/b')), null);
    assert.ok(await answer(session({ url: 'http://api.test/api/**', json: 1 }), request('GET', 'http://api.test/api/a/b')));
    assert.equal(await answer(session({ url: 'http://api.test/api/items?page=1', json: 1 }), request('GET', 'http://api.test/api/items?page=2')), null);
    assert.ok(globToRegExp('**/api/**').test('http://x/src/app/api/user.api.ts'));
  });

  test('the last matching mock wins, and method, query, GraphQL and body matchers narrow a mock', async () => {
    const mocks = session(
      { url: 'http://api.test/api/items', json: { which: 'first' } },
      { url: 'http://api.test/api/items', json: { which: 'last' } },
      { url: 'http://api.test/api/items', query: { page: '2' }, json: { which: 'page 2' } },
      { url: 'http://api.test/api/items', method: 'POST', requestJson: { kind: 'draft' }, json: { which: 'draft post' } },
      { url: 'http://api.test/graphql', graphql: 'Viewer', json: { which: 'viewer' } },
      { url: 'http://api.test/graphql', graphql: 'Feed', json: { which: 'feed' } },
    );
    assert.equal(bodyOf(await answer(mocks, request('GET', 'http://api.test/api/items'))).which, 'last');
    assert.equal(bodyOf(await answer(mocks, request('GET', 'http://api.test/api/items?sort=new&page=2'))).which, 'page 2');
    assert.equal(bodyOf(await answer(mocks, request('POST', 'http://api.test/api/items', { body: '{"kind":"draft","title":"x"}' }))).which, 'draft post');
    assert.equal(bodyOf(await answer(mocks, request('POST', 'http://api.test/api/items', { body: '{"kind":"final"}' }))).which, 'last');
    assert.equal(bodyOf(await answer(mocks, request('POST', 'http://api.test/graphql', { body: '{"operationName":"Feed","query":"query Feed { items }"}' }))).which, 'feed');
    assert.equal(bodyOf(await answer(mocks, request('POST', 'http://api.test/graphql', { body: '{"query":"query Viewer { me { id } }"}' }))).which, 'viewer');
  });

  test('preflights get CORS, times limits answers, and data mocks leave source modules alone', async () => {
    const preflight = await answer(session({ url: 'http://api.test/api/x', method: 'POST', json: {} }), request('OPTIONS', 'http://api.test/api/x', { headers: { origin: 'http://127.0.0.1:5173' } }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');
    const once = session({ url: 'http://api.test/api/x', times: 1, json: {} });
    assert.ok(await answer(once, request('GET', 'http://api.test/api/x')));
    assert.equal(await answer(once, request('GET', 'http://api.test/api/x')), null);
    const broad = session({ url: '**/api/**', json: { hijacked: true } });
    assert.equal(await answer(broad, request('GET', 'http://127.0.0.1:5173/src/app/api/user.api.ts', { resourceType: 'script' })), null);
    assert.deepEqual([...broad.skipped.keys()], ['ANY **/api/**']);
    const script = session({ url: 'https://maps.example.test/**', body: 'window.maps = {};', contentType: 'text/javascript' });
    assert.equal((await answer(script, request('GET', 'https://maps.example.test/api/js', { resourceType: 'script' }))).headers['content-type'], 'text/javascript');
  });

  test('handlers keep state per session, and SSE, image, pending and abort responses have the right shape', async () => {
    const make = () => session({ url: 'http://api.test/api/notes', handler: 'handlers.mjs#notes' });
    const first = make();
    await answer(first, request('POST', 'http://api.test/api/notes', { body: '{"text":"a"}' }));
    assert.deepEqual(bodyOf(await answer(first, request('GET', 'http://api.test/api/notes'))).notes, ['a']);
    assert.deepEqual(bodyOf(await answer(make(), request('GET', 'http://api.test/api/notes'))).notes, []);
    const kinds = session(
      { url: 'http://api.test/sse', sse: [{ event: 'tick', data: { n: 1 } }, 'plain'] },
      { url: 'http://api.test/img', image: { width: 40, height: 30 } },
      { url: 'http://api.test/slow', pending: true },
      { url: 'http://api.test/down', abort: 'timedout' },
    );
    const sse = await answer(kinds, request('GET', 'http://api.test/sse'));
    assert.equal(sse.headers['content-type'], 'text/event-stream');
    assert.match(sse.body, /retry: \d+\n\nevent: tick\ndata: \{"n":1\}\n\ndata: plain\n\n/);
    assert.equal(sseBody(['x']).split('data: x').length, 2);
    assert.match(String((await answer(kinds, request('GET', 'http://api.test/img'))).body), /^<svg[^>]+width="40" height="30"/);
    assert.equal((await answer(kinds, request('GET', 'http://api.test/slow'))).action, 'pending');
    assert.deepEqual(await answer(kinds, request('GET', 'http://api.test/down')), { action: 'abort', errorCode: 'timedout' });
  });
});

describe('realistic values from field names', async () => {
  const { booleanFor, dateFor, numberFor, stringFor, words } = await import(path.join(SCRIPTS, 'lib', 'sample-data.mjs'));
  const now = new Date('2026-10-30T10:00:00Z');
  const ctx = (key, owner = 'ItemDto', index = 0) => ({ key, owner, index, now, items: 3, depth: 1 });

  test('names, contacts, places and ids read like real data', () => {
    assert.deepEqual(words('numberOfDogs'), ['number', 'of', 'dogs']);
    assert.match(stringFor(ctx('email')), /^[a-z]+\.[a-z]+@example\.com$/);
    assert.match(stringFor(ctx('displayName', 'Viewer')), /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.match(stringFor(ctx('eventId')), /^event-1$/);
    assert.ok(stringFor(ctx('avatarUrl')).startsWith('data:image/svg+xml,'));
    assert.ok(['Ghent', 'Brno', 'Lyon'].includes(stringFor(ctx('city'))));
  });

  test('flags that hide whole screens default to off, and counts, pages and dates are plausible', () => {
    assert.equal(booleanFor(ctx('enabled', 'MaintenanceStatusResponseDto')), false);
    assert.equal(booleanFor(ctx('isFull')), false);
    assert.equal(booleanFor(ctx('isSignupOpen')), true);
    assert.equal(numberFor(ctx('pageSize')), 3);
    assert.equal(numberFor(ctx('page')), 0);
    assert.notEqual(numberFor(ctx('eventsThisYear')), 2026);
    assert.equal(numberFor(ctx('year')), 2026);
    assert.ok(new Date(dateFor(ctx('createdAt'))) < now);
    assert.ok(new Date(dateFor(ctx('startsAt'))) > now);
    assert.ok(new Date(dateFor(ctx('birthDate', 'DogDto'))).getUTCFullYear() < 2023);
  });
});

describe('pixel comparison', { skip: NO_BROWSER }, async () => {
  const { compareShot } = await import(path.join(SCRIPTS, 'lib', 'compare.mjs'));
  const { PNG } = HAS_BROWSER_DEPS ? toolRequire('pngjs') : {};
  const dir = path.join(TMP, 'compare');
  // A white page with dark bars; each bar is [top, height, gray level].
  const page = (height, bars) => {
    const png = new PNG({ width: 200, height });
    png.data.fill(255);
    for (const [top, size, level = 40] of bars) {
      for (let y = top; y < top + size; y++) for (let x = 20; x < 180; x++) png.data.set([level, level, level, 255], (y * 200 + x) * 4);
    }
    return png;
  };
  const pair = async (id, a, b) => {
    mkdirSync(path.join(dir, 'shots'), { recursive: true });
    writeFileSync(path.join(dir, 'shots', `${id}-before.png`), PNG.sync.write(a));
    writeFileSync(path.join(dir, 'shots', `${id}-after.png`), PNG.sync.write(b));
    return compareShot(dir, { id }, { before: { file: `shots/${id}-before.png` }, after: { file: `shots/${id}-after.png` } });
  };

  test('an inserted block is circled, and the content it pushed down is not', async () => {
    const result = await pair('insert', page(100, [[10, 10], [60, 10]]), page(140, [[10, 10], [40, 30, 120], [100, 10]]));
    assert.equal(result.status, 'changed');
    assert.equal(result.regions.length, 1);
    const [region] = result.regions;
    assert.ok(region.y >= 28 && region.y + region.height <= 82, JSON.stringify(region));
    // The before crop shows the empty spot where the block went in, not the bar that moved down.
    assert.ok(region.before === null || region.before.y + region.before.height <= 60, JSON.stringify(region.before));
  });

  test('a change in place maps to the same box on the before side', async () => {
    const result = await pair('edit', page(100, [[10, 10], [60, 10]]), page(100, [[10, 10], [60, 10, 150]]));
    assert.equal(result.regions.length, 1);
    const [region] = result.regions;
    assert.deepEqual(region.before, { x: region.x, y: region.y, width: region.width, height: region.height });
  });

  test('removed content is marked where it was, and its before box shows what went away', async () => {
    const result = await pair('remove', page(120, [[10, 10], [50, 20], [100, 10]]), page(90, [[10, 10], [70, 10]]));
    assert.equal(result.regions.length, 1);
    const [region] = result.regions;
    assert.ok(region.before.y <= 50 && region.before.y + region.before.height >= 70, JSON.stringify(region));
  });

  test('identical images are unchanged and write no diff', async () => {
    const result = await pair('same', page(100, [[10, 10]]), page(100, [[10, 10]]));
    assert.equal(result.status, 'unchanged');
    assert.ok(!existsSync(path.join(dir, 'shots', 'same-diff.png')));
  });
});

describe('report analysis', async () => {
  const { analyze, expectationMismatch } = await import(path.join(SCRIPTS, 'lib', 'report.mjs'));

  test('flags unexpected results, errors new on the after side, unanswered endpoints and uncovered files', () => {
    const run = {
      before: { baseURL: 'http://127.0.0.1:5301' },
      after: { baseURL: 'http://127.0.0.1:5302' },
      changedFiles: ['src/a.tsx', 'src/b.tsx', 'src/types.ts'],
      notCaptured: [{ file: 'src/types.ts', reason: 'types only' }],
      shots: [
        { id: 'control', label: 'Control', status: 'changed', expect: 'unchanged', regions: [{}, {}], sources: [], before: {}, after: {} },
        {
          id: 'page',
          label: 'Page',
          status: 'unchanged',
          expect: 'changed',
          sources: ['src/a.tsx'],
          before: { errors: ['TypeError at http://127.0.0.1:5301/src/x.ts:4'], network: { unanswered: [{ method: 'GET', url: 'http://127.0.0.1:4399/api/x?locale=en', reason: 'refused' }, { method: 'GET', url: 'http://127.0.0.1:5301/api/own', reason: 'HTML' }] } },
          after: { errors: ['TypeError at http://127.0.0.1:5302/src/x.ts:4', 'Only on after'], network: { unanswered: [{ method: 'GET', url: 'http://127.0.0.1:4399/api/x', reason: 'refused' }, { method: 'GET', url: 'http://127.0.0.1:5302/api/own', reason: 'HTML' }] } },
        },
      ],
    };
    const facts = analyze(run);
    const text = facts.attention.map((item) => `${item.label ?? ''}: ${item.text}`).join('\n');
    assert.match(text, /Control: Expected no change, but 2 regions differ/);
    assert.match(text, /Page: Expected a visible change/);
    assert.match(text, /Page: Errors logged only on the after side: Only on after$/m);
    assert.match(text, /src\/b\.tsx/);
    assert.doesNotMatch(text, /src\/types\.ts/);
    assert.deepEqual(facts.unanswered.map((entry) => `${entry.method} ${entry.origin}${entry.path}`), ['GET http://127.0.0.1:4399/api/x', 'GET /api/own']);
    assert.equal(expectationMismatch({ status: 'added', expect: 'changed' }), null);
  });
});

describe('affected.mjs', () => {
  const repo = path.join(TMP, 'affected-repo');
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

  before(() => {
    write('package.json', JSON.stringify({ name: 'shop', dependencies: { 'react-router-dom': '^6.0.0' } }));
    write('index.html', '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>\n');
    write('src/main.tsx', "import { router } from './router';\nimport './global.css';\nexport default router;\n");
    write('src/global.css', 'body { margin: 0; }\n');
    write(
      'src/router.tsx',
      [
        "import { createBrowserRouter } from 'react-router-dom';",
        "import Layout from './layout';",
        "import HomePage from './pages/home.page';",
        "import OrderPage from './pages/order.page';",
        '',
        'export const router = createBrowserRouter([',
        '  {',
        "    path: '/',",
        '    element: <Layout />,',
        '    children: [',
        '      {',
        '        index: true,',
        '        element: <HomePage />,',
        '      },',
        '      {',
        "        path: 'orders/:orderId',",
        '        element: <OrderPage />,',
        '      },',
        '    ],',
        '  },',
        '  {',
        "    path: 'settings',",
        "    lazy: () => import('./pages/settings.page'),",
        '  },',
        ']);',
        '',
      ].join('\n'),
    );
    write('src/layout.tsx', 'export default function Layout() { return <main />; }\n');
    write('src/pages/home.page.tsx', 'export default function HomePage() { return <h1>Home</h1>; }\n');
    write('src/pages/order.page.tsx', "import { Badge } from '../components/badge';\nexport default function OrderPage() { return <Badge />; }\n");
    write('src/pages/settings.page.tsx', 'export function Component() { return <h1>Settings</h1>; }\n');
    write('src/components/badge.tsx', 'export function Badge() { return <span className="badge">New</span>; }\n');
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
    write('src/components/badge.tsx', 'export function Badge() { return <span className="badge md:px-4 max-md:hidden">New</span>; }\n');
    write('src/pages/settings.page.tsx', 'export function Component() { return <h1>Account settings</h1>; }\n');
    write('src/global.css', 'body { margin: 0; color: #111; }\n');
  });

  test('maps changes to entries with route hints and viewports', () => {
    const result = run('affected.mjs', ['--base', 'HEAD'], { cwd: repo });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const badge = report.files.find((file) => file.path === 'src/components/badge.tsx');
    assert.equal(badge.scope, 'scoped');
    assert.deepEqual(badge.entries.map((entry) => [entry.entry, entry.route?.path]), [['src/pages/order.page.tsx', '/orders/:orderId']]);
    assert.equal(badge.responsive.level, 'change');
    const settings = report.files.find((file) => file.path === 'src/pages/settings.page.tsx');
    assert.equal(settings.entries[0].route.path, '/settings');
    assert.equal(report.files.find((file) => file.path === 'src/global.css').scope, 'shell');
    assert.deepEqual(report.viewports.map((viewport) => viewport.name), ['mobile', 'md', 'desktop']);
  });

  test('writes a manifest skeleton that capture.mjs refuses until the TODOs are filled in', () => {
    const skeleton = JSON.parse(run('affected.mjs', ['--base', 'HEAD', '--manifest'], { cwd: repo }).stdout);
    assert.deepEqual(skeleton.changedFiles.sort(), ['src/components/badge.tsx', 'src/global.css', 'src/pages/settings.page.tsx']);
    const order = skeleton.shots.find((shot) => shot.sources?.includes('src/components/badge.tsx'));
    assert.equal(order.path, '/orders/:orderId');
    assert.equal(order.expect, 'changed');
    assert.deepEqual(skeleton.viewports, ['mobile', { name: 'md', width: 768, height: 1024 }, 'desktop']);
    assert.ok(skeleton.shots.some((shot) => shot.expect === 'unchanged'));
    const file = path.join(TMP, 'skeleton.json');
    writeFileSync(file, JSON.stringify(skeleton));
    const capture = run('capture.mjs', [file, '--out', path.join(TMP, 'skeleton-report')]);
    assert.equal(capture.status, 1);
    assert.match(capture.stderr, /TODO placeholders[\s\S]*before\.baseURL/);
  });

  test('reads file-system routes for Next.js', () => {
    const next = path.join(TMP, 'next-repo');
    mkdirSync(path.join(next, 'app', '(shop)', 'products', '[id]'), { recursive: true });
    writeFileSync(path.join(next, 'package.json'), JSON.stringify({ name: 'next-shop', dependencies: { next: '15.0.0' } }));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: next });
    execFileSync('git', ['add', '-A'], { cwd: next });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], { cwd: next });
    writeFileSync(path.join(next, 'app', '(shop)', 'products', '[id]', 'page.tsx'), 'export default function Page() { return <p>Product</p>; }\n');
    const result = run('affected.mjs', ['--base', 'HEAD'], { cwd: next });
    assert.equal(result.status, 0, result.stderr);
    const page = JSON.parse(result.stdout).files.find((file) => file.path.endsWith('page.tsx'));
    assert.equal(page.entries[0].route.path, '/products/[id]');
  });
});

describe('types from the project', { skip: NO_TYPESCRIPT }, () => {
  const project = path.join(FIXTURES, 'typed-api', 'tsconfig.json');
  const env = { UI_CHANGELOG_TYPESCRIPT: TYPESCRIPT };

  test('find picks the calling function and its response type, ignoring tests and app links', () => {
    const find = (target, method) => run('mocks.mjs', ['find', target, '--method', method, '--project', project], { env }).stdout;
    assert.match(find('/api/orders/recent', 'GET'), /^src\/api\.ts:\d+ +GET listRecentOrders\(\) +→ Page<OrderDto>/m);
    assert.doesNotMatch(find('/api/orders/recent', 'GET'), /e2e\/orders\.spec\.ts:\d+ /);
    assert.match(find('/api/orders/A-17', 'GET'), /^src\/api\.ts:\d+ +GET getOrder\(\) +→ OrderDto/);
    assert.doesNotMatch(find('/api/orders/A-17', 'GET'), /order-link/);
    assert.match(find('/api/orders', 'POST'), /^src\/api\.ts:\d+ +POST createOrder\(\) +→ OrderDto/);
    assert.match(find('/api/me', 'GET'), /getProfile\(\) +→ UserDto/);
    assert.match(find('/api/raw/things', 'GET'), /getRawThings\(\) +\(response type unknown\)/);
  });

  test('draft writes typed mocks for unanswered calls and marks what it cannot type', () => {
    const report = path.join(TMP, 'typed-draft');
    mkdirSync(report, { recursive: true });
    const call = (method, url, shots = ['orders']) => ({ method, origin: new URL(url).origin, path: new URL(url).pathname, examples: [url], postData: null, shots });
    writeFileSync(path.join(report, 'unanswered.json'), JSON.stringify([call('GET', 'http://127.0.0.1:4399/api/orders/recent?locale=en'), call('POST', 'http://127.0.0.1:4399/api/orders'), call('GET', 'http://127.0.0.1:4399/api/raw/things')]));
    writeFileSync(path.join(report, 'manifest.json'), JSON.stringify({ fixedTime: '2026-10-30T10:00:00Z' }));
    const result = run('mocks.mjs', ['draft', report, '--project', project], { env });
    assert.equal(result.status, 0, result.stderr);
    const [recent, created, raw] = readJson(path.join(report, 'mocks.draft.json'));
    assert.equal(recent.url, 'http://127.0.0.1:4399/api/orders/recent');
    assert.equal(recent.json.items.length, 3);
    assert.deepEqual(recent.json.items.map((item) => item.status), ['placed', 'shipped', 'delivered']);
    assert.equal(recent.json.items[0].createdAt, '2026-10-27T14:15:00.000Z');
    assert.equal(recent.json.hasNextPage, false);
    assert.ok(!('label' in recent.json.items[0]) && !('describe' in recent.json.items[0]));
    assert.equal(created.method, 'POST');
    assert.equal(typeof created.json.customerName, 'string');
    assert.deepEqual(raw.json, {});
    assert.match(raw.note, /^TODO: no response type found/);
  });

  test('sample prints a value of a named type', () => {
    const result = run('mocks.mjs', ['sample', 'UserDto', '--project', project, '--now', '2026-10-30T10:00:00Z'], { env });
    const user = JSON.parse(result.stdout);
    assert.equal(typeof user.id, 'number');
    assert.ok(['admin', 'member'].includes(user.role));
    assert.ok(new Date(user.memberSince).getUTCFullYear() < 2026);
  });
});

// Servers run in child processes: run() blocks this process while a capture runs.
async function startFixtureServers(dir, ports) {
  const children = ports.map((port) => spawn(process.execPath, [path.join(ROOT, 'tests', 'serve-fixture.mjs'), dir, String(port)], { stdio: 'ignore' }));
  for (const port of ports) {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return children;
}

describe('capture with every mock kind', { skip: NO_BROWSER }, () => {
  const out = path.join(TMP, 'mock-kinds-report');
  let servers;
  before(async () => {
    servers = await startFixtureServers(path.join(FIXTURES, 'mock-kinds'), [47020, 47021]);
  });
  after(() => servers?.forEach((child) => child.kill()));

  test('mocks answer, guards block, and the report records what happened', () => {
    const result = run('capture.mjs', [path.join(FIXTURES, 'mock-kinds', 'manifest.json'), '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const results = readJson(path.join(out, 'results.json'));
    const [mocks, guards] = results.shots;
    assert.equal(mocks.status, 'unchanged', JSON.stringify(mocks.after.error ?? mocks.before.error));
    assert.equal(guards.status, 'unchanged', JSON.stringify(guards.after.error ?? guards.before.error));
    assert.deepEqual(mocks.after.network.unanswered, []);
    assert.deepEqual(mocks.after.network.skipped, [{ name: 'ANY **/api/**', requests: ['script /src/api/client.js'] }]);
    assert.equal(mocks.after.network.mocked.find((hit) => hit.name.includes('/api/notes')).count, 2);
    const unanswered = guards.after.network.unanswered.map((call) => `${call.method} ${call.url} ${call.reason}`).join('\n');
    assert.match(unanswered, /^WS wss:\/\/socket\.example\.invalid\/feed blocked by allowHosts$/m);
    assert.match(unanswered, /^GET https:\/\/analytics\.example\.invalid\/collect net::ERR_BLOCKED_BY_CLIENT/m);
    assert.match(unanswered, /^GET http:\/\/127\.0\.0\.1:47021\/api\/settings 200 HTML/m);
    assert.ok(guards.after.network.blocked.some((entry) => entry.host === 'cdn.example.invalid' && entry.resourceType === 'image'));
    assert.deepEqual(guards.after.errors, ['custom console error from the app', 'uncaught: boom from the app']);
    assert.deepEqual(readJson(path.join(out, 'unanswered.json')).map((entry) => `${entry.method} ${entry.origin}${entry.path}`).sort(), ['GET /api/settings', 'GET https://analytics.example.invalid/collect', 'WS wss://socket.example.invalid/feed']);
    assert.match(result.stderr, /Mock "ANY \*\*\/api\/\*\*" also matched non-API requests/);
  });
});

describe('allowHosts and the frontend\'s own WebSockets', { skip: NO_BROWSER }, () => {
  const children = [];
  before(async () => {
    for (const port of [47045, 47046]) children.push(spawn(process.execPath, [path.join(FIXTURES, 'ws-echo', 'server.mjs'), String(port)], { stdio: 'ignore' }));
    for (const port of [47045, 47046]) {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });
  after(() => children.forEach((child) => child.kill()));

  test('a socket to the page\'s own host (like hot reload) still reaches its server', () => {
    const out = path.join(TMP, 'ws-echo-report');
    const result = run('capture.mjs', [path.join(FIXTURES, 'ws-echo', 'manifest.json'), '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const [shot] = readJson(path.join(out, 'results.json')).shots;
    assert.equal(shot.status, 'unchanged', JSON.stringify(shot.after.error ?? shot.before.error));
    assert.deepEqual(shot.after.network.unanswered, []);
  });
});

describe('end to end: fixture app with no API', { skip: NO_BROWSER }, () => {
  const work = path.join(TMP, 'riverside');
  const repo = path.join(work, 'repo');
  const beforeDir = path.join(work, 'before');
  const children = [];
  const manifest = (mocks) => ({
    title: 'Riverside: report dialog and mobile cards',
    before: { baseURL: 'http://127.0.0.1:47030', ref: 'HEAD', dir: beforeDir },
    after: { baseURL: 'http://127.0.0.1:47031', ref: 'working tree', dir: repo },
    fixedTime: '2026-10-30T10:00:00Z',
    allowHosts: [],
    placeholderImages: true,
    hide: ['.site-footer__version'],
    changedFiles: ['src/components/footer.js', 'src/components/report-dialog.js', 'src/styles.css', 'src/api.js', 'src/types.js'],
    notCaptured: [{ file: 'src/types.js', reason: 'types only' }, { file: 'src/api.js', reason: 'client code, shown through the dialog' }],
    mocks,
    shots: [
      { id: 'footer', label: 'Home › footer', path: '/', selector: 'footer', expect: 'changed', sources: ['src/components/footer.js'] },
      { id: 'dialog', label: 'Home › footer › Report a problem, open', path: '/', new: true, steps: [{ click: '[data-testid=report-problem]' }], selector: 'dialog', padding: 16, sources: ['src/components/report-dialog.js'] },
      { id: 'cards', label: 'Home › upcoming runs', path: '/', selector: '.event-list', padding: 16, viewports: ['mobile', 'desktop'], expect: { mobile: 'changed', desktop: 'unchanged' }, sources: ['src/styles.css'] },
      { id: 'header', label: 'Header (control)', path: '/', selector: '.site-header', expect: 'unchanged' },
    ],
  });

  before(async () => {
    mkdirSync(repo, { recursive: true });
    execFileSync('bash', [path.join(SKILL, 'evals', 'missing-api-footer-dialog', 'place-files.sh')], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['worktree', 'add', '-q', '--detach', beforeDir, 'HEAD'], { cwd: repo, stdio: 'pipe' });
    for (const [dir, port] of [[beforeDir, 47030], [repo, 47031]]) {
      const child = spawn(process.execPath, ['server.mjs', '--port', String(port), '--host', '127.0.0.1', '--api', 'http://127.0.0.1:47097/api'], { cwd: dir, stdio: 'ignore' });
      children.push(child);
    }
    for (const port of [47030, 47031]) {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });
  after(() => {
    for (const child of children) child.kill();
    spawnSync('git', ['worktree', 'remove', '--force', beforeDir], { cwd: repo });
  });

  test('without mocks, the report lists the unanswered endpoints and the hidden change', () => {
    const file = path.join(work, 'manifest-nomock.json');
    writeFileSync(file, JSON.stringify(manifest([])));
    const out = path.join(work, 'report-nomock');
    const result = run('capture.mjs', [file, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readJson(path.join(out, 'unanswered.json')).map((entry) => `${entry.method} ${entry.path}`).sort(), ['GET /api/events/upcoming', 'GET /api/stats/club', 'POST /api/graphql', 'WS /api/live']);
    assert.match(result.stderr, /Home › upcoming runs, mobile: Expected a visible change, but before and after are identical/);
  });

  test('with mocks (drafted from types when TypeScript is available), every pair is right and the report is complete', () => {
    let mocks = [path.join(FIXTURES, 'riverside-mocks.json')];
    if (TYPESCRIPT) {
      const drafted = run('mocks.mjs', ['draft', path.join(work, 'report-nomock'), '--project', path.join(repo, 'jsconfig.json'), '--out', path.join(work, 'mocks.json')], { env: { UI_CHANGELOG_TYPESCRIPT: TYPESCRIPT } });
      assert.equal(drafted.status, 0, drafted.stderr);
      assert.equal((drafted.stderr.match(/^typed /gm) ?? []).length, 4, drafted.stderr);
      mocks = [path.join(work, 'mocks.json')];
    }
    const file = path.join(work, 'manifest.json');
    writeFileSync(file, JSON.stringify(manifest(mocks)));
    const out = path.join(work, 'report');
    const result = run('capture.mjs', [file, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const results = readJson(path.join(out, 'results.json'));
    const status = Object.fromEntries(results.shots.map((shot) => [shot.id, shot.status]));
    assert.deepEqual(status, { footer: 'changed', dialog: 'added', 'cards-mobile': 'changed', 'cards-desktop': 'unchanged', header: 'unchanged' });
    assert.deepEqual(readJson(path.join(out, 'unanswered.json')), []);
    assert.doesNotMatch(result.stderr, /need(s)? attention/);
    const footer = results.shots.find((shot) => shot.id === 'footer');
    assert.equal(footer.regions.length, 1, 'only the new button is circled, not the moved footer rows');
    const cards = results.shots.find((shot) => shot.id === 'cards-mobile');
    assert.equal(cards.regions.length, 3);
    for (const region of cards.regions) {
      assert.ok(region.before, `region ${region.n} has a before box`);
      assert.ok(Math.abs(region.before.y - region.y) < region.y + 1);
    }
    assert.ok(cards.regions[2].before.y > cards.regions[0].before.y);
    assert.equal(results.before.git.dirty, 0);
    assert.ok(results.after.git.dirty > 0);
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    for (const text of ['Close-ups of each circled change', 'value="swipe"', 'Changed files', 'not captured: types only', 'Capture details', 'API mocked']) assert.ok(html.includes(text), text);
    const md = readFileSync(path.join(out, 'report.md'), 'utf8');
    assert.match(md, /\| Location \| Before \| After \| Changes circled \|/);
    assert.match(md, /!\[Home › footer after\]\(\.\/shots\/footer-after\.png\)/);
    assert.match(md, /_API responses in these screenshots are mocked with fictional data\._/);
    assert.ok(existsSync(path.join(out, 'shots', 'cards-mobile-circled.png')));
    assert.ok(existsSync(path.join(out, 'manifest.json')));

    // Re-diff without a browser, re-render, and recapture one group: results stay consistent.
    assert.equal(run('capture.mjs', ['compare', '--out', out]).status, 0);
    assert.deepEqual(readJson(path.join(out, 'results.json')).shots.map((shot) => shot.status), results.shots.map((shot) => shot.status));
    assert.equal(run('capture.mjs', ['report', '--out', out]).status, 0);
    const only = run('capture.mjs', [file, '--out', out, '--only', 'cards']);
    assert.equal(only.status, 0, only.stderr);
    assert.deepEqual(readJson(path.join(out, 'results.json')).shots.map((shot) => shot.id), results.shots.map((shot) => shot.id));
  });
});

describe('redaction of shared artifacts', async () => {
  const { redactBody, redactUrl } = await import(path.join(SCRIPTS, 'lib', 'util.mjs'));

  test('query values and request-body values are replaced, the GraphQL operation is kept', () => {
    assert.equal(redactUrl('http://127.0.0.1:4399/api/x?token=abc123&page=2&operationName=Stats'), 'http://127.0.0.1:4399/api/x?token=_&page=_&operationName=Stats');
    const body = redactBody(JSON.stringify({ operationName: 'Login', query: 'mutation Login { ok }', variables: { email: 'a@b.c', password: 'hunter2', remember: true } }));
    assert.doesNotMatch(body, /hunter2|a@b\.c/);
    assert.deepEqual(JSON.parse(body), { operationName: 'Login', query: 'mutation Login { ok }', variables: { email: '<string>', password: '<string>', remember: '<boolean>' } });
    assert.equal(redactBody('user=a&pass=b'), '[13 bytes, not JSON]');
  });
});

describe('review integrity', async () => {
  const { analyze } = await import(path.join(SCRIPTS, 'lib', 'report.mjs'));

  test('GraphQL operations on one URL are separate unanswered endpoints', () => {
    const call = (operation) => ({ method: 'POST', url: 'http://127.0.0.1:4399/graphql', reason: 'refused', postData: JSON.stringify({ operationName: operation, query: `query ${operation} { x }` }) });
    const facts = analyze({ before: {}, after: {}, shots: [{ id: 's', label: 'S', status: 'unchanged', sources: [], before: {}, after: { network: { unanswered: [call('Stats'), call('Viewer')] } } }] });
    assert.deepEqual(facts.unanswered.map((entry) => entry.operation).sort(), ['Stats', 'Viewer']);
  });

  test('ids that would share a file name are refused', () => {
    const manifest = path.join(TMP, 'collide.json');
    writeFileSync(manifest, JSON.stringify({ before: { baseURL: 'http://127.0.0.1:1' }, after: { baseURL: 'http://127.0.0.1:1' }, shots: [{ id: 'a-b' }, { id: 'A b' }] }));
    const result = run('capture.mjs', [manifest, '--out', path.join(TMP, 'collide')]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /would share the file name a-b/);
  });

  test('compare keeps the per-shot threshold it was captured with', { skip: NO_BROWSER }, () => {
    const { PNG } = toolRequire('pngjs');
    const dir = path.join(TMP, 'threshold');
    mkdirSync(path.join(dir, 'shots'), { recursive: true });
    for (const [side, level] of [['before', 100], ['after', 160]]) {
      const png = new PNG({ width: 40, height: 40 });
      png.data.fill(255);
      for (let i = 0; i < 40 * 40; i++) png.data.set([level, level, level, 255], i * 4);
      writeFileSync(path.join(dir, 'shots', `t-${side}.png`), PNG.sync.write(png));
    }
    writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ title: 't', before: {}, after: {}, shots: [{ id: 't', label: 't', sources: [], threshold: 0.5, status: 'changed', before: { file: 'shots/t-before.png' }, after: { file: 'shots/t-after.png' } }] }));
    assert.equal(run('capture.mjs', ['compare', '--out', dir]).status, 0);
    assert.equal(readJson(path.join(dir, 'results.json')).shots[0].status, 'unchanged');
  });

  test('a moved line between two nearby changes is not marked as changed', { skip: NO_BROWSER }, async () => {
    const { compareShot } = await import(path.join(SCRIPTS, 'lib', 'compare.mjs'));
    const { PNG } = toolRequire('pngjs');
    const dir = path.join(TMP, 'merged-band');
    mkdirSync(path.join(dir, 'shots'), { recursive: true });
    const page = (bars) => {
      const png = new PNG({ width: 200, height: 100 });
      png.data.fill(255);
      for (const [top, size, level = 40] of bars) for (let y = top; y < top + size; y++) for (let x = 20; x < 180; x++) png.data.set([level, level, level, 255], (y * 200 + x) * 4);
      return png;
    };
    // Before: a short line, then a status line. After: a banner inserted above both, and the status changed.
    writeFileSync(path.join(dir, 'shots', 'm-before.png'), PNG.sync.write(page([[14, 6], [24, 8]])));
    writeFileSync(path.join(dir, 'shots', 'm-after.png'), PNG.sync.write(page([[10, 20, 120], [34, 6], [44, 8, 150]])));
    process.env.UI_CHANGELOG_DEBUG = '1';
    try {
      await compareShot(dir, { id: 'm' }, { before: { file: 'shots/m-before.png' }, after: { file: 'shots/m-after.png' } });
    } finally {
      delete process.env.UI_CHANGELOG_DEBUG;
    }
    const mask = PNG.sync.read(readFileSync(path.join(dir, 'shots', 'm-mask.png')));
    const markedRows = new Set();
    for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) if (mask.data[(y * mask.width + x) * 4 + 3]) markedRows.add(y);
    assert.ok(markedRows.has(15) && markedRows.has(46), 'the banner and the changed status are marked');
    for (let y = 34; y < 40; y++) assert.ok(!markedRows.has(y), `moved line row ${y} is not marked`);
  });
});

describe('servicePolicy, staleness and strict mode', { skip: NO_BROWSER }, () => {
  const fixture = path.join(FIXTURES, 'mock-kinds');
  const base = readJson(path.join(fixture, 'manifest.json'));
  const guards = { id: 'guards', label: 'Guards', path: '/?scenario=guards' };
  const write = (name, manifest) => {
    const file = path.join(fixture, `.test-${name}.json`);
    writeFileSync(file, JSON.stringify({ ...manifest, before: base.before, after: base.after }));
    return file;
  };
  const files = [];
  let servers;
  before(async () => {
    servers = await startFixtureServers(fixture, [47020, 47021]);
  });
  after(() => {
    servers?.forEach((child) => child.kill());
    files.forEach((file) => rmSync(file, { force: true }));
  });

  test('mock-only blocks unmocked same-origin API calls, and the report copy of the manifest has no secrets', () => {
    const manifest = write('mock-only', { allowHosts: [], servicePolicy: 'mock-only', extraHTTPHeaders: { 'x-api-token': 'secret-123' }, localStorage: { jwt: 'jwt-value' }, shots: [guards] });
    files.push(manifest);
    const out = path.join(TMP, 'mock-only');
    const result = run('capture.mjs', [manifest, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const [shot] = readJson(path.join(out, 'results.json')).shots;
    const reasons = shot.after.network.unanswered.filter((call) => call.url.endsWith('/api/settings')).map((call) => call.reason);
    assert.deepEqual(reasons, ['blocked by servicePolicy mock-only: no mock matched']);
    const copy = readFileSync(path.join(out, 'manifest.json'), 'utf8');
    assert.doesNotMatch(copy, /secret-123|jwt-value/);
  });

  test('kept results go stale when the manifest changes, missing results show as not run, and --strict exits 2', () => {
    const out = path.join(TMP, 'stale');
    const first = write('stale-1', { shots: [guards, { ...guards, id: 'guards-2', label: 'Guards 2' }] });
    files.push(first);
    assert.equal(run('capture.mjs', [first, '--out', out]).status, 0);
    const second = write('stale-2', { hide: ['.nothing'], shots: [guards, { ...guards, id: 'guards-2', label: 'Guards 2' }, { ...guards, id: 'guards-3', label: 'Guards 3' }] });
    files.push(second);
    const result = run('capture.mjs', [second, '--out', out, '--only', 'guards', '--strict']);
    assert.equal(result.status, 2, result.stderr);
    const byId = Object.fromEntries(readJson(path.join(out, 'results.json')).shots.map((shot) => [shot.id, shot]));
    assert.equal(byId.guards.stale, undefined);
    assert.equal(byId['guards-2'].stale, true);
    assert.equal(byId['guards-3'].status, 'not-run');
    assert.match(result.stderr, /Guards 2: Captured with an earlier version/);
    assert.match(result.stderr, /Guards 3: Not run/);
  });
});

describe('mock server', () => {
  test('serves the same mocks over HTTP with CORS, 404s for the rest, and SSE', async () => {
    const file = path.join(TMP, 'served-mocks.json');
    writeFileSync(file, JSON.stringify([{ url: 'http://127.0.0.1:47040/api/items', json: { items: [1, 2] } }, { url: 'http://127.0.0.1:47040/api/stream', sse: [{ event: 'tick', data: 1 }] }, { websocket: 'ws://127.0.0.1:47040/live', send: ['x'] }]));
    const child = spawn(process.execPath, [path.join(SCRIPTS, 'mocks.mjs'), 'serve', file, '--port', '47040'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    await new Promise((resolve, reject) => {
      child.stderr.on('data', (chunk) => {
        log += chunk;
        if (log.includes('Serving')) resolve();
      });
      child.on('exit', () => reject(new Error(log)));
    });
    try {
      const items = await fetch('http://127.0.0.1:47040/api/items?locale=en', { headers: { origin: 'http://127.0.0.1:5173' } });
      assert.deepEqual(await items.json(), { items: [1, 2] });
      assert.equal(items.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
      assert.equal((await fetch('http://localhost:47040/api/items')).status, 200, 'another host name for the same port still matches');
      assert.equal((await fetch('http://127.0.0.1:47040/api/missing')).status, 404);
      const stream = await fetch('http://127.0.0.1:47040/api/stream');
      assert.equal(stream.headers.get('content-type'), 'text/event-stream');
      assert.match(await stream.text(), /event: tick\ndata: 1/);
      assert.match(log, /WebSocket mock; serve answers HTTP only/);
    } finally {
      child.kill();
    }
  });
});

describe('command line', () => {
  test('every script explains itself with --help', () => {
    for (const script of ['capture.mjs', 'mocks.mjs', 'affected.mjs']) {
      const result = run(script, ['--help'], { cwd: os.tmpdir() });
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
      assert.match(result.stdout, /^Usage/);
    }
  });

  test('unknown manifest fields are named before a capture starts', () => {
    const file = path.join(TMP, 'typo.json');
    writeFileSync(file, JSON.stringify({ before: { baseURL: 'http://127.0.0.1:47049' }, after: { baseURL: 'http://127.0.0.1:47049' }, viewPorts: ['mobile'], shots: [{ id: 'a', pathname: '/' }] }));
    const result = run('capture.mjs', [file, '--out', path.join(TMP, 'typo-report')]);
    assert.match(result.stderr, /unknown manifest fields, ignored: manifest\.viewPorts, shots\[a\]\.pathname/);
  });
});
