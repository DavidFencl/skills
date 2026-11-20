// Tests for install-globally.sh. Run from the repository root:
//   node --test tests/install-globally.test.mjs
// Each test runs the real installer with HOME pointed at a scratch directory and a stand-in
// `luxonis` CLI first on PATH, because the real CLI reads the person's Knowledge packs.
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

function packList(packs) {
  fakeLuxonis(`cat <<'EOF'\n${JSON.stringify({ packs, installed: [] })}\nEOF`);
}

function install() {
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'GROK_HOME']) delete env[name];
  const result = spawnSync('bash', [INSTALLER], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const linkAt = (harness, name) => path.join(home, harness, 'skills', name);

test('a skill an enabled Luxonis pack provides is not linked, and the old link to this repo is removed', () => {
  packList([{ id: 'frontend', enabled: true, skills: ['ui-changelog'] }]);
  symlinkSync(skill('ui-changelog'), linkAt('.claude', 'ui-changelog'));

  const { stdout } = install();

  assert.equal(existsSync(linkAt('.claude', 'ui-changelog')), false, 'old link to this repo removed');
  assert.equal(existsSync(linkAt('.codex', 'ui-changelog')), false, 'never linked into another harness');
  assert.equal(readlinkSync(linkAt('.claude', 'design-sprint')), skill('design-sprint'), 'skills no pack provides are still linked');
  assert.match(stdout, /removed, the Luxonis pack's copy replaces it/);
});

test("the Luxonis CLI's own copy is left in place", () => {
  packList([{ id: 'frontend', enabled: true, skills: ['ui-changelog'] }]);
  const installed = linkAt('.agents', 'ui-changelog');
  mkdirSync(installed);
  writeFileSync(path.join(installed, 'SKILL.md'), '---\nname: ui-changelog\n---\n');

  install();

  assert.equal(lstatSync(installed).isDirectory(), true, 'CLI-installed directory kept');
  assert.equal(existsSync(path.join(installed, 'SKILL.md')), true, 'its files kept');
});

test('a skill in a pack that is off is still linked from this repo', () => {
  packList([{ id: 'frontend', enabled: false, skills: ['ui-changelog'] }]);

  install();

  assert.equal(readlinkSync(linkAt('.claude', 'ui-changelog')), skill('ui-changelog'));
});

test('a signed-out luxonis CLI links every skill and says the packs were not checked', () => {
  fakeLuxonis('exit 3');

  const { stderr } = install();

  assert.equal(readlinkSync(linkAt('.claude', 'ui-changelog')), skill('ui-changelog'));
  assert.match(stderr, /Luxonis pack skills are not checked/);
});
