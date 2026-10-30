import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCommand, outsideChanges, parseDescriptor, resolveRoster, runLane, snapshotChanges } from './lanes.mjs';

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), 'design-sprint-lanes-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
const isAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test('descriptors name a CLI, an optional model and an optional known effort', () => {
	assert.deepEqual(parseDescriptor('claude:opus@high'), { cli: 'claude', model: 'opus', effort: 'high' });
	assert.deepEqual(parseDescriptor('codex:'), { cli: 'codex', model: undefined, effort: undefined });
	assert.deepEqual(parseDescriptor('codex:@low'), { cli: 'codex', model: undefined, effort: 'low' });
	assert.deepEqual(parseDescriptor('pi:openrouter/~google/gemini-pro-latest@max'), { cli: 'pi', model: 'openrouter/~google/gemini-pro-latest', effort: 'max' });
	assert.deepEqual(parseDescriptor('pi:provider/model@20250514'), { cli: 'pi', model: 'provider/model@20250514', effort: undefined });
	assert.deepEqual(parseDescriptor('pi:provider/model@20250514@high'), { cli: 'pi', model: 'provider/model@20250514', effort: 'high' });
	assert.deepEqual(parseDescriptor('pi:openai-codex/gpt-6.1-sol:high'), { cli: 'pi', model: 'openai-codex/gpt-6.1-sol:high', effort: undefined });
	assert.deepEqual(parseDescriptor('grok:default'), { cli: 'grok', model: undefined, effort: undefined });
	assert.throws(() => parseDescriptor('opus'), /<cli>:<model>/);
	assert.throws(() => parseDescriptor('cursor:x'), /Unknown CLI/);
});

test('each CLI runs headless with no shell outside a sandbox and no nested agents', () => {
	const context = { prompt: 'PROMPT', promptFile: '/s/A.prompt.md', cwd: '/repo', lastMessageFile: '/s/A.last.txt' };
	assert.deepEqual(buildCommand(parseDescriptor('claude:opus@high'), context), {
		command: 'claude', args: ['-p', '--model', 'opus', '--effort', 'high', '--permission-mode', 'acceptEdits', '--disallowedTools', 'Bash', '--no-session-persistence', 'PROMPT'] });
	assert.deepEqual(buildCommand(parseDescriptor('codex:gpt-6.1-sol@xhigh'), context), {
		command: 'codex', args: ['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh', '-s', 'workspace-write', '-C', '/repo', '--skip-git-repo-check', '-o', '/s/A.last.txt', 'PROMPT'] });
	assert.deepEqual(buildCommand(parseDescriptor('grok:grok-4.7@high'), context), {
		command: 'grok', args: ['--prompt-file', '/s/A.prompt.md', '-m', 'grok-4.7', '--reasoning-effort', 'high', '--permission-mode', 'auto', '--sandbox', 'workspace', '--no-subagents', '--cwd', '/repo'] });
	assert.deepEqual(buildCommand(parseDescriptor('pi:'), context), { command: 'pi', args: ['-p', '--no-session', '--no-skills', '--exclude-tools', 'bash', 'PROMPT'] });
});

test('the roster prefers the project config, then the global config, then installed CLIs', (t) => {
	const home = tempDir(t);
	const project = tempDir(t);
	const env = { XDG_CONFIG_HOME: join(home, 'config') };
	const installed = () => ['claude', 'codex'];
	assert.deepEqual(resolveRoster({ cwd: project, home, env, installed }), { source: 'installed', models: ['claude:', 'codex:'] });

	mkdirSync(join(home, 'config', 'design-sprint'), { recursive: true });
	writeFileSync(join(home, 'config', 'design-sprint', 'config.json'), JSON.stringify({ models: ['grok:grok-4.7'], blind: true }));
	assert.deepEqual(resolveRoster({ cwd: project, home, env, installed }), { source: 'global', models: ['grok:grok-4.7'], blind: true });

	mkdirSync(join(project, '.design-sprint'));
	writeFileSync(join(project, '.design-sprint', 'config.json'), JSON.stringify({ models: ['claude:opus', 'codex:gpt-6.1-sol'] }));
	assert.deepEqual(resolveRoster({ cwd: project, home, env, installed }), { source: 'project', models: ['claude:opus', 'codex:gpt-6.1-sol'], blind: true });

	writeFileSync(join(project, '.design-sprint', 'config.json'), JSON.stringify({ models: ['cursor:x'] }));
	assert.throws(() => resolveRoster({ cwd: project, home, env, installed }), /Unknown CLI/);
});

