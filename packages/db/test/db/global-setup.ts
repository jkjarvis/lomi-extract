import type { TestProject } from 'vitest/node';
import { createTestDatabase, dropTestDatabase } from '../../src/testing.js';

const NAME = 'lomi_test_db';

export default async function setup(project: TestProject) {
  project.provide('databaseUrl', await createTestDatabase(NAME));
  return async () => {
    if (!process.env.KEEP_TEST_DB) await dropTestDatabase(NAME);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
