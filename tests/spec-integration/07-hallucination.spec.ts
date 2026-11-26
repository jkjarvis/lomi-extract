import { afterAll, describe, expect, it } from 'vitest';
import {
  byField,
  CANONICAL,
  expectEvidenceInvariants,
  expectOneValuePerField,
  expectProgressPartition,
  getProgress,
  restartWorker,
  uploadFixture,
  waitForStatus,
} from './helpers';

// Brief: "a value whose evidence doesn't appear there is stored as a gap (value: null, with a reason), never kept."
// CONTRACT §5 MOCK_LLM_HALLUCINATE, §7.6.

describe('hallucination defense', () => {
  afterAll(async () => {
    await restartWorker();
  });

  it('MOCK_LLM_HALLUCINATE=total_amount → total_amount is a gap evidence_not_in_text; other fields intact', async () => {
    await restartWorker({ MOCK_LLM_HALLUCINATE: 'total_amount' });
    const doc = await uploadFixture('invoiceV1');
    const { detail } = await waitForStatus(doc.id, ['extracted', 'failed'], 90_000);
    expect(detail.status, `error=${detail.error}`).toBe('extracted');
    await expectOneValuePerField(detail);
    expectEvidenceInvariants(detail);

    const v = byField(detail.values);
    expect(v.total_amount.value, 'hallucinated value must never be kept').toBeNull();
    expect(v.total_amount.gap?.reason).toBe('evidence_not_in_text');
    expect(v.total_amount.evidence).toBeNull();
    expect(v.total_amount.effectiveValue).toBeNull();
    expect(v.total_amount.reviewState).toBe('pending');

    for (const field of ['invoice_number', 'issue_date', 'due_date']) {
      expect(v[field].gap, field).toBeNull();
      expect(v[field].value, field).toEqual(CANONICAL.invoiceV1[field]);
    }
    expect(v.vendor_name.gap).toBeNull();

    const p = await getProgress(doc.id);
    expect(p.gaps).toBe(1);
    expect(p.total).toBe(5);
    expectProgressPartition(p);
  });

  it('MOCK_LLM_HALLUCINATE=tenant_name,monthly_rent → both are evidence_not_in_text gaps', async () => {
    await restartWorker({ MOCK_LLM_HALLUCINATE: 'tenant_name,monthly_rent' });
    const doc = await uploadFixture('lease');
    const { detail } = await waitForStatus(doc.id, ['extracted', 'failed'], 90_000);
    expect(detail.status, `error=${detail.error}`).toBe('extracted');
    const v = byField(detail.values);
    for (const field of ['tenant_name', 'monthly_rent']) {
      expect(v[field].value, field).toBeNull();
      expect(v[field].gap?.reason, field).toBe('evidence_not_in_text');
    }
    expect(v.security_deposit.value).toEqual(CANONICAL.lease.security_deposit);
    expect(v.term_months.value).toBe(24);
    expect((await getProgress(doc.id)).gaps).toBe(2);
  });
});
