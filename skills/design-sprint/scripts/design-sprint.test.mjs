import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFilesServer, createSprintServer, derivePresence, parseFeedback, readFeedback } from './serve.mjs';
import { waitForFeedback } from './wait.mjs';

const example = fileURLToPath(new URL('../assets/example-sprint.json', import.meta.url));

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), 'design-sprint-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function sprintDir(t, withManifest = true) {
	const dir = tempDir(t);
	if (withManifest) copyFileSync(example, join(dir, 'sprint.json'));
	return dir;
}

async function listen(t, server) {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	return server.address().port;
}

/** The page server and the separate preview-files server, as serve.mjs runs them. */
async function serve(t, dir) {
	const filesPort = await listen(t, createFilesServer(dir));
	const filesOrigin = `http://127.0.0.1:${filesPort}`;
	const port = await listen(t, createSprintServer(dir, { filesOrigin }));
	const base = `http://127.0.0.1:${port}`;
	const request = (path, init) => fetch(`${base}${path}`, init);
	// fetch normalizes paths and controls some headers, so probes go through node:http unchanged.
	request.raw = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
		const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on('error', reject);
		req.end(body);
	});
	request.port = port;
	request.filesOrigin = filesOrigin;
	request.files = (path) => fetch(`${filesOrigin}${path}`);
	request.filesRaw = (path) => new Promise((resolve, reject) => {
		httpRequest({ host: '127.0.0.1', port: filesPort, path }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
	});
	return request;
}

const postJson = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('feedback validation requires each event type’s fields and allowed targets', () => {
	assert.deepEqual(parseFeedback({ type: 'pick', target: 'direction', option: 'keep' }), { type: 'pick', target: 'direction', option: 'keep' });
	assert.deepEqual(parseFeedback({ type: 'pick', target: 'decision:1', option: '1-keep' }), { type: 'pick', target: 'decision:1', option: '1-keep' });
	assert.deepEqual(parseFeedback({ type: 'reprompt', target: 'variant:A', text: 'denser' }), { type: 'reprompt', target: 'variant:A', text: 'denser' });
	assert.deepEqual(parseFeedback({ type: 'submit', text: 'Direction A, 1: keep' }), { type: 'submit', text: 'Direction A, 1: keep' });
	assert.deepEqual(parseFeedback({ type: 'answer', target: 'question:q1', option: 'yes' }), { type: 'answer', target: 'question:q1', option: 'yes' });
	assert.deepEqual(parseFeedback({ type: 'answer', target: 'question:q1', text: '  because  ' }), { type: 'answer', target: 'question:q1', text: 'because' });
	assert.deepEqual(parseFeedback({ type: 'answer', target: 'question:implement', option: 'later', text: 'next week' }), { type: 'answer', target: 'question:implement', option: 'later', text: 'next week' });
	assert.match(parseFeedback({ type: 'delete' }), /type must be/);
	assert.match(parseFeedback({ type: 'answer', target: 'direction', option: 'yes' }), /question:<id>/);
	assert.match(parseFeedback({ type: 'answer', target: 'question:q1' }), /option id or text/);
	assert.match(parseFeedback({ type: 'answer', target: 'question:q1', text: '   ' }), /option id or text/);
	assert.match(parseFeedback({ type: 'answer', target: 'question:q1', option: 'bad id', text: 'because' }), /option must be an id/);
	assert.match(parseFeedback({ type: 'submit' }), /needs the answer/);
	assert.match(parseFeedback({ type: 'pick', target: 'direction' }), /needs an option/);
	assert.match(parseFeedback({ type: 'pick', target: 'variant:A', option: 'A' }), /target of direction/);
	assert.match(parseFeedback({ type: 'reprompt', text: 'denser' }), /needs a target/);
	assert.match(parseFeedback({ type: 'reprompt', target: 'variant:A', text: '  ' }), /needs text/);
	assert.match(parseFeedback({ type: 'pick', target: 3 }), /target must be a string/);
	assert.match(parseFeedback([]), /JSON object/);
});

