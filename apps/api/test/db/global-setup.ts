import type { TestProject } from 'vitest/node';
import { createTestDatabase, dropTestDatabase } from '@lomi/db/testing';

const NAME = 'lomi_test_api';

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
