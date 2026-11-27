import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'review',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each file boots a local workerd + D1 emulator via wrangler's getPlatformProxy.
    testTimeout: 60_000,
    hookTimeout: 90_000,
    pool: 'forks',
  },
});
