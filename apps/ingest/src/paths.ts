import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (apps/ingest/src → ../../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
