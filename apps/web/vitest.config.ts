import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Component tests render the real components in jsdom with React Testing Library; `fetch` is stubbed per test.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      setupFiles: ['test/setup.ts'],
    },
  }),
);
