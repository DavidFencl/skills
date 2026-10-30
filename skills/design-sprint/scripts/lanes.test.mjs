import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCommand, parseDescriptor, resolveRoster, runLane } from './lanes.mjs';

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), 'design-sprint-lanes-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test('descriptors name a CLI, an optional model and an optional effort', () => {
	assert.deepEqual(parseDescriptor('claude:opus@high'), { cli: 'claude', model: 'opus', effort: 'high' });
	assert.deepEqual(parseDescriptor('codex:'), { cli: 'codex', model: undefined, effort: undefined });
	assert.deepEqual(parseDescriptor('pi:openrouter/~google/gemini-pro-latest@max'), { cli: 'pi', model: 'openrouter/~google/gemini-pro-latest', effort: 'max' });
	assert.deepEqual(parseDescriptor('grok:default'), { cli: 'grok', model: undefined, effort: undefined });
	assert.throws(() => parseDescriptor('opus'), /<cli>:<model>/);
	assert.throws(() => parseDescriptor('cursor:x'), /Unknown CLI/);
});

test('each CLI runs headless with write access confined to the project and no nested agents', () => {
	const context = { prompt: 'PROMPT', promptFile: '/s/A.prompt.md', cwd: '/repo', lastMessageFile: '/s/A.last.txt' };
	assert.deepEqual(buildCommand(parseDescriptor('claude:opus@high'), context), {
		command: 'claude', args: ['-p', '--model', 'opus', '--effort', 'high', '--permission-mode', 'acceptEdits', '--no-session-persistence', 'PROMPT'] });
	assert.deepEqual(buildCommand(parseDescriptor('codex:gpt-6.1-sol@xhigh'), context), {
		command: 'codex', args: ['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh', '-s', 'workspace-write', '-C', '/repo', '--skip-git-repo-check', '-o', '/s/A.last.txt', 'PROMPT'] });
	assert.deepEqual(buildCommand(parseDescriptor('grok:grok-4.7@high'), context), {
		command: 'grok', args: ['--prompt-file', '/s/A.prompt.md', '-m', 'grok-4.7', '--reasoning-effort', 'high', '--permission-mode', 'auto', '--sandbox', 'workspace', '--no-subagents', '--cwd', '/repo'] });
	assert.deepEqual(buildCommand(parseDescriptor('pi:'), context), { command: 'pi', args: ['-p', '--no-session', '--no-skills', 'PROMPT'] });
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

test('a lane records a receipt for completion, failure, timeout and a failed preflight', async (t) => {
	const sprintDir = tempDir(t);
	mkdirSync(join(sprintDir, 'lanes'));
	writeFileSync(join(sprintDir, 'lanes', 'A.prompt.md'), 'build variant A');
	const ready = () => null;
	const lane = (id, script) => ({ id, model: 'claude:opus@high', prompt: 'lanes/A.prompt.md', command: { command: process.execPath, args: ['-e', script] } });

	const done = await runLane(lane('A', 'console.log("{\\"label\\":\\"Flat\\"}")'), { sprintDir, cwd: sprintDir, check: ready });
	assert.equal(done.status, 'complete');
	assert.deepEqual([done.model, done.cli, done.cliModel, done.effort], ['claude:opus@high', 'claude', 'opus', 'high']);
	assert.match(readFileSync(done.output, 'utf8'), /"label":"Flat"/);
	assert.equal(JSON.parse(readFileSync(join(sprintDir, 'lanes', 'A.receipt.json'), 'utf8')).status, 'complete');

	const failed = await runLane(lane('B', 'console.error("quota"); process.exit(3)'), { sprintDir, cwd: sprintDir, check: ready });
	assert.equal(failed.status, 'dropout');
	assert.equal(failed.exitCode, 3);
	assert.match(readFileSync(join(sprintDir, 'lanes', 'B.stderr.txt'), 'utf8'), /quota/);

	const slow = await runLane(lane('C', 'setTimeout(() => {}, 10_000)'), { sprintDir, cwd: sprintDir, check: ready, timeoutMs: 200 });
	assert.equal(slow.status, 'dropout');
	assert.match(slow.reason, /Timed out/);

	const missing = await runLane(lane('D', ''), { sprintDir, cwd: sprintDir, check: () => 'claude is not installed.' });
	assert.deepEqual([missing.status, missing.reason], ['dropout', 'claude is not installed.']);
});
