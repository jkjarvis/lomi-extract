import { afterAll, describe, expect, it } from 'vitest';
import {
  byField,
  describeRes,
  expectCanonicalValues,
  expectOneValuePerField,
  flushRedis,
  getDetail,
  restartWorker,
  retry,
  reviewOk,
  settleExtracted,
  sleep,
  uploadFixture,
  waitForStatus,
} from './helpers';

// Brief: "Extracting the same document version twice must not duplicate values — however the second run happens
// (a retry, a crash recovery, an impatient user)." CONTRACT §7.3.

describe('idempotent extraction: exactly one value per field per version', () => {
  afterAll(async () => {
    await restartWorker();
  });

  it('FLUSHALL + worker recreate while extracting (crash recovery / redelivery) → still one value per field', async () => {
    await restartWorker({ MOCK_LLM_DELAY_MS: '8000' });
    const doc = await uploadFixture('invoiceV1');
    await waitForStatus(doc.id, ['extracting'], 60_000, { intervalMs: 200 });

    await flushRedis();
    await restartWorker({ MOCK_LLM_DELAY_MS: '2000' }); // the old worker may still commit during shutdown

    const { detail } = await settleExtracted(doc.id, 120_000);
    await expectOneValuePerField(detail);
    expectCanonicalValues(detail, 'invoiceV1');
  });

  it('concurrent POST /retry burst on a failed document → one value per field', async () => {
    await restartWorker({ MOCK_LLM_FAIL: 'always' });
    const doc = await uploadFixture('lease');
    const failed = await waitForStatus(doc.id, ['failed', 'extracted'], 150_000);
    expect(failed.detail.status, `expected failed, history ${failed.history.join(' → ')}`).toBe('failed');

    // Fix the "LLM" but keep it slow so overlapping runs would collide if retries were not deduplicated.
    await restartWorker({ MOCK_LLM_DELAY_MS: '3000' });
    const responses = await Promise.all(Array.from({ length: 6 }, () => retry(doc.id)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 202).length, `at least one retry must be accepted: ${statuses}`).toBeGreaterThanOrEqual(1);
    for (const r of responses) expect([202, 409], describeRes(r)).toContain(r.status);

    const { detail } = await waitForStatus(doc.id, ['extracted', 'failed'], 120_000);
    expect(detail.status, `error=${detail.error}`).toBe('extracted');
    await expectOneValuePerField(detail);
    expectCanonicalValues(detail, 'lease');

    // A late duplicate run must not appear afterwards either.
    await sleep(8_000);
    const later = await getDetail(doc.id);
    await expectOneValuePerField(later);
    expect(later.values.map((v) => v.id).sort()).toEqual(detail.values.map((v) => v.id).sort());
  });

  it('an extracted version is not re-extracted by the reconciler: value ids and reviews are stable over time', async () => {
    await restartWorker();
    const doc = await uploadFixture('invoiceV1');
    const { detail } = await waitForStatus(doc.id, ['extracted'], 90_000);
    const v = byField(detail.values);
    await reviewOk(v.invoice_number.id, { action: 'approve' });
    await reviewOk(v.vendor_name.id, { action: 'correct', value: 'Meridian Office Supplies LLC', note: 'casing' });
    const before = await getDetail(doc.id);

    // > RECONCILE_INTERVAL_MS (default 10 s), plus a worker restart (reconciler runs on boot).
    await restartWorker();
    await sleep(12_000);

    const after = await getDetail(doc.id);
    expect(after.status).toBe('extracted');
    await expectOneValuePerField(after);
    expect(after.values.sort((a, b) => a.field.localeCompare(b.field))).toEqual(
      before.values.sort((a, b) => a.field.localeCompare(b.field)),
    );
  });
});
