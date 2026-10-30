#!/usr/bin/env node
// Runs design-sprint variant lanes on different models, each through its own CLI, in parallel.
// A model descriptor is `<cli>:<model>[@<effort>]`, e.g. `claude:opus@high`,
// `codex:gpt-6.1-sol@high`, `grok:grok-4.7`, `pi:openrouter/~google/gemini-pro-latest@high`.
// An empty model (`codex:`) uses that CLI's own default model.
//
//   node lanes.mjs roster [--cwd <project>]           print the models a sprint would use
//   node lanes.mjs run --sprint <dir> --plan <file> [--only A,C] [--timeout <seconds>]
//
// Node built-ins only.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIS = ['claude', 'codex', 'grok', 'pi'];

export function parseDescriptor(descriptor) {
	const colon = descriptor.indexOf(':');
	if (colon <= 0) throw new Error(`Model descriptor "${descriptor}" must look like <cli>:<model>[@<effort>].`);
	const cli = descriptor.slice(0, colon);
	if (!CLIS.includes(cli)) throw new Error(`Unknown CLI "${cli}" in "${descriptor}"; use one of ${CLIS.join(', ')}.`);
	let model = descriptor.slice(colon + 1);
	let effort;
	const at = model.lastIndexOf('@');
	if (at !== -1) {
		effort = model.slice(at + 1) || undefined;
		model = model.slice(0, at);
	}
	return { cli, model: model && model !== 'default' ? model : undefined, effort };
}

/** The headless command for one lane. Lanes may write files inside `cwd`; they must not start other agents. */
export function buildCommand({ cli, model, effort }, { prompt, promptFile, cwd, lastMessageFile }) {
	switch (cli) {
		case 'claude':
			return { command: 'claude', args: ['-p', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
				'--permission-mode', 'acceptEdits', '--no-session-persistence', prompt] };
		case 'codex':
			return { command: 'codex', args: ['exec', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
				'-s', 'workspace-write', '-C', cwd, '--skip-git-repo-check', '-o', lastMessageFile, prompt] };
		case 'grok':
			return { command: 'grok', args: ['--prompt-file', promptFile, ...(model ? ['-m', model] : []), ...(effort ? ['--reasoning-effort', effort] : []),
				'--permission-mode', 'auto', '--sandbox', 'workspace', '--no-subagents', '--cwd', cwd] };
		case 'pi':
			return { command: 'pi', args: ['-p', ...(model ? ['--model', model] : []), ...(effort ? ['--thinking', effort] : []),
				'--no-session', '--no-skills', prompt] };
		default:
			throw new Error(`Unknown CLI "${cli}".`);
	}
}

function readJson(file) {
	return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export function globalConfigPath(home = homedir(), env = process.env) {
	return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'design-sprint', 'config.json');
}

/**
 * Models come from the project's `.design-sprint/config.json`, else the global config, else one lane per
 * installed CLI on its default model. The parent harness may also build one variant itself.
 */
export function resolveRoster({ cwd = process.cwd(), home = homedir(), env = process.env, installed = installedClis } = {}) {
	const global = readJson(globalConfigPath(home, env));
	const project = readJson(join(cwd, '.design-sprint', 'config.json'));
	const config = { ...global, ...project };
	if (Array.isArray(config.models) && config.models.length) {
		config.models.forEach(parseDescriptor);
		return { source: project.models ? 'project' : 'global', ...config };
	}
	return { source: 'installed', ...config, models: installed().map((cli) => `${cli}:`) };
}

export function installedClis() {
	return CLIS.filter((cli) => spawnSync(cli, ['--version'], { stdio: 'ignore', timeout: 20_000 }).status === 0);
}

/** Cheap readiness check where the CLI has one; other CLIs report failures when the lane runs. */
function preflight({ cli, model }) {
	const version = spawnSync(cli, ['--version'], { encoding: 'utf8', timeout: 20_000 });
	if (version.error?.code === 'ENOENT' || version.status === null) return `${cli} is not installed.`;
	if (cli === 'pi' && model) {
		const check = spawnSync('pi', ['auth', 'check', '--model', model, '--json', '--no-refresh'], { encoding: 'utf8', timeout: 30_000 });
		try {
			const result = JSON.parse(check.stdout);
			if (result.status !== 'ready') return `pi cannot use ${model}: ${result.reason ?? result.status}.`;
		} catch {
			return `pi auth check failed: ${check.stderr || check.stdout}`.trim();
		}
	}
	return null;
}

