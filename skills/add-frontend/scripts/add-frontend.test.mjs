import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { check, frontendServices } from './check.mjs';
import { NODE_FOR_BUILD, scaffold } from './scaffold.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const PYTHON = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;

const MAIN = `import depthai as dai

visualizer = dai.RemoteConnection(httpPort=8082)
with dai.Pipeline() as pipeline:
    cam = pipeline.create(dai.node.Camera).build()
    visualizer.addTopic("Color", cam.requestOutput((640, 400)))
    visualizer.registerService("Set Threshold", lambda body: {"ok": True})
    pipeline.start()
`;

const OAKAPP = `identifier = "com.example.counter"
entrypoint = ["bash", "-c", "python3 -u /app/main.py"]
prepare_container = [
    { type = "RUN", command = "apt-get update" },
]

[base_image]
image_name = "luxonis/oakapp-base"
image_tag = "1.4.0"
`;

function app(t, files) {
	const dir = mkdtempSync(join(os.tmpdir(), 'add-frontend-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

function wire(dir, entry = 'main.py') {
	const path = join(dir, entry);
	writeFileSync(path, readFileSync(path, 'utf8')
		.replace('import depthai as dai\n', 'import depthai as dai\nfrom frontend_server import serve_frontend\n\nserve_frontend()\n')
		.replace('dai.RemoteConnection(httpPort=8082)', 'dai.RemoteConnection(serveFrontend=False)'));
	const services = join(dir, 'frontend/src/services.ts');
	writeFileSync(services, readFileSync(services, 'utf8').replace('export const SERVICES = {}', "export const SERVICES = { setThreshold: 'Set Threshold' }"));
	writeFileSync(join(dir, 'frontend/src/streams.ts'), "export const STREAMS: string[] = ['Color'];\n");
}

test('scaffold copies the template, titles the page and adds the standalone frontend to oakapp.toml', (t) => {
	const dir = app(t, { 'main.py': MAIN, 'oakapp.toml': OAKAPP });
	const summary = scaffold({ app: dir, title: "Dave's counter <beta>" });
	assert.deepEqual(summary.created, ['frontend/', 'frontend_server.py', '.oakappignore']);
	assert.deepEqual(summary.updated, ['oakapp.toml']);
	assert.deepEqual(summary.notes, []);
	for (const file of ['package.json', 'package-lock.json', 'vite.config.ts', '.gitignore', 'src/main.tsx', 'src/services.ts', 'src/Controls.tsx']) {
		assert.ok(existsSync(join(dir, 'frontend', file)), `frontend/${file} is copied`);
	}
	assert.match(readFileSync(join(dir, 'frontend/index.html'), 'utf8'), /<title>Dave&#39;s counter &#60;beta&#62;<\/title>/);
	assert.match(readFileSync(join(dir, 'frontend/src/App.tsx'), 'utf8'), /const TITLE = 'Dave\\'s counter <beta>';/);
	assert.match(readFileSync(join(dir, 'frontend_server.py'), 'utf8'), /Path\(__file__\)\.resolve\(\)\.parent \/ "frontend\/dist"/);
	assert.equal(readFileSync(join(dir, '.oakappignore'), 'utf8'), 'node_modules/\n');

	const toml = readFileSync(join(dir, 'oakapp.toml'), 'utf8');
	assert.ok(toml.includes(`]\n\n${NODE_FOR_BUILD}\n\n[base_image]`), 'Node is installed by a top-level key, one blank line before the first table');
	assert.doesNotMatch(toml, /\n\n\n/);
	assert.match(toml, /\[static_frontend\]\ndist_path = "\.\/frontend\/dist"\n\n\[static_frontend\.build\]\nsource_path = "\.\/frontend"\nsteps = \[.*npm install && npm run build.*\]\n$/);
	assert.match(toml, /image_tag = "1\.4\.0"\n/, 'the existing tables are kept');
});

test('scaffold refuses to replace a frontend and changes nothing', (t) => {
	const dir = app(t, { 'main.py': MAIN, 'oakapp.toml': OAKAPP, 'frontend/index.html': '<p>mine</p>' });
	assert.throws(() => scaffold({ app: dir }), /already exists/);
	assert.equal(readFileSync(join(dir, 'oakapp.toml'), 'utf8'), OAKAPP);
	assert.equal(existsSync(join(dir, 'frontend_server.py')), false);
});

test('scaffold names the candidate entry scripts when main.py is missing', (t) => {
	const dir = app(t, { 'backend/src/app.py': MAIN, 'tools/plot.py': 'import matplotlib\n' });
	assert.throws(() => scaffold({ app: dir }), /one of: backend\/src\/app\.py\.$/);
});

test('a nested entry script gets a server that finds frontend/dist from its own folder', (t) => {
	const dir = app(t, { 'backend/src/main.py': MAIN });
	const summary = scaffold({ app: dir, entry: 'backend/src/main.py' });
	assert.deepEqual(summary.created, ['frontend/', 'backend/src/frontend_server.py']);
	assert.deepEqual(summary.updated, [], 'an app without oakapp.toml gets no oakapp files');
	assert.match(readFileSync(join(dir, 'backend/src/frontend_server.py'), 'utf8'), /parent \/ "\.\.\/\.\.\/frontend\/dist"/);
	wire(dir, 'backend/src/main.py');
	assert.deepEqual(check({ app: dir }).errors, []);
});

test('scaffold keeps an existing Node setup and reports an image that does not serve the frontend', (t) => {
	const oakapp = `identifier = "com.example.counter"\nprepare_build_container = [\n    { type = "RUN", command = "apt-get install -y nodejs npm" },\n]\n`;
	const dir = app(t, { 'main.py': MAIN, 'oakapp.toml': oakapp, '.oakappignore': 'media/\n' });
	const summary = scaffold({ app: dir });
	assert.equal(summary.notes.length, 2);
	assert.match(summary.notes[0], /already has prepare_build_container/);
	assert.match(summary.notes[1], /luxonis\/oakapp-base/);
	const toml = readFileSync(join(dir, 'oakapp.toml'), 'utf8');
	assert.equal(toml.match(/prepare_build_container/g).length, 1);
	assert.equal(readFileSync(join(dir, '.oakappignore'), 'utf8'), 'media/\nnode_modules/\n');
});

test('check passes a wired app and lists what the frontend and the Python app share', (t) => {
	const dir = app(t, { 'main.py': MAIN, 'oakapp.toml': OAKAPP });
	scaffold({ app: dir });
	wire(dir);
	const result = check({ app: dir });
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.warnings, ['frontend/dist is not built yet. Run npm install and npm run build in frontend/.']);
	assert.deepEqual(result.services, { python: ['Set Threshold'], frontend: ['Set Threshold'] });
	assert.deepEqual(result.topics, { python: ['Color'], frontend: ['Color'] });
});

test('check catches an unwired entry script, the default Visualizer and a renamed service', (t) => {
	const dir = app(t, { 'main.py': MAIN, 'oakapp.toml': OAKAPP });
	scaffold({ app: dir });
	const services = join(dir, 'frontend/src/services.ts');
	writeFileSync(services, readFileSync(services, 'utf8').replace('export const SERVICES = {}', "export const SERVICES = { setThreshold: 'Set threshold' }"));
	const { ok, errors } = check({ app: dir });
	assert.equal(ok, false);
	assert.equal(errors.length, 3);
	assert.match(errors[0], /No Python file calls serve_frontend/);
	assert.match(errors[1], /^main\.py: RemoteConnection\(httpPort=8082\) .*serveFrontend=False/);
	assert.match(errors[2], /"Set threshold", which the Python app never registers/);
});

test('check flags oakapp.toml without a frontend build and services the viewer would poll', (t) => {
	const dir = app(t, { 'main.py': MAIN });
	scaffold({ app: dir });
	wire(dir);
	writeFileSync(join(dir, 'oakapp.toml'), 'identifier = "com.example.counter"\n\n[static_frontend]\ndist_path = "./frontend"\n');
	const main = join(dir, 'frontend/src/main.tsx');
	writeFileSync(main, readFileSync(main, 'utf8').replace('activeServices={[]}', "activeServices={['Set Threshold']}"));
	const { errors, warnings } = check({ app: dir });
	assert.deepEqual(errors, [
		'oakapp.toml: [static_frontend] dist_path is ./frontend, not ./frontend/dist.',
		'oakapp.toml has no [static_frontend.build] steps, so the device has nothing to serve unless frontend/dist is shipped.',
	]);
	assert.ok(warnings.some((warning) => /activeServices/.test(warning)));
	assert.ok(warnings.some((warning) => /oakapp-base/.test(warning)));
});

test('check compares only literal service names, and lists topics named at run time', (t) => {
	const dir = app(t, { 'main.py': MAIN.replace('addTopic("Color"', 'addTopic(sensor.socket.name') });
	scaffold({ app: dir });
	wire(dir);
	const literal = check({ app: dir });
	assert.deepEqual(literal.errors, []);
	assert.equal(literal.warnings.length, 1, 'a topic named at run time is not a warning');
	assert.deepEqual(literal.topics, { python: ['main.py: addTopic(sensor.socket.name), named at run time'], frontend: ['Color'] });

	writeFileSync(join(dir, 'main.py'), readFileSync(join(dir, 'main.py'), 'utf8').replace('registerService("Set Threshold"', 'registerService(SERVICE_NAME'));
	const dynamic = check({ app: dir });
	assert.deepEqual(dynamic.errors, [], 'a service name set at run time cannot be called missing');
	assert.match(dynamic.warnings[0], /^Some service names are not string literals.*registerService\(SERVICE_NAME\)/);
});

test('check catches a stream the app never publishes, and warns when the page opens none', (t) => {
	const dir = app(t, { 'main.py': MAIN });
	scaffold({ app: dir });
	wire(dir);
	const streams = join(dir, 'frontend/src/streams.ts');
	writeFileSync(streams, "export const STREAMS: string[] = ['Color', 'Depth'];\n");
	assert.deepEqual(check({ app: dir }).errors, ['The page opens the stream "Depth", which the Python app never publishes with addTopic.']);
	writeFileSync(streams, 'export const STREAMS: string[] = [];\n');
	const empty = check({ app: dir });
	assert.deepEqual(empty.errors, []);
	assert.ok(empty.warnings.some((warning) => /STREAMS .* is empty/.test(warning)));
});

test('frontendServices reads the names in SERVICES', () => {
	assert.deepEqual(frontendServices("export const SERVICES = {\n\ta: 'One',\n\tb: \"Two\",\n} as const satisfies Record<string, string>;"), ['One', 'Two']);
	assert.deepEqual(frontendServices('export const SERVICES = {} as const;'), []);
});

async function freePort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

async function runServer(t, dir, env = {}) {
	const port = await freePort();
	const code = `import sys, time\nsys.path.insert(0, ${JSON.stringify(dir)})\nfrom frontend_server import serve_frontend\nprint(serve_frontend(host="127.0.0.1", port=${port}), flush=True)\ntime.sleep(30)\n`;
	const child = spawn(PYTHON, ['-c', code], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
	t.after(() => child.kill());
	let output = '';
	child.stdout.on('data', (chunk) => { output += chunk; });
	child.stderr.on('data', (chunk) => { output += chunk; });
	for (let attempt = 0; attempt < 100 && child.exitCode === null && !/\n(None|<.*>)\n/.test(`\n${output}`); attempt += 1) await sleep(50);
	return { port, output: () => output };
}

test('the Python server serves the built files, falls back to index.html, and stays off in standalone mode', { skip: PYTHON ? false : 'python3 is not installed' }, async (t) => {
	const dir = app(t, { 'main.py': MAIN });
	scaffold({ app: dir });
	mkdirSync(join(dir, 'frontend/dist/assets'), { recursive: true });
	writeFileSync(join(dir, 'frontend/dist/index.html'), '<p>app</p>');
	writeFileSync(join(dir, 'frontend/dist/assets/app.js'), 'console.log(1)');

	const { port, output } = await runServer(t, dir);
	assert.match(output(), /Frontend: http:\/\/localhost:\d+/);
	const get = async (path) => {
		const response = await fetch(`http://127.0.0.1:${port}${path}`);
		return [response.status, await response.text()];
	};
	assert.deepEqual(await get('/'), [200, '<p>app</p>']);
	assert.deepEqual(await get('/assets/app.js'), [200, 'console.log(1)']);
	assert.deepEqual(await get('/settings/camera'), [200, '<p>app</p>'], 'a browser route gets index.html');
	assert.deepEqual(await get('/assets/'), [200, '<p>app</p>'], 'a folder is never listed');
	assert.equal((await get('/assets/missing.js'))[0], 404, 'a missing file is a 404, not the page');

	const standalone = await runServer(t, dir, { OAKAPP_STATIC_FRONTEND_PORT: '9000' });
	assert.match(standalone.output(), /^None$/m, 'the oakapp serves the frontend in standalone mode');
});

test('the Python server explains how to build a missing frontend', { skip: PYTHON ? false : 'python3 is not installed' }, async (t) => {
	const dir = app(t, { 'main.py': MAIN });
	scaffold({ app: dir });
	const { output } = await runServer(t, dir);
	assert.match(output(), /FileNotFoundError: .*frontend\/dist\/index\.html does not exist\. Build the frontend first: cd frontend && npm ci && npm run build/);
});

test('the scripts run from the command line', (t) => {
	const dir = app(t, { 'main.py': MAIN });
	const scaffolded = spawnSync(process.execPath, [join(SCRIPTS, 'scaffold.mjs'), '--app', dir, '--title', 'Counter'], { encoding: 'utf8' });
	assert.equal(scaffolded.status, 0, scaffolded.stderr);
	assert.deepEqual(JSON.parse(scaffolded.stdout).created, ['frontend/', 'frontend_server.py']);
	const again = spawnSync(process.execPath, [join(SCRIPTS, 'scaffold.mjs'), '--app', dir], { encoding: 'utf8' });
	assert.equal(again.status, 1);
	assert.match(again.stderr, /already exists/);
	const checked = spawnSync(process.execPath, [join(SCRIPTS, 'check.mjs'), '--app', dir], { encoding: 'utf8' });
	assert.equal(checked.status, 1);
	assert.equal(JSON.parse(checked.stdout).ok, false);
});
