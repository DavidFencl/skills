import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFilesServer, createSprintServer, readFeedback } from '../skills/design-sprint/scripts/serve.mjs';

const TOOL_HOME = process.env.UI_CHANGELOG_HOME ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'ui-changelog');
let chromium;
try { ({ chromium } = createRequire(path.join(TOOL_HOME, 'package.json'))('playwright')); } catch {}
const NO_BROWSER = chromium ? false : `tool cache ${TOOL_HOME} lacks playwright; run skills/ui-changelog/scripts/setup.sh`;

const SECRET = 'codex:secret-model';

async function listen(server, port = 0) {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	return `http://127.0.0.1:${server.address().port}`;
}

function sprint(overrides = {}) {
	return {
		title: 'Applications', goal: 'Pick a list layout', blind: true, round: 1, viewports: [390, 1280], themes: ['light', 'dark'],
		status: { message: 'Building 2 variants' },
		current: { url: 'preview.html?v=current', note: 'Today.' },
		variants: ['A', 'B'].map((id) => ({ id, label: `Layout ${id}`, url: `preview.html?v=${id}`, model: SECRET, intent: `Intent ${id}` })),
		decisions: [{ id: '1', question: 'Which spacing?', current: { url: 'preview.html?v=1-current' }, options: [{ id: '1a', label: 'Compact', url: 'preview.html?v=1a' }] }],
		requests: [],
		questions: [
			{ id: 'implement', text: 'Implement the winner now?', withSubmit: true, options: [{ id: 'now', label: 'Yes' }, { id: 'later', label: 'Not now', recommended: true }] },
			{ id: 'why', text: 'Anything we missed?', withSubmit: true },
		],
		...overrides,
	};
}

async function harness(t, manifest) {
	let dir = mkdtempSync(path.join(os.tmpdir(), 'design-sprint-page-'));
	const dirs = [dir];
	const servers = [];
	const errors = [];
	let dialog = false;
	let browser;
	t.after(async () => {
		await browser?.close();
		await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
		for (const each of dirs) rmSync(each, { recursive: true, force: true });
		assert.deepEqual(errors, [], 'the page has no script errors');
		assert.equal(dialog, false, 'text from the user or the agent never runs as HTML');
	});
	const save = () => writeFileSync(path.join(dir, 'sprint.json'), JSON.stringify(manifest));
	const start = async (port) => {
		writeFileSync(path.join(dir, 'preview.html'), '<!doctype html><title>Preview</title><p>List preview</p>');
		mkdirSync(path.join(dir, 'lanes'));
		save();
		const files = createFilesServer(dir);
		const server = createSprintServer(dir, { filesOrigin: await listen(files) });
		servers.push(files, server);
		return listen(server, port);
	};
	let base = await start();
	browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	page.setDefaultTimeout(5000);
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('dialog', async (popup) => { dialog = true; await popup.dismiss(); });
	const reloads = { count: 0 };
	page.on('framenavigated', (frame) => { if (frame !== page.mainFrame()) reloads.count += 1; });
	const write = (name, value) => writeFileSync(path.join(dir, name), JSON.stringify(value));
	const listener = (listening) => write('listener.json', { listening, seen: readFeedback(dir).length, at: new Date().toISOString() });
	await page.goto(base);
	await page.locator('body[data-phase]').waitFor();
	const nextSprint = async (next) => {
		await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
		dir = mkdtempSync(path.join(os.tmpdir(), 'design-sprint-page-'));
		dirs.push(dir);
		manifest = next;
		base = await start(Number(new URL(base).port));
		await page.goto(base);
		await page.locator('body[data-phase]').waitFor();
	};
	return { dir, page, manifest, save, write, listener, reloads, nextSprint, feedback: () => readFeedback(dir) };
}

const text = (page, selector) => page.locator(selector).textContent();
const visibleText = (page) => page.evaluate(() => document.body.innerText);
async function until(page, selector, needle) {
	await page.waitForFunction(([css, value]) => document.querySelector(css)?.textContent.includes(value), [selector, needle]);
}
const settle = (page) => page.waitForTimeout(1300);

