// The run state machine against real Postgres: every transition is a conditional UPDATE, so these tests pin
// down who wins when actors race and what the fencing token (attempt) protects.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createPrisma } from '../../src/index.js';
import {
  claimRun,
  failRun,
  heartbeatRun,
  listQueuedRuns,
  queueRetryRun,
  recoverStaleRuns,
  releaseRun,
  supersedeActiveRuns,
} from '../../src/runs.js';
import { seedFixtures } from '../../src/seed.js';
import { insertDocument, truncateAll } from '../../src/testing.js';

let prisma: PrismaClient;
beforeAll(() => {
  prisma = createPrisma(inject('databaseUrl'));
});
afterAll(async () => prisma.$disconnect());
beforeEach(async () => truncateAll(prisma));

const PDF = new TextEncoder().encode('%PDF-1.4 test');
const run = (id: string) => prisma.extractionRun.findUniqueOrThrow({ where: { id } });
const expireLease = (id: string) => prisma.$executeRaw`UPDATE extraction_runs SET lease_until = now() - interval '1 second' WHERE id = ${id}`;

describe('claim / heartbeat', () => {
  it('only a queued run can be claimed, and only once', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'd1', fileBytes: PDF });
    const [a, b] = await Promise.all([claimRun(prisma, runId, 30_000, 'w-a'), claimRun(prisma, runId, 30_000, 'w-b')]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toEqual([{ id: runId, attempt: 1, versionId }]);
    const r = await run(runId);
    expect(r.status).toBe('extracting');
    expect(r.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await claimRun(prisma, runId, 30_000, 'w-c')).toBeNull();
  });

  it('heartbeat extends the lease only for the current attempt of an extracting run', async () => {
    const { runId } = await insertDocument(prisma, { id: 'd1', fileBytes: PDF });
    await claimRun(prisma, runId, 1_000, 'w');
    const before = (await run(runId)).leaseUntil!.getTime();
    expect(await heartbeatRun(prisma, runId, 1, 60_000)).toBe(true);
    expect((await run(runId)).leaseUntil!.getTime()).toBeGreaterThan(before + 30_000);
    expect(await heartbeatRun(prisma, runId, 2, 60_000)).toBe(false); // stale fencing token
    await failRun(prisma, runId, 1, 'x');
    expect(await heartbeatRun(prisma, runId, 1, 60_000)).toBe(false); // no longer extracting
  });
});

describe('queueRetryRun', () => {
  it('inserts a queued run only when the version has no active run; concurrent calls create exactly one', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'd1', fileBytes: PDF });
    expect(await queueRetryRun(prisma, versionId, 2)).toBeNull(); // v1's run is still queued
    await claimRun(prisma, runId, 30_000, 'w');
    expect(await queueRetryRun(prisma, versionId, 2)).toBeNull(); // ... or extracting
    await failRun(prisma, runId, 1, 'boom');
    const ids = await Promise.all(Array.from({ length: 6 }, () => queueRetryRun(prisma, versionId, 2)));
    const created = ids.filter(Boolean);
    expect(created).toHaveLength(1);
    expect(await run(created[0]!)).toMatchObject({ status: 'queued', attempt: 2, versionId });
    expect(await prisma.extractionRun.count({ where: { versionId } })).toBe(2);
  });
});

describe('failRun', () => {
  it('records the error and debug info, keeping earlier prompt/response when none is given', async () => {
    const { runId } = await insertDocument(prisma, { id: 'd1', fileBytes: PDF });
    await claimRun(prisma, runId, 30_000, 'w');
    await prisma.extractionRun.update({ where: { id: runId }, data: { prompt: 'P0' } });
    expect(await failRun(prisma, runId, 1, 'boom'.repeat(2000), { rawResponse: 'RAW', provider: 'anthropic', model: 'm' })).toBe(true);
    const r = await run(runId);
    expect(r).toMatchObject({ status: 'failed', prompt: 'P0', rawResponse: 'RAW', provider: 'anthropic', model: 'm', leaseUntil: null });
    expect(r.error).toHaveLength(4000); // capped
    expect(r.finishedAt).not.toBeNull();
  });

  it('is fenced: a stale attempt or a non-extracting run is not touched', async () => {
    const { runId } = await insertDocument(prisma, { id: 'd1', fileBytes: PDF });
    expect(await failRun(prisma, runId, 1, 'x')).toBe(false); // still queued
    await claimRun(prisma, runId, 30_000, 'w');
    expect(await failRun(prisma, runId, 2, 'x')).toBe(false);
    expect((await run(runId)).status).toBe('extracting');
  });
});

describe('releaseRun (graceful shutdown)', () => {
  it('hands the run back as queued with attempt+1, fencing out the old holder', async () => {
    const { runId } = await insertDocument(prisma, { id: 'd1', fileBytes: PDF });
    await claimRun(prisma, runId, 30_000, 'w');
    expect(await releaseRun(prisma, runId, 1)).toBe(2);
    expect(await run(runId)).toMatchObject({ status: 'queued', attempt: 2, workerId: null, leaseUntil: null });
    expect(await releaseRun(prisma, runId, 1)).toBeNull();
    expect(await failRun(prisma, runId, 1, 'late')).toBe(false);
  });
});

