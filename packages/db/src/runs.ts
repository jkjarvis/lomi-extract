/**
 * The extraction-run state machine. Every transition is a single conditional UPDATE so that concurrent actors
 * (API, several workers, the reconciler) can never both win. `attempt` is the fencing token: a worker that was
 * presumed dead and comes back late can no longer touch a run whose attempt has moved on.
 *
 *   queued ──claim──▶ extracting ──commit──▶ extracted
 *     ▲                  │  │
 *     └──lease expired───┘  └──error──▶ failed ──(API retry: new run)──▶ queued
 *   (any in-flight run of a non-current version) ──new version──▶ superseded
 */
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export const EXTRACTION_QUEUE = 'extraction';

/** Payload of a BullMQ job. Deliberately nothing but a pointer: Postgres holds the truth. */
export interface ExtractionJob {
  runId: string;
}

/** One BullMQ job per (run, attempt): re-adding is deduplicated while the job exists, and a new attempt rings again. */
export function jobIdFor(runId: string, attempt: number): string {
  return `run-${runId}-a${attempt}`;
}

export interface ClaimedRun {
  id: string;
  attempt: number;
  versionId: string;
}

export async function claimRun(db: Db, runId: string, leaseMs: number, workerId: string): Promise<ClaimedRun | null> {
  const rows = await db.$queryRaw<Array<{ id: string; attempt: number; version_id: string }>>`
    UPDATE extraction_runs
       SET status = 'extracting',
           lease_until = now() + (${leaseMs}::int * interval '1 millisecond'),
           worker_id = ${workerId},
           started_at = now(),
           error = NULL,
           updated_at = now()
     WHERE id = ${runId} AND status = 'queued'
     RETURNING id, attempt, version_id`;
  const r = rows[0];
  return r ? { id: r.id, attempt: r.attempt, versionId: r.version_id } : null;
}

/** Extend the lease. Returns false if the run is no longer ours (superseded, recovered, or finished). */
export async function heartbeatRun(db: Db, runId: string, attempt: number, leaseMs: number): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE extraction_runs
       SET lease_until = now() + (${leaseMs}::int * interval '1 millisecond'), updated_at = now()
     WHERE id = ${runId} AND attempt = ${attempt} AND status = 'extracting'`;
  return n > 0;
}

export interface RunDebugInfo {
  prompt?: string | null;
  rawResponse?: string | null;
  provider?: string | null;
  model?: string | null;
}

export async function failRun(db: Db, runId: string, attempt: number, error: string, info: RunDebugInfo = {}): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE extraction_runs
       SET status = 'failed',
           error = ${error.slice(0, 4000)},
           prompt = COALESCE(${info.prompt ?? null}, prompt),
           raw_response = COALESCE(${info.rawResponse ?? null}, raw_response),
           provider = COALESCE(${info.provider ?? null}, provider),
           model = COALESCE(${info.model ?? null}, model),
           lease_until = NULL,
           finished_at = now(),
           updated_at = now()
     WHERE id = ${runId} AND attempt = ${attempt} AND status = 'extracting'`;
  return n > 0;
}

/** Hand a run back to the queue (graceful shutdown). Bumps the attempt so the old holder is fenced out. */
export async function releaseRun(db: Db, runId: string, attempt: number): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ attempt: number }>>`
    UPDATE extraction_runs
       SET status = 'queued', attempt = attempt + 1, lease_until = NULL, worker_id = NULL, updated_at = now()
     WHERE id = ${runId} AND attempt = ${attempt} AND status = 'extracting'
     RETURNING attempt`;
  return rows[0]?.attempt ?? null;
}

export interface RecoveryResult {
  requeued: Array<{ id: string; attempt: number }>;
  failed: string[];
}

/**
 * Recover runs whose worker vanished: lease expired, or (on boot) runs held under our own worker id, which we
 * cannot possibly still be processing. Each recovery bumps attempt; after `maxAttempts` the run fails visibly.
 */
export async function recoverStaleRuns(db: Db, maxAttempts: number, ownWorkerId?: string): Promise<RecoveryResult> {
  const own = ownWorkerId ?? null;
  const failed = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE extraction_runs
       SET status = 'failed',
           error = 'Extraction was interrupted ' || (recoveries + 1) || ' times (worker stopped or lost its lease). Retry to try again.',
           lease_until = NULL,
           finished_at = now(),
           updated_at = now()
     WHERE status = 'extracting'
       AND (lease_until IS NULL OR lease_until < now() OR (${own}::text IS NOT NULL AND worker_id = ${own}::text))
       AND recoveries + 1 >= ${maxAttempts}
     RETURNING id`;
  const requeued = await db.$queryRaw<Array<{ id: string; attempt: number }>>`
    UPDATE extraction_runs
       SET status = 'queued',
           attempt = attempt + 1,
           recoveries = recoveries + 1,
           lease_until = NULL,
           worker_id = NULL,
           updated_at = now()
     WHERE status = 'extracting'
       AND (lease_until IS NULL OR lease_until < now() OR (${own}::text IS NOT NULL AND worker_id = ${own}::text))
     RETURNING id, attempt`;
  return { requeued, failed: failed.map((r) => r.id) };
}

export async function listQueuedRuns(db: Db, limit = 500): Promise<Array<{ id: string; attempt: number }>> {
  return db.$queryRaw<Array<{ id: string; attempt: number }>>`
    SELECT id, attempt FROM extraction_runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ${limit}`;
}

/** Mark every in-flight run of the document's versions as superseded (call inside the new-version transaction). */
export async function supersedeActiveRuns(db: Db, documentId: string): Promise<number> {
  return db.$executeRaw`
    UPDATE extraction_runs r
       SET status = 'superseded', lease_until = NULL, finished_at = now(), updated_at = now(),
           error = 'Superseded by a newer version of the document'
      FROM document_versions v
     WHERE r.version_id = v.id AND v.document_id = ${documentId} AND r.status IN ('queued', 'extracting')`;
}
