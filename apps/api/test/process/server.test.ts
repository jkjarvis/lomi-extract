// The API as the container runs it: `node dist/server.js` as a child process (NODE_V8_COVERAGE), on an
// ephemeral port, against a throwaway lomi_test_api_proc database and Redis logical DB 14 of this stack's Redis.
import { readFileSync } from 'node:fs';
import net from 'node:net';
import type { ExtractionJob, PrismaClient } from '@lomi/db';
import { EXTRACTION_QUEUE, createPrisma, jobIdFor } from '@lomi/db';
import { truncateAll } from '@lomi/db/testing';
import type { Spawned } from '@lomi/db/testing-process';
import { closedPort, flushTestRedis, killAllSpawned, processTestRedisUrl, spawnEntry, until } from '@lomi/db/testing-process';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

const REDIS_URL = processTestRedisUrl(14);
const INVOICE = readFileSync(new URL('../../../../fixtures/documents/invoice-001.pdf', import.meta.url));

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

/** Start the server on an ephemeral port and return its base URL once it logs that it is listening. */
async function startApi(env: Partial<Record<'DATABASE_URL' | 'REDIS_URL' | 'PORT', string>> = {}) {
  const p = spawnEntry(inject('pkgDir'), 'dist/server.js', {
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL,
    PORT: '0',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
    ...env,
  });
  const line = await p.waitForLine(/Server listening at http:\/\/127\.0\.0\.1:\d+/);
  const base = /(http:\/\/127\.0\.0\.1:\d+)/.exec(line)![1]!;
  return { p, base };
}

const upload = (base: string, type = 'invoice') => {
  const form = new FormData();
  form.set('type', type);
  form.set('file', new Blob([INVOICE], { type: 'application/pdf' }), 'invoice-001.pdf');
  return fetch(`${base}/documents`, { method: 'POST', body: form });
};

const refused = (base: string) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(Number(new URL(base).port), '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(true));
  });

async function expectGracefulExit(p: Spawned, signal: NodeJS.Signals, base: string) {
  const exit = await p.stop(signal);
  expect(exit, p.lines.slice(-10).join('\n')).toMatchObject({ code: 0, signal: null });
  expect(exit.ms).toBeLessThan(5_000);
  expect(await refused(base)).toBe(true);
}

describe('node dist/server.js', () => {
  it('boots on an ephemeral port, /health is 200, an upload is enqueued in Redis, and SIGTERM exits 0', async () => {
    const { p, base } = await startApi();

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const res = await upload(base);
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const run = await prisma.extractionRun.findFirstOrThrow({ where: { version: { documentId: id } } });
    expect(run).toMatchObject({ status: 'queued', attempt: 1 });

    // The doorbell: a BullMQ job carrying only the run id, deduplicated by (run, attempt).
    const job = await until(() => queue.getJob(jobIdFor(run.id, 1)), 5_000, 'the enqueued job');
    expect(job.data).toEqual({ runId: run.id });

    await expectGracefulExit(p, 'SIGTERM', base);
  });

  it('/health is 503 db_unavailable while Postgres is unreachable; SIGINT exits 0', async () => {
    const { p, base } = await startApi({ DATABASE_URL: `postgresql://lomi:lomi@127.0.0.1:${await closedPort()}/lomi_test_api_proc?connect_timeout=2` });

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: false, error: { code: 'db_unavailable' } });

    await expectGracefulExit(p, 'SIGINT', base);
  });

  it('with Redis unreachable an upload still returns 202 at once and the run is durable in Postgres', async () => {
    const { p, base } = await startApi({ REDIS_URL: `redis://127.0.0.1:${await closedPort()}/14` });

    const t0 = Date.now();
    const res = await upload(base);
    expect(res.status).toBe(202);
    expect(Date.now() - t0).toBeLessThan(1_500);
    const { id } = (await res.json()) as { id: string };
    expect(await prisma.extractionRun.findFirstOrThrow({ where: { version: { documentId: id } } })).toMatchObject({ status: 'queued' });

    // The enqueue fails fast (no offline queue) and is logged; the worker's reconciler owns the repair.
    await p.waitForLine(/enqueue failed; reconciler will pick the run up/, 5_000);
    expect((await fetch(`${base}/health`)).status).toBe(200);

    await expectGracefulExit(p, 'SIGTERM', base);
  });

  it('exits non-zero when its port is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    try {
      const p = spawnEntry(inject('pkgDir'), 'dist/server.js', {
        DATABASE_URL: inject('databaseUrl'),
        REDIS_URL,
        PORT: String((blocker.address() as net.AddressInfo).port),
        HOST: '127.0.0.1',
      });
      const exit = await p.exited;
      expect(exit.code).not.toBe(0);
      expect(p.lines.join('\n')).toMatch(/EADDRINUSE/);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
