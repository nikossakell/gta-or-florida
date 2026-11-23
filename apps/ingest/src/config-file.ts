/** Node-only: read data/sources.json from disk (CLI + tests). Workers import the JSON directly. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSourcesConfig, type SourcesConfig } from './normalize.ts';

export function loadSourcesConfig(dataDir: string): SourcesConfig {
  const file = resolve(dataDir, 'sources.json');
  return parseSourcesConfig(JSON.parse(readFileSync(file, 'utf8')), file);
}