test('the server serves the page and the manifest, and reports a missing manifest', async (t) => {
	const request = await serve(t, sprintDir(t));
	const page = await request('/');
	assert.equal(page.status, 200);
	assert.match(await page.text(), /Do nothing/);
	assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'none'");
	const config = await (await request('/api/config')).json();
	assert.equal(config.filesOrigin, request.filesOrigin);
	assert.match(config.sprintId, /^[0-9a-f-]{36}$/);
	assert.equal(config.maxText, 8000);
	const state = await request('/api/state');
	const body = await state.json();
	assert.deepEqual(Object.keys(body).sort(), ['agent', 'feedback', 'sprint']);
	assert.equal(body.sprint.title, 'Organizer applications list');
	assert.deepEqual(body.feedback, []);
	assert.deepEqual(Object.keys(body.agent).sort(), ['building', 'seen', 'since', 'state']);
	assert.equal((await request('/api/sprint')).status, 404);

	const empty = await serve(t, sprintDir(t, false));
	assert.equal((await empty('/api/state')).status, 404);
});

test('feedback is appended with an id and timestamp, and invalid bodies are rejected', async (t) => {
	const dir = sprintDir(t);
	const request = await serve(t, dir);
	const created = await request('/api/feedback', postJson({ type: 'reprompt', target: 'direction', text: 'try a calendar view' }));
	assert.equal(created.status, 201);
	const record = await created.json();
	assert.match(record.id, /^[0-9a-f]{8}$/);
	assert.ok(!Number.isNaN(Date.parse(record.at)));
	assert.deepEqual(readFeedback(dir), [record]);
	assert.deepEqual((await (await request('/api/state')).json()).feedback, [record]);
	assert.equal((await request('/api/feedback')).status, 405);

	assert.equal((await request('/api/feedback', { ...postJson({}), body: '{not json' })).status, 400);
	assert.equal((await request('/api/feedback', postJson({ type: 'reprompt', target: 'direction' }))).status, 400);
	assert.equal((await request('/api/feedback', { method: 'DELETE' })).status, 405);
	assert.equal(readFeedback(dir).length, 1);
});

test('only the page itself can write feedback: JSON content type, own origin, loopback host', async (t) => {
	const dir = sprintDir(t);
	const request = await serve(t, dir);
	const body = JSON.stringify({ type: 'submit', text: 'Direction A' });
	const own = `http://127.0.0.1:${request.port}`;
	assert.equal(await request.raw('/api/feedback', { method: 'POST', body, headers: { 'content-type': 'text/plain' } }), 403);
	assert.equal(await request.raw('/api/feedback', { method: 'POST', body, headers: { 'content-type': 'application/json', origin: 'https://evil.example' } }), 403);
	assert.equal(await request.raw('/api/feedback', { method: 'POST', body, headers: { 'content-type': 'application/json', origin: 'null' } }), 403);
	assert.equal(await request.raw('/api/feedback', { method: 'POST', body, headers: { 'content-type': 'application/json', host: `evil.example:${request.port}` } }), 403);
	assert.equal(await request.raw('/api/feedback', { method: 'POST', body, headers: { 'content-type': 'application/json', origin: request.filesOrigin } }), 403);
	assert.equal(readFeedback(dir).length, 0);
	assert.equal(await request.raw('/api/feedback', { method: 'POST', body, headers: { 'content-type': 'application/json', origin: own } }), 201);
	assert.equal(readFeedback(dir).length, 1);
});

test('preview files come only from the separate files origin, never from the page origin', async (t) => {
	const dir = sprintDir(t);
	writeFileSync(join(dir, 'a.html'), '<script>parent.document.title = "x"</script>');
	const request = await serve(t, dir);
	assert.equal((await request('/files/a.html')).status, 404);
	assert.equal((await request.files('/files/a.html')).status, 200);
	assert.equal((await request.files('/api/state')).status, 404);
	assert.equal((await request.files('/')).status, 404);
});

