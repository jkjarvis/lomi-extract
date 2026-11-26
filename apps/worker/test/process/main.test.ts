// The worker as the container runs it: `node dist/main.js` as a child process (NODE_V8_COVERAGE), against a
// throwaway lomi_test_worker_proc database and Redis logical DB 15 of this stack's Redis, with the mock LLM.
// A TCP proxy in front of Postgres/Redis takes a dependency "down" and brings it back without touching it.
import { readFileSync } from 'node:fs';
import { EXPECTED_FIELDS } from '@lomi/core';
import type { ExtractionJob, PrismaClient } from '@lomi/db';
import { EXTRACTION_QUEUE, createPrisma, jobIdFor } from '@lomi/db';
import { insertDocument, truncateAll } from '@lomi/db/testing';
import type { Spawned } from '@lomi/db/testing-process';
import { closedPort, flushTestRedis, killAllSpawned, processTestRedisUrl, spawnEntry, startTcpProxy, until } from '@lomi/db/testing-process';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

const REDIS_URL = processTestRedisUrl(15);
const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../../../../fixtures/documents/${n}`, import.meta.url)));
const INVOICE = fixture('invoice-001.pdf');
const LEASE = fixture('lease-excerpt-001.pdf');

let prisma: PrismaClient;
let redis: Redis;
let queue: Queue<ExtractionJob>;
beforeAll(async () => {
  prisma = createPrisma(inject('databaseUrl'));
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue<ExtractionJob>(EXTRACTION_QUEUE, { connection: redis });
});
afterAll(async () => {
  await flushTestRedis(redis);
  await queue.close();
  redis.disconnect();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await truncateAll(prisma);
  await flushTestRedis(redis);
});
afterEach(() => killAllSpawned());

type Knobs = Partial<Record<'DATABASE_URL' | 'REDIS_URL' | 'WORKER_ID' | 'RECONCILE_INTERVAL_MS' | 'MOCK_LLM_DELAY_MS' | 'LEASE_MS', string>>;
const startWorker = (env: Knobs = {}) =>
  spawnEntry(inject('pkgDir'), 'dist/main.js', {
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL,
    WORKER_ID: 'proc-test',
    LLM_PROVIDER: 'mock',
    RECONCILE_INTERVAL_MS: '60000',
    ...env,
  });

const msg = (p: Spawned, m: string) => p.logs().filter((l) => l.msg === m);
const ready = (p: Spawned, timeoutMs?: number) => p.waitForLine((l) => l.includes('"msg":"worker ready"'), timeoutMs);
const runRow = (id: string) => prisma.extractionRun.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) => (await runRow(id)).status;
const extracted = (runId: string, timeoutMs = 20_000) =>
  until(async () => (await statusOf(runId)) === 'extracted', timeoutMs, `run ${runId} to be extracted`);

/** Graceful: exit 0 well before the 8 s force-exit timer in stop(). */
async function expectGracefulExit(p: Spawned) {
  const exit = await p.stop('SIGTERM');
  expect(exit, p.lines.slice(-10).join('\n')).toMatchObject({ code: 0, signal: null });
  expect(exit.ms).toBeLessThan(7_000);
  // Exactly one shutdown, however many signals arrived (their delivery order is up to the OS).
  expect(msg(p, 'shutting down')).toEqual([expect.objectContaining({ signal: expect.stringMatching(/^SIG(TERM|INT)$/) })]);
}

describe('node dist/main.js', () => {
  it('boots, reconciles on boot (a pre-inserted queued run is extracted), processes a live job, then exits 0 on SIGTERM', async () => {
    const boot = await insertDocument(prisma, { id: 'boot-doc', type: 'invoice', fileBytes: INVOICE });
    const p = startWorker();
    await ready(p);
    expect(msg(p, 'worker starting')).toEqual([
      expect.objectContaining({ workerId: 'proc-test', provider: 'mock', reconcileIntervalMs: 60_000, leaseMs: 30_000, concurrency: 4 }),
    ]);

    // Nobody enqueued boot-doc: only the boot reconcile can have found it in Postgres.
    await extracted(boot.runId);
    expect(await prisma.extractedValue.count({ where: { versionId: boot.versionId } })).toBe(EXPECTED_FIELDS.invoice.length);
    expect(msg(p, 'run extracted')).toEqual([expect.objectContaining({ runId: boot.runId, attempt: 1 })]);

    // A live job, rung the way the API does it.
    const live = await insertDocument(prisma, { id: 'live-doc', type: 'lease', fileBytes: LEASE });
    await queue.add('extract', { runId: live.runId }, { jobId: jobIdFor(live.runId, 1) });
    await extracted(live.runId);
    const values = await prisma.extractedValue.findMany({ where: { versionId: live.versionId } });
    expect(values.map((v) => v.field).sort()).toEqual(EXPECTED_FIELDS.lease.map((f) => f.field).sort());
    const run = await runRow(live.runId);
    expect(run.prompt).toBeTruthy();
    expect(run.rawResponse).toBeTruthy();

    await expectGracefulExit(p);
  });

  it('honours RECONCILE_INTERVAL_MS: a never-enqueued queued run waits for the next tick', async () => {
    // Slow interval (60 s): a run inserted after boot is not picked up in the next few seconds.
    const slow = startWorker({ WORKER_ID: 'proc-slow' });
    await ready(slow);
    const waiting = await insertDocument(prisma, { id: 'waiting-doc', fileBytes: INVOICE });
    await new Promise((r) => setTimeout(r, 2_500));
    expect(await statusOf(waiting.runId)).toBe('queued');
    expect(await queue.getJob(jobIdFor(waiting.runId, 1))).toBeUndefined();
    await expectGracefulExit(slow);

    // Fast interval (300 ms): the tick enqueues it, and also recovers a run whose worker died (expired lease).
    const fast = startWorker({ WORKER_ID: 'proc-fast', RECONCILE_INTERVAL_MS: '300' });
    await ready(fast);
    const orphan = await insertDocument(prisma, { id: 'orphan-doc', fileBytes: INVOICE, runStatus: 'extracting' });
    await prisma.extractionRun.update({ where: { id: orphan.runId }, data: { workerId: 'dead-worker', leaseUntil: new Date(Date.now() - 1_000) } });
    const late = await insertDocument(prisma, { id: 'late-doc', fileBytes: INVOICE });
    await extracted(late.runId, 5_000);
    await extracted(orphan.runId, 5_000);
    expect(await runRow(orphan.runId)).toMatchObject({ attempt: 2, workerId: 'proc-fast' });
    expect(msg(fast, 'recovered stale runs')).toEqual([expect.objectContaining({ requeued: [orphan.runId] })]);
    await expectGracefulExit(fast);
  });

  it('SIGTERM mid-extraction releases the run back to queued (attempt+1, re-enqueued) and exits 0; the next worker finishes it', async () => {
    const doc = await insertDocument(prisma, { id: 'slow-doc', fileBytes: INVOICE });
    const p = startWorker({ MOCK_LLM_DELAY_MS: '120000' });
    await until(async () => (await statusOf(doc.runId)) === 'extracting', 15_000, 'the run to be claimed');
    await p.waitForLine((l) => l.includes('"msg":"run claimed"'));

    // Repeated signals (docker stop, then Ctrl-C) must not start a second shutdown.
    p.child.kill('SIGTERM');
    p.child.kill('SIGINT');
    await expectGracefulExit(p);
    expect(msg(p, 'run released on shutdown')).toEqual([expect.objectContaining({ runId: doc.runId, attempt: 1, nextAttempt: 2 })]);
    expect(await runRow(doc.runId)).toMatchObject({ status: 'queued', attempt: 2, workerId: null, leaseUntil: null });
    expect(await prisma.extractedValue.count({ where: { versionId: doc.versionId } })).toBe(0);
    expect((await queue.getJob(jobIdFor(doc.runId, 2)))?.data).toEqual({ runId: doc.runId });

    const next = startWorker({ WORKER_ID: 'proc-next' });
    await extracted(doc.runId);
    expect(await runRow(doc.runId)).toMatchObject({ attempt: 2, workerId: 'proc-next' });
    await expectGracefulExit(next);
  });
});

describe('node dist/main.js with Postgres or Redis down', () => {
  const pg = new URL(inject('databaseUrl'));
  const rd = new URL(REDIS_URL);

  it('Postgres unreachable: logs and retries the boot reconcile every 2 s, and comes up once Postgres is back', async () => {
    const proxy = await startTcpProxy({ host: pg.hostname, port: Number(pg.port || 5432) }, 'refuse');
    try {
      const doc = await insertDocument(prisma, { id: 'pg-down-doc', fileBytes: INVOICE });
      const url = new URL(pg);
      url.hostname = '127.0.0.1';
      url.port = String(proxy.port);
      const p = startWorker({ DATABASE_URL: url.toString() });

      await until(async () => msg(p, 'boot reconcile failed, retrying in 2s').length >= 2, 15_000, 'two failed boot reconciles');
      expect(p.child.exitCode).toBeNull(); // retrying, not crashed
      expect(msg(p, 'worker ready')).toEqual([]);
      expect(await statusOf(doc.runId)).toBe('queued');

      proxy.setMode('forward');
      await ready(p, 15_000);
      await extracted(doc.runId);
      await expectGracefulExit(p);
    } finally {
      await proxy.close();
    }
  });

  it('Postgres lost after boot: reconcile ticks log and retry, and the worker carries on once it is back', async () => {
    const proxy = await startTcpProxy({ host: pg.hostname, port: Number(pg.port || 5432) }, 'forward');
    try {
      const url = new URL(pg);
      url.hostname = '127.0.0.1';
      url.port = String(proxy.port);
      url.searchParams.set('connect_timeout', '1');
      const p = startWorker({ DATABASE_URL: url.toString(), RECONCILE_INTERVAL_MS: '200' });
      await ready(p);
      proxy.setMode('refuse');
      await until(async () => msg(p, 'reconcile failed (will retry)').length >= 2, 15_000, 'failed reconcile ticks');
      expect(p.child.exitCode).toBeNull();

      const doc = await insertDocument(prisma, { id: 'pg-lost-doc', fileBytes: INVOICE });
      proxy.setMode('forward');
      // Prisma's engine takes ~15 s to open a fresh connection after this kind of outage (see TEST_TRIAGE.md).
      await extracted(doc.runId, 45_000);
      await expectGracefulExit(p);
    } finally {
      await proxy.close();
    }
  });

  it('Postgres unreachable: SIGTERM during the boot retry loop still exits 0', async () => {
    const p = startWorker({ DATABASE_URL: `postgresql://lomi:lomi@127.0.0.1:${await closedPort()}/lomi_test_worker_proc` });
    await p.waitForLine((l) => l.includes('boot reconcile failed'), 15_000);
    await expectGracefulExit(p);
    expect(msg(p, 'worker ready')).toEqual([]);
  });

  it('Redis unreachable: warns and keeps reconnecting without becoming ready, and comes up once Redis is back', async () => {
    const proxy = await startTcpProxy({ host: rd.hostname, port: Number(rd.port) }, 'refuse');
    try {
      const doc = await insertDocument(prisma, { id: 'redis-down-doc', fileBytes: INVOICE });
      const p = startWorker({ REDIS_URL: `redis://127.0.0.1:${proxy.port}/15` });

      await until(async () => msg(p, 'redis error').length >= 2, 15_000, 'redis connection errors');
      await new Promise((r) => setTimeout(r, 1_500));
      expect(p.child.exitCode).toBeNull();
      expect(msg(p, 'worker ready')).toEqual([]); // the boot reconcile waits for Redis to enqueue

      proxy.setMode('forward');
      await ready(p, 20_000);
      await extracted(doc.runId);
      await expectGracefulExit(p);
    } finally {
      await proxy.close();
    }
  });

  it('Redis lost after boot: reconcile ticks do not pile up, and a run queued meanwhile is extracted once Redis is back', async () => {
    const proxy = await startTcpProxy({ host: rd.hostname, port: Number(rd.port) }, 'forward');
    try {
      const p = startWorker({ REDIS_URL: `redis://127.0.0.1:${proxy.port}/15`, RECONCILE_INTERVAL_MS: '200' });
      await ready(p);
      proxy.setMode('refuse');
      await until(async () => msg(p, 'redis error').length >= 1, 10_000, 'the worker to notice Redis is gone');
      const doc = await insertDocument(prisma, { id: 'redis-lost-doc', fileBytes: INVOICE });
      await new Promise((r) => setTimeout(r, 1_500)); // several 200 ms ticks while one is stuck enqueueing
      expect(await statusOf(doc.runId)).toBe('queued');
      expect(p.child.exitCode).toBeNull();

      proxy.setMode('forward');
      await extracted(doc.runId);
      await expectGracefulExit(p);
    } finally {
      await proxy.close();
    }
  });

  it('Redis unreachable: SIGTERM while the boot reconcile is stuck enqueueing still exits 0 promptly; the run stays queued', async () => {
    const doc = await insertDocument(prisma, { id: 'stuck-doc', fileBytes: INVOICE });
    const p = startWorker({ REDIS_URL: `redis://127.0.0.1:${await closedPort()}/15` });
    await until(async () => msg(p, 'redis error').length >= 2, 15_000, 'redis connection errors');
    await expectGracefulExit(p);
    expect(await runRow(doc.runId)).toMatchObject({ status: 'queued', attempt: 1 });
  });
});
