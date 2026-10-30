#!/usr/bin/env node
// Maps a git diff to the UI entry points (pages, routes, layouts) that render the changed files.
// Usage: node affected.mjs [--base <ref>] [--scope <dir>]... [--entry <regex>]... [--max-entries <n>] [--markdown]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const root = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    console.error('affected.mjs must run inside the git repository under review.');
    process.exit(1);
  }
})();
const base = args.base ?? defaultBase();
const maxEntries = Number(args['max-entries'] ?? 15);
const scopes = [].concat(args.scope ?? []).map((dir) => {
  const absolute = existsSync(path.resolve(dir)) ? path.resolve(dir) : path.join(root, dir);
  return `${path.relative(root, absolute).replace(/\/+$/, '')}/`;
});

const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro'];
const STYLE_EXT = ['.css', '.scss', '.sass', '.less', '.styl', '.pcss'];
const ASSET_EXT = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.json'];
const RESOLVE_EXT = [...SOURCE_EXT, ...STYLE_EXT, ...ASSET_EXT];
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'dev-dist', 'storybook-static', '.vercel', '.output']);

const COMPONENT_FILE = /\.(tsx|jsx|js|vue|svelte|astro)$/;
const ENTRY_PATTERNS = [
  /(^|\/)(pages?|routes?|views?|screens?)\/[^/]+$/,
  /\.(page|route|view|screen|layout)\.\w+$/,
  /(^|\/)(page|layout|template|route)\.\w+$/,
  /\+(page|layout)\.svelte$/,
];
const ROUTER_PATTERN = /(^|\/)(router|routes|app-routes|routing)\.[cm]?[jt]sx?$/;
const CUSTOM_ENTRY_PATTERNS = [].concat(args.entry ?? []).map((source) => new RegExp(source));
const SHELL_PATTERN = /(^|\/)(main|index|app|root|_app|_document|layout|shell)\.[cm]?[jt]sx?$/i;
const TEST_PATTERN = /(\.|\/)(spec|test|stories|story|e2e|cy)(\.|\/)|(^|\/)(__tests__|__mocks__|e2e|test|tests|cypress|playwright)\//;
const LOCALE_PATTERN = /(^|\/)(locales?|i18n|lang|translations?|messages)(\/|\.)/;
const THEME_PATTERN = /(^|\/)(theme|tokens?|design-tokens|tailwind\.config|global(s)?\.(s?css|less)|index\.(s?css|less)|variables\.(s?css|less))/;

const changed = changedFiles();
const files = walk(root);
const resolver = createResolver(files);
const importers = buildReverseGraph(files, resolver);

const breakpoints = readBreakpoints(files);
const classified = changed.map(classify);
const report = {
  root,
  base,
  baseCommit: git(['rev-parse', base]).trim(),
  after: dirty() ? 'working tree (includes uncommitted changes)' : 'HEAD',
  breakpoints,
  viewports: suggestViewports(classified),
  files: classified,
};

