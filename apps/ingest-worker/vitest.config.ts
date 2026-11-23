import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'ingest-worker',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
