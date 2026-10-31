#!/usr/bin/env node
// Serves the design-sprint decisions page for one sprint directory and records the user's
// picks, re-prompts and final answer to <sprint>/feedback.jsonl. Node built-ins only.
//
//   node serve.mjs --sprint .design-sprint/<slug> [--port 4390] [--files-port 4391]
//
// The page and its API run on --port; preview files run on --files-port, a separate origin.

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
};

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
		case 'submit':
			if (!event.text?.trim()) return 'A submission needs the answer text.';
			return event;
		default:
			return 'type must be one of: pick, reprompt, submit.';
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
export function createSprintServer(sprintDir, { filesOrigin } = {}) {
	const root = resolve(sprintDir);
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
				return send(res, 200, { filesOrigin: filesOrigin ?? null });
			}
			if (req.method === 'GET' && url.pathname === '/api/sprint') {
				const manifest = join(root, 'sprint.json');
				if (!existsSync(manifest)) return send(res, 404, { error: 'sprint.json not found.' });
				return send(res, 200, readFileSync(manifest), MIME['.json']);
			}
			if (url.pathname === '/api/feedback') {
				if (req.method === 'GET') return send(res, 200, readFeedback(root));
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
		await listen(createSprintServer(sprint, { filesOrigin: `http://127.0.0.1:${filesPort}` }), port);
	} catch (error) {
		console.error(error.message);
		process.exit(69);
	}
	console.log(`Design sprint: http://127.0.0.1:${port}/`);
	console.log(`Preview files: http://127.0.0.1:${filesPort}/files/`);
	console.log(`Feedback log: ${join(resolve(sprint), 'feedback.jsonl')}`);
}

if (isMain(import.meta.url)) await main();
