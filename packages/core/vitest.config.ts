import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `test/*.test.ts` are the implementer's unit tests; `test/spec/*.spec.ts` is the independent spec suite written
// from CONTRACT.md without seeing the implementation. The spec files import '@lomi/core', aliased to the source so
// they always test the current code (not a stale dist/).
export default defineConfig({
  resolve: { alias: { '@lomi/core': fileURLToPath(new URL('./src/index.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts', 'test/spec/**/*.spec.ts'], environment: 'node' },
});
