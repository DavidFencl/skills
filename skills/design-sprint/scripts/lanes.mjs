#!/usr/bin/env node
// Runs design-sprint variant lanes on different models, each through its own CLI, in parallel.
// A model descriptor is `<cli>:<model>[@<effort>]`, e.g. `claude:opus@high`,
// `codex:gpt-6.1-sol@high`, `grok:grok-4.7`, `pi:openrouter/~google/gemini-pro-latest@high`.
// An empty model (`codex:`) uses that CLI's own default model. `@<effort>` is read as an effort only
// when it names a known level, so model ids that contain `@` stay intact.
//
//   node lanes.mjs roster [--cwd <project>]           print the models a sprint would use
//   node lanes.mjs run --sprint <dir> --plan <file> [--only A,C] [--timeout <seconds>]
//
// Node built-ins only.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIS = ['claude', 'codex', 'grok', 'pi'];
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const KILL_GRACE_MS = 5000;
const DRAIN_MS = 2000;

export function parseDescriptor(descriptor) {
	const colon = descriptor.indexOf(':');
	if (colon <= 0) throw new Error(`Model descriptor "${descriptor}" must look like <cli>:<model>[@<effort>].`);
	const cli = descriptor.slice(0, colon);
	if (!CLIS.includes(cli)) throw new Error(`Unknown CLI "${cli}" in "${descriptor}"; use one of ${CLIS.join(', ')}.`);
	let model = descriptor.slice(colon + 1);
	let effort;
	const at = model.lastIndexOf('@');
	if (at !== -1 && EFFORTS.includes(model.slice(at + 1))) {
		effort = model.slice(at + 1);
		model = model.slice(0, at);
	}
	return { cli, model: model && model !== 'default' ? model : undefined, effort };
}

/**
 * The headless command for one lane. Codex and Grok run in their own workspace sandboxes, but MCP servers
 * configured for those CLIs still load and run outside the sandbox. Claude runs restricted: no
 * code-running tools, no user/project settings, no MCP servers, file tools confined to the working
 * directory. pi loses its shell and MCP tools but has no sandbox, so its file tools can write anywhere the
 * user can.
 */
