import type { ExtractionJob } from '@lomi/db';
import { EXTRACTION_QUEUE, createPrisma, jobIdFor } from '@lomi/db';
import { createProvider, resolveProviderName } from '@lomi/extraction';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig, log } from './config.js';
import { processRun } from './process.js';
import { reconcile } from './reconciler.js';

const cfg = loadConfig();
const prisma = createPrisma(cfg.databaseUrl);
const shutdown = new AbortController();

const redisOpts = { maxRetriesPerRequest: null, enableReadyCheck: true } as const;
const queueConn = new Redis(cfg.redisUrl, redisOpts);
const workerConn = new Redis(cfg.redisUrl, redisOpts);
for (const c of [queueConn, workerConn]) c.on('error', (err) => log('warn', 'redis error', { err: String(err) }));

const queue = new Queue<ExtractionJob>(EXTRACTION_QUEUE, {
  connection: queueConn,
  defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
});

async function enqueue(runId: string, attempt: number) {
  await queue.add('extract', { runId }, { jobId: jobIdFor(runId, attempt) });
}

const worker = new Worker<ExtractionJob>(
  EXTRACTION_QUEUE,
  async (job) => {
    // Knobs (MOCK_LLM_*) are read per job via a fresh provider.
    return processRun(
      { prisma, createProvider: () => createProvider(process.env), leaseMs: cfg.leaseMs, workerId: cfg.workerId, shutdown: shutdown.signal, onReleased: enqueue },
      job.data.runId,
    );
  },
  { connection: workerConn, concurrency: cfg.concurrency, autorun: false, removeOnComplete: { count: 0 }, removeOnFail: { count: 0 } },
);
worker.on('error', (err) => log('warn', 'bullmq worker error', { err: String(err) }));
worker.on('failed', (job, err) => log('warn', 'job threw (run stays queued; reconciler will retry)', { runId: job?.data.runId, err: String(err) }));

let timer: NodeJS.Timeout | undefined;
let reconciling = false;
async function tick(ownWorkerId?: string) {
  if (reconciling) return;
  reconciling = true;
  try {
    await reconcile({ prisma, enqueue, maxRunAttempts: cfg.maxRunAttempts }, ownWorkerId);
  } catch (err) {
    log('warn', 'reconcile failed (will retry)', { err: String(err) });
  } finally {
    reconciling = false;
  }
}

async function start() {
  log('info', 'worker starting', {
    workerId: cfg.workerId,
    provider: resolveProviderName(process.env),
    leaseMs: cfg.leaseMs,
    reconcileIntervalMs: cfg.reconcileIntervalMs,
    concurrency: cfg.concurrency,
  });
  // Boot reconcile before consuming: reclaim anything a previous life of this worker left half-done.
  for (;;) {
    try {
      await reconcile({ prisma, enqueue, maxRunAttempts: cfg.maxRunAttempts }, cfg.workerId);
      break;
    } catch (err) {
      log('warn', 'boot reconcile failed, retrying in 2s', { err: String(err) });
      await new Promise((r) => setTimeout(r, 2000));
      if (shutdown.signal.aborted) return;
    }
  }
  timer = setInterval(() => void tick(), cfg.reconcileIntervalMs);
  void worker.run().catch((err) => log('error', 'worker loop crashed', { err: String(err) }));
  log('info', 'worker ready');
}

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting down', { signal });
  const force = setTimeout(() => process.exit(0), 8000);
  force.unref();
  if (timer) clearInterval(timer);
  shutdown.abort(); // in-flight runs release themselves back to `queued`
  try {
    await worker.close();
    await queue.close();
  } catch (err) {
    log('warn', 'error closing bullmq', { err: String(err) });
  }
  await prisma.$disconnect().catch(() => undefined);
  queueConn.disconnect();
  workerConn.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
process.on('unhandledRejection', (err) => log('error', 'unhandled rejection', { err: String(err) }));

void start();
