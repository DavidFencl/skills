// Tests for install-globally.sh. Run from the repository root:
//   node --test tests/install-globally.test.mjs
// Each test copies the real installer into a scratch repo with two skills, points HOME at the
// scratch directory, and puts a stand-in `luxonis` CLI first on PATH, because the real CLI reads
// this machine's installed packs. `shared` is a skill a Luxonis pack also has; `mine` is not.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const INSTALLER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'install-globally.sh');

let home;
let repo;
let bin;

function writeSkill(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'install-globally-test-')));
  repo = path.join(home, 'repo');
  bin = path.join(home, 'bin');
  mkdirSync(bin);
  for (const name of ['shared', 'mine']) writeSkill(path.join(repo, 'skills', name), name);
  copyFileSync(INSTALLER, path.join(repo, 'install-globally.sh'));
  for (const root of ['.agents', '.claude', '.codex']) mkdirSync(path.join(home, root, 'skills'), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const skill = (name) => path.join(repo, 'skills', name);
const linkAt = (harness, name) => path.join(home, harness, 'skills', name);

function fakeLuxonis(script) {
  const file = path.join(bin, 'luxonis');
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
}

function status({ installed = [], conflicts = [], feed = 'enabled' } = {}) {
  const body = { account: 'local', installed: installed.map((name) => ({ packId: 'frontend', name })), conflicts, lastRun: { feed, conflicts } };
  fakeLuxonis(`cat <<'EOF'\n${JSON.stringify(body)}\nEOF`);
}

const blockedBy = (name, reason = 'external-owner') => ({ packId: 'frontend', name, reason });

function install() {
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'GROK_HOME']) delete env[name];
  const result = spawnSync('bash', [path.join(repo, 'install-globally.sh')], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

// What the luxonis CLI leaves on a machine: a real directory in ~/.agents/skills, and a relative
// link to it from Claude Code's folder.
function cliCopy(name) {
  writeSkill(linkAt('.agents', name), name);
  symlinkSync(`../../.agents/skills/${name}`, linkAt('.claude', name));
}

function assertCliCopyKept(name) {
  assert.equal(lstatSync(linkAt('.agents', name)).isDirectory(), true, 'CLI directory kept');
  assert.equal(existsSync(path.join(linkAt('.agents', name), 'SKILL.md')), true, 'CLI files kept');
  assert.equal(readlinkSync(linkAt('.claude', name)), `../../.agents/skills/${name}`, 'CLI link kept');
}

test('a skill the luxonis CLI installed is not linked, and the old link to this repo is removed', () => {
  status({ installed: ['shared'] });
  symlinkSync(skill('shared'), linkAt('.codex', 'shared'));

  const { stdout } = install();

  assert.equal(existsSync(linkAt('.codex', 'shared')), false, 'old link to this repo removed');
  assert.equal(existsSync(linkAt('.claude', 'shared')), false, 'never linked');
  assert.equal(readlinkSync(linkAt('.claude', 'mine')), skill('mine'), 'skills the CLI does not install are still linked');
  assert.match(stdout, /removed, the Luxonis copy is installed/);
});

test("a pack skill blocked only by this repo's links has them removed, and a duplicate-name conflict does not count", () => {
  status({ conflicts: [blockedBy('shared'), blockedBy('mine', 'duplicate-pack-name')] });
  symlinkSync(skill('shared'), linkAt('.claude', 'shared'));

  const { stdout } = install();

  assert.equal(existsSync(linkAt('.claude', 'shared')), false, 'blocking link removed');
  assert.equal(readlinkSync(linkAt('.claude', 'mine')), skill('mine'), 'no pack copy is installed, so this repo keeps it');
  assert.match(stdout, /run luxonis tick to install the Luxonis copy/);
});

test("this repo's links stay when another copy also keeps the Luxonis copy out", () => {
  status({ conflicts: [blockedBy('shared')] });
  writeSkill(path.join(home, 'other-checkout', 'skills', 'shared'), 'shared');
  symlinkSync(path.join(home, 'other-checkout', 'skills', 'shared'), linkAt('.agents', 'shared'));
  symlinkSync(skill('shared'), linkAt('.claude', 'shared'));

  const { stderr } = install();

  assert.equal(readlinkSync(linkAt('.claude', 'shared')), skill('shared'), "this repo's link kept");
  assert.equal(readlinkSync(linkAt('.agents', 'shared')), path.join(home, 'other-checkout', 'skills', 'shared'), 'the other copy kept');
  assert.match(stderr, /keeps the Luxonis copy out/);
});

test('conflicts kept from a signed-out sync do not remove links', () => {
  status({ conflicts: [blockedBy('shared')], feed: 'unauthenticated' });
  symlinkSync(skill('shared'), linkAt('.claude', 'shared'));

  install();

  assert.equal(readlinkSync(linkAt('.claude', 'shared')), skill('shared'));
});

test("the CLI's copies are never replaced or doubled, whether or not luxonis answers", () => {
  cliCopy('shared');

  status({ installed: ['shared'] });
  install();
  assertCliCopyKept('shared');

  fakeLuxonis('echo "not json"; exit 1');
  const { stderr } = install();
  assertCliCopyKept('shared');
  assert.equal(existsSync(linkAt('.codex', 'shared')), false, 'no second copy for Codex, which also reads ~/.agents/skills');
  assert.equal(readlinkSync(linkAt('.codex', 'mine')), skill('mine'));
  assert.match(stderr, /not checked/);
});

test('an old link to this repo is recognised through a symlinked or relative path', () => {
  status({ installed: ['shared'] });
  const alias = path.join(home, 'repo-alias');
  symlinkSync(repo, alias);
  symlinkSync(path.join(alias, 'skills', 'shared'), linkAt('.claude', 'shared'));
  symlinkSync(path.relative(path.join(home, '.codex', 'skills'), skill('shared')), linkAt('.codex', 'shared'));

  install();

  assert.equal(existsSync(linkAt('.claude', 'shared')), false, 'link through a symlinked repo path removed');
  assert.equal(existsSync(linkAt('.codex', 'shared')), false, 'relative link removed');
});

test('a machine where the CLI installed nothing keeps its links, and a dangling link is repaired', () => {
  status();
  symlinkSync(skill('shared'), linkAt('.claude', 'shared'));
  symlinkSync(path.join(home, 'gone', 'mine'), linkAt('.claude', 'mine'));

  install();

  assert.equal(readlinkSync(linkAt('.claude', 'shared')), skill('shared'), 'existing link kept');
  assert.equal(readlinkSync(linkAt('.codex', 'shared')), skill('shared'), 'missing link added');
  assert.equal(readlinkSync(linkAt('.claude', 'mine')), skill('mine'), 'dangling link replaced');
});

test("a harness whose skills folder is this repo's skills folder is left alone", () => {
  status({ installed: ['shared'] });
  writeSkill(path.join(repo, 'vendor', 'shared'), 'shared');
  rmSync(skill('shared'), { recursive: true });
  symlinkSync('../vendor/shared', skill('shared'));
  rmSync(path.join(home, '.codex', 'skills'), { recursive: true });
  symlinkSync(path.join(repo, 'skills'), path.join(home, '.codex', 'skills'));

  const { stdout } = install();

  assert.equal(readlinkSync(skill('shared')), '../vendor/shared', "the repo's own entry kept");
  assert.match(stdout, /is this repo's skills folder, skipped/);
});

test('a dangling harness skills folder is skipped and the other harnesses are still installed', () => {
  status();
  rmSync(path.join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(path.join(home, 'gone'), path.join(home, '.claude', 'skills'));

  install();

  assert.equal(readlinkSync(linkAt('.codex', 'mine')), skill('mine'));
});