export function buildCommand({ cli, model, effort }, { prompt, promptFile, cwd, lastMessageFile }) {
	switch (cli) {
		case 'claude':
			return { command: 'claude', args: ['-p', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
				'--permission-mode', 'acceptEdits', '--restricted', '--strict-mcp-config', '--no-session-persistence', prompt] };
		case 'codex':
			return { command: 'codex', args: ['exec', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
				'-s', 'workspace-write', '-C', cwd, '--skip-git-repo-check', '-o', lastMessageFile, prompt] };
		case 'grok':
			return { command: 'grok', args: ['--prompt-file', promptFile, ...(model ? ['-m', model] : []), ...(effort ? ['--reasoning-effort', effort] : []),
				'--permission-mode', 'auto', '--sandbox', 'workspace', '--no-subagents', '--cwd', cwd] };
		case 'pi':
			return { command: 'pi', args: ['-p', ...(model ? ['--model', model] : []), ...(effort ? ['--thinking', effort] : []),
				'--no-session', '--no-skills', '--no-mcp', '--exclude-tools', 'bash', prompt] };
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

const groups = new Set();
function killGroup(child, signal) {
	try {
		if (process.platform === 'win32') child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		// The group already exited.
	}
}

export async function runLane(lane, { sprintDir, cwd, timeoutMs = 0, check = preflight, spawnImpl = spawn, killGraceMs = KILL_GRACE_MS }) {
	const dir = join(sprintDir, 'lanes');
	mkdirSync(dir, { recursive: true });
	const descriptor = parseDescriptor(lane.model);
	const files = {
		stdout: join(dir, `${lane.id}.stdout.txt`),
		stderr: join(dir, `${lane.id}.stderr.txt`),
		lastMessage: join(dir, `${lane.id}.last.txt`),
		receipt: join(dir, `${lane.id}.receipt.json`),
	};
	for (const file of Object.values(files)) rmSync(file, { force: true });
	const started = Date.now();
	const receipt = { id: lane.id, model: lane.model, cli: descriptor.cli, cliModel: descriptor.model ?? null, effort: descriptor.effort ?? null,
		status: 'dropout', startedAt: new Date(started).toISOString() };
	const finish = (fields) => {
		Object.assign(receipt, fields, { elapsedMs: Date.now() - started });
		writeFileSync(files.receipt, `${JSON.stringify(receipt, null, '\t')}\n`);
		return receipt;
	};

	const promptFile = resolve(sprintDir, lane.promptFile ?? '');
	if (!lane.promptFile || !existsSync(promptFile)) return finish({ reason: `Prompt file not found: ${lane.promptFile ?? '(none)'}.` });
	const problem = check(descriptor);
	if (problem) return finish({ reason: problem });
	const prompt = readFileSync(promptFile, 'utf8');
	const { command, args } = lane.command ?? buildCommand(descriptor, { prompt, promptFile, cwd, lastMessageFile: files.lastMessage });

	return new Promise((resolveLane) => {
		const child = spawnImpl(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
		groups.add(child);
		const out = [];
		const err = [];
		let timedOut = false;
		let exitCode = null;
		let done = false;
		const timers = [];
		const settle = (fields) => {
			if (done) return;
			done = true;
			timers.forEach(clearTimeout);
			groups.delete(child);
			resolveLane(finish(fields));
		};
		const complete = () => {
			if (done) return;
			// Reap anything the lane left running, such as a dev server or a watcher.
			killGroup(child, 'SIGKILL');
			const stdout = Buffer.concat(out).toString('utf8');
			writeFileSync(files.stdout, stdout);
			writeFileSync(files.stderr, Buffer.concat(err).toString('utf8'));
			if (!existsSync(files.lastMessage)) writeFileSync(files.lastMessage, stdout);
			if (timedOut) return settle({ exitCode, reason: `Timed out after ${timeoutMs / 1000}s.` });
			if (exitCode !== 0) return settle({ exitCode, reason: `Exited with ${exitCode}; see ${files.stderr}.` });
			settle({ status: 'complete', exitCode: 0, output: files.lastMessage });
		};
		if (timeoutMs > 0) {
			timers.push(setTimeout(() => {
				timedOut = true;
				killGroup(child, 'SIGTERM');
				timers.push(setTimeout(() => killGroup(child, 'SIGKILL'), killGraceMs));
			}, timeoutMs));
		}
		child.stdout.on('data', (chunk) => out.push(chunk));
		child.stderr.on('data', (chunk) => err.push(chunk));
		child.on('error', (error) => settle({ reason: error.code === 'ENOENT' ? `${command} is not installed.` : error.message }));
		child.on('exit', (code, signal) => {
			exitCode = code ?? signal;
			// A grandchild may keep the pipes open after the lane exits; stop waiting for them.
			timers.push(setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				complete();
			}, DRAIN_MS));
		});
		child.on('close', complete);
	});
}

const sha1 = (data) => createHash('sha1').update(data).digest('hex');

/** A fingerprint of one changed path: file contents, a link target, or a nested repository's own state. */
function fingerprint(path) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		return 'deleted';
	}
	if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
	if (stat.isDirectory()) {
		// git lists a directory only for a nested repository or submodule; fingerprint its own changes.
		const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).stdout;
		return `dir:${sha1(`${head}\n${JSON.stringify(snapshotChanges(path))}`)}`;
	}
	return sha1(readFileSync(path));
}

/**
 * Fingerprints of the paths git reports as changed or untracked, so lanes' stray writes can be found.
 * Renames are reported as a deletion plus an addition, so a file moved into a lane's paths still shows
 * its original location as changed.
 */
export function snapshotChanges(cwd) {
	const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '-uall', '--no-renames', '--ignore-submodules=none'], { cwd, encoding: 'utf8' });
	if (status.status !== 0) return null;
	const snapshot = {};
	for (const entry of status.stdout.split('\0').filter(Boolean)) {
		const path = entry.slice(3).replace(/\/$/, '');
		snapshot[path] = fingerprint(join(cwd, path));
	}
	return snapshot;
}

/** Paths that changed during the run outside every lane's own paths and the sprint directory. */
export function outsideChanges(before, after, allowed) {
	const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
	const isAllowed = (path) => allowed.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
	return [...paths].filter((path) => before[path] !== after[path] && !isAllowed(path)).sort();
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
		for (const signal of ['SIGINT', 'SIGTERM']) {
			process.on(signal, () => {
				for (const child of groups) killGroup(child, 'SIGKILL');
				process.exit(130);
			});
		}
		const before = snapshotChanges(cwd);
		const receipts = await Promise.all(lanes.map((lane) => runLane(lane, { sprintDir: resolve(sprintDir), cwd, timeoutMs })));
		const after = snapshotChanges(cwd);
		const sprintPath = relative(cwd, resolve(sprintDir)).split(sep).join('/');
		const allowed = [sprintPath, ...plan.lanes.flatMap((lane) => lane.owns ?? [])];
		const stray = before && after ? outsideChanges(before, after, allowed) : null;
		writeFileSync(join(resolve(sprintDir), 'lanes', 'outside-changes.json'), `${JSON.stringify(stray, null, '\t')}\n`);
		console.log(JSON.stringify({
			lanes: receipts.map(({ id, model, status, reason, elapsedMs }) => ({ id, model, status, reason, elapsedMs })),
			outsideChanges: stray ?? 'not a git repository; changes outside lane paths were not checked',
		}, null, 2));
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
