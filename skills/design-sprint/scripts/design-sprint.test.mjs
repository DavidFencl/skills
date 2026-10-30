import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSprintServer, parseFeedback, readFeedback } from './serve.mjs';
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

async function serve(t, dir) {
	const server = createSprintServer(dir);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	const port = server.address().port;
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
	return request;
}

const postJson = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('feedback validation requires each event type’s fields and allowed targets', () => {
	assert.deepEqual(parseFeedback({ type: 'pick', target: 'direction', option: 'keep' }), { type: 'pick', target: 'direction', option: 'keep' });
	assert.deepEqual(parseFeedback({ type: 'pick', target: 'decision:1', option: '1-keep' }), { type: 'pick', target: 'decision:1', option: '1-keep' });
	assert.deepEqual(parseFeedback({ type: 'reprompt', target: 'variant:A', text: 'denser' }), { type: 'reprompt', target: 'variant:A', text: 'denser' });
	assert.deepEqual(parseFeedback({ type: 'submit', text: 'Direction A, 1: keep' }), { type: 'submit', text: 'Direction A, 1: keep' });
	assert.match(parseFeedback({ type: 'delete' }), /type must be/);
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
	const manifest = await request('/api/sprint');
	assert.equal((await manifest.json()).title, 'Organizer applications list');

	const empty = await serve(t, sprintDir(t, false));
	assert.equal((await empty('/api/sprint')).status, 404);
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
	assert.deepEqual(await (await request('/api/feedback')).json(), [record]);

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
	assert.equal(readFeedback(dir).length, 0);
	assert.equal(await request.raw('/api/feedback', { method: 'POST', body, headers: { 'content-type': 'application/json', origin: own } }), 201);
	assert.equal(readFeedback(dir).length, 1);
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
	assert.equal(await (await request('/files/a.html')).text(), '<p>variant a</p>');
	assert.equal(await (await request('/files/..notes/n.txt')).text(), 'note');
	assert.equal(await request.raw('/files/..%2f..%2fetc%2fpasswd'), 403);
	assert.equal(await request.raw('/files/%2fetc%2fpasswd'), 403);
	assert.equal(await request.raw('/files/link.txt'), 403);
	assert.equal(await request.raw('/files/linked-dir/secret.txt'), 403);
	assert.equal((await request('/files/missing.png')).status, 404);
});

test('malformed request targets get 400 and leave the server running', async (t) => {
	const request = await serve(t, sprintDir(t));
	assert.equal(await request.raw('http://['), 400);
	assert.equal(await request.raw('/files/%E0%A4%A'), 400);
	assert.equal((await request('/api/sprint')).status, 200);
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
