import { defineConfig } from 'vitest/config';

// Two projects: `unit` (pure, no I/O; what `pnpm test` runs) and `db` (real Postgres in a throwaway
// lomi_test_db database, see @lomi/db/testing; `pnpm test:db`). `pnpm coverage` runs both.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/db/**'], environment: 'node' } },
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
    ],
  },
});