test('building shows lane progress without model names, then opens the first step when variants arrive', { skip: NO_BROWSER }, async (t) => {
	const manifest = sprint({ variants: [], dropouts: [{ id: 'C', model: SECRET, reason: 'The lane exited.' }] });
	const { page, save, write } = await harness(t, manifest);
	assert.equal(await page.locator('body').getAttribute('data-phase'), 'building');
	write('lanes/progress.json', { running: ['B'], finished: [{ id: 'A', status: 'complete' }], at: new Date().toISOString() });
	await until(page, '#lanes', 'B: building');
	assert.match(await text(page, '#lanes'), /A: ready/);
	assert.match(await text(page, '#presence'), /Building variant B\./);
	assert.match(await visibleText(page), /C dropped out\. The lane exited\./);
	assert.doesNotMatch(await visibleText(page), /secret-model/);
	manifest.variants = sprint().variants;
	save();
	await page.locator('body[data-phase="choosing"][data-step="direction"]').waitFor();
	assert.doesNotMatch(await visibleText(page), /secret-model/, 'a blind sprint hides models until submit');
});

test('steps advance one at a time, picks go out when the user leaves a step, and the step survives a reload', { skip: NO_BROWSER }, async (t) => {
	const { page, feedback } = await harness(t, sprint());
	await page.locator('body[data-step="direction"]').waitFor();
	assert.equal(await page.locator('#next').isDisabled(), true, 'Next needs a pick');
	await page.getByRole('button', { name: 'Pick B', exact: true }).click();
	await page.getByRole('button', { name: 'Pick A', exact: true }).click();
	assert.deepEqual(feedback(), [], 'clicking around sends nothing yet');
	assert.equal(await page.getByRole('button', { name: 'Picked A', exact: true }).getAttribute('aria-pressed'), 'true');
	await page.locator('#next').click();
	await page.locator('body[data-step="decision:1"]').waitFor();
	assert.deepEqual(feedback().map(({ type, target, option }) => [type, target, option]), [['pick', 'direction', 'A']]);
	assert.match(await text(page, '#stepper'), /1 Direction · A/);
	await page.locator('#back').click();
	await page.locator('body[data-step="direction"]').waitFor();
	assert.equal(feedback().length, 1, 'leaving a step whose pick did not change sends nothing');
	await page.reload();
	await page.locator('body[data-step="direction"]').waitFor();
	assert.equal(await page.getByRole('button', { name: 'Picked A', exact: true }).count(), 1, 'picks survive a reload');
	await page.getByRole('button', { name: /^2 Which spacing\?/ }).click();
	await page.locator('body[data-step="decision:1"]').waitFor();
	await page.reload();
	await page.locator('body[data-step="decision:1"]').waitFor();
	await page.getByRole('button', { name: 'Pick Do nothing', exact: true }).click();
	await page.locator('#next').click();
	await page.locator('body[data-step="review"]').waitFor();
	const last = feedback().at(-1);
	assert.deepEqual([last.type, last.target, last.option], ['pick', 'decision:1', '1-keep']);
	assert.match(await text(page, '#review-rows'), /Direction → A[\s\S]*Which spacing\? → keep/);
});

test('previews never reload for picks, requests, questions or presence, and drafts survive every poll', { skip: NO_BROWSER }, async (t) => {
	const { page, manifest, save, listener, reloads, feedback } = await harness(t, sprint());
	await page.locator('body[data-step="direction"]').waitFor();
	await settle(page);
	reloads.count = 0;
	await page.evaluate(() => { window.firstFrames = [...document.querySelectorAll('iframe')]; });
	await page.getByRole('button', { name: 'Pick B', exact: true }).click();
	await page.getByText('Change variant B').click();
	await page.getByLabel('What should change in B?').fill('Sticky headers');
	await page.locator('details[data-key="variant:B"]').getByRole('button', { name: 'Send to agent' }).click();
	const request = feedback()[0];
	listener(true);
	await until(page, `#request-${request.id}`, 'Received by the agent');
	manifest.requests = [{ feedbackId: request.id, status: 'working', note: 'Rebuilding B.' }];
	manifest.questions.push({ id: 'q1', text: 'Sticky to the list or the page?', about: request.id, allowText: true, options: [{ id: 'list', label: 'The list' }, { id: 'page', label: 'The page' }] });
	manifest.status = { message: 'Rebuilding B' };
	save();
	await until(page, `#request-${request.id}`, 'Rebuilding B.');
	const reply = page.locator('#question-q1 textarea');
	await reply.fill('Only on wide scr');
	await reply.evaluate((node) => node.setSelectionRange(5, 9));
	manifest.requests[0].note = 'Rebuilding B. Two minutes left.';
	save();
	await until(page, `#request-${request.id}`, 'Two minutes left.');
	await settle(page);
	assert.equal(await reply.inputValue(), 'Only on wide scr');
	assert.equal(await reply.evaluate((node) => node === document.activeElement), true, 'focus stays in the reply');
	assert.deepEqual(await reply.evaluate((node) => [node.selectionStart, node.selectionEnd]), [5, 9]);
	assert.equal(reloads.count, 0, 'no preview reloaded');
	assert.equal(await page.evaluate(() => window.firstFrames.every((node) => node.isConnected)), true, 'the same iframes stay in the page');
});