if (scopes.length && report.files.every((file) => file.kind === 'out-of-scope')) {
  console.error(`No changed files under ${scopes.join(', ')} (paths are resolved from the current directory, then the repo root).`);
}
if (args.markdown) printMarkdown(report);
else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function classify({ path: rel, status }) {
  const ext = path.extname(rel);
  const isTest = TEST_PATTERN.test(rel);
  const isUiSource = SOURCE_EXT.includes(ext) || STYLE_EXT.includes(ext) || ASSET_EXT.includes(ext) || rel.endsWith('.html');
  let kind = 'non-ui';
  if (isTest) kind = 'test';
  else if (LOCALE_PATTERN.test(rel)) kind = 'locale';
  else if (THEME_PATTERN.test(rel)) kind = 'theme';
  else if (isEntry(rel)) kind = 'entry';
  else if (STYLE_EXT.includes(ext)) kind = 'style';
  else if (ASSET_EXT.includes(ext)) kind = 'asset';
  else if (isUiSource) kind = 'module';

  const result = { path: rel, status, kind };
  if (scopes.length && !scopes.some((dir) => rel.startsWith(dir))) return { ...result, kind: 'out-of-scope' };
  if (kind === 'test' || kind === 'non-ui' || status === 'D') return result;

  const { entries, roots, reached } = traceToEntries(rel);
  if (kind === 'asset' && !reached) return { ...result, kind: 'non-ui' };
  result.importers = reached;
  if (entries.length > maxEntries) {
    result.scope = 'global';
    result.entryCount = entries.length;
    result.sampleEntries = entries.slice(0, 5);
  } else {
    result.scope = entries.length ? 'scoped' : roots.length && roots.every(({ root: top }) => SHELL_PATTERN.test(top)) ? 'shell' : 'unreached';
    result.entries = entries;
  }
  if (!entries.length && roots.length) result.roots = roots.slice(0, maxEntries);
  const responsive = responsiveSignals(rel, status);
  if (responsive) result.responsive = responsive;
  return result;
}

// Responsive signals in the changed lines ("change") or elsewhere in the file ("file").
// A change-level signal means the change itself differs by viewport; a file-level one means the
// change lands in a layout that does.
function responsiveSignals(rel, status) {
  let text;
  try {
    text = readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
  const changedLines =
    status === 'A'
      ? text
      : git(['diff', '-U0', '--no-color', base, '--', rel])
          .split('\n')
          .filter((line) => /^[+-](?![+-]{2})/.test(line))
          .map((line) => line.slice(1))
          .join('\n');
  const inChange = scanResponsive(changedLines);
  const inFile = scanResponsive(text);
  if (!inFile.length) return null;
  return { level: inChange.length ? 'change' : 'file', signals: inChange.length ? inChange : inFile };
}

function scanResponsive(text) {
  const names = Object.keys(breakpoints).sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const found = new Set();
  const variant = new RegExp(`(?<![\\w/-])(max-|min-)?(${names.join('|')}):(?=[\\w!\\[-])`, 'g');
  for (const match of text.matchAll(variant)) found.add(`${match[1] ?? ''}${match[2]}:`);
  for (const match of text.matchAll(/@(?:media|container)[^{]*?\(\s*(min|max)-width\s*:\s*([\d.]+)(px|rem|em)\s*\)/g)) {
    found.add(`${match[1]}-width: ${match[2]}${match[3]}`);
  }
  for (const match of text.matchAll(/\b(matchMedia|useMediaQuery|innerWidth|use\w*(?:Window|Media|Breakpoint|Viewport|Screen)\w*)\b/g)) found.add(match[1]);
  return [...found];
}

// Tailwind defaults, overridden by `--breakpoint-*` theme variables (v4) or `screens` (v3 config).
function readBreakpoints(allFiles) {
  const result = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 };
  const toPx = (value, unit) => Math.round(Number(value) * (unit === 'px' ? 1 : 16));
  for (const file of allFiles) {
    if (!/\.(css|scss|pcss)$/.test(file) && !/tailwind\.config\.[cm]?[jt]s$/.test(file)) continue;
    let text;
    try {
      text = readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/--breakpoint-([\w-]+)\s*:\s*([\d.]+)(px|rem|em)/g)) result[match[1]] = toPx(match[2], match[3]);
    const screens = text.match(/screens\s*:\s*\{([^}]*)\}/);
    if (screens) for (const match of screens[1].matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"]([\d.]+)(px|rem|em)['"]/g)) result[match[1]] = toPx(match[2], match[3]);
  }
  return result;
}

