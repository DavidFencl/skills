// Tests for install-globally.sh. Run from the repository root:
//   node --test tests/install-globally.test.mjs
// Each test runs the real installer with HOME pointed at a scratch directory and a stand-in
// `luxonis` CLI first on PATH, because the real CLI reads this machine's installed packs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'install-globally.sh');
const skill = (name) => path.join(ROOT, 'skills', name);

let home;
let bin;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'install-globally-test-'));
  bin = path.join(home, 'bin');
  mkdirSync(bin);
  for (const root of ['.agents', '.claude', '.codex']) mkdirSync(path.join(home, root, 'skills'), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function fakeLuxonis(script) {
  const file = path.join(bin, 'luxonis');
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
}

function status({ installed = [], conflicts = [] }) {
  const body = { account: 'local', installed: installed.map((name) => ({ packId: 'frontend', name })), conflicts };
  fakeLuxonis(`cat <<'EOF'\n${JSON.stringify(body)}\nEOF`);
}

function install() {
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'GROK_HOME']) delete env[name];
  const result = spawnSync('bash', [INSTALLER], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const linkAt = (harness, name) => path.join(home, harness, 'skills', name);

// What the luxonis CLI leaves on a machine: a real directory in ~/.agents/skills, and a relative
// link to it from Claude Code's folder.
function cliCopy(name) {
  const dir = linkAt('.agents', name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  symlinkSync(`../../.agents/skills/${name}`, linkAt('.claude', name));
}

function assertCliCopyKept(name) {
  assert.equal(lstatSync(linkAt('.agents', name)).isDirectory(), true, 'CLI directory kept');
  assert.equal(existsSync(path.join(linkAt('.agents', name), 'SKILL.md')), true, 'CLI files kept');
  assert.equal(readlinkSync(linkAt('.claude', name)), `../../.agents/skills/${name}`, 'CLI link kept');
}

test('a skill the luxonis CLI installed is not linked, and the old link to this repo is removed', () => {
  status({ installed: ['ui-changelog'] });
  symlinkSync(skill('ui-changelog'), linkAt('.codex', 'ui-changelog'));

  const { stdout } = install();

  assert.equal(existsSync(linkAt('.codex', 'ui-changelog')), false, 'old link to this repo removed');
  assert.equal(existsSync(linkAt('.claude', 'ui-changelog')), false, 'never linked');
  assert.equal(readlinkSync(linkAt('.claude', 'add-frontend')), skill('add-frontend'), 'skills the CLI does not install are still linked');
  assert.match(stdout, /removed, run luxonis tick to install the Luxonis copy/);
});

test("a pack skill blocked by this repo's link has the link removed, and a duplicate-name conflict does not count", () => {
  status({
    conflicts: [
      { packId: 'frontend', name: 'ui-changelog', reason: 'external-owner' },
      { packId: 'frontend', name: 'add-frontend', reason: 'duplicate-pack-name' },
    ],
  });
  symlinkSync(skill('ui-changelog'), linkAt('.claude', 'ui-changelog'));

  install();

  assert.equal(existsSync(linkAt('.claude', 'ui-changelog')), false, 'blocking link removed');
  assert.equal(readlinkSync(linkAt('.claude', 'add-frontend')), skill('add-frontend'), 'no pack copy is installed, so this repo keeps it');
});

test("the CLI's copies are never replaced, whether or not luxonis answers", () => {
  cliCopy('ui-changelog');

  status({ installed: ['ui-changelog'] });
  install();
  assertCliCopyKept('ui-changelog');

  fakeLuxonis('echo "not json"; exit 1');
  const { stderr } = install();
  assertCliCopyKept('ui-changelog');
  assert.match(stderr, /not checked/);
});

test('an old link to this repo is recognised through a symlinked or relative path', () => {
  status({ installed: ['ui-changelog'] });
  const alias = path.join(home, 'skills-alias');
  symlinkSync(ROOT, alias);
  symlinkSync(path.join(alias, 'skills', 'ui-changelog'), linkAt('.claude', 'ui-changelog'));
  symlinkSync(path.relative(path.join(home, '.codex', 'skills'), skill('ui-changelog')), linkAt('.codex', 'ui-changelog'));

  install();

  assert.equal(existsSync(linkAt('.claude', 'ui-changelog')), false, 'link through a symlinked repo path removed');
  assert.equal(existsSync(linkAt('.codex', 'ui-changelog')), false, 'relative link removed');
});

test('a machine where the CLI installed nothing keeps every link, and a dangling link is repaired', () => {
  status({});
  symlinkSync(path.join(home, 'gone', 'add-frontend'), linkAt('.claude', 'add-frontend'));

  install();

  assert.equal(readlinkSync(linkAt('.claude', 'ui-changelog')), skill('ui-changelog'));
  assert.equal(readlinkSync(linkAt('.claude', 'add-frontend')), skill('add-frontend'), 'dangling link replaced');
});
