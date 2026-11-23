import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'worker',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each file boots a local workerd + D1 emulator via wrangler's getPlatformProxy.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
