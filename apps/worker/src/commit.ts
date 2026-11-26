import type { ValidatedValue } from '@lomi/core';
import type { PrismaClient } from '@lomi/db';
import { Prisma } from '@lomi/db';
import type { ExtractionResult } from '@lomi/extraction';
import type { PrevValueRow } from './plan.js';
import { planValues } from './plan.js';

export interface CommitInput {
  runId: string;
  attempt: number;
  versionId: string;
  documentId: string;
  versionNo: number;
  text: string;
  validated: ValidatedValue[];
  result: ExtractionResult;
}

export type CommitOutcome =
  | { committed: true; values: number }
  | { committed: false; reason: 'not_extracting' | 'attempt_mismatch' | 'missing' | 'already_committed'; status?: string };

/**
 * Commit an extraction: all values, carried-over reviews and the run's final status in ONE transaction, guarded
 * by the run row lock. A superseded, recovered (attempt moved on) or duplicate run commits nothing.
 */
export async function commitRun(prisma: PrismaClient, input: CommitInput): Promise<CommitOutcome> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string; attempt: number }>>`
        SELECT status::text AS status, attempt FROM extraction_runs WHERE id = ${input.runId} FOR UPDATE`;
      const run = rows[0];
      if (!run) return { committed: false, reason: 'missing' };
      if (run.status !== 'extracting') return { committed: false, reason: 'not_extracting', status: run.status };
      if (run.attempt !== input.attempt) return { committed: false, reason: 'attempt_mismatch' };

      // Unique (version_id, field) makes duplicates impossible; this check makes the outcome explicit.
      const existing = await tx.extractedValue.count({ where: { versionId: input.versionId } });
      if (existing > 0) {
        await tx.extractionRun.update({
          where: { id: input.runId },
          data: {
            status: 'extracted',
            leaseUntil: null,
            finishedAt: new Date(),
            error: 'Values for this version were already committed by an earlier run; nothing written.',
          },
        });
        return { committed: false, reason: 'already_committed' };
      }

      const prevVersion = await tx.documentVersion.findFirst({
        where: { documentId: input.documentId, versionNo: { lt: input.versionNo }, values: { some: {} } },
        orderBy: { versionNo: 'desc' },
        include: { values: { include: { reviews: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } } } },
      });
      const prev: PrevValueRow[] = (prevVersion?.values ?? []).map((v) => ({
        id: v.id,
        field: v.field,
        value: v.value ?? null,
        evidenceQuote: v.evidenceQuote,
        reviewState: v.reviewState,
        latestReview: v.reviews[0]
          ? { id: v.reviews[0].id, action: v.reviews[0].action, value: v.reviews[0].value, note: v.reviews[0].note }
          : null,
      }));

      const plan = planValues(input.validated, prev, input.text);
      for (const p of plan) {
        const v = p.validated;
        await tx.extractedValue.create({
          data: {
            versionId: input.versionId,
            runId: input.runId,
            field: v.field,
            type: v.type,
            value: v.value === null ? Prisma.DbNull : (v.value as Prisma.InputJsonValue),
            rawValue: v.rawValue,
            evidenceQuote: v.evidence?.quote ?? null,
            evidenceStart: v.evidence?.start ?? null,
            evidenceEnd: v.evidence?.end ?? null,
            gapReason: v.gap?.reason ?? null,
            gapDetail: v.gap?.detail ?? null,
            reviewState: p.reviewState,
            changed: p.changed,
            previousValueId: p.previousValueId,
            reviews: p.carriedReview
              ? {
                  create: {
                    action: p.carriedReview.action,
                    value: p.carriedReview.value,
                    note: p.carriedReview.note,
                    carriedFromReviewId: p.carriedReview.id,
                  },
                }
              : undefined,
          },
        });
      }

      await tx.extractionRun.update({
        where: { id: input.runId },
        data: {
          status: 'extracted',
          leaseUntil: null,
          finishedAt: new Date(),
          error: null,
          prompt: input.result.prompt,
          rawResponse: input.result.rawResponse,
          provider: input.result.provider,
          model: input.result.model,
        },
      });
      await tx.document.update({ where: { id: input.documentId }, data: { updatedAt: new Date() } });
      return { committed: true, values: plan.length };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000, maxWait: 10_000 },
  );
}
