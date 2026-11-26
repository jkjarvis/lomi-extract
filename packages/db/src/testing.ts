/**
 * Test support (not used at runtime): a throwaway, fully migrated Postgres database per test suite.
 * DB-backed tests run against the compose stack's Postgres (TEST_DATABASE_URL, default the contract's
 * postgresql://lomi:lomi@localhost:5432/lomi) but never touch its `lomi` database: each suite drops and
 * recreates its own `lomi_test_*` database, so the running app's data is never at risk.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { createPrisma } from './index.js';

export const DEFAULT_TEST_SERVER_URL = 'postgresql://lomi:lomi@localhost:5432/lomi';

export function testDatabaseUrl(name: string, server: string = process.env.TEST_DATABASE_URL || DEFAULT_TEST_SERVER_URL): string {
  if (!/^lomi_test_[a-z0-9_]+$/.test(name)) throw new Error(`Refusing to use test database "${name}" (must match lomi_test_*)`);
  const u = new URL(server);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Drop + create `name` on the test server and apply every migration. Returns its URL. */
export async function createTestDatabase(name: string): Promise<string> {
  const url = testDatabaseUrl(name);
  const admin = createPrisma(process.env.TEST_DATABASE_URL || DEFAULT_TEST_SERVER_URL);
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } catch (err) {
    throw new Error(
      `DB-backed tests need Postgres (start it with \`docker compose up -d postgres\` or set TEST_DATABASE_URL): ${String(err)}`,
    );
  } finally {
    await admin.$disconnect();
  }
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const schema = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schema], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  return url;
}

export async function dropTestDatabase(name: string): Promise<void> {
  testDatabaseUrl(name);
  const admin = createPrisma(process.env.TEST_DATABASE_URL || DEFAULT_TEST_SERVER_URL);
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
}

/** Empty every table (between tests). */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE reviews, extracted_values, extraction_runs, document_versions, documents RESTART IDENTITY CASCADE',
  );
}

export interface InsertedDoc {
  documentId: string;
  versionId: string;
  runId: string;
}

/** Insert a document with version `versionNo` (and a run) directly, the way the API's upload transaction does. */
export async function insertDocument(
  prisma: PrismaClient,
  opts: { id: string; type?: 'invoice' | 'lease' | 'market_report'; fileBytes: Uint8Array; parsedText?: string | null; runStatus?: 'queued' | 'extracting' },
): Promise<InsertedDoc> {
  const doc = await prisma.document.create({
    data: {
      id: opts.id,
      type: opts.type ?? 'invoice',
      title: opts.id,
      currentVersion: 1,
      versions: {
        create: {
          versionNo: 1,
          fileName: `${opts.id}.pdf`,
          fileBytes: Uint8Array.from(opts.fileBytes),
          fileSha256: 'test',
          parsedText: opts.parsedText ?? null,
          runs: { create: { status: opts.runStatus ?? 'queued', attempt: 1 } },
        },
      },
    },
    select: { id: true, versions: { select: { id: true, runs: { select: { id: true } } } } },
  });
  return { documentId: doc.id, versionId: doc.versions[0]!.id, runId: doc.versions[0]!.runs[0]!.id };
}
