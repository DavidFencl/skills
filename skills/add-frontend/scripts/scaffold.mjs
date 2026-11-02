#!/usr/bin/env node

import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pythonFiles, readOakapp } from './app.mjs';
import { isMain } from './entry.mjs';

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));

export const NODE_FOR_BUILD = `prepare_build_container = [{ type = "RUN", command = "bash -c 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . \\"$HOME/.nvm/nvm.sh\\" && nvm install 24'" }]`;

export const STATIC_FRONTEND = `[static_frontend]
dist_path = "./frontend/dist"

[static_frontend.build]
source_path = "./frontend"
steps = ["bash -c 'ulimit -n $(ulimit -Hn); cd /app/frontend && export NODE_OPTIONS=--max-old-space-size=4096 && . $HOME/.nvm/nvm.sh && npm install && npm run build'"]
`;

const escapeHtml = (text) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const titleFrom = (appDir) => basename(appDir).replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());

export function scaffold({ app, entry = 'main.py', title }) {
	const appDir = resolve(app);
	if (!existsSync(appDir) || !statSync(appDir).isDirectory()) throw new Error(`${appDir} is not a directory.`);
	const entryPath = join(appDir, entry);
	if (!existsSync(entryPath)) {
		const candidates = pythonFiles(appDir).filter((file) => /^\s*(import depthai|from depthai)/m.test(readFileSync(join(appDir, file), 'utf8')));
		throw new Error(`${entry} not found in ${appDir}. Pass --entry with the script that starts the pipeline${candidates.length ? `, one of: ${candidates.join(', ')}` : ''}.`);
	}
	const frontendDir = join(appDir, 'frontend');
	if (existsSync(frontendDir)) throw new Error(`${frontendDir} already exists. This skill adds a new frontend; it does not replace one.`);

	const entryDir = dirname(entryPath);
	const distFromEntry = relative(entryDir, join(frontendDir, 'dist')).split(sep).join('/');
	const server = readFileSync(join(ASSETS, 'frontend_server.py'), 'utf8').replace('"frontend/dist"', JSON.stringify(distFromEntry));
	const serverPath = join(entryDir, 'frontend_server.py');
	if (existsSync(serverPath) && readFileSync(serverPath, 'utf8') !== server) {
		throw new Error(`${serverPath} already exists with other content. Rename it, then run this again.`);
	}

	const oakapp = readOakapp(appDir);
	const pageTitle = title?.trim() || titleFrom(appDir);
	const summary = { app: appDir, created: [], updated: [], notes: [] };
	const rel = (path) => relative(appDir, path).split(sep).join('/');

	cpSync(join(ASSETS, 'frontend'), frontendDir, { recursive: true });
	for (const [file, replacement] of [['index.html', escapeHtml(pageTitle)], ['src/App.tsx', null]]) {
		const path = join(frontendDir, file);
		const text = readFileSync(path, 'utf8');
		writeFileSync(path, replacement === null ? text.replace("'__APP_TITLE__'", `'${pageTitle.replace(/[\\']/g, '\\$&')}'`) : text.replace('__APP_TITLE__', replacement));
	}
	summary.created.push('frontend/');
	if (!existsSync(serverPath)) {
		writeFileSync(serverPath, server);
		summary.created.push(rel(serverPath));
	}

	if (oakapp) {
		let text = oakapp.text;
		if ('static_frontend' in oakapp.tables) {
			summary.notes.push('oakapp.toml already has [static_frontend]. Check that dist_path is "./frontend/dist" and that its build steps build frontend/.');
		} else {
			if (oakapp.buildContainer === null) {
				const { firstTable } = oakapp;
				text = firstTable === -1
					? `${text.replace(/\n*$/, '\n')}${NODE_FOR_BUILD}\n`
					: `${text.slice(0, firstTable).replace(/\n*$/, '\n\n')}${NODE_FOR_BUILD}\n\n${text.slice(firstTable)}`;
			} else {
				summary.notes.push('oakapp.toml already has prepare_build_container. Make sure it installs Node 24 with nvm, which the [static_frontend] build steps use.');
			}
			text = `${text.replace(/\n*$/, '\n')}\n${STATIC_FRONTEND}`;
			writeFileSync(oakapp.file, text);
			summary.updated.push('oakapp.toml');
		}
		if (oakapp.tables.base_image?.image_name !== 'luxonis/oakapp-base') {
			summary.notes.push('oakapp.toml does not use the luxonis/oakapp-base image, whose web server serves [static_frontend] on the device. Without it, nothing serves the frontend in standalone mode. Ask before changing the base image.');
		}
		const ignore = join(appDir, '.oakappignore');
		const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : null;
		if (ignored === null) {
			writeFileSync(ignore, 'node_modules/\n');
			summary.created.push('.oakappignore');
		} else if (!/^\s*\/?(frontend\/)?node_modules\/?\s*$/m.test(ignored)) {
			writeFileSync(ignore, `${ignored.replace(/\n*$/, '\n')}node_modules/\n`);
			summary.updated.push('.oakappignore');
		}
	}

	summary.next = [
		`Edit ${rel(entryPath)}: call serve_frontend() from frontend_server before the pipeline starts, and pass serveFrontend=False to dai.RemoteConnection.`,
		'Fill SERVICES in frontend/src/services.ts and the controls in frontend/src/Controls.tsx.',
		'cd frontend && npm ci && npm run build',
		`node ${fileURLToPath(new URL('./check.mjs', import.meta.url))} --app ${appDir}`,
	];
	return summary;
}

if (isMain(import.meta.url)) {
	const { values } = parseArgs({ options: { app: { type: 'string' }, entry: { type: 'string' }, title: { type: 'string' } } });
	if (!values.app) {
		console.error('Usage: node scaffold.mjs --app <app dir> [--entry <script>] [--title <page title>]');
		process.exit(64);
	}
	try {
		console.log(JSON.stringify(scaffold(values), null, 2));
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
