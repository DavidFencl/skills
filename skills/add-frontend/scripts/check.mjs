#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pythonFiles, readOakapp, registeredNames } from './app.mjs';
import { isMain } from './entry.mjs';

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

export function frontendServices(text) {
	const body = text.match(/export const SERVICES\s*=\s*\{([\s\S]*?)\}\s*as const/)?.[1] ?? '';
	return [...body.matchAll(/:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

export function frontendStreams(text) {
	const body = text.match(/export const STREAMS[^=]*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
	return [...body.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

export function check({ app }) {
	const appDir = resolve(app);
	const errors = [];
	const warnings = [];
	const python = pythonFiles(appDir).map((file) => ({ file, text: readFileSync(join(appDir, file), 'utf8') }));

	const entries = python.filter(({ text }) => /\bserve_frontend\s*\(/.test(text) && !/^\s*def serve_frontend\b/m.test(text));
	if (!entries.length) errors.push('No Python file calls serve_frontend(), so peripheral mode serves no frontend.');
	for (const { file } of entries) {
		if (!existsSync(join(appDir, dirname(file), 'frontend_server.py'))) errors.push(`${file} calls serve_frontend(), but there is no frontend_server.py next to it.`);
	}
	for (const { file, text } of python) {
		for (const call of text.matchAll(/RemoteConnection\s*\(([^)]*)\)/g)) {
			if (!/serveFrontend\s*=\s*False/.test(call[1])) errors.push(`${file}: ${call[0].replace(/\s+/g, ' ')} serves the default Visualizer on port 8082, where the frontend server listens. Pass serveFrontend=False.`);
		}
	}

	const names = registeredNames(appDir);
	const servicesText = read(join(appDir, 'frontend/src/services.ts'));
	const frontend = servicesText === null ? [] : frontendServices(servicesText);
	if (servicesText === null) errors.push('frontend/src/services.ts is missing.');
	for (const name of frontend) {
		if (!names.services.includes(name) && !names.dynamic.services.length) errors.push(`The frontend calls the service "${name}", which the Python app never registers.`);
	}
	if (names.dynamic.services.length) warnings.push(`Some service names are not string literals, so they cannot be compared with SERVICES: ${names.dynamic.services.join('; ')}.`);

	const streamsText = read(join(appDir, 'frontend/src/streams.ts'));
	const streams = streamsText === null ? [] : frontendStreams(streamsText);
	if (streamsText === null) errors.push('frontend/src/streams.ts is missing.');
	for (const name of streams) {
		if (!names.topics.includes(name) && !names.dynamic.topics.length) errors.push(`The page opens the stream "${name}", which the Python app never publishes with addTopic.`);
	}
	if (streamsText !== null && !streams.length && (names.topics.length || names.dynamic.topics.length)) warnings.push('STREAMS in frontend/src/streams.ts is empty, so the page opens no stream until the user picks one.');

	const main = read(join(appDir, 'frontend/src/main.tsx')) ?? '';
	if (/activeServices=\{\[\s*[^\]\s]/.test(main)) warnings.push('frontend/src/main.tsx lists services in activeServices. The viewer calls each of them every 10 seconds with no arguments. Call services with useService() instead.');

	const pkg = JSON.parse(read(join(appDir, 'frontend/package.json')) ?? '{}');
	for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
		if (name.startsWith('@luxonis/') && !/^\d+\.\d+\.\d+$/.test(version)) warnings.push(`frontend/package.json: ${name} is "${version}". Pin @luxonis packages to an exact version that matches the app's DepthAI version.`);
	}
	if (!existsSync(join(appDir, 'frontend/dist/index.html'))) warnings.push('frontend/dist is not built yet. Run npm install and npm run build in frontend/.');

	const oakapp = readOakapp(appDir);
	if (oakapp) {
		const frontendTable = oakapp.tables.static_frontend;
		const build = oakapp.tables['static_frontend.build'];
		if (!frontendTable) errors.push('oakapp.toml has no [static_frontend], so the device neither builds nor serves the frontend in standalone mode.');
		else if (frontendTable.dist_path?.replace(/\/$/, '') !== './frontend/dist') errors.push(`oakapp.toml: [static_frontend] dist_path is ${frontendTable.dist_path}, not ./frontend/dist.`);
		if (frontendTable && !build?.steps) errors.push('oakapp.toml has no [static_frontend.build] steps, so the device has nothing to serve unless frontend/dist is shipped.');
		if (build?.steps && !/nvm|node/i.test(oakapp.buildContainer ?? '')) warnings.push('oakapp.toml: prepare_build_container does not appear to install Node, which the frontend build steps need.');
		if (oakapp.tables.base_image?.image_name !== 'luxonis/oakapp-base') warnings.push('oakapp.toml does not use the luxonis/oakapp-base image, whose web server serves [static_frontend]. On another image, nothing serves the frontend in standalone mode.');
	}

	const topics = [...names.topics, ...names.dynamic.topics.map((call) => `${call}, named at run time`)];
	return { ok: errors.length === 0, errors, warnings, services: { python: names.services, frontend }, topics: { python: topics, frontend: streams } };
}

if (isMain(import.meta.url)) {
	const { values } = parseArgs({ options: { app: { type: 'string' } } });
	if (!values.app) {
		console.error('Usage: node check.mjs --app <app dir>');
		process.exit(64);
	}
	const result = check(values);
	console.log(JSON.stringify(result, null, 2));
	process.exit(result.ok ? 0 : 1);
}