// One viewport below the smallest breakpoint involved, one at each breakpoint, and desktop.
function suggestViewports(rows) {
  const responsive = rows.filter((row) => row.responsive);
  if (!responsive.length) return [];
  const widths = new Map([[390, { name: 'mobile', width: 390, height: 844, mobile: true }], [1280, { name: 'desktop', width: 1280, height: 800 }]]);
  for (const row of responsive.filter((candidate) => candidate.responsive.level === 'change')) {
    for (const signal of row.responsive.signals) {
      const tailwind = signal.match(/^(max-|min-)?([\w-]+):$/);
      const media = signal.match(/^(min|max)-width: ([\d.]+)(px|rem|em)$/);
      const width = tailwind ? breakpoints[tailwind[2]] : media ? Math.round(Number(media[2]) * (media[3] === 'px' ? 1 : 16)) : null;
      if (!width || widths.has(width)) continue;
      const name = tailwind ? tailwind[2] : `w${width}`;
      widths.set(width, { name, width, height: width < 1024 ? 1024 : 800 });
    }
  }
  return [...widths.values()].sort((a, b) => a.width - b.width).map((viewport) => ({
    ...viewport,
    required: responsive.some((row) => row.responsive.level === 'change') || viewport.name === 'desktop',
  }));
}

// BFS up the reverse import graph, stopping at entry files; records one shortest chain per entry.
function traceToEntries(start) {
  if (isEntry(start)) return { entries: [{ entry: start, chain: [start] }], roots: [], reached: 0 };
  const parent = new Map([[start, null]]);
  const queue = [start];
  const entries = [];
  const roots = [];
  while (queue.length) {
    const current = queue.shift();
    if (current !== start && isEntry(current)) {
      entries.push({ entry: current, chain: chainTo(current, parent) });
      continue;
    }
    const next = [...(importers.get(current) ?? [])].filter((file) => !TEST_PATTERN.test(file));
    if (!next.length && current !== start) roots.push({ root: current, chain: chainTo(current, parent) });
    for (const file of next) {
      if (parent.has(file)) continue;
      parent.set(file, current);
      queue.push(file);
    }
  }
  return { entries, roots, reached: parent.size - 1 };
}

function chainTo(file, parent) {
  const chain = [];
  for (let node = file; node; node = parent.get(node)) chain.unshift(node);
  return chain;
}

function isEntry(rel) {
  if (TEST_PATTERN.test(rel)) return false;
  if (CUSTOM_ENTRY_PATTERNS.length) return CUSTOM_ENTRY_PATTERNS.some((pattern) => pattern.test(rel));
  return ROUTER_PATTERN.test(rel) || (COMPONENT_FILE.test(rel) && ENTRY_PATTERNS.some((pattern) => pattern.test(rel)));
}