describe('recoverStaleRuns (reconciler)', () => {
  it('requeues an expired lease held by ANOTHER worker, bumping attempt and recoveries', async () => {
    const { runId } = await insertDocument(prisma, { id: 'd1', fileBytes: PDF });
    await claimRun(prisma, runId, 30_000, 'w-dead');
    expect(await recoverStaleRuns(prisma, 3, 'w-alive')).toEqual({ requeued: [], failed: [] }); // lease still live
    await expireLease(runId);
    expect(await recoverStaleRuns(prisma, 3, 'w-alive')).toEqual({ requeued: [{ id: runId, attempt: 2 }], failed: [] });
    expect(await run(runId)).toMatchObject({ status: 'queued', attempt: 2, recoveries: 1, workerId: null });
    // The dead worker coming back late cannot touch it any more.
    expect(await heartbeatRun(prisma, runId, 1, 30_000)).toBe(false);
    expect(await failRun(prisma, runId, 1, 'late')).toBe(false);
  });

  it('on boot, reclaims runs held under its OWN id even if the lease has not expired; other ids are left alone', async () => {
    const mine = await insertDocument(prisma, { id: 'd1', fileBytes: PDF });
    const theirs = await insertDocument(prisma, { id: 'd2', fileBytes: PDF });
    await claimRun(prisma, mine.runId, 30_000, 'worker-1');
    await claimRun(prisma, theirs.runId, 30_000, 'worker-2');
    const res = await recoverStaleRuns(prisma, 3, 'worker-1');
    expect(res.requeued).toEqual([{ id: mine.runId, attempt: 2 }]);
    expect((await run(theirs.runId)).status).toBe('extracting');
    // Without an own id (interval tick), nothing with a live lease is touched.
    await claimRun(prisma, mine.runId, 30_000, 'worker-1');
    expect(await recoverStaleRuns(prisma, 3)).toEqual({ requeued: [], failed: [] });
  });

  it('after MAX_RUN_ATTEMPTS recoveries the run fails visibly instead of looping forever', async () => {
    const { runId } = await insertDocument(prisma, { id: 'd1', fileBytes: PDF });
    for (let i = 1; i <= 2; i++) {
      await claimRun(prisma, runId, 30_000, 'w');
      await expireLease(runId);
      expect((await recoverStaleRuns(prisma, 3)).requeued).toHaveLength(1);
    }
    await claimRun(prisma, runId, 30_000, 'w');
    await expireLease(runId);
    expect(await recoverStaleRuns(prisma, 3)).toEqual({ requeued: [], failed: [runId] });
    const r = await run(runId);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/interrupted 3 times.*Retry/);
    expect(r.leaseUntil).toBeNull();
  });

  it('a lease with no expiry at all (NULL) counts as stale', async () => {
    const { runId } = await insertDocument(prisma, { id: 'd1', fileBytes: PDF, runStatus: 'extracting' });
    expect((await recoverStaleRuns(prisma, 3)).requeued).toEqual([{ id: runId, attempt: 2 }]);
  });
});

describe('listQueuedRuns / supersedeActiveRuns', () => {
  it('lists queued runs oldest first', async () => {
    const a = await insertDocument(prisma, { id: 'd1', fileBytes: PDF });
    const b = await insertDocument(prisma, { id: 'd2', fileBytes: PDF });
    await claimRun(prisma, b.runId, 30_000, 'w');
    const c = await insertDocument(prisma, { id: 'd3', fileBytes: PDF });
    expect(await listQueuedRuns(prisma)).toEqual([
      { id: a.runId, attempt: 1 },
      { id: c.runId, attempt: 1 },
    ]);
  });

  it('supersedes queued and extracting runs of that document only, leaving finished runs alone', async () => {
    const a = await insertDocument(prisma, { id: 'd1', fileBytes: PDF });
    const other = await insertDocument(prisma, { id: 'd2', fileBytes: PDF });
    const done = await prisma.extractionRun.create({ data: { versionId: a.versionId, status: 'failed', attempt: 0 } });
    await claimRun(prisma, a.runId, 30_000, 'w');
    expect(await supersedeActiveRuns(prisma, 'd1')).toBe(1);
    expect(await run(a.runId)).toMatchObject({ status: 'superseded', leaseUntil: null, error: expect.stringMatching(/Superseded/) });
    expect((await run(done.id)).status).toBe('failed');
    expect((await run(other.runId)).status).toBe('queued');
    // A superseded run's in-flight worker is fenced out of every transition.
    expect(await heartbeatRun(prisma, a.runId, 1, 30_000)).toBe(false);
    expect(await failRun(prisma, a.runId, 1, 'x')).toBe(false);
    expect(await releaseRun(prisma, a.runId, 1)).toBeNull();
  });
});

describe('seed (contract §4)', () => {
  const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');

  it('creates v1 of each fixture document with one queued run, and is idempotent', async () => {
    const quiet = () => undefined;
    expect(await seedFixtures(prisma, fixtures, quiet)).toEqual(['doc-invoice-001', 'doc-lease-001', 'doc-report-001']);
    expect(await seedFixtures(prisma, fixtures, quiet)).toEqual([]);
    const docs = await prisma.document.findMany({ orderBy: { id: 'asc' }, include: { versions: { include: { runs: true } } } });
    expect(docs.map((d) => [d.id, d.type, d.currentVersion, d.versions.length])).toEqual([
      ['doc-invoice-001', 'invoice', 1, 1],
      ['doc-lease-001', 'lease', 1, 1],
      ['doc-report-001', 'market_report', 1, 1],
    ]);
    for (const d of docs) {
      expect(d.versions[0]!.runs.map((r) => r.status)).toEqual(['queued']);
      expect(Buffer.from(d.versions[0]!.fileBytes).subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('never resets review work on a re-seed', async () => {
    await seedFixtures(prisma, fixtures, () => undefined);
    await prisma.document.update({ where: { id: 'doc-invoice-001' }, data: { title: 'Renamed by a user', currentVersion: 1 } });
    await seedFixtures(prisma, fixtures, () => undefined);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: 'doc-invoice-001' } })).title).toBe('Renamed by a user');
  });
});