test('files are served only from inside the sprint directory, symlinks included', async (t) => {
	const dir = sprintDir(t);
	const outside = tempDir(t);
	writeFileSync(join(outside, 'secret.txt'), 'secret');
	writeFileSync(join(dir, 'a.html'), '<p>variant a</p>');
	mkdirSync(join(dir, '..notes'));
	writeFileSync(join(dir, '..notes', 'n.txt'), 'note');
	symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));
	symlinkSync(outside, join(dir, 'linked-dir'));
	const request = await serve(t, dir);
	assert.equal(await (await request.files('/files/a.html')).text(), '<p>variant a</p>');
	assert.equal(await (await request.files('/files/..notes/n.txt')).text(), 'note');
	assert.equal(await request.filesRaw('/files/..%2f..%2fetc%2fpasswd'), 403);
	assert.equal(await request.filesRaw('/files/%2fetc%2fpasswd'), 403);
	assert.equal(await request.filesRaw('/files/link.txt'), 403);
	assert.equal(await request.filesRaw('/files/linked-dir/secret.txt'), 403);
	assert.equal((await request.files('/files/missing.png')).status, 404);
});

test('malformed request targets get 400 and leave the server running', async (t) => {
	const request = await serve(t, sprintDir(t));
	assert.equal(await request.raw('http://['), 400);
	assert.equal(await request.filesRaw('http://['), 400);
	assert.equal(await request.filesRaw('/files/%E0%A4%A'), 400);
	assert.equal((await request('/api/state')).status, 200);
});

test('a half-written feedback line is ignored until its newline arrives', (t) => {
	const dir = sprintDir(t);
	const first = { id: 'a', type: 'pick', target: 'direction', option: 'A' };
	writeFileSync(join(dir, 'feedback.jsonl'), `${JSON.stringify(first)}\n{"id":"b","type":"sub`);
	assert.deepEqual(readFeedback(dir), [first]);
	appendFileSync(join(dir, 'feedback.jsonl'), 'mit","text":"Direction A"}\n');
	assert.deepEqual(readFeedback(dir).map((event) => event.id), ['a', 'b']);
});

test('wait resolves with only the events after the given count, or times out empty', async (t) => {
	const dir = sprintDir(t);
	writeFileSync(join(dir, 'feedback.jsonl'), `${JSON.stringify({ id: 'a', type: 'pick', target: 'direction', option: 'A' })}\n`);
	const pending = waitForFeedback(dir, { after: 1, intervalMs: 20 });
	setTimeout(() => {
		writeFileSync(join(dir, 'feedback.jsonl'), `${JSON.stringify({ id: 'a', type: 'pick', target: 'direction', option: 'A' })}\n${JSON.stringify({ id: 'b', type: 'submit', text: 'Direction A' })}\n`);
	}, 60);
	const result = await pending;
	assert.equal(result.count, 2);
	assert.deepEqual(result.events.map((event) => event.id), ['b']);

	const idle = await waitForFeedback(dir, { after: 2, timeoutMs: 80, intervalMs: 20 });
	assert.deepEqual(idle, { count: 2, events: [] });
});

test('wait without --after starts from what it last handed out, and from the beginning on the first call', async (t) => {
	const dir = sprintDir(t);
	const line = (event) => `${JSON.stringify(event)}\n`;
	writeFileSync(join(dir, 'feedback.jsonl'), line({ id: 'q', type: 'answer', target: 'question:outside', text: 'Keep them' }));
	const first = await waitForFeedback(dir, { timeoutMs: 1000, intervalMs: 20, coalesceMs: 10, presenceIntervalMs: 0 });
	assert.deepEqual(first.events.map((event) => event.id), ['q'], 'an event sent before the first wait is still handed over');
	assert.equal(JSON.parse(readFileSync(join(dir, 'listener.json'), 'utf8')).seen, 1);
	appendFileSync(join(dir, 'feedback.jsonl'), line({ id: 'r', type: 'reprompt', target: 'direction', text: 'a calendar' }));
	const second = await waitForFeedback(dir, { timeoutMs: 1000, intervalMs: 20, coalesceMs: 10, presenceIntervalMs: 0 });
	assert.deepEqual(second.events.map((event) => event.id), ['r'], 'nothing is handed over twice');
});

