import { defineConfig } from 'vitest/config';

// Black-box suite against the running docker compose stack. Strictly sequential: tests restart/kill containers
// and flush Redis, so no two test files (or tests) may overlap.
export default defineConfig({
  test: {
    include: ['**/*.spec.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    globalSetup: ['./global-setup.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    sequence: { concurrent: false, shuffle: false },
    testTimeout: 300_000,
    hookTimeout: 240_000,
    retry: 0,
    reporters: ['verbose'],
  },
});
