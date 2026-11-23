import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'ingest',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
