#!/usr/bin/env node
// Serves the design-sprint decisions page for one sprint directory and records the user's
// picks, re-prompts, answers and final answer to <sprint>/feedback.jsonl. Node built-ins only.
//
//   node serve.mjs --sprint .design-sprint/<slug> [--port 4390] [--files-port 4391]
//
// The page and its API run on --port; preview files run on --files-port, a separate origin.

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './entry.mjs';

const PAGE = fileURLToPath(new URL('../assets/decisions.html', import.meta.url));
const MAX_BODY = 64 * 1024;
const MAX_FIELD = 8000;
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
};
const ID = '[A-Za-z0-9._-]+';
const TARGETS = {
	pick: new RegExp(`^(direction|decision:${ID})$`),
	reprompt: new RegExp(`^(direction|sprint|variant:${ID}|decision:${ID})$`),
	answer: new RegExp(`^question:${ID}$`),
};
const OPTION_ID = new RegExp(`^${ID}$`);
const PRESENCE_FRESH_MS = 15_000;
const PRESENCE_WORKING_MS = 10 * 60_000;

/** Complete records only: a line still being appended is not valid JSON yet, so it is skipped until it is. */
export function readFeedback(sprintDir) {
	const file = join(sprintDir, 'feedback.jsonl');
	if (!existsSync(file)) return [];
	return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

/** Returns a normalized event or an error message. */
export function parseFeedback(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected a JSON object.';
	const event = { type: body.type };
	for (const key of ['target', 'option', 'text']) {
		if (body[key] === undefined || body[key] === null) continue;
		if (typeof body[key] !== 'string' || body[key].length > MAX_FIELD) return `${key} must be a string of at most ${MAX_FIELD} characters.`;
		event[key] = body[key];
	}
	switch (body.type) {
		case 'pick':
			if (!TARGETS.pick.test(event.target ?? '')) return 'A pick needs a target of direction or decision:<id>.';
			if (!new RegExp(`^${ID}$`).test(event.option ?? '')) return 'A pick needs an option id.';
			return event;
		case 'reprompt':
			if (!TARGETS.reprompt.test(event.target ?? '')) return 'A re-prompt needs a target of direction, sprint, variant:<id> or decision:<id>.';
			if (!event.text?.trim()) return 'A re-prompt needs text.';
			return event;
		case 'submit': {
			if (!event.text?.trim()) return 'A submission needs the answer text.';
			if (body.answers === undefined) return event;
			const answers = parseAnswers(body.answers);
			if (typeof answers === 'string') return answers;
			event.answers = answers;
			return event;
		}
		case 'answer': {
			if (!TARGETS.answer.test(event.target ?? '')) return 'An answer needs a target of question:<id>.';
			if (event.option !== undefined && !OPTION_ID.test(event.option)) return 'An answer option must be an id.';
			const text = event.text?.trim() ?? '';
			if (text) event.text = text;
			else delete event.text;
			if (!event.option && !event.text) return 'An answer needs an option id or text.';
			return event;
		}
		default:
			return 'type must be one of: pick, reprompt, answer, submit.';
	}
}

const MAX_ANSWERS = 20;

function parseAnswers(raw) {
	const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw) : null;
	if (!entries || entries.length > MAX_ANSWERS) return `answers must be an object of at most ${MAX_ANSWERS} questions.`;
	const answers = {};
	for (const [id, value] of entries) {
		if (!OPTION_ID.test(id)) return 'answers must be keyed by question id.';
		const option = value?.option;
		const text = typeof value?.text === 'string' ? value.text.trim() : value?.text;
		if (option !== undefined && (typeof option !== 'string' || !OPTION_ID.test(option))) return `The answer to ${id} needs an option id.`;
		if (text !== undefined && (typeof text !== 'string' || text.length > MAX_FIELD)) return `The answer to ${id} must be text of at most ${MAX_FIELD} characters.`;
		if (!option && !text) return `The answer to ${id} needs an option or text.`;
		answers[id] = { ...(option ? { option } : {}), ...(text ? { text } : {}) };
	}
	return answers;
}

function sprintId(root) {
	const file = join(root, '.sprint-id');
	try {
		return readFileSync(file, 'utf8').trim();
	} catch {
		const id = randomUUID();
		writeFileSync(file, id);
		return id;
	}
}

function asObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function timeMs(value) {
	if (typeof value !== 'string') return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

export function derivePresence({ listener, progress, sprintMtimeMs = null, now = Date.now() } = {}) {
	const listenerOk = asObject(listener);
	const progressOk = asObject(progress);
	const listenerAt = timeMs(listenerOk?.at);
	const progressAt = timeMs(progressOk?.at);
	const age = (ms) => (ms == null ? Infinity : now - ms);
	const fresh = (ms) => age(ms) <= PRESENCE_FRESH_MS;

	const listening = listenerOk?.listening === true && fresh(listenerAt);
	const running = Array.isArray(progressOk?.running) ? progressOk.running.filter((id) => typeof id === 'string' && id) : [];
	const finished = Array.isArray(progressOk?.finished)
		? progressOk.finished.filter((item) => asObject(item) && typeof item.id === 'string' && item.id).map(({ id, status }) => ({ id, status: typeof status === 'string' ? status : null }))
		: [];
	const building = fresh(progressAt) && running.length > 0 ? { running, finished } : null;
	const latest = [listenerAt, progressAt, sprintMtimeMs].filter((ms) => ms != null).reduce((max, ms) => Math.max(max, ms), -Infinity);
	const state = listening ? 'listening' : latest !== -Infinity && age(latest) <= PRESENCE_WORKING_MS ? 'working' : 'stalled';
	const seen = typeof listenerOk?.seen === 'number' && Number.isFinite(listenerOk.seen) ? listenerOk.seen : 0;
	const since = listening || listenerAt == null ? null : new Date(listenerAt).toISOString();
	return { state, seen, building, since };
}

function readOptionalJson(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
	res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
	res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
	return new Promise((resolveBody, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new Error('Body too large.'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/**
 * Only the page itself may write feedback. A JSON content type forces a CORS preflight that this
 * server never grants, the Origin must be this server, and the Host must be loopback (DNS rebinding).
 */
function rejectForeignWrite(req, port) {
	const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	if (!hosts.has(req.headers.host ?? '')) return 'Unexpected Host header.';
	const origin = req.headers.origin;
	if (origin !== undefined && !hosts.has(origin.replace(/^http:\/\//, ''))) return 'Cross-origin writes are not allowed.';
	if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return 'Content-Type must be application/json.';
	return null;
}

/** Resolves a /files/ path to a real file inside the sprint directory, following no symlink out of it. */
export function resolveSprintFile(root, requestPath) {
	const realRoot = realpathSync(root);
	const candidate = resolve(realRoot, requestPath);
	const inside = (file) => {
		const rel = relative(realRoot, file);
		return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
	};
	if (!inside(candidate) || !existsSync(candidate)) return { status: inside(candidate) ? 404 : 403 };
	const real = realpathSync(candidate);
	if (!inside(real)) return { status: 403 };
	if (!statSync(real).isFile()) return { status: 404 };
	return { status: 200, file: real };
}

function parseTarget(req) {
	try {
		return new URL(req.url ?? '/', 'http://localhost');
	} catch {
		return null;
	}
}

/**
 * The decisions page and its API. Preview files are not served here: they come from the files server
 * on another port, so preview code never shares the page's origin and cannot drive the page.
 */
export function createSprintServer(sprintDir, { filesOrigin, onDone } = {}) {
	const root = resolve(sprintDir);
	const id = sprintId(root);
	let doneServed = false;
	const server = createServer(async (req, res) => {
		try {
			const url = parseTarget(req);
			if (!url) return send(res, 400, { error: 'Malformed request target.' });
			if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
				res.setHeader('content-security-policy', "frame-ancestors 'none'");
				res.setHeader('x-frame-options', 'DENY');
				return send(res, 200, readFileSync(PAGE), MIME['.html']);
			}
			if (req.method === 'GET' && url.pathname === '/api/config') {
				return send(res, 200, { filesOrigin: filesOrigin ?? null, sprintId: id, maxText: MAX_FIELD });
			}
			if (req.method === 'GET' && url.pathname === '/api/state') {
				const manifest = join(root, 'sprint.json');
				let sprint;
				try {
					sprint = JSON.parse(readFileSync(manifest, 'utf8'));
				} catch (error) {
					if (error.code === 'ENOENT') return send(res, 404, { error: 'sprint.json not found.' });
					return send(res, 500, { error: 'sprint.json is not valid JSON.' });
				}
				if (sprint?.done && !doneServed) {
					doneServed = true;
					if (onDone) res.once('finish', onDone);
				}
				return send(res, 200, {
					sprint,
					feedback: readFeedback(root),
					agent: derivePresence({
						listener: readOptionalJson(join(root, 'listener.json')),
						progress: readOptionalJson(join(root, 'lanes', 'progress.json')),
						sprintMtimeMs: statSync(manifest, { throwIfNoEntry: false })?.mtimeMs ?? null,
					}),
				});
			}
			if (url.pathname === '/api/feedback') {
				if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
				const foreign = rejectForeignWrite(req, server.address().port);
				if (foreign) return send(res, 403, { error: foreign });
				let body;
				try {
					body = JSON.parse(await readBody(req));
				} catch {
					return send(res, 400, { error: 'Invalid JSON body.' });
				}
				const event = parseFeedback(body);
				if (typeof event === 'string') return send(res, 400, { error: event });
				const record = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), ...event };
				appendFileSync(join(root, 'feedback.jsonl'), `${JSON.stringify(record)}\n`);
				return send(res, 201, record);
			}
			return send(res, 404, { error: 'Not found.' });
		} catch (error) {
			return send(res, 500, { error: error.message });
		}
	});
	return server;
}

/** Read-only static server for preview files under /files/, on its own origin. */
export function createFilesServer(sprintDir) {
	const root = resolve(sprintDir);
	return createServer((req, res) => {
		try {
			const url = parseTarget(req);
			if (!url) return send(res, 400, { error: 'Malformed request target.' });
			if (req.method !== 'GET' || !url.pathname.startsWith('/files/')) return send(res, 404, { error: 'Not found.' });
			let requestPath;
			try {
				requestPath = decodeURIComponent(url.pathname.slice('/files/'.length));
			} catch {
				return send(res, 400, { error: 'Malformed path.' });
			}
			const { status, file } = resolveSprintFile(root, requestPath);
			if (status !== 200) return send(res, status, { error: status === 403 ? 'Outside the sprint directory.' : 'Not found.' });
			return send(res, 200, readFileSync(file), MIME[extname(file)] ?? 'application/octet-stream');
		} catch (error) {
			return send(res, 500, { error: error.message });
		}
	});
}

function listen(server, port) {
	return new Promise((resolveListen, reject) => {
		server.once('error', (error) => reject(error.code === 'EADDRINUSE' ? new Error(`Port ${port} is in use; pass --port or --files-port.`) : error));
		server.listen(port, '127.0.0.1', resolveListen);
	});
}

async function main() {
	const args = process.argv.slice(2);
	const value = (flag) => {
		const index = args.indexOf(flag);
		return index === -1 ? undefined : args[index + 1];
	};
	const sprint = value('--sprint');
	const port = Number(value('--port') ?? 4390);
	const filesPort = Number(value('--files-port') ?? port + 1);
	if (!sprint || !Number.isInteger(port) || !Number.isInteger(filesPort) || port === filesPort) {
		console.error('Usage: node serve.mjs --sprint <sprint-dir> [--port 4390] [--files-port <port + 1>]');
		process.exit(64);
	}
	if (!existsSync(join(sprint, 'sprint.json'))) {
		console.error(`No sprint.json in ${sprint}. Write the manifest before serving.`);
		process.exit(66);
	}
	try {
		await listen(createFilesServer(sprint), filesPort);
		const onDone = () => { console.log('The page has shown the done screen. Stopping.'); process.exit(0); };
		await listen(createSprintServer(sprint, { filesOrigin: `http://127.0.0.1:${filesPort}`, onDone }), port);
	} catch (error) {
		console.error(error.message);
		process.exit(69);
	}
	console.log(`Design sprint: http://127.0.0.1:${port}/`);
	console.log(`Preview files: http://127.0.0.1:${filesPort}/files/`);
	console.log(`Feedback log: ${join(resolve(sprint), 'feedback.jsonl')}`);
}

if (isMain(import.meta.url)) await main();
