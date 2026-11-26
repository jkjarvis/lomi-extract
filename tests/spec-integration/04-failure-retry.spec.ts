import { afterAll, describe, expect, it } from 'vitest';
import {
  api,
  describeRes,
  expectCanonicalValues,
  expectEvidenceInvariants,
  expectOneValuePerField,
  getDetail,
  restartWorker,
  retry,
  uploadFixture,
  waitForStatus,
  type DocumentSummary,
} from './helpers';

// Brief: "A failure is a state, not an exception. An LLM or parsing error leaves the document visibly failed and
// retryable." CONTRACT §3 (retry 202 / 409), §7.4.

describe('failure is a state; retry recovers', () => {
  afterAll(async () => {
    await restartWorker();
  });

  it('MOCK_LLM_FAIL=always → failed with error (not stuck); retry while still failing → failed again; fixed → retry → extracted', async () => {
    await restartWorker({ MOCK_LLM_FAIL: 'always' });
    const doc = await uploadFixture('invoiceV1');

    const failed = await waitForStatus(doc.id, ['failed', 'extracted'], 150_000);
    expect(failed.detail.status, `history: ${failed.history.join(' → ')}`).toBe('failed');
    expect(typeof failed.detail.error).toBe('string');
    expect(failed.detail.error!.trim().length, 'failed document must expose a non-empty error').toBeGreaterThan(0);
    expect(failed.detail.values).toEqual([]);

    // visible in the list too
    const list = await api<DocumentSummary[]>('GET', '/documents');
    const row = list.body.find((d) => d.id === doc.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toBeTruthy();

    // retry while the LLM is still broken → accepted, then failed again (never stuck in extracting)
    const r1 = await retry(doc.id);
    expect(r1.status, describeRes(r1)).toBe(202);
    const again = await waitForStatus(doc.id, ['failed', 'extracted'], 150_000);
    expect(again.detail.status).toBe('failed');
    expect(again.detail.error).toBeTruthy();

    // fix the LLM, retry → extracted
    await restartWorker({ MOCK_LLM_FAIL: 'never' });
    const r2 = await retry(doc.id);
    expect(r2.status, describeRes(r2)).toBe(202);
    const done = await waitForStatus(doc.id, ['extracted', 'failed'], 120_000);
    expect(done.detail.status, `error=${done.detail.error}`).toBe('extracted');
    expect(done.detail.error).toBeNull();
    await expectOneValuePerField(done.detail);
    expectCanonicalValues(done.detail, 'invoiceV1');
    expectEvidenceInvariants(done.detail);
    expect(done.detail.currentVersion, 'retry re-runs the same version, it does not create one').toBe(1);
  });

  it('POST /retry on an extracted document → 409', async () => {
    await restartWorker();
    const doc = await uploadFixture('marketReport');
    await waitForStatus(doc.id, ['extracted'], 90_000);
    const r = await retry(doc.id);
    expect(r.status, describeRes(r)).toBe(409);
    const d = await getDetail(doc.id);
    expect(d.status, '409 retry must not change anything').toBe('extracted');
  });

  it('MOCK_LLM_FAIL=once → ends in a terminal state (extracted, or failed with an error), never stuck', async () => {
    await restartWorker({ MOCK_LLM_FAIL: 'once' });
    const doc = await uploadFixture('lease');
    const { detail } = await waitForStatus(doc.id, ['extracted', 'failed'], 150_000);
    if (detail.status === 'failed') expect(detail.error).toBeTruthy();
    else await expectOneValuePerField(detail);
  });
});