function laneSetup(t) {
	const sprintDir = tempDir(t);
	mkdirSync(join(sprintDir, 'lanes'));
	writeFileSync(join(sprintDir, 'lanes', 'A.prompt.md'), 'build variant A');
	const lane = (id, script) => ({ id, model: 'claude:opus@high', promptFile: 'lanes/A.prompt.md', command: { command: process.execPath, args: ['-e', script] } });
	return { sprintDir, lane, ready: () => null };
}

test('a lane records a receipt for completion, failure, a missing prompt and a failed preflight', async (t) => {
	const { sprintDir, lane, ready } = laneSetup(t);
	const done = await runLane(lane('A', 'console.log("{\\"label\\":\\"Flat\\"}")'), { sprintDir, cwd: sprintDir, check: ready });
	assert.equal(done.status, 'complete');
	assert.deepEqual([done.model, done.cli, done.cliModel, done.effort], ['claude:opus@high', 'claude', 'opus', 'high']);
	assert.match(readFileSync(done.output, 'utf8'), /"label":"Flat"/);
	assert.equal(JSON.parse(readFileSync(join(sprintDir, 'lanes', 'A.receipt.json'), 'utf8')).status, 'complete');

	const failed = await runLane(lane('B', 'console.error("quota"); process.exit(3)'), { sprintDir, cwd: sprintDir, check: ready });
	assert.deepEqual([failed.status, failed.exitCode], ['dropout', 3]);
	assert.match(readFileSync(join(sprintDir, 'lanes', 'B.stderr.txt'), 'utf8'), /quota/);

	const noPrompt = await runLane({ ...lane('C', ''), promptFile: 'lanes/missing.md' }, { sprintDir, cwd: sprintDir, check: ready });
	assert.deepEqual([noPrompt.status, noPrompt.reason], ['dropout', 'Prompt file not found: lanes/missing.md.']);

	const missing = await runLane(lane('D', ''), { sprintDir, cwd: sprintDir, check: () => 'claude is not installed.' });
	assert.deepEqual([missing.status, missing.reason], ['dropout', 'claude is not installed.']);
});

test('a rerun never reports the previous run’s message', async (t) => {
	const { sprintDir, lane, ready } = laneSetup(t);
	writeFileSync(join(sprintDir, 'lanes', 'A.last.txt'), 'stale report');
	const rerun = await runLane(lane('A', 'console.log("fresh report")'), { sprintDir, cwd: sprintDir, check: ready });
	assert.equal(readFileSync(rerun.output, 'utf8').trim(), 'fresh report');
});

test('a timeout kills a lane that ignores SIGTERM, and a finished lane’s leftovers are reaped', async (t) => {
	const { sprintDir, lane, ready } = laneSetup(t);
	const stubborn = await runLane(lane('A', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'),
		{ sprintDir, cwd: sprintDir, check: ready, timeoutMs: 200, killGraceMs: 200 });
	assert.equal(stubborn.status, 'dropout');
	assert.match(stubborn.reason, /Timed out/);

	const pidFile = join(sprintDir, 'grandchild.pid');
	const script = `const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
		require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); console.log("done"); process.exit(0);`;
	const leaky = await runLane(lane('B', script), { sprintDir, cwd: sprintDir, check: ready });
	assert.equal(leaky.status, 'complete');
	const grandchild = Number(readFileSync(pidFile, 'utf8'));
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(isAlive(grandchild), false);
});

test('changes outside every lane’s own paths are reported, including edits to already-dirty files', (t) => {
	const repo = tempDir(t);
	const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
	git('init', '-q');
	git('-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
	writeFileSync(join(repo, 'dirty.txt'), 'user work');
	mkdirSync(join(repo, 'src', 'variant-A'), { recursive: true });
	const before = snapshotChanges(repo);

	writeFileSync(join(repo, 'src', 'variant-A', 'index.tsx'), 'lane A');
	writeFileSync(join(repo, 'dirty.txt'), 'changed by a lane');
	writeFileSync(join(repo, 'stray.txt'), 'new file');
	mkdirSync(join(repo, '.design-sprint', 's', 'lanes'), { recursive: true });
	writeFileSync(join(repo, '.design-sprint', 's', 'lanes', 'A.receipt.json'), '{}');
	const after = snapshotChanges(repo);

	assert.deepEqual(outsideChanges(before, after, ['.design-sprint/s', 'src/variant-A']), ['dirty.txt', 'stray.txt']);
	assert.equal(snapshotChanges(tempDir(t)), null);
	assert.ok(existsSync(join(repo, 'dirty.txt')));
});
