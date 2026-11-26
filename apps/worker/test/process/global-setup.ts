import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { createTestDatabase, dropTestDatabase } from '@lomi/db/testing';
import { assertBuilt, resetV8CoverageDir } from '@lomi/db/testing-process';

const NAME = 'lomi_test_worker_proc';
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The process tests run the built entry points, so dist/ must be current; their raw V8 coverage starts empty.
export default async function setup(project: TestProject) {
  assertBuilt(PKG_DIR);
  resetV8CoverageDir(PKG_DIR);
  project.provide('databaseUrl', await createTestDatabase(NAME));
  project.provide('pkgDir', PKG_DIR);
  return async () => {
    if (!process.env.KEEP_TEST_DB) await dropTestDatabase(NAME);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    pkgDir: string;
  }
}
