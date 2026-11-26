/**
 * Idempotent seed: creates version 1 of every fixture document with a queued extraction run.
 * Existing documents are left untouched, so re-running never duplicates or resets review work.
 * Nothing is enqueued here: the worker's reconciler picks queued runs up from Postgres on boot.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDocType } from '@lomi/core';
import type { PrismaClient } from '@prisma/client';
import { createPrisma } from './index.js';

interface ManifestDoc {
  id: string;
  type: string;
  title: string;
  versions: Array<{ version: number; file: string }>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = process.env.FIXTURES_DIR ?? path.resolve(here, '../../../fixtures');

/** Seed v1 of every manifest document. Returns the ids it created (existing documents are skipped). */
export async function seedFixtures(prisma: PrismaClient, dir: string = fixturesDir, log: (msg: string) => void = console.log): Promise<string[]> {
  const createdIds: string[] = [];
  {
    const manifest = JSON.parse(await readFile(path.join(dir, 'documents.json'), 'utf8')) as ManifestDoc[];
    for (const doc of manifest) {
      if (!isDocType(doc.type)) throw new Error(`Unknown document type in manifest: ${doc.type}`);
      const v1 = doc.versions.find((v) => v.version === 1);
      if (!v1) throw new Error(`Manifest document ${doc.id} has no version 1`);
      const bytes = await readFile(path.join(dir, v1.file));
      const type = doc.type;

      const created = await prisma.$transaction(async (tx) => {
        const existing = await tx.document.findUnique({ where: { id: doc.id } });
        if (existing) return false;
        await tx.document.create({
          data: {
            id: doc.id,
            type,
            title: doc.title,
            currentVersion: 1,
            versions: {
              create: {
                versionNo: 1,
                fileName: path.basename(v1.file),
                fileBytes: bytes,
                fileSha256: createHash('sha256').update(bytes).digest('hex'),
                runs: { create: { status: 'queued', attempt: 1 } },
              },
            },
          },
        });
        return true;
      });
      if (created) createdIds.push(doc.id);
      log(`[seed] ${doc.id}: ${created ? 'created v1 with a queued run' : 'already present, skipped'}`);
    }
  }
  return createdIds;
}

async function main() {
  const prisma = createPrisma();
  try {
    await seedFixtures(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// Run only as a script (`node dist/seed.js`), not when imported by tests. import.meta.url is already the real
// path (Node resolves the main module through symlinks), argv[1] is the path as typed: compare real paths, or
// `node node_modules/@lomi/db/dist/seed.js` (a pnpm symlink) silently seeds nothing and exits 0.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  });
}
