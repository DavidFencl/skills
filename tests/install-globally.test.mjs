// Tests for install-globally.sh. Run from the repository root:
//   node --test tests/install-globally.test.mjs
// Each test copies the real installer into a scratch repo with two skills, points HOME at the
// scratch directory, and puts a stand-in `luxonis` CLI first on PATH, because the real CLI reads
// and changes this machine's installed packs. `shared` is a skill a Luxonis pack also has; `mine`
// is not.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const INSTALLER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'install-globally.sh');
const TARGETS = ['.agents', '.claude', '.grok'];

let home;
let repo;
let state;

function writeSkill(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\n`);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'install-globally-test-')));
  repo = path.join(home, 'repo');
  state = path.join(home, 'luxonis-state');
  mkdirSync(path.join(home, 'bin'));
  mkdirSync(state);
  for (const name of ['shared', 'mine']) writeSkill(path.join(repo, 'skills', name), name);
  copyFileSync(INSTALLER, path.join(repo, 'install-globally.sh'));
  for (const root of [...TARGETS, '.codex', path.join('.pi', 'agent')]) mkdirSync(path.join(home, root, 'skills'), { recursive: true });
  const fake = path.join(home, 'bin', 'luxonis');
  writeFileSync(
    fake,
    `#!/bin/sh
s="${state}"
case "$1" in
  skills) cat "$s/status.json" 2>/dev/null; exit "$(cat "$s/status-exit" 2>/dev/null || echo 0)" ;;
  tick) echo tick >> "$s/calls"; [ -f "$s/after-tick.json" ] && cp "$s/after-tick.json" "$s/status.json"; [ -f "$s/tick.sh" ] && sh "$s/tick.sh"; exit 0 ;;