test('a submit carries the answers to the review questions, and bad answers reject the whole submit', () => {
	assert.deepEqual(parseFeedback({ type: 'submit', text: 'Direction A', answers: { implement: { option: 'later' }, why: { text: ' keyboard ' } } }),
		{ type: 'submit', text: 'Direction A', answers: { implement: { option: 'later' }, why: { text: 'keyboard' } } });
	assert.match(parseFeedback({ type: 'submit', text: 'Direction A', answers: { implement: { option: 'not an id' } } }), /needs an option id/);
	assert.match(parseFeedback({ type: 'submit', text: 'Direction A', answers: { implement: {} } }), /needs an option or text/);
	assert.match(parseFeedback({ type: 'submit', text: 'Direction A', answers: { 'bad id': { option: 'x' } } }), /keyed by question id/);
	assert.match(parseFeedback({ type: 'submit', text: 'Direction A', answers: [] }), /must be an object/);
	assert.match(parseFeedback({ type: 'submit', text: 'Direction A', answers: { why: { text: 'x'.repeat(8001) } } }), /at most 8000/);
});

test('each sprint directory keeps one sprint id, and the server reports when the page has been served done', async (t) => {
	const dir = sprintDir(t);
	const first = await (await (await serve(t, dir))('/api/config')).json();
	const again = await (await (await serve(t, dir))('/api/config')).json();
	const other = await (await (await serve(t, sprintDir(t)))('/api/config')).json();
	assert.equal(first.sprintId, again.sprintId);
	assert.notEqual(first.sprintId, other.sprintId);

	let done = 0;
	const server = createSprintServer(dir, { onDone: () => { done += 1; } });
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	const state = () => fetch(`http://127.0.0.1:${server.address().port}/api/state`);
	await state();
	assert.equal(done, 0);
	const manifest = JSON.parse(readFileSync(join(dir, 'sprint.json'), 'utf8'));
	writeFileSync(join(dir, 'sprint.json'), JSON.stringify({ ...manifest, done: { message: 'Recorded.' } }));
	await state();
	await state();
	assert.equal(done, 1, 'onDone runs once, after the page fetched the done state');
});

test('presence is listening while a listener is fresh, working when it is stale, and building while lanes run', async (t) => {
	const dir = sprintDir(t);
	const request = await serve(t, dir);
	const at = new Date().toISOString();
	writeFileSync(join(dir, 'listener.json'), JSON.stringify({ listening: true, seen: 2, at }));
	let agent = (await (await request('/api/state')).json()).agent;
	assert.equal(agent.state, 'listening');
	assert.equal(agent.seen, 2);
	assert.equal(agent.since, null);
	assert.equal(agent.building, null);

	const stale = new Date(Date.now() - 30_000).toISOString();
	writeFileSync(join(dir, 'listener.json'), JSON.stringify({ listening: true, seen: 3, at: stale }));
	agent = (await (await request('/api/state')).json()).agent;
	assert.equal(agent.state, 'working');
	assert.equal(agent.seen, 3);
	assert.equal(agent.since, stale);
	assert.equal(agent.building, null);

	mkdirSync(join(dir, 'lanes'));
	writeFileSync(join(dir, 'lanes', 'progress.json'), JSON.stringify({ running: ['D'], finished: [{ id: 'A', status: 'complete' }], at }));
	agent = (await (await request('/api/state')).json()).agent;
	assert.equal(agent.state, 'working');
	assert.deepEqual(agent.building, { running: ['D'], finished: [{ id: 'A', status: 'complete' }] });

	writeFileSync(join(dir, 'listener.json'), JSON.stringify({ listening: true, seen: 4, at }));
	agent = (await (await request('/api/state')).json()).agent;
	assert.equal(agent.state, 'listening');
	assert.deepEqual(agent.building.running, ['D']);
	assert.equal(agent.since, null);

	writeFileSync(join(dir, 'listener.json'), '{');
	writeFileSync(join(dir, 'lanes', 'progress.json'), '{');
	agent = (await (await request('/api/state')).json()).agent;
	assert.equal(agent.state, 'working');
	assert.equal(agent.seen, 0);
	assert.equal(agent.building, null);

	const old = new Date(Date.now() - 11 * 60_000);
	utimesSync(join(dir, 'sprint.json'), old, old);
	agent = (await (await request('/api/state')).json()).agent;
	assert.equal(agent.state, 'stalled');
	assert.equal(agent.since, null);
});

