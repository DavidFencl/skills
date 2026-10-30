#!/usr/bin/env node
// Checks that every skill in skills/ loads in each agent harness and stays harness-neutral.
//   node tests/check-portability.mjs
// Static checks always run. Each installed harness (Claude Code, Codex, Grok, pi) also loads the skill
// with its own loader, using a throwaway home directory so no configuration is touched.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(ROOT, 'skills');
// Fields defined by the Agent Skills specification, the set every harness accepts.
const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
// Tool names and substitutions that exist in one harness only.
const HARNESS_SPECIFIC = /\b(Read|Write|Edit|MultiEdit|Bash|Glob|Grep|Task|TodoWrite|WebFetch|WebSearch|AskUserQuestion|NotebookEdit|Skill|apply_patch|shell) tool\b|\$\{CLAUDE_[A-Z_]+\}|\$ARGUMENTS\b|\buse the `(Read|Write|Edit|Bash|Glob|Grep)`/;
const results = [];
const record = (check, status, detail = '') => results.push({ check, status, detail });
const tmp = mkdtempSync(path.join(process.env.UI_CHANGELOG_TEST_TMP ?? os.tmpdir(), 'portability-'));

const skills = readdirSync(SKILLS, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(path.join(SKILLS, entry.name, 'SKILL.md'))).map((entry) => entry.name);
const loadYaml = findYamlParser();

