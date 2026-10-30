import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSprintServer, parseFeedback, readFeedback } from './serve.mjs';
import { waitForFeedback } from './wait.mjs';

const example = fileURLToPath(new URL('../assets/example-sprint.json', import.meta.url));

function sprintDir(t, withManifest = true) {
	const dir = mkdtempSync(join(tmpdir(), 'design-sprint-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	if (withManifest) copyFileSync(example, join(dir, 'sprint.json'));
	return dir;
}

async function serve(t, dir) {
	const server = createSprintServer(dir);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	const base = `http://127.0.0.1:${server.address().port}`;
	const request = (path, init) => fetch(`${base}${path}`, init);
	// fetch normalizes dot segments, so traversal probes go through node:http unchanged.
	request.raw = (path) => new Promise((resolve, reject) => get(`${base}${path}`, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
	return request;
}

const postJson = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('feedback validation accepts the three event types and rejects malformed events', () => {
	assert.deepEqual(parseFeedback({ type: 'pick', target: 'direction', option: 'keep' }), { type: 'pick', target: 'direction', option: 'keep' });
	assert.deepEqual(parseFeedback({ type: 'reprompt', target: 'variant:A', text: 'denser' }), { type: 'reprompt', target: 'variant:A', text: 'denser' });
	assert.deepEqual(parseFeedback({ type: 'submit', text: 'Direction A, 1: keep' }), { type: 'submit', text: 'Direction A, 1: keep' });
	assert.match(parseFeedback({ type: 'delete' }), /type must be/);
	assert.match(parseFeedback({ type: 'reprompt', target: 'variant:A', text: '  ' }), /needs text/);
	assert.match(parseFeedback({ type: 'pick' }), /needs a target/);
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

	assert.equal((await request('/api/feedback', { method: 'POST', body: '{not json' })).status, 400);
	assert.equal((await request('/api/feedback', postJson({ type: 'reprompt', target: 'direction' }))).status, 400);
	assert.equal((await request('/api/feedback', { method: 'DELETE' })).status, 405);
	assert.equal(readFeedback(dir).length, 1);
});

test('files are served only from inside the sprint directory', async (t) => {
	const dir = sprintDir(t);
	writeFileSync(join(dir, 'a.html'), '<p>variant a</p>');
	const request = await serve(t, dir);
	assert.equal(await (await request('/files/a.html')).text(), '<p>variant a</p>');
	assert.equal(await request.raw('/files/..%2f..%2fetc%2fpasswd'), 403);
	assert.equal(await request.raw('/files/%2fetc%2fpasswd'), 403);
	assert.equal((await request('/files/missing.png')).status, 404);
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
