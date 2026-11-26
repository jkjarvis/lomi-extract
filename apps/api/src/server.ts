import type { ExtractionJob } from '@lomi/db';
import { EXTRACTION_QUEUE, createPrisma, jobIdFor } from '@lomi/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';
const prisma = createPrisma();

// Fail fast when Redis is down (no offline queue): the run is already durable in Postgres and the
// worker's reconciler will enqueue it once Redis is back.
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 2000,
});
redis.on('error', () => undefined);
const queue = new Queue<ExtractionJob>(EXTRACTION_QUEUE, {
  connection: redis,
  defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
});
queue.on('error', () => undefined);

async function enqueue(runId: string, attempt: number) {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('enqueue timed out')), 2000).unref());
  await Promise.race([queue.add('extract', { runId }, { jobId: jobIdFor(runId, attempt) }), timeout]);
}

const app = await buildApp({ prisma, enqueue, logger: { level: process.env.LOG_LEVEL ?? 'info' } });

const close = async () => {
  await app.close().catch(() => undefined);
  await queue.close().catch(() => undefined);
  redis.disconnect();
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());

await app.listen({ port, host });