test('request threads: plain text, delivery, notes, an answer a stale poll cannot undo, and earlier requests', { skip: NO_BROWSER }, async (t) => {
	const { dir, page, manifest, save, listener, feedback } = await harness(t, sprint());
	await page.locator('body[data-step="direction"]').waitFor();
	await page.getByLabel(/Describe the direction you want instead/).fill('<img src=x onerror=alert(1)> a calendar');
	await page.getByRole('button', { name: 'Send to agent' }).last().click();
	const request = feedback()[0];
	await until(page, '[data-thread-target="direction"]', 'Sent');
	assert.equal(await page.locator('[data-thread-target="direction"] img').count(), 0);
	assert.match(await text(page, '#agent-line'), /Your request about a new direction is sent\./);
	listener(true);
	await until(page, '#agent-line', 'The agent has your request about a new direction');
	manifest.questions.push({ id: 'q2', text: 'Week or month view?', about: request.id, options: [{ id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }] });
	save();
	await until(page, '#agent-line', 'The agent asks about a new direction: Week or month view?');

	let release;
	await page.route('**/api/state', async (route) => {
		const response = await route.fetch();
		if (!release) await new Promise((resolve) => { release = resolve; });
		await route.fulfill({ response });
	});
	while (!release) await page.waitForTimeout(20);
	await page.locator('#question-q2').getByRole('button', { name: 'Week', exact: true }).click();
	await until(page, '#question-q2', 'Your answer: Week');
	release();
	await settle(page);
	assert.match(await text(page, '#question-q2'), /Your answer: Week/, 'a poll that started before the answer does not hide it');
	assert.deepEqual(feedback().filter((event) => event.type === 'answer').map(({ target, option }) => [target, option]), [['question:q2', 'week']]);
	await page.unroute('**/api/state');

	manifest.variants[1].retired = true;
	manifest.variants.push({ id: 'C', label: 'Calendar', url: 'preview.html?v=C', round: 2 });
	manifest.round = 2;
	manifest.requests = [{ feedbackId: request.id, status: 'done', note: 'Added C, a week calendar.' }];
	save();
	await until(page, '#agent-line', 'Done with a new direction: Added C, a week calendar.');
	assert.match(await text(page, '#step'), /C · Calendar\s*New/);
	writeFileSync(path.join(dir, 'feedback.jsonl'), `${JSON.stringify({ id: 'old', type: 'reprompt', target: 'variant:B', text: 'Denser B', at: new Date().toISOString() })}\n`, { flag: 'a' });
	await page.getByRole('button', { name: /Review$/ }).click();
	await page.locator('#earlier:not([hidden])').waitFor();
	assert.match(await text(page, '#earlier'), /You asked about variant B: Denser B/);
});

