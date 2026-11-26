// The HTTP API against real Postgres (Redis replaced by an enqueue spy). Covers the paths the no-DB tests in
// test/app.test.ts cannot reach: uploads, versions/supersede, review rules, retry, progress, error handling.
import { readFileSync } from 'node:fs';
import { EXPECTED_FIELDS, validateExtraction } from '@lomi/core';
import type { PrismaClient } from '@lomi/db';
import { Prisma, createPrisma, listQueuedRuns } from '@lomi/db';
import { truncateAll } from '@lomi/db/testing';
import { MockProvider, pdfToText } from '@lomi/extraction';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { DocumentDetail, DocumentSummary, ValueDTO } from '../../src/dto.js';

const fixture = (n: string) => readFileSync(new URL(`../../../../fixtures/documents/${n}`, import.meta.url));
const INVOICE_V1 = fixture('invoice-001.pdf');
const INVOICE_V2 = fixture('invoice-001.v2.pdf');

function multipart(parts: Array<{ name: string; value: string | Buffer; filename?: string }>) {
  const boundary = '----lomidb' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(
      Buffer.from(
        p.filename
          ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: application/pdf\r\n\r\n`
          : `Content-Disposition: form-data; name="${p.name}"\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

let prisma: PrismaClient;
let app: FastifyInstance;
const enqueue = vi.fn(async (_runId: string, _attempt: number) => undefined);

beforeAll(async () => {
  prisma = createPrisma(inject('databaseUrl'));
  app = await buildApp({ prisma, enqueue: (r, a) => enqueue(r, a) });
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await truncateAll(prisma);
  enqueue.mockReset();
  enqueue.mockImplementation(async () => undefined);
});

const upload = (type: string, file: Buffer, title?: string) =>
  app.inject({
    method: 'POST',
    url: '/documents',
    ...multipart([{ name: 'type', value: type }, ...(title ? [{ name: 'title', value: title }] : []), { name: 'file', value: file, filename: 'invoice-001.pdf' }]),
  });
const uploadVersion = (id: string, file: Buffer) =>
  app.inject({ method: 'POST', url: `/documents/${id}/versions`, ...multipart([{ name: 'file', value: file, filename: 'v.pdf' }]) });
const getDoc = async (id: string, version?: number) => {
  const res = await app.inject({ method: 'GET', url: `/documents/${id}${version ? `?version=${version}` : ''}` });
  return { status: res.statusCode, body: res.json() as DocumentDetail };
};
const review = (valueId: string, body: unknown) => app.inject({ method: 'POST', url: `/values/${valueId}/review`, payload: body as object });

/** Stand-in for the worker: claim the current version's queued run and commit mock-extracted values (no carry-over). */
async function extractCurrent(docId: string, opts: { previousFrom?: number } = {}) {
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: docId } });
  const version = await prisma.documentVersion.findUniqueOrThrow({
    where: { documentId_versionNo: { documentId: docId, versionNo: doc.currentVersion } },
    include: { runs: { where: { status: 'queued' } } },
  });
  const text = await pdfToText(new Uint8Array(version.fileBytes));
  const fields = EXPECTED_FIELDS[doc.type];
  const res = await new MockProvider({}).extract({ docType: doc.type, fields, text, attempt: 1 });
  const prev = opts.previousFrom
    ? await prisma.extractedValue.findMany({ where: { version: { documentId: docId, versionNo: opts.previousFrom } } })
    : [];
  const run = version.runs[0]!;
  await prisma.documentVersion.update({ where: { id: version.id }, data: { parsedText: text } });
  for (const v of validateExtraction(text, fields, res.fields)) {
    const p = prev.find((x) => x.field === v.field);
    await prisma.extractedValue.create({
      data: {
        versionId: version.id,
        runId: run.id,
        field: v.field,
        type: v.type,
        value: v.value === null ? Prisma.DbNull : (v.value as Prisma.InputJsonValue),
        rawValue: v.rawValue,
        evidenceQuote: v.evidence?.quote ?? null,
        evidenceStart: v.evidence?.start ?? null,
        evidenceEnd: v.evidence?.end ?? null,
        gapReason: v.gap?.reason ?? null,
        gapDetail: v.gap?.detail ?? null,
        previousValueId: p?.id ?? null,
        changed: !!p && JSON.stringify(p.value) !== JSON.stringify(v.value),
      },
    });
  }
  await prisma.extractionRun.update({ where: { id: run.id }, data: { status: 'extracted', prompt: 'P', rawResponse: 'R' } });
}

