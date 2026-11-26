// The seed as the migrate container runs it: `node dist/seed.js`, a real child process with NODE_V8_COVERAGE.
// `seedFixtures` itself is covered in-process by test/db; this pins the script path (`main()`, exit codes).
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createPrisma } from '../../src/index.js';
import { truncateAll } from '../../src/testing.js';
import { closedPort, killAllSpawned, spawnEntry } from '../../src/testing-process.js';

let prisma: PrismaClient;
beforeAll(async () => {
  prisma = createPrisma(inject('databaseUrl'));
});
afterAll(async () => prisma.$disconnect());
beforeEach(async () => truncateAll(prisma));
afterEach(() => killAllSpawned());

const seed = async (databaseUrl: string, script = 'dist/seed.js') => {
  const p = spawnEntry(inject('pkgDir'), script, { DATABASE_URL: databaseUrl });
  const exit = await p.exited;
  return { ...exit, out: p.lines.join('\n') };
};

describe('node dist/seed.js (the migrate container)', () => {
  it('run twice against a fresh database: creates the 3 seed documents exactly once', async () => {
    expect(await prisma.document.count()).toBe(0);

    const first = await seed(inject('databaseUrl'));
    expect(first.code, first.out).toBe(0);
    expect(first.out.match(/created v1 with a queued run/g)).toHaveLength(3);

    const second = await seed(inject('databaseUrl'));
    expect(second.code, second.out).toBe(0);
    expect(second.out.match(/already present, skipped/g)).toHaveLength(3);
    expect(second.out).not.toMatch(/created v1/);

    const docs = await prisma.document.findMany({ orderBy: { id: 'asc' }, include: { versions: { include: { runs: true } } } });
    expect(docs.map((d) => [d.id, d.type, d.currentVersion, d.versions.map((v) => v.versionNo), d.versions[0]!.runs.map((r) => r.status)])).toEqual([
      ['doc-invoice-001', 'invoice', 1, [1], ['queued']],
      ['doc-lease-001', 'lease', 1, [1], ['queued']],
      ['doc-report-001', 'market_report', 1, [1], ['queued']],
    ]);
    expect(await prisma.documentVersion.count()).toBe(3);
    expect(await prisma.extractionRun.count()).toBe(3);
  });

  it('also seeds when started through a symlinked path (node_modules/@lomi/db/dist/seed.js is a pnpm symlink)', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'lomi-seed-'));
    try {
      symlinkSync(path.join(inject('pkgDir'), 'dist'), path.join(tmp, 'dist'), 'dir');
      const res = await seed(inject('databaseUrl'), path.join(tmp, 'dist', 'seed.js'));
      expect(res.code, res.out).toBe(0);
      expect(res.out.match(/created v1 with a queued run/g)).toHaveLength(3);
      expect(await prisma.document.count()).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exits 1 with a logged error when the database is unreachable (the API and worker then never start)', async () => {
    const res = await seed(`postgresql://lomi:lomi@127.0.0.1:${await closedPort()}/lomi_test_db_proc?connect_timeout=2`);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/\[seed\] failed/);
  });
});