export async function runLane(lane, { sprintDir, cwd, timeoutMs = 0, check = preflight, spawnImpl = spawn }) {
	const dir = join(sprintDir, 'lanes');
	mkdirSync(dir, { recursive: true });
	const descriptor = parseDescriptor(lane.model);
	const promptFile = resolve(sprintDir, lane.prompt);
	const files = {
		stdout: join(dir, `${lane.id}.stdout.txt`),
		stderr: join(dir, `${lane.id}.stderr.txt`),
		lastMessage: join(dir, `${lane.id}.last.txt`),
		receipt: join(dir, `${lane.id}.receipt.json`),
	};
	const started = Date.now();
	const receipt = { id: lane.id, model: lane.model, cli: descriptor.cli, cliModel: descriptor.model ?? null, effort: descriptor.effort ?? null, status: 'dropout', startedAt: new Date(started).toISOString() };
	const finish = (fields) => {
		Object.assign(receipt, fields, { elapsedMs: Date.now() - started });
		writeFileSync(files.receipt, `${JSON.stringify(receipt, null, '\t')}\n`);
		return receipt;
	};

	const problem = check(descriptor);
	if (problem) return finish({ reason: problem });
	const prompt = readFileSync(promptFile, 'utf8');
	const { command, args } = lane.command ?? buildCommand(descriptor, { prompt, promptFile, cwd, lastMessageFile: files.lastMessage });

	return new Promise((resolveLane) => {
		const child = spawnImpl(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		const out = [];
		const err = [];
		let timedOut = false;
		const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs) : null;
		child.stdout.on('data', (chunk) => out.push(chunk));
		child.stderr.on('data', (chunk) => err.push(chunk));
		child.on('error', (error) => {
			clearTimeout(timer);
			resolveLane(finish({ reason: error.code === 'ENOENT' ? `${command} is not installed.` : error.message }));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			const stdout = Buffer.concat(out).toString('utf8');
			writeFileSync(files.stdout, stdout);
			writeFileSync(files.stderr, Buffer.concat(err).toString('utf8'));
			if (!existsSync(files.lastMessage)) writeFileSync(files.lastMessage, stdout);
			if (timedOut) return resolveLane(finish({ exitCode: code, reason: `Timed out after ${timeoutMs / 1000}s.` }));
			if (code !== 0) return resolveLane(finish({ exitCode: code, reason: `Exited with ${code}; see ${files.stderr}.` }));
			resolveLane(finish({ status: 'complete', exitCode: 0, output: files.lastMessage }));
		});
	});
}

function option(args, flag) {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (command === 'roster') {
		console.log(JSON.stringify(resolveRoster({ cwd: resolve(option(args, '--cwd') ?? '.') }), null, 2));
		return;
	}
	if (command === 'run') {
		const sprintDir = option(args, '--sprint');
		const planFile = option(args, '--plan');
		if (!sprintDir || !planFile) throw new Error('Usage: node lanes.mjs run --sprint <dir> --plan <file> [--only A,C] [--timeout <seconds>]');
		const plan = JSON.parse(readFileSync(planFile, 'utf8'));
		const only = option(args, '--only')?.split(',');
		const lanes = plan.lanes.filter((lane) => !only || only.includes(lane.id));
		const cwd = resolve(dirname(planFile), plan.cwd ?? '.');
		const timeoutMs = Number(option(args, '--timeout') ?? 0) * 1000;
		const receipts = await Promise.all(lanes.map((lane) => runLane(lane, { sprintDir: resolve(sprintDir), cwd, timeoutMs })));
		console.log(JSON.stringify(receipts.map(({ id, model, status, reason, elapsedMs }) => ({ id, model, status, reason, elapsedMs })), null, 2));
		process.exitCode = receipts.some((receipt) => receipt.status === 'complete') ? 0 : 1;
		return;
	}
	throw new Error('Usage: node lanes.mjs roster [--cwd <dir>] | run --sprint <dir> --plan <file> [--only A,C] [--timeout <seconds>]');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 64;
	});
}
