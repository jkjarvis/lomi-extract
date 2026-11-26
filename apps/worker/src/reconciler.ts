import type { PrismaClient } from '@lomi/db';
import { listQueuedRuns, recoverStaleRuns } from '@lomi/db';
import { log } from './config.js';

export interface ReconcileDeps {
  prisma: PrismaClient;
  enqueue: (runId: string, attempt: number) => Promise<void>;
  maxRunAttempts: number;
}

/**
 * Make Redis agree with Postgres. Runs on boot and on an interval:
 *  1. runs stuck in `extracting` with an expired lease (worker died) → back to `queued` with attempt+1,
 *     or `failed` once they've used up their attempts;
 *  2. every `queued` run gets a job (deduplicated by job id), which repairs FLUSHALL and lost enqueues.
 * `ownWorkerId` is only passed on boot: anything still held under our id belongs to a previous life of this worker.
 */
export async function reconcile(deps: ReconcileDeps, ownWorkerId?: string) {
  const recovered = await recoverStaleRuns(deps.prisma, deps.maxRunAttempts, ownWorkerId);
  if (recovered.requeued.length || recovered.failed.length) {
    log('warn', 'recovered stale runs', { requeued: recovered.requeued.map((r) => r.id), failed: recovered.failed });
  }
  const queued = await listQueuedRuns(deps.prisma);
  let enqueued = 0;
  for (const r of queued) {
    try {
      await deps.enqueue(r.id, r.attempt);
      enqueued += 1;
    } catch (err) {
      log('warn', 'enqueue failed during reconcile (will retry next tick)', { runId: r.id, err: String(err) });
    }
  }
  return { ...recovered, queued: queued.length, enqueued };
}