test('the header points at the most urgent thing, and Reply jumps to it on another step', { skip: NO_BROWSER }, async (t) => {
	const { page, manifest, save, listener, feedback } = await harness(t, sprint());
	await page.locator('body[data-step="direction"]').waitFor();
	await page.getByRole('button', { name: 'Pick A', exact: true }).click();
	await page.locator('#next').click();
	await page.getByText('None of these fit').click();
	await page.getByLabel(/What would you want for/).fill('A roomier option');
	await page.locator('details[data-key="decision:1"]').getByRole('button', { name: 'Send to agent' }).click();
	const roomy = feedback().at(-1);
	manifest.questions.push({ id: 'q3', text: 'How roomy?', about: roomy.id });
	manifest.questions.push({ id: 'q4', text: 'Should the list remember its scroll position?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] });
	manifest.requests = [{ feedbackId: roomy.id, status: 'working', note: 'Building 1b.' }];
	listener(true);
	save();
	await until(page, '#agent-line', 'The agent asks about decision 1: How roomy?');
	assert.match(await text(page, '#agent-line'), /1 other thing is still open\./);
	await page.locator('#back').click();
	await page.locator('body[data-step="direction"]').waitFor();
	assert.match(await text(page, '#asks'), /How roomy\?/, 'a question whose thread is on another step shows above this one');
	assert.match(await text(page, '#asks'), /remember its scroll position/);
	await page.locator('#agent-show').click();
	await page.locator('body[data-step="decision:1"]').waitFor();
	await page.waitForFunction(() => document.activeElement === document.querySelector('#question-q3 textarea'));
	await page.locator('#question-q3 textarea').fill('Like today');
	await page.locator('#question-q3').getByRole('button', { name: 'Send answer' }).click();
	await until(page, '#agent-line', 'remember its scroll position');
	await page.locator('#asks').getByRole('button', { name: 'No', exact: true }).click();
	await until(page, '#agent-line', 'Working on decision 1: Building 1b.');
	assert.deepEqual(feedback().filter((event) => event.type === 'answer').map(({ target, option, text: answer }) => [target, option ?? answer]), [['question:q3', 'Like today'], ['question:q4', 'no']]);
});

test('review asks the wrap-up questions, the submit carries the answers, and wrap-up and done stay connected', { skip: NO_BROWSER }, async (t) => {
	const { page, manifest, save, listener, feedback } = await harness(t, sprint());
	await page.locator('body[data-step="direction"]').waitFor();
	await page.getByRole('button', { name: 'Pick B', exact: true }).click();
	await page.locator('#next').click();
	await page.getByRole('button', { name: 'Pick 1a', exact: true }).click();
	await page.locator('#next').click();
	await page.locator('body[data-step="review"]').waitFor();
	assert.equal(await page.getByLabel('Not now').isChecked(), true, 'the recommended option is preselected');
	assert.equal(await page.locator('#submit').isDisabled(), true, 'a text question still needs an answer');
	await page.getByLabel('Your answer', { exact: true }).fill('Keyboard shortcuts');
	await page.getByLabel('Yes', { exact: true }).check();
	await page.getByLabel(/A note sent with your answer/).fill('Ship it');
	await page.locator('#submit').click();
	await page.locator('body[data-phase="wrap-up"]').waitFor();
	assert.deepEqual(feedback().map(({ type, target, option, text: value, answers }) => [type, target ?? null, option ?? null, value ?? null, answers ?? null]), [
		['pick', 'direction', 'B', null, null],
		['pick', 'decision:1', '1a', null, null],
		['submit', null, 'Ship it', 'Direction B, 1a', { implement: { option: 'now' }, why: { text: 'Keyboard shortcuts' } }],
	]);
	assert.match(await text(page, '#delivery'), /Sent/);
	assert.match(await visibleText(page), /B · Layout B: codex:secret-model/, 'models are revealed after submit');
	listener(false);
	await until(page, '#delivery', 'The agent received your answer');
	manifest.status = { message: 'Recording the decisions in DESIGN.md' };
	save();
	await until(page, '#presence', 'Recording the decisions in DESIGN.md');
	manifest.done = { message: 'Recorded 2 decisions. Implementing B next in the terminal.' };
	save();
	await page.locator('body[data-phase="done"]').waitFor();
	assert.match(await text(page, '#step'), /Implementing B next in the terminal\.[\s\S]*You can close this tab\./);
	assert.equal(await page.locator('#presence').isHidden(), true);
	let polls = 0;
	page.on('request', (request) => { if (request.url().endsWith('/api/state')) polls += 1; });
	await settle(page);
	assert.equal(polls, 0, 'the done page stops polling');
});

test('a new feature shows only the decisions built over the picked direction, and none when the feature is not added', { skip: NO_BROWSER }, async (t) => {
	const { page, manifest, save, feedback } = await harness(t, sprint({ mode: 'new-feature', decisions: [], questions: [] }));
	await page.locator('body[data-step="direction"]').waitFor();
	assert.equal(await page.getByRole('button', { name: "Pick Don't add it", exact: true }).count(), 1);
	await page.getByRole('button', { name: 'Pick A', exact: true }).click();
	await page.locator('#next').click();
	await page.locator('body[data-step="waiting"]').waitFor();
	assert.equal(feedback().at(-1).option, 'A', 'the direction goes to the agent so it can build the decisions');
	assert.match(await text(page, '#step'), /Building decision options over A/);
	manifest.decisions = [{ id: '2', basedOn: 'A', question: 'Button width?', options: [{ id: '2a', label: 'Full width', url: 'preview.html?v=2a' }, { id: '2-keep', keep: true, label: 'As in A' }] }];
	save();
	await page.locator('body[data-step="decision:2"]').waitFor();
	await page.locator('#back').click();
	await page.getByRole('button', { name: 'Pick B', exact: true }).click();
	await page.locator('#next').click();
	await page.locator('body[data-step="waiting"]').waitFor();
	assert.match(await text(page, '#step'), /Building decision options over B/, 'decisions built over A do not apply to B');
	manifest.variants[1].noDecisions = true;
	save();
	await page.locator('body[data-step="review"]').waitFor();
	assert.equal(await page.locator('#submit').isDisabled(), false, 'a direction with nothing to decide can be submitted');
	await page.locator('#back').click();
	await page.getByRole('button', { name: "Pick Don't add it", exact: true }).click();
	assert.doesNotMatch(await text(page, '#stepper'), /Button width/, 'not adding the feature has no decisions');
	await page.locator('#next').click();
	await page.locator('body[data-step="review"]').waitFor();
	assert.equal(await page.locator('#submit').isDisabled(), false);
});

test('an id outside the documented characters does not break navigation', { skip: NO_BROWSER }, async (t) => {
	const { page } = await harness(t, sprint({ decisions: [{ id: '50%', question: 'Opacity?', options: [{ id: '50a', label: 'Half', url: 'preview.html?v=50a' }] }] }));
	await page.getByRole('button', { name: /^2 Opacity\?/ }).click();
	await page.locator('body[data-step="decision:50%"]').waitFor();
	await page.reload();
	await page.locator('body[data-step="decision:50%"]').waitFor();
	assert.equal(await page.locator('#offline').isHidden(), true);
});

test('a new sprint with the same title starts clean, other steps never reload, and a rejected submit sends nothing', { skip: NO_BROWSER }, async (t) => {
	const { page, manifest, save, reloads, nextSprint, feedback } = await harness(t, sprint({ decisions: [{ id: '2', question: 'Opacity?', options: [{ id: '2a', label: 'Half', url: 'preview.html?v=2a' }] }] }));
	await page.locator('body[data-step="direction"]').waitFor();
	await page.getByRole('button', { name: 'Pick B', exact: true }).click();
	await page.locator('#next').click();
	await page.locator('body[data-step="decision:2"]').waitFor();
	await settle(page);
	reloads.count = 0;
	manifest.variants.push({ id: 'C', label: 'Layout C', url: 'preview.html?v=C', round: 2, reviews: [{ model: 'x', text: 'Fine.' }] });
	manifest.round = 2;
	save();
	await until(page, '#top', 'Round 2');
	await settle(page);
	assert.equal(reloads.count, 0, 'a new variant does not reload the decision step');
	await page.getByRole('button', { name: 'Pick 2a', exact: true }).click();
	await page.locator('#next').click();
	await page.locator('body[data-step="review"]').waitFor();
	await page.getByLabel('Your answer', { exact: true }).fill('Nothing');
	assert.equal(await page.getByLabel(/A note sent with your answer/).getAttribute('maxlength'), '8000');
	await page.route('**/api/feedback', (route) => (route.request().postDataJSON()?.type === 'submit'
		? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Server busy' }) })
		: route.continue()));
	await page.locator('#submit').click();
	await until(page, '#send-status', 'Not sent');
	assert.deepEqual(feedback().map((event) => event.type), ['pick', 'pick'], 'no answer and no submit went out');
	assert.equal(await page.locator('body').getAttribute('data-phase'), 'choosing');

	await nextSprint(sprint());
	await page.locator('body[data-step="direction"]').waitFor();
	assert.equal(await page.getByRole('button', { name: /^Picked/ }).count(), 0, 'the old sprint\'s picks do not carry over');
	assert.equal(await page.locator('#next').isDisabled(), true);
});
