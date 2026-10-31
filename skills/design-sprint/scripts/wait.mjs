#!/usr/bin/env node
// Blocks until the user sends new design-sprint feedback, then prints it as JSON:
//   { "count": <total events>, "events": [ ...new events ] }
// Pass the last printed count as --after to wait for the next batch.
//
//   node wait.mjs --sprint .design-sprint/<slug> [--after <count>] [--timeout <seconds>]
//
// Exit 0 with new events, 2 on timeout (count printed, events empty).

import { setTimeout as sleep } from 'node:timers/promises';
import { isMain } from './entry.mjs';
import { readFeedback } from './serve.mjs';

export async function waitForFeedback(sprintDir, { after, timeoutMs = 0, intervalMs = 500 } = {}) {
	const start = Date.now();
	const baseline = after ?? readFeedback(sprintDir).length;
	for (;;) {
		const events = readFeedback(sprintDir);
		if (events.length > baseline) return { count: events.length, events: events.slice(baseline) };
		if (timeoutMs > 0 && Date.now() - start >= timeoutMs) return { count: events.length, events: [] };
		await sleep(intervalMs);
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
	const result = await waitForFeedback(sprint, { after, timeoutMs: timeout * 1000 });
	console.log(JSON.stringify(result, null, 2));
	process.exit(result.events.length ? 0 : 2);
}

if (isMain(import.meta.url)) await main();