test('derivePresence applies the fresh and working windows and ignores malformed input', () => {
	const now = 1_700_000_000_000;
	const iso = (delta) => new Date(now + delta).toISOString();
	assert.deepEqual(derivePresence({ listener: { listening: true, seen: 4, at: iso(0) }, progress: null, sprintMtimeMs: null, now }), {
		state: 'listening', seen: 4, building: null, since: null,
	});
	assert.equal(derivePresence({ listener: { listening: true, seen: 1, at: iso(-15_000) }, now }).state, 'listening');
	assert.equal(derivePresence({ listener: { listening: true, seen: 1, at: iso(-15_001) }, sprintMtimeMs: now, now }).state, 'working');
	assert.equal(derivePresence({ listener: { listening: false, seen: 2, at: iso(-1000) }, sprintMtimeMs: now - 9 * 60_000, now }).state, 'working');
	assert.equal(derivePresence({ listener: { listening: false, seen: 2, at: iso(-1000) }, sprintMtimeMs: now, now }).since, iso(-1000));
	assert.equal(derivePresence({ sprintMtimeMs: now - 10 * 60_000, now }).state, 'working');
	assert.equal(derivePresence({ sprintMtimeMs: now - 10 * 60_000 - 1, now }).state, 'stalled');
	const alongside = derivePresence({
		listener: { listening: true, seen: 0, at: iso(0) },
		progress: { running: ['D'], finished: [{ id: 'C', status: 'complete' }], at: iso(-1000) },
		now,
	});
	assert.equal(alongside.state, 'listening');
	assert.deepEqual(alongside.building, { running: ['D'], finished: [{ id: 'C', status: 'complete' }] });
	assert.equal(derivePresence({
		listener: { listening: true, seen: 0, at: iso(0) },
		progress: { running: ['D'], finished: [], at: iso(-15_001) },
		now,
	}).building, null);
	assert.deepEqual(derivePresence({ listener: 'nope', progress: [], now }), {
		state: 'stalled', seen: 0, building: null, since: null,
	});
	assert.equal(derivePresence({ listener: { listening: true, at: iso(0) }, now }).seen, 0);
});

const appendEvent = (dir, event) => appendFileSync(join(dir, 'feedback.jsonl'), `${JSON.stringify(event)}\n`);