for (const name of skills) {
  const dir = path.join(SKILLS, name);
  const text = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    record(`${name}: frontmatter`, 'fail', 'SKILL.md must start with a --- block');
    continue;
  }
  let front;
  try {
    front = loadYaml.parse(match[1]);
    record(`${name}: frontmatter parses (${loadYaml.name})`, 'pass');
  } catch (error) {
    record(`${name}: frontmatter parses (${loadYaml.name})`, 'fail', error.message);
    continue;
  }
  const extra = Object.keys(front).filter((key) => !SPEC_FIELDS.has(key));
  record(`${name}: only Agent Skills spec fields`, extra.length ? 'fail' : 'pass', extra.join(', '));
  record(`${name}: name matches folder, lowercase-hyphen, at most 64`, front.name === name && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64 ? 'pass' : 'fail', String(front.name));
  const description = String(front.description ?? '');
  record(`${name}: description present, at most 1024 chars, no angle brackets`, description && description.length <= 1024 && !/[<>]/.test(description) ? 'pass' : 'fail', `${description.length} chars`);
  if (front.compatibility !== undefined) record(`${name}: compatibility at most 500 chars`, String(front.compatibility).length <= 500 ? 'pass' : 'fail', `${String(front.compatibility).length} chars`);
  if (front.metadata !== undefined) record(`${name}: metadata maps strings to strings`, Object.values(front.metadata).every((value) => typeof value === 'string') ? 'pass' : 'fail');
  const lines = text.split('\n').length;
  record(`${name}: SKILL.md under 500 lines`, lines < 500 ? 'pass' : 'fail', `${lines} lines, ${text.split(/\s+/).length} words`);

  const docs = [path.join(dir, 'SKILL.md'), ...listFiles(path.join(dir, 'references')).filter((file) => file.endsWith('.md'))];
  const offenders = docs.flatMap((file) => readFileSync(file, 'utf8').split('\n').map((line, index) => [file, index + 1, line]).filter(([, , line]) => HARNESS_SPECIFIC.test(line)));
  record(`${name}: no harness-specific tool names in SKILL.md and references`, offenders.length ? 'fail' : 'pass', offenders.map(([file, line]) => `${path.relative(dir, file)}:${line}`).join(', '));
  const missing = [...text.matchAll(/`((?:references|scripts)\/[^`\s]+)`/g)].map((found) => found[1].replace(/[),.]+$/, '')).filter((rel) => !existsSync(path.join(dir, rel)));
  record(`${name}: files named in SKILL.md exist`, missing.length ? 'fail' : 'pass', missing.join(', '));

  const scripts = listFiles(path.join(dir, 'scripts')).filter((file) => /\.(mjs|js|sh)$/.test(file));
  const badImports = scripts.filter((file) => file.endsWith('.mjs')).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((found) => found[1]).filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.')).map((spec) => `${path.relative(dir, file)} imports ${spec}`));
  record(`${name}: scripts import only Node built-ins and their own files`, badImports.length ? 'fail' : 'pass', badImports.join(', '));
  const shells = scripts.filter((file) => file.endsWith('.sh'));
  const shellErrors = shells.filter((file) => spawnSync('bash', ['-n', file]).status !== 0);
  record(`${name}: shell scripts parse with bash -n`, shellErrors.length ? 'fail' : 'pass', shellErrors.map((file) => path.relative(dir, file)).join(', '));
  const nodeErrors = scripts.filter((file) => file.endsWith('.mjs') && spawnSync(process.execPath, ['--check', file]).status !== 0);
  record(`${name}: Node scripts pass node --check`, nodeErrors.length ? 'fail' : 'pass', nodeErrors.map((file) => path.relative(dir, file)).join(', '));

  checkClaude(name);
  checkCodex(name, dir, description);
  checkGrok(name, dir, description);
  await checkPi(name, description);
}

rmSync(tmp, { recursive: true, force: true });
const width = Math.max(...results.map((result) => result.check.length));
for (const result of results) console.log(`${result.status.padEnd(7)} ${result.check.padEnd(width)}  ${result.detail}`);
const failed = results.filter((result) => result.status === 'fail').length;
console.log(`\n${results.filter((result) => result.status === 'pass').length} passed, ${failed} failed, ${results.filter((result) => result.status === 'skipped').length} skipped`);
process.exit(failed ? 1 : 0);

function checkClaude(name) {
  if (!onPath('claude')) return record(`${name}: Claude Code loads it (claude plugin validate)`, 'skipped', 'claude not installed');
  const home = path.join(tmp, 'claude-config');
  mkdirSync(home, { recursive: true });
  const result = spawnSync('claude', ['plugin', 'validate', SKILLS], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: home }, timeout: 120_000 });
  record(`${name}: Claude Code loads it (claude plugin validate)`, result.status === 0 && /Validation passed/.test(result.stdout) ? 'pass' : 'fail', (result.stdout + result.stderr).trim().split('\n').at(-1));
}

function checkCodex(name, dir, description) {
  if (!onPath('codex')) return record(`${name}: Codex lists it (codex debug prompt-input)`, 'skipped', 'codex not installed');
  const home = path.join(tmp, 'codex-home');
  mkdirSync(path.join(home, 'skills'), { recursive: true });
  symlinkSync(dir, path.join(home, 'skills', name));
  const result = spawnSync('codex', ['debug', 'prompt-input', 'hello'], { encoding: 'utf8', cwd: tmp, env: { ...process.env, CODEX_HOME: home }, timeout: 120_000 });
  const listed = result.stdout.includes(`- ${name}: ${JSON.stringify(description.slice(0, 200)).slice(1, -1)}`);
  record(`${name}: Codex lists it (codex debug prompt-input)`, listed ? 'pass' : 'fail', listed ? 'name and description in the skills list' : (result.stderr || result.stdout).slice(0, 200));
}

function checkGrok(name, dir, description) {
  if (!onPath('grok')) return record(`${name}: Grok lists it (grok inspect)`, 'skipped', 'grok not installed');
  const home = path.join(tmp, 'grok-home');
  mkdirSync(path.join(home, 'skills'), { recursive: true });
  symlinkSync(dir, path.join(home, 'skills', name));
  const result = spawnSync('grok', ['inspect', '--json'], { encoding: 'utf8', cwd: tmp, env: { ...process.env, GROK_HOME: home }, timeout: 120_000 });
  let skill;
  try {
    skill = JSON.parse(result.stdout).skills.find((candidate) => candidate.name === name && candidate.source.path.startsWith(home));
  } catch {
    // Reported below.
  }
  record(`${name}: Grok lists it (grok inspect)`, skill?.description === description ? 'pass' : 'fail', skill ? 'name and full description' : (result.stderr || result.stdout).slice(0, 200));
}

async function checkPi(name, description) {
  const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout?.trim();
  const loader = globalRoot && path.join(globalRoot, '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'skills.js');
  if (!loader || !existsSync(loader)) return record(`${name}: pi loads it (pi's loadSkillsFromDir)`, 'skipped', 'pi not installed');
  const { loadSkillsFromDir } = await import(pathToFileURL(loader).href);
  const { skills: loaded, diagnostics } = loadSkillsFromDir({ dir: SKILLS, source: 'portability-check' });
  const skill = loaded.find((candidate) => candidate.name === name);
  const warnings = diagnostics.filter((entry) => entry.path?.includes(`${path.sep}${name}${path.sep}`));
  record(`${name}: pi loads it (pi's loadSkillsFromDir)`, skill?.description === description && !warnings.length ? 'pass' : 'fail', warnings.map((entry) => entry.message).join('; ') || (skill ? 'no diagnostics' : 'not loaded'));
}

// Prefer the YAML parser a harness actually uses (pi's "yaml" package), then PyYAML.
function findYamlParser() {
  const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout?.trim();
  const piYaml = globalRoot && path.join(globalRoot, '@earendil-works', 'pi-coding-agent', 'node_modules', 'yaml');
  if (piYaml && existsSync(piYaml)) {
    const yaml = createRequire(path.join(piYaml, 'package.json'))(piYaml);
    return { name: 'yaml (npm, as pi uses)', parse: (source) => yaml.parse(source, { strict: true, uniqueKeys: true }) };
  }
  if (spawnSync('python3', ['-c', 'import yaml']).status === 0) {
    return { name: 'PyYAML', parse: (source) => JSON.parse(execFileSync('python3', ['-c', 'import sys, json, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], { input: source, encoding: 'utf8' })) };
  }
  throw new Error('No YAML parser found: install python3 with PyYAML, or pi.');
}

function onPath(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? listFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}
