import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP = new Set(['node_modules', 'frontend', 'dist', 'build', 'venv', '.venv', '__pycache__', '.git']);

export function pythonFiles(appDir, dir = appDir, depth = 0) {
	if (depth > 4) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.isDirectory()) return SKIP.has(entry.name) || entry.name.startsWith('.') ? [] : pythonFiles(appDir, join(dir, entry.name), depth + 1);
		return entry.name.endsWith('.py') ? [relative(appDir, join(dir, entry.name)).split(sep).join('/')] : [];
	});
}

const stringArgument = (call) => new RegExp(`\\.${call}\\(\\s*(?:"([^"]*)"|'([^']*)'|([^,)]+))`, 'g');

export function registeredNames(appDir) {
	const names = { services: [], topics: [], dynamic: { services: [], topics: [] } };
	for (const file of pythonFiles(appDir)) {
		const text = readFileSync(join(appDir, file), 'utf8');
		for (const [kind, calls] of [['services', ['registerService', 'registerBinaryService']], ['topics', ['addTopic']]]) {
			for (const call of calls) {
				for (const match of text.matchAll(stringArgument(call))) {
					const literal = match[1] ?? match[2];
					if (literal !== undefined) names[kind].push(literal);
					else names.dynamic[kind].push(`${file}: ${call}(${match[3].trim()})`);
				}
			}
		}
	}
	return names;
}

export const TABLE_HEADER = /^[ \t]*\[\[?\s*([A-Za-z0-9_.\-"' ]+?)\s*\]\]?\s*(#.*)?$/m;

export function readOakapp(appDir) {
	const file = join(appDir, 'oakapp.toml');
	if (!existsSync(file)) return null;
	const text = readFileSync(file, 'utf8');
	const tables = {};
	let table = '';
	for (const line of text.split('\n')) {
		const header = line.match(TABLE_HEADER);
		if (header) {
			table = header[1].trim();
			tables[table] ??= {};
			continue;
		}
		const pair = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
		if (pair) (tables[table] ??= {})[pair[1]] = unquote(pair[2].trim());
	}
	const firstTable = text.search(TABLE_HEADER);
	const top = firstTable === -1 ? text : text.slice(0, firstTable);
	const buildContainer = top.match(/^\s*prepare_build_container\s*=([\s\S]*?)(?=^\s*[A-Za-z0-9_]+\s*=|(?![\s\S]))/m)?.[1] ?? null;
	return { file, text, tables, firstTable, buildContainer };
}

const unquote = (value) => value?.replace(/^["']|["']\s*(#.*)?$/g, '');