function buildReverseGraph(allFiles, resolve) {
  const graph = new Map();
  const IMPORT_PATTERNS = [
    /(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g,
    /@(?:import|use|forward)\s+(?:url\()?\s*['"]([^'"]+)['"]/g,
    /url\(\s*['"]?([^'")]+?\.(?:svg|png|jpe?g|gif|webp|avif|woff2?|ttf|otf))['"]?\s*\)/g,
  ];
  for (const file of allFiles) {
    const ext = path.extname(file);
    if (!SOURCE_EXT.includes(ext) && !STYLE_EXT.includes(ext) && !file.endsWith('.html')) continue;
    let text;
    try {
      text = readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const target = resolve(match[1], file);
        if (!target || target === file) continue;
        if (!graph.has(target)) graph.set(target, new Set());
        graph.get(target).add(file);
      }
    }
  }
  return graph;
}

function createResolver(allFiles) {
  const fileSet = new Set(allFiles);
  const aliases = readTsconfigAliases(allFiles);
  const packages = readWorkspacePackages(allFiles);

  const tryFile = (candidate) => {
    const rel = path.relative(root, candidate);
    if (rel.startsWith('..')) return null;
    const stripped = rel.replace(/\.(m|c)?js$/, '');
    const candidates = [rel];
    for (const ext of RESOLVE_EXT) candidates.push(rel + ext, stripped + ext);
    for (const ext of SOURCE_EXT) candidates.push(path.join(rel, `index${ext}`));
    return candidates.find((name) => fileSet.has(name)) ?? null;
  };

  return (specifier, fromFile) => {
    const spec = specifier.split(/[?#]/)[0];
    if (!spec || /^(https?:|data:|node:)/.test(spec)) return null;
    const fromDir = path.join(root, path.dirname(fromFile));
    if (spec.startsWith('.')) return tryFile(path.resolve(fromDir, spec));
    if (spec.startsWith('/')) return tryFile(path.join(root, spec)) ?? tryFile(path.join(nearestDir(fromFile, 'public') ?? root, spec));

    for (const { prefix, suffix, exact, targets } of aliases) {
      if (exact ? spec !== prefix : !spec.startsWith(prefix) || !spec.endsWith(suffix) || spec.length < prefix.length + suffix.length) continue;
      const wildcard = spec.slice(prefix.length, spec.length - suffix.length);
      for (const target of targets) {
        const hit = tryFile(target.replace('*', wildcard));
        if (hit) return hit;
      }
    }
    for (const [name, { dir, entries }] of packages) {
      if (spec !== name && !spec.startsWith(`${name}/`)) continue;
      const sub = spec.slice(name.length + 1);
      const candidates = sub ? [path.join(dir, sub), path.join(dir, 'src', sub)] : entries;
      for (const candidate of candidates) {
        const hit = tryFile(candidate);
        if (hit) return hit;
      }
    }
    const aliasRoot = /^[@~#]\//.test(spec) ? nearestDir(fromFile, 'src') : null;
    return aliasRoot ? tryFile(path.join(aliasRoot, spec.slice(2))) : null;
  };
}

function readTsconfigAliases(allFiles) {
  const aliases = [];
  for (const file of allFiles.filter((name) => /(^|\/)[tj]sconfig[^/]*\.json$/.test(name))) {
    const config = readJsonc(path.join(root, file));
    const options = config?.compilerOptions;
    if (!options?.paths) continue;
    const baseDir = path.resolve(path.join(root, path.dirname(file)), options.baseUrl ?? '.');
    for (const [pattern, targets] of Object.entries(options.paths)) {
      const [prefix, suffix = ''] = pattern.split('*');
      aliases.push({ prefix, suffix: pattern.includes('*') ? suffix : '', exact: !pattern.includes('*'), targets: targets.map((target) => path.resolve(baseDir, target)) });
    }
  }
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

function readWorkspacePackages(allFiles) {
  const packages = new Map();
  for (const file of allFiles.filter((name) => name.endsWith('package.json'))) {
    const pkg = readJsonc(path.join(root, file));
    if (!pkg?.name) continue;
    const dir = path.join(root, path.dirname(file));
    const exported = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.']?.import ?? pkg.exports?.['.']?.default;
    const entries = [pkg.source, pkg.module, pkg.main, exported, pkg.types, 'src/index', 'index']
      .filter((entry) => typeof entry === 'string')
      .map((entry) => path.join(dir, entry));
    packages.set(pkg.name, { dir, entries });
  }
  return packages;
}

function readJsonc(file) {
  try {
    const text = readFileSync(file, 'utf8')
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, string) => string ?? '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function nearestDir(fromFile, name) {
  for (let dir = path.dirname(fromFile); dir && dir !== '.'; dir = path.dirname(dir)) {
    const candidate = path.join(root, dir, name);
    if (existsSync(candidate)) return candidate;
    if (path.basename(dir) === name) return path.join(root, dir);
  }
  return existsSync(path.join(root, name)) ? path.join(root, name) : null;
}

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.isDirectory())) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function changedFiles() {
  const tracked = git(['diff', '--name-status', '--no-renames', base])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status[0], path: rest.join('\t') };
    });
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
    .filter((rel) => {
      try {
        return statSync(path.join(root, rel)).isFile();
      } catch {
        return false;
      }
    })
    .map((rel) => ({ status: 'A', path: rel }));
  return [...tracked, ...untracked].filter((file) => !file.path.split('/').slice(0, -1).some((dir) => dir.startsWith('.') || IGNORED_DIRS.has(dir)));
}