esac
`,
  );
  chmodSync(fake, 0o755);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const skill = (name) => path.join(repo, 'skills', name);
const linkAt = (harness, name) => path.join(home, harness, 'skills', name);

const statusJson = ({ installed = [], conflicts = [], feed = 'enabled' } = {}) =>
  JSON.stringify({ account: 'local', installed: installed.map((name) => ({ packId: 'frontend', name })), conflicts, lastRun: { feed, conflicts } });
const status = (body) => writeFileSync(path.join(state, 'status.json'), statusJson(body));
const blockedBy = (name, reason = 'external-owner') => ({ packId: 'frontend', name, reason });
const ticks = () => (existsSync(path.join(state, 'calls')) ? readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n').length : 0);

// What a successful sync does: the CLI's real directory in ~/.agents/skills, relative links to it
// from Claude Code's and Grok's folders, and a status that lists the skill as installed.
function tickInstalls(name) {
  writeFileSync(path.join(state, 'after-tick.json'), statusJson({ installed: [name] }));
  writeFileSync(
    path.join(state, 'tick.sh'),
    `mkdir -p "${linkAt('.agents', name)}" && printf -- '---\\nname: ${name}\\n---\\n' > "${linkAt('.agents', name)}/SKILL.md"\n` +
      ['.claude', '.grok'].map((h) => `ln -s "../../.agents/skills/${name}" "${linkAt(h, name)}"`).join('\n'),
  );
}

function cliCopy(name) {
  writeSkill(linkAt('.agents', name), name);
  for (const harness of ['.claude', '.grok']) symlinkSync(`../../.agents/skills/${name}`, linkAt(harness, name));
}

function assertCliCopy(name) {
  assert.equal(lstatSync(linkAt('.agents', name)).isDirectory(), true, 'CLI directory in place');
  assert.equal(existsSync(path.join(linkAt('.agents', name), 'SKILL.md')), true, 'CLI files in place');
  for (const harness of ['.claude', '.grok']) assert.equal(readlinkSync(linkAt(harness, name)), `../../.agents/skills/${name}`, `CLI link in ${harness}`);
}

function install() {
  const env = { ...process.env, HOME: home, PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH}` };
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'GROK_HOME']) delete env[name];
  const result = spawnSync('bash', [path.join(repo, 'install-globally.sh')], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('skills are linked where the luxonis CLI installs, and not into the Codex or pi folders', () => {
  status();

  install();

  for (const harness of TARGETS) assert.equal(readlinkSync(linkAt(harness, 'mine')), skill('mine'), harness);
  assert.equal(existsSync(linkAt('.codex', 'mine')), false, 'Codex reads ~/.agents/skills');
  assert.equal(existsSync(linkAt(path.join('.pi', 'agent'), 'mine')), false, 'pi reads ~/.agents/skills');
});

test('old links in the Codex and pi folders are removed, and everything else there stays', () => {
  status();
  symlinkSync(skill('mine'), linkAt('.codex', 'mine'));
  symlinkSync(skill('mine'), linkAt(path.join('.pi', 'agent'), 'mine'));
  writeSkill(linkAt('.codex', 'shared'), 'shared');

  install();

  assert.equal(existsSync(linkAt('.codex', 'mine')), false);
  assert.equal(existsSync(linkAt(path.join('.pi', 'agent'), 'mine')), false);
  assert.equal(existsSync(path.join(linkAt('.codex', 'shared'), 'SKILL.md')), true, 'a copy this repo did not install stays');
});

test('a skill the luxonis CLI installed is not linked, and old links to this repo are removed', () => {
  status({ installed: ['shared'] });
  for (const harness of TARGETS) symlinkSync(skill('shared'), linkAt(harness, 'shared'));

  const { stdout } = install();

  for (const harness of TARGETS) assert.equal(existsSync(linkAt(harness, 'shared')), false, harness);
  assert.equal(readlinkSync(linkAt('.claude', 'mine')), skill('mine'), 'skills the CLI does not install are still linked');
  assert.equal(ticks(), 0, 'no sync needed');
  assert.match(stdout, /the Luxonis copy of shared is installed/);
});

test("a pack skill blocked by this repo's links is handed to the CLI, which installs its copy", () => {
  status({ conflicts: [blockedBy('shared')] });
  for (const harness of TARGETS) symlinkSync(skill('shared'), linkAt(harness, 'shared'));
  tickInstalls('shared');

  const { stdout } = install();

  assert.equal(ticks(), 1, 'luxonis tick ran');
  assertCliCopy('shared');
  assert.match(stdout, /shared: the Luxonis copy is installed/);
});

test('when the CLI still cannot install its copy, this repo links its own again', () => {
  status({ conflicts: [blockedBy('shared')], feed: 'unauthenticated' });
  for (const harness of TARGETS) symlinkSync(skill('shared'), linkAt(harness, 'shared'));

  const { stdout } = install();

  assert.equal(ticks(), 1);
  for (const harness of TARGETS) assert.equal(readlinkSync(linkAt(harness, 'shared')), skill('shared'), harness);
  assert.match(stdout, /still not installed, so this repo's copy is linked again/);
});

test('a duplicate-name conflict does not count as a block', () => {
  status({ conflicts: [blockedBy('shared', 'duplicate-pack-name')] });

  install();

  assert.equal(ticks(), 0);
  assert.equal(readlinkSync(linkAt('.claude', 'shared')), skill('shared'));
});

test("the CLI's copies are never replaced or doubled, whether or not luxonis answers", () => {
  cliCopy('shared');

  status({ installed: ['shared'] });
  install();
  assertCliCopy('shared');

  writeFileSync(path.join(state, 'status.json'), 'not json');
  writeFileSync(path.join(state, 'status-exit'), '1');
  const { stderr } = install();
  assertCliCopy('shared');
  assert.equal(existsSync(linkAt('.codex', 'shared')), false, 'no second copy for Codex');
  assert.equal(readlinkSync(linkAt('.claude', 'mine')), skill('mine'));
  assert.match(stderr, /not checked/);
});

test('an old link to this repo is recognised through a symlinked or relative path', () => {
  status({ installed: ['shared'] });
  const alias = path.join(home, 'repo-alias');
  symlinkSync(repo, alias);
  symlinkSync(path.join(alias, 'skills', 'shared'), linkAt('.claude', 'shared'));
  symlinkSync(path.relative(path.join(home, '.grok', 'skills'), skill('shared')), linkAt('.grok', 'shared'));

  install();

  assert.equal(existsSync(linkAt('.claude', 'shared')), false, 'link through a symlinked repo path removed');
  assert.equal(existsSync(linkAt('.grok', 'shared')), false, 'relative link removed');
});

test('a machine where the CLI installed nothing keeps its links, and a dangling link is repaired', () => {
  status();
  symlinkSync(skill('shared'), linkAt('.claude', 'shared'));
  symlinkSync(path.join(home, 'gone', 'mine'), linkAt('.claude', 'mine'));

  install();

  assert.equal(readlinkSync(linkAt('.claude', 'shared')), skill('shared'), 'existing link kept');
  assert.equal(readlinkSync(linkAt('.grok', 'shared')), skill('shared'), 'missing link added');
  assert.equal(readlinkSync(linkAt('.claude', 'mine')), skill('mine'), 'dangling link replaced');
});

test("a skills folder that is this repo's skills folder is left alone, and the other harnesses still get links", () => {
  status({ installed: ['shared'] });
  writeSkill(path.join(repo, 'vendor', 'shared'), 'shared');
  rmSync(skill('shared'), { recursive: true });
  symlinkSync('../vendor/shared', skill('shared'));
  rmSync(path.join(home, '.agents', 'skills'), { recursive: true });
  symlinkSync(path.join(repo, 'skills'), path.join(home, '.agents', 'skills'));

  install();

  assert.equal(readlinkSync(skill('shared')), '../vendor/shared', "the repo's own entry kept");
  assert.equal(readlinkSync(linkAt('.claude', 'mine')), skill('mine'), 'Claude Code still linked');
});

test('a dangling skills folder is skipped and the other harnesses still get links', () => {
  status();
  rmSync(path.join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(path.join(home, 'gone'), path.join(home, '.claude', 'skills'));

  install();

  assert.equal(readlinkSync(linkAt('.grok', 'mine')), skill('mine'));
});

test('a skill is matched to the CLI by the name in its SKILL.md, not its folder name', () => {
  writeSkill(path.join(repo, 'skills', 'tool'), 'shared-tool');
  status({ installed: ['shared-tool'] });
  symlinkSync(skill('tool'), linkAt('.claude', 'tool'));

  install();

  assert.equal(existsSync(linkAt('.claude', 'tool')), false);
});
