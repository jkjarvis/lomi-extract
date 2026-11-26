import { defineConfig } from 'vitest/config';

// Three projects: `unit` (pure, no I/O; what `pnpm test` runs), `db` (real Postgres in a throwaway
// lomi_test_api database, see @lomi/db/testing; `pnpm test:db`); `process`
// spawns the real built entry points (`node dist/...`) with NODE_V8_COVERAGE (`pnpm test:process`).
// `pnpm coverage` runs all three and merges the child processes' coverage in.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/db/**', 'test/process/**'], environment: 'node' } },
      {
        test: {
          name: 'db',
          include: ['test/db/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/db/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'process',
          include: ['test/process/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/process/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