function defaultBase() {
  if (dirty()) return 'HEAD';
  const remoteHead = tryGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.trim();
  for (const candidate of [remoteHead, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean)) {
    const mergeBase = tryGit(['merge-base', 'HEAD', candidate])?.trim();
    if (mergeBase) return mergeBase;
  }
  throw new Error('Could not pick a base ref; pass --base <ref>.');
}

function dirty() {
  return git(['status', '--porcelain']).trim().length > 0;
}

function git(gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function tryGit(gitArgs) {
  try {
    return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[key] = key in out ? [].concat(out[key], value) : value;
  }
  return out;
}

function printMarkdown({ base, baseCommit, after, viewports, files: rows }) {
  const lines = [`Base: ${base} (${baseCommit.slice(0, 10)}). After: ${after}.`, ''];
  const responsive = rows.filter((row) => row.responsive);
  if (responsive.length) {
    const change = responsive.filter((row) => row.responsive.level === 'change');
    lines.push(change.length ? '## Responsive (the change differs by viewport; capture every viewport below)' : '## Responsive (the change sits in a responsive layout; capture mobile too)');
    for (const row of responsive) lines.push(`- \`${row.path}\` (${row.responsive.level === 'change' ? 'in the changed lines' : 'elsewhere in the file'}): ${row.responsive.signals.slice(0, 8).map((signal) => `\`${signal}\``).join(', ')}`);
    lines.push(`- Viewports: ${viewports.map((viewport) => `${viewport.name} ${viewport.width}×${viewport.height}`).join(', ')}`, '');
  }
  const groups = { scoped: [], shell: [], global: [], unreached: [], skipped: [] };
  for (const row of rows) (groups[row.scope] ?? groups.skipped).push(row);
  if (groups.scoped.length) {
    lines.push('## Scoped (capture these entries)');
    for (const row of groups.scoped) {
      lines.push(`- \`${row.path}\` (${row.kind}, ${row.status})`);
      for (const { entry, chain } of row.entries) lines.push(`  - \`${entry}\`${chain.length > 2 ? ` via ${chain.slice(1, -1).map((step) => `\`${path.basename(step)}\``).join(' → ')}` : ''}`);
    }
  }
  if (groups.shell.length) {
    lines.push('', '## App shell (renders on every page; capture one representative page per layout)');
    for (const row of groups.shell) lines.push(`- \`${row.path}\` (${row.kind}) via ${row.roots.map(({ chain }) => chain.slice(1).map((step) => `\`${path.basename(step)}\``).join(' → ')).join('; ')}`);
  }
  if (groups.global.length) {
    lines.push('', '## Global (reaches many entries; find the specific consumers from the diff hunks)');
    for (const [kind, rows] of Object.entries(Object.groupBy(groups.global, (row) => row.kind))) {
      lines.push(`- ${kind}, ${rows.length} file(s) reaching up to ${Math.max(...rows.map((row) => row.entryCount))} entries: ${rows.map((row) => `\`${row.path}\``).join(', ')}`);
    }
  }
  if (groups.unreached.length) {
    lines.push('', '## Unreached (no entry found; inspect manually)');
    for (const row of groups.unreached) lines.push(`- \`${row.path}\` (${row.kind})${row.roots?.length ? `, top importers: ${row.roots.map(({ root: top }) => `\`${top}\``).join(', ')}` : ', no importers'}`);
  }
  if (groups.skipped.length) {
    lines.push('', '## Skipped');
    const byKind = Object.groupBy(groups.skipped, (row) => (row.status === 'D' ? 'deleted' : row.kind));
    for (const [kind, rows] of Object.entries(byKind)) lines.push(`- ${kind}: ${rows.map((row) => `\`${row.path}\``).join(', ')}`);
  }
  process.stdout.write(`${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
}
