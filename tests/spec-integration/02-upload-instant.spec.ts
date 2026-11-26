import { afterAll, describe, expect, it } from 'vitest';
import {
  describeRes,
  expectOneValuePerField,
  getDetail,
  readFixture,
  restartWorker,
  retry,
  sleep,
  startWorker,
  stopWorker,
  uniqueTitle,
  uploadDocumentRaw,
  waitForStatus,
} from './helpers';

// Brief: "Uploading must feel instant … An upload must never wait for the LLM." CONTRACT §7.1.

const INSTANT_MS = 1000; // contract target is < 300 ms; we allow headroom for CI/docker networking

describe('upload is instant and status is visible', () => {
  afterAll(async () => {
    await restartWorker(); // back to default knobs
  });

  it('with MOCK_LLM_DELAY_MS=8000: 202 in < 1 s, queued → extracting → extracted', async () => {
    await restartWorker({ MOCK_LLM_DELAY_MS: '8000' });

    const r = await uploadDocumentRaw('invoice', readFixture('invoiceV1'), uniqueTitle('instant'));
    expect(r.status, describeRes(r)).toBe(202);
    expect(r.ms, `POST /documents took ${Math.round(r.ms)} ms`).toBeLessThan(INSTANT_MS);
    expect(r.body.status).toBe('queued');
    const id: string = r.body.id;

    // Extraction is underway (the mock sleeps 8 s) and visible as such.
    const extracting = await waitForStatus(id, ['extracting', 'extracted', 'failed'], 60_000, { intervalMs: 200 });
    expect(extracting.detail.status, `history: ${extracting.history.join(' → ')}`).toBe('extracting');
    expect(extracting.detail.values, 'no values are shown while extracting').toEqual([]);

    // POST /retry while not failed → 409
    const rr = await retry(id);
    expect(rr.status, `retry while extracting: ${describeRes(rr)}`).toBe(409);

    const done = await waitForStatus(id, ['extracted', 'failed'], 90_000, { intervalMs: 200, history: extracting.history });
    expect(done.detail.status, `history: ${done.history.join(' → ')} error=${done.detail.error}`).toBe('extracted');
    expect(done.history).not.toContain('failed');
    const order = done.history.filter((s) => ['queued', 'extracting', 'extracted'].includes(s));
    expect(order.indexOf('extracting')).toBeLessThan(order.indexOf('extracted'));
    await expectOneValuePerField(done.detail);
  });

  it('several uploads in a row are all instant while the worker is busy', async () => {
    await restartWorker({ MOCK_LLM_DELAY_MS: '8000' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await uploadDocumentRaw('lease', readFixture('lease'), uniqueTitle(`burst ${i}`));
      expect(r.status, describeRes(r)).toBe(202);
      expect(r.ms, `upload #${i} took ${Math.round(r.ms)} ms`).toBeLessThan(INSTANT_MS);
      ids.push(r.body.id);
    }
    for (const id of ids) {
      const { detail } = await waitForStatus(id, ['extracted', 'failed'], 150_000);
      expect(detail.status, `${id} error=${detail.error}`).toBe('extracted');
    }
  });

  it('upload succeeds instantly even with the worker stopped; it stays queued and extracts once the worker is back', async () => {
    await restartWorker();
    await stopWorker();
    try {
      const r = await uploadDocumentRaw('invoice', readFixture('invoiceV1'), uniqueTitle('worker down'));
      expect(r.status, describeRes(r)).toBe(202);
      expect(r.ms).toBeLessThan(INSTANT_MS);
      expect(r.body.status).toBe('queued');
      await sleep(3_000);
      const d = await getDetail(r.body.id);
      expect(d.status, 'nothing can extract without a worker').toBe('queued');
      await startWorker();
      const { detail } = await waitForStatus(r.body.id, ['extracted', 'failed'], 90_000);
      expect(detail.status, `error=${detail.error}`).toBe('extracted');
    } finally {
      await startWorker().catch(() => undefined);
    }
  });
});