describe('POST /documents', () => {
  it('202 immediately with status queued; the run is durable in Postgres and the doorbell rung', async () => {
    const res = await upload('invoice', INVOICE_V1, 'My invoice');
    expect(res.statusCode).toBe(202);
    const body = res.json() as DocumentSummary;
    expect(body).toMatchObject({ type: 'invoice', title: 'My invoice', currentVersion: 1, status: 'queued', error: null });
    expect(body.progress).toEqual({ total: 0, pending: 0, approved: 0, corrected: 0, carriedOver: 0, gaps: 0 });
    const runs = await listQueuedRuns(prisma);
    expect(runs).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledWith(runs[0]!.id, 1);
  });

  it('defaults the title to the file name', async () => {
    expect((await upload('invoice', INVOICE_V1)).json().title).toBe('invoice-001');
  });

  it('does not wait for Redis: a hanging or failing enqueue still returns 202 and leaves the run for the reconciler', async () => {
    enqueue.mockImplementation(() => new Promise(() => undefined)); // Redis hangs forever
    const t0 = Date.now();
    const res = await upload('lease', INVOICE_V1);
    expect(res.statusCode).toBe(202);
    expect(Date.now() - t0).toBeLessThan(1000);

    enqueue.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await upload('lease', INVOICE_V1)).statusCode).toBe(202);
    // Both runs are committed as queued, which is all the worker's reconciler needs to enqueue them later.
    expect(await listQueuedRuns(prisma)).toHaveLength(2);
  });
});

