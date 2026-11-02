import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import packageJson from './package.json';

const pipelineLibPackageJson = '\0depthai-pipeline-lib-package-json';
const pipelineLibVersion =
	packageJson.dependencies['@luxonis/depthai-pipeline-lib'];

export default defineConfig({
	// Relative asset paths: Luxonis Hub serves the app under /<version>/.
	base: '',
	plugins: [
		react(),
		{
			// depthai-pipeline-lib imports its own package.json, which Vite cannot resolve from the package.
			name: 'depthai-pipeline-lib-package-json',
			resolveId(source, importer) {
				const entry =
					'/node_modules/@luxonis/depthai-pipeline-lib/dist/src/index.js';
				if (
					source === '../package.json' &&
					importer?.replace(/\\/g, '/').endsWith(entry)
				) {
					return pipelineLibPackageJson;
				}
			},
			load(id) {
				if (id === pipelineLibPackageJson) {
					return `export const version = ${JSON.stringify(pipelineLibVersion)}; export default { version };`;
				}
			},
		},
	],
	worker: {
		format: 'es',
	},
	build: {
		rollupOptions: {
			// OAK's build container has a low file-descriptor limit.
			maxParallelFileOps: 8,
			output: {
				format: 'esm',
			},
		},
	},
});
