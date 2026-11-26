// processRun / commitRun / reconcile against real Postgres, with the LLM stubbed. These are the branches the
// black-box suites can only reach by luck (races at commit time, lease loss, provider failures, broken PDFs).
import { readFileSync } from 'node:fs';
import { EXPECTED_FIELDS } from '@lomi/core';
import type { PrismaClient } from '@lomi/db';
import { claimRun, createPrisma, recoverStaleRuns, supersedeActiveRuns } from '@lomi/db';
import { insertDocument, truncateAll } from '@lomi/db/testing';
import type { ExtractionRequest, LlmProvider } from '@lomi/extraction';
import { AnthropicProvider, LlmError, MockProvider, renderPrompt } from '@lomi/extraction';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import type { ProcessDeps } from '../../src/process.js';
import { processRun } from '../../src/process.js';
import { reconcile } from '../../src/reconciler.js';

let prisma: PrismaClient;
beforeAll(() => {
  prisma = createPrisma(inject('databaseUrl'));
});
afterAll(async () => prisma.$disconnect());
beforeEach(async () => truncateAll(prisma));

const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../../../../fixtures/documents/${n}`, import.meta.url)));
const INVOICE_V1 = fixture('invoice-001.pdf');
const INVOICE_V2 = fixture('invoice-001.v2.pdf');

/** A well-formed PDF with one blank page: opens fine, contains no text (think: a scan without OCR). */
function blankPdf(): Uint8Array {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>'];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const quietLog = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
beforeEach(() => {
  quietLog();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function deps(provider: LlmProvider | (() => LlmProvider), over: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    prisma,
    createProvider: typeof provider === 'function' ? provider : () => provider,
    leaseMs: 30_000,
    workerId: 'w-test',
    shutdown: new AbortController().signal,
    ...over,
  };
}

/** Wraps the mock provider so a test can act in the middle of an extraction (after the LLM call, before commit). */
function providerWith(during: (req: ExtractionRequest) => Promise<void>, inner: LlmProvider = new MockProvider({})): LlmProvider {
  return {
    name: inner.name,
    model: inner.model,
    async extract(req) {
      const res = await inner.extract(req);
      await during(req);
      return res;
    },
  };
}

const failing = (err: Error): LlmProvider => ({
  name: 'stub',
  model: 'stub-1',
  extract: async () => {
    throw err;
  },
});

const runRow = (id: string) => prisma.extractionRun.findUniqueOrThrow({ where: { id } });
const valuesOf = (versionId: string) => prisma.extractedValue.findMany({ where: { versionId }, orderBy: { field: 'asc' }, include: { reviews: true } });

/** Stubbed Anthropic HTTP layer (no network): one canned reply. */
function anthropicReplying(reply: { status?: number; text?: string; body?: unknown }) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const body =
      reply.body ??
      (reply.status && reply.status >= 400
        ? { type: 'error', error: { type: 'api_error', message: 'upstream exploded' } }
        : {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5-5',
            content: [{ type: 'text', text: reply.text ?? '' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
    return new Response(JSON.stringify(body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { provider: new AnthropicProvider('sk-test', 'claude-sonnet-5-5', { fetch: fetchImpl, maxRetries: 0 }), calls };
}

describe('happy path', () => {
  it('extracts once, stores parsed text, prompt and raw response; a duplicate delivery is skipped', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    expect(await processRun(deps(new MockProvider({})), runId)).toBe('extracted');

    const run = await runRow(runId);
    expect(run).toMatchObject({ status: 'extracted', provider: 'mock', error: null, leaseUntil: null });
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(version.parsedText).toMatch(/^MERIDIAN OFFICE SUPPLIES LLC/);
    expect(version.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.prompt).toBe(renderPrompt('invoice', EXPECTED_FIELDS.invoice, version.parsedText!));
    expect(JSON.parse(run.rawResponse!)).toHaveProperty('fields');

    const values = await valuesOf(versionId);
    expect(values.map((v) => v.field)).toEqual(['due_date', 'invoice_number', 'issue_date', 'total_amount', 'vendor_name']);
    expect(values.every((v) => v.reviewState === 'pending' && v.runId === runId)).toBe(true);

    expect(await processRun(deps(new MockProvider({})), runId)).toBe('skipped');
    expect(await valuesOf(versionId)).toHaveLength(5);
  });

  it('a hallucinated quote is stored as a gap, never as a value', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    await processRun(deps(new MockProvider({ MOCK_LLM_HALLUCINATE: 'total_amount' })), runId);
    const total = (await valuesOf(versionId)).find((v) => v.field === 'total_amount')!;
    expect(total).toMatchObject({ value: null, gapReason: 'evidence_not_in_text', evidenceQuote: null, evidenceStart: null });
    // What the model claimed is kept beside the gap for the reviewer, never as evidence.
    expect(total.rawValue).toBeTruthy();
    expect(total.claimedEvidence).toBeTruthy();
    expect(total.gapDetail).toContain(total.claimedEvidence!);
  });
});

describe('real provider (Anthropic) with a stubbed HTTP layer', () => {
  it('a valid structured answer is validated and committed; prompt and raw response are recorded on the run', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'doc-1', type: 'lease', fileBytes: fixture('lease-excerpt-001.pdf') });
    const answer = JSON.stringify({
      fields: [
        { field: 'tenant_name', value: 'Dana Okafor', evidence: 'Dana Okafor', reason: null },
        { field: 'monthly_rent', value: '$2,350.00', evidence: 'This quote is not in the lease at all: $2,350.00', reason: null },
        { field: 'lease_start', value: null, evidence: null, reason: 'not stated' },
      ],
    });
    const { provider, calls } = anthropicReplying({ text: answer });
    expect(await processRun(deps(provider), runId)).toBe('extracted');
    expect(calls).toHaveLength(1);

    const run = await runRow(runId);
    expect(run.provider).toBe('anthropic');
    expect(run.model).toBe('claude-sonnet-5-5');
    expect(run.rawResponse).toBe(answer);
    expect(run.prompt).toMatch(/^\[system\]\n[\s\S]*Fields to extract:[\s\S]*- tenant_name/);

    const byField = Object.fromEntries((await valuesOf(versionId)).map((v) => [v.field, v]));
    expect(byField.tenant_name).toMatchObject({ value: 'Dana Okafor', gapReason: null });
    expect(byField.monthly_rent).toMatchObject({
      value: null,
      gapReason: 'evidence_not_in_text',
      rawValue: '$2,350.00',
      claimedEvidence: 'This quote is not in the lease at all: $2,350.00',
    });
    expect(byField.lease_start!.claimedEvidence).toBeNull();
    expect(byField.lease_start).toMatchObject({ value: null, gapReason: 'not_found', gapDetail: 'not stated' });
    expect(byField.security_deposit).toMatchObject({ value: null, gapReason: 'missing_from_response' });
    expect(Object.keys(byField)).toHaveLength(EXPECTED_FIELDS.lease.length);
  });

  it('HTTP 500 → run failed (visible + retryable) with the error and the prompt recorded; no values', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    expect(await processRun(deps(anthropicReplying({ status: 500 }).provider), runId)).toBe('failed');
    const run = await runRow(runId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/Anthropic API error 500/);
    expect(run.prompt).toMatch(/^\[system\]/);
    expect(run).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', leaseUntil: null });
    expect(await valuesOf(versionId)).toHaveLength(0);

    // Retry = a new run for the same version (what POST /retry creates); it succeeds and commits once.
    const retry = await prisma.extractionRun.create({ data: { versionId, status: 'queued', attempt: 2 } });
    expect(await processRun(deps(new MockProvider({})), retry.id)).toBe('extracted');
    expect(await valuesOf(versionId)).toHaveLength(5);
  });

  it('malformed JSON → failed, with the broken raw response kept for debugging', async () => {
    const { runId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    const broken = '{"fields": [{"field": "invoice_number", "value": "INV-';
    expect(await processRun(deps(anthropicReplying({ text: broken }).provider), runId)).toBe('failed');
    expect(await runRow(runId)).toMatchObject({ status: 'failed', error: 'LlmError: Model returned invalid JSON', rawResponse: broken });
  });

  it('JSON without a fields array → failed, with prompt AND raw response kept', async () => {
    const { runId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    expect(await processRun(deps(anthropicReplying({ text: '{"answer":42}' }).provider), runId)).toBe('failed');
    const run = await runRow(runId);
    expect(run.error).toMatch(/no "fields" array/);
    expect(run.rawResponse).toBe('{"answer":42}');
    expect(run.prompt).toMatch(/^\[system\]/);
  });
});

describe('parse failures are a state, not an exception', () => {
  it('a corrupt PDF that still starts with %PDF- → failed with a parse error; the LLM is never called', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: new TextEncoder().encode('%PDF-1.7\nthis is not really a pdf\n') });
    const extract = vi.fn();
    expect(await processRun(deps({ name: 'spy', model: 'spy', extract }), runId)).toBe('failed');
    const run = await runRow(runId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/^PdfParseError: /);
    expect(extract).not.toHaveBeenCalled();
    expect((await prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } })).parsedText).toBeNull();
  });

  it('a PDF with no extractable text → failed ("no extractable text"), not a page of guessed gaps', async () => {
    const { runId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: blankPdf() });
    expect(await processRun(deps(new MockProvider({})), runId)).toBe('failed');
    expect((await runRow(runId)).error).toMatch(/PdfParseError: PDF contains no extractable text/);
  });

  it('an unexpected non-LLM error also ends as failed, with provider/model recorded', async () => {
    const { runId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    expect(await processRun(deps(failing(new TypeError('cannot read x of undefined'))), runId)).toBe('failed');
    expect(await runRow(runId)).toMatchObject({ status: 'failed', error: 'TypeError: cannot read x of undefined', provider: 'stub', model: 'stub-1' });
  });

  it('an LlmError keeps its raw response and prompt', async () => {
    const { runId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    await processRun(deps(failing(new LlmError('Model refused', '{"stop_reason":"refusal"}', '[system] P'))), runId);
    expect(await runRow(runId)).toMatchObject({ error: 'LlmError: Model refused', rawResponse: '{"stop_reason":"refusal"}', prompt: '[system] P' });
  });

  it('reuses stored parsed text instead of re-parsing (vN is always validated against vN\'s text)', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: blankPdf(), parsedText: 'Invoice Number: INV-1' });
    const seen: string[] = [];
    await processRun(deps(providerWith(async (req) => void seen.push(req.text))), runId);
    expect(seen).toEqual(['Invoice Number: INV-1']);
    expect((await runRow(runId)).status).toBe('extracted');
    expect((await valuesOf(versionId)).find((v) => v.field === 'invoice_number')!.value).toBe('INV-1');
  });
});

describe('races at commit time', () => {
  it('superseded while extracting → the commit is dropped and nothing is written for that version', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    const outcome = await processRun(deps(providerWith(async () => void (await supersedeActiveRuns(prisma, 'doc-1')))), runId);
    expect(outcome).toBe('dropped');
    expect((await runRow(runId)).status).toBe('superseded');
    expect(await valuesOf(versionId)).toHaveLength(0);
  });

  it('superseded, then the LLM fails → the run stays superseded (a late failure cannot overwrite it)', async () => {
    const { runId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    const p: LlmProvider = {
      name: 'stub',
      model: 'stub',
      extract: async () => {
        await supersedeActiveRuns(prisma, 'doc-1');
        throw new LlmError('HTTP 500');
      },
    };
    expect(await processRun(deps(p), runId)).toBe('dropped');
    expect((await runRow(runId)).status).toBe('superseded');
  });

  it('lease expired and another worker took over → the original worker\'s late commit is fenced out', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    let workerB: Promise<string> | null = null;
    const slowA = providerWith(async () => {
      // Worker A is presumed dead: its lease lapses, the reconciler on worker B requeues (attempt 2), B claims it.
      await prisma.$executeRaw`UPDATE extraction_runs SET lease_until = now() - interval '1 second' WHERE id = ${runId}`;
      expect((await recoverStaleRuns(prisma, 3, 'w-B')).requeued).toEqual([{ id: runId, attempt: 2 }]);
      workerB = processRun(deps(new MockProvider({}), { workerId: 'w-B' }), runId);
      expect(await workerB).toBe('extracted');
    });
    expect(await processRun(deps(slowA, { workerId: 'w-A' }), runId)).toBe('dropped');
    expect(workerB).not.toBeNull();
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: 'extracted', attempt: 2, workerId: 'w-B' });
    const values = await valuesOf(versionId);
    expect(values).toHaveLength(5); // exactly one value per field, from B's run
    expect(new Set(values.map((v) => v.runId))).toEqual(new Set([runId]));
  });

  it('the heartbeat notices a lost lease and aborts the in-flight LLM call', async () => {
    const { runId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    const slow = new MockProvider({ MOCK_LLM_DELAY_MS: '10000' }); // abortable sleep
    const started = Date.now();
    const p = processRun(deps(slow, { leaseMs: 1500, workerId: 'w-A' }), runId); // heartbeat every 500 ms
    await vi.waitFor(async () => expect((await runRow(runId)).status).toBe('extracting'));
    await prisma.$executeRaw`UPDATE extraction_runs SET lease_until = now() - interval '1 second' WHERE id = ${runId}`;
    await recoverStaleRuns(prisma, 3, 'w-B');
    expect(await p).toBe('dropped');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await runRow(runId)).toMatchObject({ status: 'queued', attempt: 2 }); // left for the new owner, untouched
  });

  it('a second run of an already-extracted version writes nothing (no duplicate values)', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    await processRun(deps(new MockProvider({})), runId);
    const again = await prisma.extractionRun.create({ data: { versionId, status: 'queued', attempt: 2 } });
    expect(await processRun(deps(new MockProvider({})), again.id)).toBe('dropped');
    expect(await runRow(again.id)).toMatchObject({ status: 'extracted', error: expect.stringMatching(/already committed/) });
    expect(await valuesOf(versionId)).toHaveLength(5);
  });

  it('concurrent deliveries of the same run: exactly one extracts', async () => {
    const { runId, versionId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    const outcomes = await Promise.all([1, 2, 3].map(() => processRun(deps(new MockProvider({})), runId)));
    expect(outcomes.sort()).toEqual(['extracted', 'skipped', 'skipped']);
    expect(await valuesOf(versionId)).toHaveLength(5);
  });
});

describe('graceful shutdown', () => {
  it('releases the in-flight run back to queued (attempt+1) and re-rings it', async () => {
    const { runId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    const shutdown = new AbortController();
    const onReleased = vi.fn(async () => undefined);
    const p = processRun(deps(new MockProvider({ MOCK_LLM_DELAY_MS: '10000' }), { shutdown: shutdown.signal, onReleased }), runId);
    await vi.waitFor(async () => expect((await runRow(runId)).status).toBe('extracting'));
    shutdown.abort();
    expect(await p).toBe('released');
    expect(await runRow(runId)).toMatchObject({ status: 'queued', attempt: 2, workerId: null });
    expect(onReleased).toHaveBeenCalledWith(runId, 2);
  });

  it('a job arriving after shutdown began is released immediately', async () => {
    const { runId } = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    const shutdown = new AbortController();
    shutdown.abort();
    expect(await processRun(deps(new MockProvider({ MOCK_LLM_DELAY_MS: '5000' }), { shutdown: shutdown.signal }), runId)).toBe('released');
  });
});

describe('re-extraction commit (carry-over)', () => {
  it('v2 of the invoice: 3 reviews carried over (incl. a correction), 2 changed values pending with their previous', async () => {
    const v1 = await insertDocument(prisma, { id: 'doc-1', fileBytes: INVOICE_V1 });
    await processRun(deps(new MockProvider({})), v1.runId);
    for (const v of await valuesOf(v1.versionId)) {
      const correct = v.field === 'vendor_name';
      await prisma.review.create({ data: { valueId: v.id, action: correct ? 'correct' : 'approve', value: correct ? 'Meridian Office Supplies LLC' : null, note: correct ? 'case' : null } });
      await prisma.extractedValue.update({ where: { id: v.id }, data: { reviewState: correct ? 'corrected' : 'approved' } });
    }
    const v2 = await prisma.documentVersion.create({
      data: { documentId: 'doc-1', versionNo: 2, fileBytes: INVOICE_V2, fileSha256: 'x', runs: { create: { status: 'queued', attempt: 1 } } },
      include: { runs: true },
    });
    await prisma.document.update({ where: { id: 'doc-1' }, data: { currentVersion: 2 } });
    expect(await processRun(deps(new MockProvider({})), v2.runs[0]!.id)).toBe('extracted');

    const prevIds = new Map((await valuesOf(v1.versionId)).map((v) => [v.field, v.id]));
    const byField = Object.fromEntries((await valuesOf(v2.id)).map((v) => [v.field, v]));
    for (const f of ['due_date', 'total_amount']) {
      expect(byField[f]).toMatchObject({ reviewState: 'pending', changed: true, previousValueId: prevIds.get(f) });
      expect(byField[f]!.reviews).toHaveLength(0);
    }
    for (const f of ['invoice_number', 'issue_date', 'vendor_name']) {
      expect(byField[f]).toMatchObject({ reviewState: 'carried_over', changed: false, previousValueId: prevIds.get(f) });
      expect(byField[f]!.reviews).toHaveLength(1);
      expect(byField[f]!.reviews[0]!.carriedFromReviewId).not.toBeNull();
    }
    expect(byField.vendor_name!.reviews[0]).toMatchObject({ action: 'correct', value: 'Meridian Office Supplies LLC', note: 'case' });
    // v1 untouched.
    const v1Values = await valuesOf(v1.versionId);
    expect(v1Values.map((v) => v.reviewState).sort()).toEqual(['approved', 'approved', 'approved', 'approved', 'corrected']);
    expect(v1Values.every((v) => v.reviews.length === 1)).toBe(true);
  });
});

describe('reconcile', () => {
  it('enqueues every queued run (repairs a lost enqueue / FLUSHALL) and survives enqueue failures', async () => {
    const a = await insertDocument(prisma, { id: 'doc-a', fileBytes: INVOICE_V1 });
    const b = await insertDocument(prisma, { id: 'doc-b', fileBytes: INVOICE_V1 });
    const enqueue = vi.fn(async (runId: string) => {
      if (runId === a.runId) throw new Error('redis down');
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await reconcile({ prisma, enqueue, maxRunAttempts: 3 });
    expect(res).toMatchObject({ queued: 2, enqueued: 1, requeued: [], failed: [] });
    expect(enqueue).toHaveBeenCalledWith(b.runId, 1);
    // Next tick, Redis is back: the run that missed its doorbell gets one, and is then processed normally.
    const ok = vi.fn(async () => undefined);
    expect((await reconcile({ prisma, enqueue: ok, maxRunAttempts: 3 })).enqueued).toBe(2);
    expect(await processRun(deps(new MockProvider({})), a.runId)).toBe('extracted');
  });

  it('recovers a dead worker\'s run and re-enqueues it with the new attempt; caps attempts with a visible failure', async () => {
    const { runId } = await insertDocument(prisma, { id: 'doc-a', fileBytes: INVOICE_V1 });
    await claimRun(prisma, runId, 30_000, 'worker-1');
    const enqueue = vi.fn(async () => undefined);
    // Boot of worker-1 after a crash: it reclaims its own run without waiting for the lease.
    const res = await reconcile({ prisma, enqueue, maxRunAttempts: 2 }, 'worker-1');
    expect(res.requeued).toEqual([{ id: runId, attempt: 2 }]);
    expect(enqueue).toHaveBeenCalledWith(runId, 2);

    await claimRun(prisma, runId, 30_000, 'worker-1');
    const res2 = await reconcile({ prisma, enqueue, maxRunAttempts: 2 }, 'worker-1');
    expect(res2).toMatchObject({ failed: [runId], requeued: [], queued: 0 });
    expect(await runRow(runId)).toMatchObject({ status: 'failed', error: expect.stringMatching(/interrupted 2 times/) });
  });
});
