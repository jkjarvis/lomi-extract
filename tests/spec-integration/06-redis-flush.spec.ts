import { afterAll, describe, expect, it } from 'vitest';
import {
  api,
  byField,
  expectCanonicalValues,
  expectOneValuePerField,
  flushRedis,
  getDetail,
  restartServices,
  restartWorker,
  reviewOk,
  settleExtracted,
  snapshotOf,
  startWorker,
  stopWorker,
  uploadFixture,
  waitForStatus,
  type DocumentSummary,
} from './helpers';

// Brief: "A Redis flush is not a disaster. If we run FLUSHALL on Redis and restart the stack, no extracted value,
// review, or visible job outcome is lost, and any document that was mid-extraction ends up completed or visibly
// retryable — never stuck." CONTRACT §7.5.

describe('Redis FLUSHALL', () => {
  afterAll(async () => {
    await restartWorker();
  });

  it('FLUSHALL mid-extraction + restart api & worker: in-flight docs complete/retryable, existing values & reviews unchanged', async () => {
    // 1. A reviewed, extracted document (state that must survive).
    await restartWorker();
    const reviewed = await uploadFixture('invoiceV1');
    const ex = await waitForStatus(reviewed.id, ['extracted'], 90_000);
    const v = byField(ex.detail.values);
    await reviewOk(v.invoice_number.id, { action: 'approve' });
    await reviewOk(v.total_amount.id, { action: 'correct', value: '$5,230.00', note: 'rounding dispute' });

    // A failed document (a visible job outcome that must survive too).
    await restartWorker({ MOCK_LLM_FAIL: 'always' });
    const failedDoc = await uploadFixture('lease');
    const f = await waitForStatus(failedDoc.id, ['failed', 'extracted'], 150_000);
    expect(f.detail.status).toBe('failed');

    // 2. Snapshot every settled document (seed docs included).
    const list = (await api<DocumentSummary[]>('GET', '/documents')).body;
    const settled = list.filter((d) => d.status === 'extracted' || d.status === 'failed');
    const before = new Map<string, ReturnType<typeof snapshotOf>>();
    for (const d of settled) before.set(d.id, snapshotOf(await getDetail(d.id)));
    const progressBefore = new Map(settled.map((d) => [d.id, d.progress]));

    // 3. In-flight work: one extracting, one queued behind it.
    await restartWorker({ MOCK_LLM_DELAY_MS: '8000' });
    const inflight = await uploadFixture('marketReport');
    const queued = await uploadFixture('invoiceV2');
    await waitForStatus(inflight.id, ['extracting'], 60_000, { intervalMs: 200 });

    // 4. Disaster.
    await flushRedis();
    await restartServices(['api', 'worker']);

    // 5. In-flight docs end extracted (or failed & retryable → extracted).
    for (const [doc, fixture] of [
      [inflight, 'marketReport'],
      [queued, 'invoiceV2'],
    ] as const) {
      const { detail } = await settleExtracted(doc.id, 150_000);
      await expectOneValuePerField(detail);
      expectCanonicalValues(detail, fixture);
    }

    // 6. Nothing that was settled changed: values, reviews, statuses, errors-as-outcomes, progress.
    for (const [id, snap] of before) {
      const now = snapshotOf(await getDetail(id));
      expect(now, `document ${id} changed after FLUSHALL + restart`).toEqual(snap);
    }
    const listAfter = (await api<DocumentSummary[]>('GET', '/documents')).body;
    for (const d of listAfter) {
      if (!progressBefore.has(d.id)) continue;
      expect(d.progress, `progress of ${d.id}`).toEqual(progressBefore.get(d.id));
    }
    const failedAfter = await getDetail(failedDoc.id);
    expect(failedAfter.status, 'a failed outcome is not lost by a Redis flush').toBe('failed');
    expect(failedAfter.error).toBeTruthy();

    // The reviewed document still has its approve + correction.
    const r = byField((await getDetail(reviewed.id)).values);
    expect(r.invoice_number.reviewState).toBe('approved');
    expect(r.total_amount.reviewState).toBe('corrected');
    expect(r.total_amount.review).toMatchObject({ action: 'correct', value: '$5,230.00', note: 'rounding dispute' });
  });

  it('FLUSHALL while a document is only queued (worker down) → it is still extracted after the worker starts', async () => {
    await restartWorker();
    await stopWorker();
    try {
      const doc = await uploadFixture('lease');
      await flushRedis(); // the enqueued job is gone; Postgres still says queued
      await startWorker();
      const { detail } = await settleExtracted(doc.id, 90_000);
      await expectOneValuePerField(detail);
      expectCanonicalValues(detail, 'lease');
    } finally {
      await startWorker().catch(() => undefined);
    }
  });
});
