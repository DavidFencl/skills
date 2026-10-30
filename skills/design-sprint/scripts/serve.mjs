#!/usr/bin/env node
// Serves the design-sprint decisions page for one sprint directory and records the user's
// picks, re-prompts and final answer to <sprint>/feedback.jsonl. Node built-ins only.
//
//   node serve.mjs --sprint .design-sprint/<slug> [--port 4390]

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../assets/decisions.html', import.meta.url));
const MAX_BODY = 64 * 1024;
const TYPES = new Set(['pick', 'reprompt', 'submit']);
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

export function readFeedback(sprintDir) {
	const file = join(sprintDir, 'feedback.jsonl');
	if (!existsSync(file)) return [];
	return readFileSync(file, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/** Returns a normalized event or an error message. */
export function parseFeedback(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected a JSON object.';
	if (!TYPES.has(body.type)) return `type must be one of: ${[...TYPES].join(', ')}.`;
	const event = { type: body.type };
	for (const key of ['target', 'option', 'text']) {
		if (body[key] === undefined || body[key] === null) continue;
		if (typeof body[key] !== 'string' || body[key].length > 8000) return `${key} must be a string.`;
		event[key] = body[key];
	}
	if (event.type === 'reprompt' && !event.text?.trim()) return 'A re-prompt needs text.';
	if (event.type === 'pick' && !event.target) return 'A pick needs a target.';
	return event;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
	res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
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

export function createSprintServer(sprintDir) {
	const root = resolve(sprintDir);
	return createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		try {
			if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
				return send(res, 200, readFileSync(PAGE), MIME['.html']);
			}
			if (req.method === 'GET' && url.pathname === '/api/sprint') {
				const manifest = join(root, 'sprint.json');
				if (!existsSync(manifest)) return send(res, 404, { error: 'sprint.json not found.' });
				return send(res, 200, readFileSync(manifest), MIME['.json']);
			}
			if (url.pathname === '/api/feedback') {
				if (req.method === 'GET') return send(res, 200, readFeedback(root));
				if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
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
			if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
				const file = resolve(root, decodeURIComponent(url.pathname.slice('/files/'.length)));
				const inside = relative(root, file);
				if (inside.startsWith('..') || inside.startsWith(sep) || inside === '') {
					return send(res, 403, { error: 'Outside the sprint directory.' });
				}
				if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Not found.' });
				return send(res, 200, readFileSync(file), MIME[extname(file)] ?? 'application/octet-stream');
			}
			return send(res, 404, { error: 'Not found.' });
		} catch (error) {
			return send(res, 500, { error: error.message });
		}
	});
}

function main() {
	const args = process.argv.slice(2);
	const value = (flag) => {
		const index = args.indexOf(flag);
		return index === -1 ? undefined : args[index + 1];
	};
	const sprint = value('--sprint');
	const port = Number(value('--port') ?? 4390);
	if (!sprint || !Number.isInteger(port)) {
		console.error('Usage: node serve.mjs --sprint <sprint-dir> [--port 4390]');
		process.exit(64);
	}
	if (!existsSync(join(sprint, 'sprint.json'))) {
		console.error(`No sprint.json in ${sprint}. Write the manifest before serving.`);
		process.exit(66);
	}
	const server = createSprintServer(sprint);
	server.on('error', (error) => {
		console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use; pass --port.` : error.message);
		process.exit(69);
	});
	server.listen(port, '127.0.0.1', () => {
		console.log(`Design sprint: http://127.0.0.1:${port}/`);
		console.log(`Feedback log: ${join(resolve(sprint), 'feedback.jsonl')}`);
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
