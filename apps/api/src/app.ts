import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { DOC_TYPES, isDocType } from '@lomi/core';
import type { PrismaClient } from '@lomi/db';
import { supersedeActiveRuns } from '@lomi/db';
import { isPdf, sha256 } from '@lomi/extraction';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import type { DocumentRow, ValueRow } from './dto.js';
import { latestRun, toDetail, toSummary, toValueDTO } from './dto.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AppDeps {
  prisma: PrismaClient;
  /** Ring the doorbell for a run. Failures are tolerated: the worker's reconciler re-enqueues queued runs. */
  enqueue: (runId: string, attempt: number) => Promise<void>;
  logger?: boolean | { level: string };
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

const RUN_SELECT = { status: true, error: true, attempt: true, createdAt: true } as const;
const RUN_ORDER = [{ createdAt: 'desc' as const }, { attempt: 'desc' as const }];
const REVIEW_LATEST = { orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }], take: 1 };

const DOC_SELECT = {
  id: true,
  type: true,
  title: true,
  currentVersion: true,
  createdAt: true,
  updatedAt: true,
  versions: {
    select: {
      versionNo: true,
      createdAt: true,
      runs: { select: RUN_SELECT, orderBy: RUN_ORDER },
      values: { select: { reviewState: true, value: true } },
    },
  },
} as const;

const VALUE_INCLUDE = {
  reviews: REVIEW_LATEST,
  previousValue: { include: { version: { select: { versionNo: true } }, reviews: REVIEW_LATEST } },
} as const;

interface Upload {
  fields: Record<string, string>;
  file: { buffer: Buffer; filename: string } | null;
}

async function readUpload(request: FastifyRequest): Promise<Upload> {
  if (!request.isMultipart()) throw new HttpError(400, 'not_multipart', 'Expected a multipart/form-data upload');
  const fields: Record<string, string> = {};
  let file: Upload['file'] = null;
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer(); // throws 413 past the fileSize limit
      if (part.fieldname === 'file' && !file) file = { buffer, filename: part.filename };
    } else if (typeof part.value === 'string') {
      fields[part.fieldname] = part.value;
    }
  }
  return { fields, file };
}

function requirePdf(file: Upload['file']): { buffer: Buffer; filename: string } {
  if (!file || file.buffer.length === 0) throw new HttpError(400, 'file_required', 'A PDF file is required in the "file" field');
  if (!isPdf(file.buffer)) throw new HttpError(400, 'not_pdf', 'The uploaded file is not a PDF (missing %PDF- header)');
  return file;
}