describe('GET /documents and /documents/:id', () => {
  it('lists documents oldest first with status and progress', async () => {
    const a = (await upload('invoice', INVOICE_V1, 'A')).json() as DocumentSummary;
    const b = (await upload('lease', INVOICE_V1, 'B')).json() as DocumentSummary;
    const list = (await app.inject({ method: 'GET', url: '/documents' })).json() as DocumentSummary[];
    expect(list.map((d) => d.id)).toEqual([a.id, b.id]);
  });

  it('detail before extraction: no text, no values; after: one value per expected field, in field order', async () => {
    const { id } = (await upload('invoice', INVOICE_V1)).json() as DocumentSummary;
    let d = (await getDoc(id)).body;
    expect(d).toMatchObject({ version: 1, status: 'queued', text: null, values: [], versions: [{ version: 1, status: 'queued' }] });
    await extractCurrent(id);
    d = (await getDoc(id)).body;
    expect(d.status).toBe('extracted');
    expect(d.text).toMatch(/^MERIDIAN/);
    expect(d.values.map((v) => v.field)).toEqual(EXPECTED_FIELDS.invoice.map((f) => f.field));
    const total = d.values.find((v) => v.field === 'total_amount')!;
    expect(total.value).toEqual({ amount: 5230.29, currency: 'USD' });
    expect(d.text!.slice(total.evidence!.start, total.evidence!.end)).toBe(total.evidence!.quote);
    expect(d.progress).toMatchObject({ total: 5, pending: 5 });
  });

  it('404 for unknown document or version, 400 for a junk version', async () => {
    const { id } = (await upload('invoice', INVOICE_V1)).json() as DocumentSummary;
    expect((await getDoc('doc-nope')).status).toBe(404);
    expect((await getDoc(id, 7)).status).toBe(404);
    const res = await app.inject({ method: 'GET', url: `/documents/${id}?version=abc` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_version');
    expect((await app.inject({ method: 'GET', url: '/documents/doc-nope/progress' })).statusCode).toBe(404);
  });

  it('failed status carries the run error', async () => {
    const { id } = (await upload('invoice', INVOICE_V1)).json() as DocumentSummary;
    await prisma.extractionRun.updateMany({ data: { status: 'failed', error: 'Anthropic API error 500: boom' } });
    expect((await getDoc(id)).body).toMatchObject({ status: 'failed', error: 'Anthropic API error 500: boom' });
  });
});

describe('POST /documents/:id/versions', () => {
  it('404 for an unknown document (and no upload is stored)', async () => {
    const res = await uploadVersion('doc-nope', INVOICE_V2);
    expect(res.statusCode).toBe(404);
    expect(await prisma.documentVersion.count()).toBe(0);
  });

  it('400 for a non-PDF', async () => {
    const { id } = (await upload('invoice', INVOICE_V1)).json() as DocumentSummary;
    const res = await uploadVersion(id, Buffer.from('not a pdf'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_pdf');
  });

  it('a new version while v1 is still extracting supersedes v1\'s run; v2 is current and queued; v1 stays queryable', async () => {
    const { id } = (await upload('invoice', INVOICE_V1)).json() as DocumentSummary;
    await prisma.extractionRun.updateMany({ data: { status: 'extracting', leaseUntil: new Date(Date.now() + 30_000), workerId: 'w' } });
    const res = await uploadVersion(id, INVOICE_V2);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ currentVersion: 2, status: 'queued' });
    const d = (await getDoc(id)).body;
    expect(d.versions).toEqual([
      { version: 1, status: 'superseded', createdAt: expect.any(String) },
      { version: 2, status: 'queued', createdAt: expect.any(String) },
    ]);
    expect((await getDoc(id, 1)).body).toMatchObject({ version: 1, currentVersion: 2, status: 'queued' });
    const queued = await listQueuedRuns(prisma);
    expect(queued).toHaveLength(1);
    expect(enqueue).toHaveBeenLastCalledWith(queued[0]!.id, 1);
  });

  it('two versions uploaded at once get distinct version numbers and exactly one active run', async () => {
    const { id } = (await upload('invoice', INVOICE_V1)).json() as DocumentSummary;
    const [a, b] = await Promise.all([uploadVersion(id, INVOICE_V2), uploadVersion(id, INVOICE_V2)]);
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    const versions = await prisma.documentVersion.findMany({ where: { documentId: id }, orderBy: { versionNo: 'asc' }, include: { runs: true } });
    expect(versions.map((v) => v.versionNo)).toEqual([1, 2, 3]);
    expect(versions.flatMap((v) => v.runs).filter((r) => r.status === 'queued')).toHaveLength(1);
    expect((await prisma.document.findUniqueOrThrow({ where: { id } })).currentVersion).toBe(3);
  });
});

describe('POST /values/:id/review', () => {
  async function extracted() {
    const { id } = (await upload('invoice', INVOICE_V1)).json() as DocumentSummary;
    await extractCurrent(id);
    const { body } = await getDoc(id);
    return { id, byField: Object.fromEntries(body.values.map((v) => [v.field, v])) as Record<string, ValueDTO> };
  }

  it('approve → approved; the value and its quote are unchanged', async () => {
    const { byField } = await extracted();
    const res = await review(byField.invoice_number!.id, { action: 'approve' });
    expect(res.statusCode).toBe(200);
    const v = res.json() as ValueDTO;
    expect(v).toMatchObject({ reviewState: 'approved', value: 'INV-2025-0847', effectiveValue: 'INV-2025-0847', review: { action: 'approve', value: null } });
    expect(v.evidence).toEqual(byField.invoice_number!.evidence);
  });

  it('correct → stored BESIDE the extracted value; effectiveValue is the normalised correction; note kept', async () => {
    const { id, byField } = await extracted();
    const res = await review(byField.total_amount!.id, { action: 'correct', value: '$5,300.00', note: 'phone call' });
    const v = res.json() as ValueDTO;
    expect(v).toMatchObject({
      reviewState: 'corrected',
      value: { amount: 5230.29, currency: 'USD' },
      effectiveValue: { amount: 5300, currency: 'USD' },
      review: { action: 'correct', value: '$5,300.00', note: 'phone call' },
    });
    expect((await prisma.extractedValue.findUniqueOrThrow({ where: { id: byField.total_amount!.id } })).value).toEqual({ amount: 5230.29, currency: 'USD' });
    expect((await app.inject({ method: 'GET', url: `/documents/${id}/progress` })).json()).toMatchObject({ total: 5, pending: 4, corrected: 1 });
  });

  it('re-review: latest wins, history kept', async () => {
    const { byField } = await extracted();
    const vid = byField.due_date!.id;
    await review(vid, { action: 'correct', value: '2025-10-15' });
    const v = (await review(vid, { action: 'approve' })).json() as ValueDTO;
    expect(v).toMatchObject({ reviewState: 'approved', effectiveValue: '2025-10-14', review: { action: 'approve' } });
    expect(await prisma.review.count({ where: { valueId: vid } })).toBe(2);
  });

  it('a gap cannot be approved (400 gap_requires_correction) but can be corrected', async () => {
    const { id } = (await upload('market_report', fixture('market-report-excerpt-001.pdf'))).json() as DocumentSummary;
    await extractCurrent(id);
    const gap = (await getDoc(id)).body.values.find((v) => v.field === 'median_household_income')!;
    expect(gap).toMatchObject({ value: null, gap: { reason: 'not_found' } });
    const bad = await review(gap.id, { action: 'approve' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('gap_requires_correction');
    const ok = await review(gap.id, { action: 'correct', value: '$61,000' });
    expect(ok.json()).toMatchObject({ reviewState: 'corrected', value: null, effectiveValue: { amount: 61000, currency: 'USD' } });
    expect((await app.inject({ method: 'GET', url: `/documents/${id}/progress` })).json()).toMatchObject({ gaps: 1, corrected: 1 });
  });

  it('404 for an unknown value; 400 for a correction without a value (nothing stored)', async () => {
    const { byField } = await extracted();
    expect((await review('00000000-0000-0000-0000-000000000000', { action: 'approve' })).statusCode).toBe(404);
    expect((await review(byField.due_date!.id, { action: 'correct' })).statusCode).toBe(400);
    expect(await prisma.review.count()).toBe(0);
  });

  it('409 for a value of a non-current (superseded/earlier) version; that version\'s reviews stay as they were', async () => {
    const { id, byField } = await extracted();
    await review(byField.vendor_name!.id, { action: 'approve' });
    await uploadVersion(id, INVOICE_V2);
    const res = await review(byField.vendor_name!.id, { action: 'correct', value: 'Someone else' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('version_not_current');
    const v1 = (await getDoc(id, 1)).body.values.find((v) => v.field === 'vendor_name')!;
    expect(v1).toMatchObject({ reviewState: 'approved', review: { action: 'approve' } });
  });

  it('after re-extraction, a changed value shows the previous version\'s value and review', async () => {
    const { id, byField } = await extracted();
    await review(byField.total_amount!.id, { action: 'correct', value: '5230.30', note: 'rounding' });
    await uploadVersion(id, INVOICE_V2);
    await extractCurrent(id, { previousFrom: 1 });
    const total = (await getDoc(id)).body.values.find((v) => v.field === 'total_amount')!;
    expect(total).toMatchObject({
      value: { amount: 6126.45, currency: 'USD' },
      changed: true,
      reviewState: 'pending',
      previous: { version: 1, value: { amount: 5230.29, currency: 'USD' }, reviewState: 'corrected', review: { action: 'correct', value: '5230.30', note: 'rounding' } },
    });
    expect(total.previous!.evidenceQuote).toMatch(/5,230\.29/);
  });
});

describe('POST /documents/:id/retry', () => {
  it('409 unless the current version failed; then a new queued run whose attempt continues the count', async () => {
    const { id } = (await upload('invoice', INVOICE_V1)).json() as DocumentSummary;
    const notFailed = await app.inject({ method: 'POST', url: `/documents/${id}/retry` });
    expect(notFailed.statusCode).toBe(409);
    expect(notFailed.json().error.code).toBe('not_failed');

    await prisma.extractionRun.updateMany({ data: { status: 'failed', attempt: 3, error: 'x' } });
    enqueue.mockClear();
    const res = await app.inject({ method: 'POST', url: `/documents/${id}/retry` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'queued', error: null });
    const [queued] = await listQueuedRuns(prisma);
    expect(queued!.attempt).toBe(4);
    expect(enqueue).toHaveBeenCalledWith(queued!.id, 4);
    expect((await app.inject({ method: 'POST', url: `/documents/${id}/retry` })).statusCode).toBe(409); // already queued
  });

  it('404 for an unknown document', async () => {
    expect((await app.inject({ method: 'POST', url: '/documents/doc-nope/retry' })).statusCode).toBe(404);
  });
});

describe('health and unexpected errors', () => {
  it('health is ok with a reachable DB', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true });
  });

  it('an unexpected DB error is a 500 with the error envelope and no internals leaked', async () => {
    const broken = new Proxy(prisma, {
      get(target, prop, recv) {
        if (prop === 'document') return { findMany: () => Promise.reject(new Error('connection reset; secret=hunter2')) };
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    const a = await buildApp({ prisma: broken, enqueue: async () => undefined });
    const res = await a.inject({ method: 'GET', url: '/documents' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
    await a.close();
  });
});