test('wait writes listener presence, holds decision picks, and batches an answer with the submit', async (t) => {
	const dir = sprintDir(t);
	let settled = false;
	const pending = waitForFeedback(dir, { after: 0, intervalMs: 20, coalesceMs: 300, presenceIntervalMs: 40 }).then((result) => {
		settled = true;
		return result;
	});
	await sleep(50);
	const listening = JSON.parse(readFileSync(join(dir, 'listener.json'), 'utf8'));
	assert.equal(listening.listening, true);
	assert.equal(listening.seen, 0);
	const firstAt = listening.at;

	appendEvent(dir, { id: 'pick', type: 'pick', target: 'decision:1', option: '1a' });
	await sleep(120);
	assert.equal(settled, false, 'a decision pick alone does not wake the wait');
	let refreshed = firstAt;
	for (let attempt = 0; attempt < 20 && refreshed === firstAt; attempt += 1) {
		await sleep(30);
		refreshed = JSON.parse(readFileSync(join(dir, 'listener.json'), 'utf8')).at;
	}
	assert.notEqual(refreshed, firstAt, 'listener.at refreshes while the wait is blocked');

	appendEvent(dir, { id: 'answer', type: 'answer', target: 'question:implement', option: 'later' });
	await sleep(100);
	appendEvent(dir, { id: 'submit', type: 'submit', text: 'Direction B, 1a' });
	const result = await pending;
	assert.equal(settled, true);
	assert.equal(result.count, 3);
	assert.deepEqual(result.events.map((event) => event.id), ['pick', 'answer', 'submit']);
	const idle = JSON.parse(readFileSync(join(dir, 'listener.json'), 'utf8'));
	assert.equal(idle.listening, false);
	assert.equal(idle.seen, 3);
});

test('a timeout does not consume a decision pick, so the next waking event returns it', async (t) => {
	const dir = sprintDir(t);
	const pending = waitForFeedback(dir, { after: 0, timeoutMs: 180, intervalMs: 20, coalesceMs: 40, presenceIntervalMs: 0 });
	setTimeout(() => appendEvent(dir, { id: 'pick', type: 'pick', target: 'decision:1', option: '1a' }), 40);
	const timedOut = await pending;
	assert.deepEqual(timedOut, { count: 0, events: [] });
	assert.equal(JSON.parse(readFileSync(join(dir, 'listener.json'), 'utf8')).listening, false);
	assert.equal(JSON.parse(readFileSync(join(dir, 'listener.json'), 'utf8')).seen, 0);

	const next = waitForFeedback(dir, { after: timedOut.count, intervalMs: 20, coalesceMs: 40, presenceIntervalMs: 0 });
	setTimeout(() => appendEvent(dir, { id: 'submit', type: 'submit', text: 'Direction A, 1a' }), 40);
	const result = await next;
	assert.equal(result.count, 2);
	assert.deepEqual(result.events.map((event) => event.id), ['pick', 'submit']);
});

test('a direction pick wakes the wait', async (t) => {
	const dir = sprintDir(t);
	const pending = waitForFeedback(dir, { after: 0, intervalMs: 20, coalesceMs: 20, presenceIntervalMs: 0 });
	setTimeout(() => appendEvent(dir, { id: 'pick', type: 'pick', target: 'direction', option: 'B' }), 30);
	const result = await pending;
	assert.deepEqual(result.events.map((event) => event.target), ['direction']);
	assert.equal(JSON.parse(readFileSync(join(dir, 'listener.json'), 'utf8')).listening, false);
	assert.equal(JSON.parse(readFileSync(join(dir, 'listener.json'), 'utf8')).seen, 1);
});

test('SIGTERM marks the listener idle and exits 130', async (t) => {
	const dir = sprintDir(t);
	const child = spawn(process.execPath, [fileURLToPath(new URL('./wait.mjs', import.meta.url)), '--sprint', dir, '--timeout', '30'], { stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout.resume();
	child.stderr.resume();
	t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
	const file = join(dir, 'listener.json');
	let listening;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			listening = JSON.parse(readFileSync(file, 'utf8'));
			if (listening.listening === true) break;
		} catch {}
		await sleep(20);
	}
	assert.equal(listening?.listening, true);
	assert.equal(listening.seen, 0);
	child.kill('SIGTERM');
	const code = await new Promise((resolve) => child.once('exit', resolve));
	assert.equal(code, 130);
	const after = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(after.listening, false);
	assert.equal(after.seen, 0);
});
