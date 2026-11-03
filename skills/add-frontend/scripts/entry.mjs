import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node resolves symlinks for import.meta.url but keeps argv[1] as invoked, and harnesses install skills as symlinks.
export const isMain = (moduleUrl) => Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
