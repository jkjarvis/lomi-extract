import { EXPECTED_FIELDS, isDocType, validateExtraction } from '@lomi/core';
import type { PrismaClient } from '@lomi/db';
import { claimRun, failRun, heartbeatRun, releaseRun } from '@lomi/db';
import type { LlmProvider } from '@lomi/extraction';
import { LlmError, pdfToText, sha256 } from '@lomi/extraction';
import { commitRun } from './commit.js';
import { log } from './config.js';

export interface ProcessDeps {
  prisma: PrismaClient;
  createProvider: () => LlmProvider;
  leaseMs: number;
  workerId: string;
  /** Aborted on graceful shutdown: in-flight runs are handed back to the queue instead of being failed. */
  shutdown: AbortSignal;
  /** Called after a run was released on shutdown so it is re-enqueued promptly (best effort). */
  onReleased?: (runId: string, attempt: number) => Promise<void>;
}

export type ProcessOutcome = 'skipped' | 'extracted' | 'failed' | 'dropped' | 'released';

const SHUTDOWN = 'worker shutting down';
const LEASE_LOST = 'lease lost';

/** Handle one job. Never throws for business failures: they become run state in Postgres. */
export async function processRun(deps: ProcessDeps, runId: string): Promise<ProcessOutcome> {
  const { prisma } = deps;
  const claimed = await claimRun(prisma, runId, deps.leaseMs, deps.workerId);
  if (!claimed) {
    log('info', 'job skipped: run is not queued (duplicate, superseded, or already done)', { runId });
    return 'skipped';
  }
  const { attempt } = claimed;
  log('info', 'run claimed', { runId, attempt });

  const ac = new AbortController();
  const onShutdown = () => ac.abort(new Error(SHUTDOWN));
  if (deps.shutdown.aborted) onShutdown();
  else deps.shutdown.addEventListener('abort', onShutdown, { once: true });

  const beat = setInterval(
    () => {
      heartbeatRun(prisma, runId, attempt, deps.leaseMs)
        .then((ours) => {
          if (!ours) ac.abort(new Error(LEASE_LOST));
        })
        .catch((err) => log('warn', 'heartbeat failed', { runId, err: String(err) }));
    },
    Math.max(500, Math.floor(deps.leaseMs / 3)),
  );

  let debug: { prompt?: string | null; rawResponse?: string | null; provider?: string | null; model?: string | null } = {};
  try {
    const version = await prisma.documentVersion.findUniqueOrThrow({
      where: { id: claimed.versionId },
      include: { document: true },
    });
    const docType = version.document.type;
    if (!isDocType(docType)) throw new Error(`Unsupported document type ${String(docType)}`);

    let text = version.parsedText;
    if (text === null) {
      text = await pdfToText(new Uint8Array(version.fileBytes));
      // Parsed once per version and kept: evidence and the review UI for vN always use vN's text.
      await prisma.documentVersion.updateMany({
        where: { id: version.id, parsedText: null },
        data: { parsedText: text, textSha256: sha256(text) },
      });
    }

    const provider = deps.createProvider();
    debug = { provider: provider.name, model: provider.model };
    const fields = EXPECTED_FIELDS[docType];
    const result = await provider.extract({ docType, fields, text, attempt, signal: ac.signal });
    debug = { prompt: result.prompt, rawResponse: result.rawResponse, provider: result.provider, model: result.model };
    if (ac.signal.aborted) throw ac.signal.reason;

    const validated = validateExtraction(text, fields, result.fields);
    const outcome = await commitRun(prisma, {
      runId,
      attempt,
      versionId: version.id,
      documentId: version.documentId,
      versionNo: version.versionNo,
      text,
      validated,
      result,
    });
    if (outcome.committed) {
      log('info', 'run extracted', { runId, attempt, values: outcome.values, gaps: validated.filter((v) => v.gap).length });
      return 'extracted';
    }
    log('warn', 'commit dropped (run no longer ours)', { runId, attempt, reason: outcome.reason });
    return 'dropped';
  } catch (err) {
    const reason = ac.signal.aborted ? (ac.signal.reason as Error | undefined)?.message : undefined;
    if (reason === SHUTDOWN) {
      const next = await releaseRun(prisma, runId, attempt).catch(() => null);
      log('info', 'run released on shutdown', { runId, attempt, nextAttempt: next });
      if (next !== null) await deps.onReleased?.(runId, next).catch(() => undefined);
      return 'released';
    }
    if (reason === LEASE_LOST) {
      log('warn', 'lease lost; dropping work', { runId, attempt });
      return 'dropped';
    }
    const message = err instanceof Error ? `${err.name === 'Error' ? '' : `${err.name}: `}${err.message}` : String(err);
    if (err instanceof LlmError) {
      debug = { ...debug, prompt: err.prompt ?? debug.prompt, rawResponse: err.rawResponse ?? debug.rawResponse };
    }
    const failed = await failRun(prisma, runId, attempt, message, debug);
    log('error', 'run failed', { runId, attempt, error: message, recorded: failed });
    return failed ? 'failed' : 'dropped';
  } finally {
    clearInterval(beat);
    deps.shutdown.removeEventListener('abort', onShutdown);
  }
}
