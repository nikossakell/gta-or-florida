import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/config', 'apps/worker', 'apps/ingest', 'apps/ingest-worker', 'apps/web', 'scripts'],
  },
});
