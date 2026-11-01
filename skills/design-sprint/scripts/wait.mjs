#!/usr/bin/env node
// Blocks until the user sends feedback the agent has to handle, then prints it as JSON:
//   { "count": <events handed to the caller>, "events": [ ...new events ] }
// listener.json remembers how many events it has handed out, so run the same command every time;
// --after overrides that count.
//
//   node wait.mjs --sprint .design-sprint/<slug> [--after <count>] [--timeout <seconds>]
//
// A decision pick does not wake the wait. It stays in the file and is returned with the next
// batch that does. Exit 0 with new events, 2 on timeout (count printed, events empty).

import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isMain } from './entry.mjs';
import { readFeedback } from './serve.mjs';

const needsAgent = (event) => !(event.type === 'pick' && event.target.startsWith('decision:'));

function writeJsonAtomic(directory, name, value) {
	const tmp = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(value)}\n`);
	renameSync(tmp, join(directory, name));
}

function lastSeen(sprintDir) {
	try {
		const { seen } = JSON.parse(readFileSync(join(sprintDir, 'listener.json'), 'utf8'));
		return Number.isInteger(seen) && seen >= 0 ? seen : 0;
	} catch {
		return 0;
	}
}

export async function waitForFeedback(sprintDir, {
	after,
	timeoutMs = 0,
	intervalMs = 500,
	now = () => Date.now(),
	presenceIntervalMs = 5000,
	coalesceMs = 300,
	handleSignals = false,
	sleep: sleepImpl = sleep,
} = {}) {
	const started = now();
	const baseline = after ?? lastSeen(sprintDir);
	let closed = false;
	const write = (listening, seen) => {
		writeJsonAtomic(sprintDir, 'listener.json', { listening, seen, at: new Date(now()).toISOString() });
	};
	const timers = [];
	const close = (seen) => {
		if (closed) return;
		closed = true;
		for (const timer of timers) clearInterval(timer);
		write(false, seen);
	};
	const onSignal = () => {
		close(baseline);
		process.exit(130);
	};
	if (handleSignals) {
		process.on('SIGINT', onSignal);
		process.on('SIGTERM', onSignal);
	}
	if (presenceIntervalMs > 0) {
		const timer = setInterval(() => { if (!closed) write(true, baseline); }, presenceIntervalMs);
		timer.unref();
		timers.push(timer);
	}
	try {
		write(true, baseline);
		for (;;) {
			const events = readFeedback(sprintDir);
			if (events.slice(baseline).some(needsAgent)) {
				await sleepImpl(coalesceMs);
				const again = readFeedback(sprintDir);
				close(again.length);
				return { count: again.length, events: again.slice(baseline) };
			}
			if (timeoutMs > 0 && now() - started >= timeoutMs) {
				close(baseline);
				return { count: baseline, events: [] };
			}
			await sleepImpl(intervalMs);
		}
	} finally {
		if (handleSignals) {
			process.off('SIGINT', onSignal);
			process.off('SIGTERM', onSignal);
		}
		if (!closed) close(baseline);
	}
}

async function main() {
	const args = process.argv.slice(2);
	const value = (flag) => {
		const index = args.indexOf(flag);
		return index === -1 ? undefined : args[index + 1];
	};
	const sprint = value('--sprint');
	const after = value('--after') === undefined ? undefined : Number(value('--after'));
	const timeout = Number(value('--timeout') ?? 0);
	if (!sprint || (after !== undefined && !Number.isInteger(after)) || !Number.isFinite(timeout)) {
		console.error('Usage: node wait.mjs --sprint <sprint-dir> [--after <count>] [--timeout <seconds>]');
		process.exit(64);
	}
	const result = await waitForFeedback(sprint, { after, timeoutMs: timeout * 1000, handleSignals: true });
	console.log(JSON.stringify(result, null, 2));
	process.exit(result.events.length ? 0 : 2);
}

if (isMain(import.meta.url)) await main();