async function lockDocument(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM documents WHERE id = ${id} FOR UPDATE`;
  return rows.length > 0;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { prisma } = deps;
  const app = Fastify({ logger: deps.logger ?? false, disableRequestLogging: true, bodyLimit: 1024 * 1024 });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 20, fieldSize: 64 * 1024 } });

  const ring = (runId: string, attempt: number) => {
    // Never awaited by the request: an upload must not depend on Redis being up.
    deps.enqueue(runId, attempt).catch((err) => app.log.warn({ err: String(err), runId }, 'enqueue failed; reconciler will pick the run up'));
  };

  const loadDoc = async (id: string): Promise<DocumentRow | null> =>
    (await prisma.document.findUnique({ where: { id }, select: DOC_SELECT })) as DocumentRow | null;

  const summaryOf = async (id: string) => {
    const doc = await loadDoc(id);
    if (!doc) throw new HttpError(404, 'not_found', `Document ${id} not found`);
    return toSummary(doc);
  };

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    let status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    let code = (err.code ?? 'error').toLowerCase();
    if (status === 413 || err.code === 'FST_REQ_FILE_TOO_LARGE') {
      status = 413;
      code = 'file_too_large';
    } else if (err.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' || status === 406) {
      status = 400;
      code = 'not_multipart';
    } else if (status >= 500) {
      request.log.error({ err }, 'request failed');
      code = 'internal_error';
    }
    return reply.status(status).send({ error: { code, message: status >= 500 ? 'Internal server error' : err.message } });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found` } }),
  );

  app.get('/health', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false, error: { code: 'db_unavailable', message: 'Database unreachable' } });
    }
  });

  app.get('/documents', async () => {
    const docs = (await prisma.document.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: DOC_SELECT })) as DocumentRow[];
    return docs.map(toSummary);
  });

  app.post('/documents', async (request, reply) => {
    const { fields, file } = await readUpload(request);
    const type = fields.type?.trim();
    if (!isDocType(type)) throw new HttpError(400, 'invalid_type', `"type" must be one of ${DOC_TYPES.join(', ')}`);
    const pdf = requirePdf(file);
    const title = fields.title?.trim() || pdf.filename.replace(/\.pdf$/i, '') || `Untitled ${type}`;

    const { docId, runId } = await prisma.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: {
          id: `doc-${randomUUID()}`,
          type,
          title,
          currentVersion: 1,
          versions: {
            create: {
              versionNo: 1,
              fileName: pdf.filename,
              fileBytes: Uint8Array.from(pdf.buffer),
              fileSha256: sha256(pdf.buffer),
              runs: { create: { status: 'queued', attempt: 1 } },
            },
          },
        },
        select: { id: true, versions: { select: { runs: { select: { id: true } } } } },
      });
      return { docId: doc.id, runId: doc.versions[0]!.runs[0]!.id };
    });
    ring(runId, 1);
    return reply.status(202).send(await summaryOf(docId));
  });

  app.post<{ Params: { id: string } }>('/documents/:id/versions', async (request, reply) => {
    const { id } = request.params;
    if (!(await prisma.document.findUnique({ where: { id }, select: { id: true } }))) {
      throw new HttpError(404, 'not_found', `Document ${id} not found`);
    }
    const { file } = await readUpload(request);
    const pdf = requirePdf(file);

    const runId = await prisma.$transaction(async (tx) => {
      if (!(await lockDocument(tx, id))) throw new HttpError(404, 'not_found', `Document ${id} not found`);
      // Decision: a new version supersedes any in-flight extraction of older versions.
      await supersedeActiveRuns(tx, id);
      const max = await tx.documentVersion.aggregate({ where: { documentId: id }, _max: { versionNo: true } });
      const versionNo = (max._max.versionNo ?? 0) + 1;
      const version = await tx.documentVersion.create({
        data: {
          documentId: id,
          versionNo,
          fileName: pdf.filename,
          fileBytes: Uint8Array.from(pdf.buffer),
          fileSha256: sha256(pdf.buffer),
          runs: { create: { status: 'queued', attempt: 1 } },
        },
        select: { runs: { select: { id: true } } },
      });
      await tx.document.update({ where: { id }, data: { currentVersion: versionNo } });
      return version.runs[0]!.id;
    });
    ring(runId, 1);
    return reply.status(202).send(await summaryOf(id));
  });

  app.get<{ Params: { id: string }; Querystring: { version?: string } }>('/documents/:id', async (request) => {
    const { id } = request.params;
    const doc = await loadDoc(id);
    if (!doc) throw new HttpError(404, 'not_found', `Document ${id} not found`);
    let versionNo = doc.currentVersion;
    if (request.query.version !== undefined && request.query.version !== '') {
      versionNo = Number(request.query.version);
      if (!Number.isInteger(versionNo) || versionNo < 1) throw new HttpError(400, 'invalid_version', 'version must be a positive integer');
    }
    const shown = await prisma.documentVersion.findUnique({
      where: { documentId_versionNo: { documentId: id, versionNo } },
      select: {
        versionNo: true,
        createdAt: true,
        parsedText: true,
        runs: { select: RUN_SELECT, orderBy: RUN_ORDER },
        values: { include: VALUE_INCLUDE },
      },
    });
    if (!shown) throw new HttpError(404, 'not_found', `Document ${id} has no version ${versionNo}`);
    return toDetail(doc, shown, shown.values as unknown as ValueRow[]);
  });

  app.get<{ Params: { id: string } }>('/documents/:id/progress', async (request) => (await summaryOf(request.params.id)).progress);

  app.post<{ Params: { id: string } }>('/documents/:id/retry', async (request, reply) => {
    const { id } = request.params;
    const created = await prisma.$transaction(async (tx) => {
      if (!(await lockDocument(tx, id))) throw new HttpError(404, 'not_found', `Document ${id} not found`);
      const doc = await tx.document.findUniqueOrThrow({ where: { id } });
      const version = await tx.documentVersion.findUniqueOrThrow({
        where: { documentId_versionNo: { documentId: id, versionNo: doc.currentVersion } },
        select: { id: true, runs: { select: RUN_SELECT, orderBy: RUN_ORDER } },
      });
      const latest = latestRun(version.runs);
      if (latest?.status !== 'failed') {
        throw new HttpError(409, 'not_failed', `Only a failed extraction can be retried (current status: ${latest?.status ?? 'none'})`);
      }
      // Attempts keep counting across runs of a version, so the attempt number stays a meaningful fencing token.
      const attempt = Math.max(...version.runs.map((r) => r.attempt)) + 1;
      const run = await tx.extractionRun.create({ data: { versionId: version.id, status: 'queued', attempt }, select: { id: true } });
      await tx.document.update({ where: { id }, data: { updatedAt: new Date() } });
      return { runId: run.id, attempt };
    });
    ring(created.runId, created.attempt);
    return reply.status(202).send(await summaryOf(id));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/values/:id/review', async (request) => {
    const body = parseReviewBody(request.body);
    const { id } = request.params;
    await prisma.$transaction(async (tx) => {
      const value = await tx.extractedValue.findUnique({
        where: { id },
        select: { id: true, value: true, version: { select: { versionNo: true, documentId: true } } },
      });
      if (!value) throw new HttpError(404, 'not_found', `Value ${id} not found`);
      await lockDocument(tx, value.version.documentId);
      const doc = await tx.document.findUniqueOrThrow({ where: { id: value.version.documentId }, select: { currentVersion: true } });
      if (doc.currentVersion !== value.version.versionNo) {
        throw new HttpError(409, 'version_not_current', `Value belongs to version ${value.version.versionNo}; only the current version (${doc.currentVersion}) can be reviewed`);
      }
      if (body.action === 'approve' && value.value === null) {
        throw new HttpError(400, 'gap_requires_correction', 'This field is a gap (no value was extracted); it can only be corrected');
      }
      await tx.review.create({
        data: { valueId: id, action: body.action, value: body.action === 'correct' ? body.value : null, note: body.note ?? null },
      });
      await tx.extractedValue.update({ where: { id }, data: { reviewState: body.action === 'approve' ? 'approved' : 'corrected' } });
      await tx.document.update({ where: { id: value.version.documentId }, data: { updatedAt: new Date() } });
    });
    const fresh = await prisma.extractedValue.findUniqueOrThrow({ where: { id }, include: VALUE_INCLUDE });
    return toValueDTO(fresh as unknown as ValueRow);
  });

  return app;
}

export type ReviewBody = { action: 'approve'; note?: string | null } | { action: 'correct'; value: string; note?: string | null };

export function parseReviewBody(body: unknown): ReviewBody {
  const bad = (msg: string) => new HttpError(400, 'invalid_body', msg);
  if (!body || typeof body !== 'object') throw bad('Body must be a JSON object');
  const b = body as Record<string, unknown>;
  const note = b.note;
  if (note !== undefined && note !== null && typeof note !== 'string') throw bad('"note" must be a string');
  const cleanNote = typeof note === 'string' && note.trim() ? note.trim() : null;
  if (b.action === 'approve') return { action: 'approve', note: cleanNote };
  if (b.action === 'correct') {
    if (typeof b.value !== 'string' || b.value.trim() === '') throw bad('A correction needs a non-empty string "value"');
    return { action: 'correct', value: b.value.trim(), note: cleanNote };
  }
  throw bad('"action" must be "approve" or "correct"');
}
