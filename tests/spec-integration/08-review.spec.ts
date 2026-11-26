import { beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  byField,
  describeRes,
  expectProgressPartition,
  getDetail,
  getProgress,
  restartWorker,
  review,
  reviewOk,
  uploadFixture,
  waitForStatus,
  type DocumentSummary,
  type ValueDTO,
} from './helpers';

// CONTRACT §3 POST /values/:id/review: approve | correct{value, note?}; corrections live BESIDE the extracted value;
// re-review allowed (latest wins); correct without value → 400; approving a gap → 400 gap_requires_correction.

async function freshExtracted(fixture: 'invoiceV1' | 'marketReport') {
  const doc = await uploadFixture(fixture);
  const { detail } = await waitForStatus(doc.id, ['extracted', 'failed'], 90_000);
  expect(detail.status, `error=${detail.error}`).toBe('extracted');
  return detail;
}

describe('review', () => {
  beforeAll(async () => {
    await restartWorker();
  });

  it('approve → reviewState approved, review recorded, effectiveValue = value, progress updated', async () => {
    const d = await freshExtracted('invoiceV1');
    const v = byField(d.values);
    expect(await getProgress(d.id)).toMatchObject({ total: 5, pending: 5, approved: 0, corrected: 0, carriedOver: 0, gaps: 0 });
    for (const x of d.values) {
      expect(x.reviewState).toBe('pending');
      expect(x.review).toBeNull();
      expect(x.changed).toBe(false);
      expect(x.previous, 'version 1 has no predecessor').toBeNull();
      expect(x.effectiveValue).toEqual(x.value);
    }

    const res = await reviewOk(v.invoice_number.id, { action: 'approve' });
    expect(res.id).toBe(v.invoice_number.id);
    expect(res.reviewState).toBe('approved');
    expect(res.review).toMatchObject({ action: 'approve' });
    expect(Number.isNaN(Date.parse(res.review!.createdAt))).toBe(false);
    expect(res.value).toBe('INV-2025-0847');
    expect(res.effectiveValue).toBe('INV-2025-0847');

    const again = byField((await getDetail(d.id)).values);
    expect(again.invoice_number.reviewState).toBe('approved');
    const p = await getProgress(d.id);
    expect(p).toMatchObject({ total: 5, pending: 4, approved: 1, corrected: 0, carriedOver: 0, gaps: 0 });
  });

  it('correct with value + note → stored beside the extracted value (value/rawValue/evidence unchanged)', async () => {
    const d = await freshExtracted('invoiceV1');
    const orig = byField(d.values).vendor_name;
    const res = await reviewOk(orig.id, { action: 'correct', value: 'Meridian Office Supplies, LLC', note: 'legal name per W-9' });
    expect(res.reviewState).toBe('corrected');
    expect(res.review).toMatchObject({ action: 'correct', value: 'Meridian Office Supplies, LLC', note: 'legal name per W-9' });
    expect(res.value, 'extracted value must not be overwritten').toEqual(orig.value);
    expect(res.rawValue).toEqual(orig.rawValue);
    expect(res.evidence).toEqual(orig.evidence);
    expect(res.effectiveValue).toBe('Meridian Office Supplies, LLC');

    const persisted = byField((await getDetail(d.id)).values).vendor_name;
    expect(persisted).toMatchObject({
      value: orig.value,
      reviewState: 'corrected',
      effectiveValue: 'Meridian Office Supplies, LLC',
      review: { action: 'correct', value: 'Meridian Office Supplies, LLC', note: 'legal name per W-9' },
    });
  });

  it('correct without a note → note null', async () => {
    const d = await freshExtracted('invoiceV1');
    const res = await reviewOk(byField(d.values).invoice_number.id, { action: 'correct', value: 'INV-2025-0847-A' });
    expect(res.review).toMatchObject({ action: 'correct', value: 'INV-2025-0847-A', note: null });
  });

  it('correcting a money value keeps the extracted money value and records the raw correction', async () => {
    const d = await freshExtracted('invoiceV1');
    const orig = byField(d.values).total_amount;
    const res = await reviewOk(orig.id, { action: 'correct', value: '$5,300.00', note: 'per phone call' });
    expect(res.reviewState).toBe('corrected');
    expect(res.value).toEqual({ amount: 5230.29, currency: 'USD' });
    expect(res.review?.value).toBe('$5,300.00');
    expect(res.effectiveValue).not.toBeNull();
  });

  it('re-review overrides (latest wins): correct → approve → correct', async () => {
    const d = await freshExtracted('invoiceV1');
    const id = byField(d.values).vendor_name.id;
    await reviewOk(id, { action: 'correct', value: 'First Correction' });
    const approved = await reviewOk(id, { action: 'approve' });
    expect(approved.reviewState).toBe('approved');
    expect(approved.review?.action).toBe('approve');
    expect(String(approved.effectiveValue).toLowerCase()).toBe('meridian office supplies llc');
    const second = await reviewOk(id, { action: 'correct', value: 'Second Correction', note: 'n2' });
    expect(second.reviewState).toBe('corrected');
    expect(second.review).toMatchObject({ action: 'correct', value: 'Second Correction', note: 'n2' });
    expect(second.effectiveValue).toBe('Second Correction');

    const p = await getProgress(d.id);
    expect(p).toMatchObject({ total: 5, pending: 4, approved: 0, corrected: 1 });
  });

  it.each([
    [{ action: 'correct' }],
    [{ action: 'correct', note: 'no value' }],
    [{ action: 'correct', value: null }],
    [{ action: 'reject' }],
    [{}],
  ])('invalid body %j → 400', async (body) => {
    const d = await freshExtracted('invoiceV1');
    const id = byField(d.values).due_date.id;
    const r = await review(id, body);
    expect(r.status, describeRes(r)).toBe(400);
    const after = byField((await getDetail(d.id)).values).due_date;
    expect(after.reviewState, 'a rejected review must not change state').toBe('pending');
  });

  it('gaps: approve → 400 gap_requires_correction; correct → 200; still counted as a gap', async () => {
    const d = await freshExtracted('marketReport');
    const gap = byField(d.values).median_household_income;
    expect(gap.value).toBeNull();
    expect(gap.gap?.reason).toBeTruthy();

    const bad = await review(gap.id, { action: 'approve' });
    expect(bad.status, describeRes(bad)).toBe(400);
    expect((bad.body as any)?.error?.code).toBe('gap_requires_correction');
    expect(byField((await getDetail(d.id)).values).median_household_income.reviewState).toBe('pending');

    const fixed = await reviewOk(gap.id, { action: 'correct', value: '$85,000', note: 'from census table' });
    expect(fixed.reviewState).toBe('corrected');
    expect(fixed.value, 'the extracted gap stays null; the correction lives beside it').toBeNull();
    expect(fixed.gap).not.toBeNull();
    expect(fixed.review).toMatchObject({ action: 'correct', value: '$85,000', note: 'from census table' });
    expect(fixed.effectiveValue).not.toBeNull();

    const p = await getProgress(d.id);
    expect(p).toMatchObject({ total: 6, pending: 5, approved: 0, corrected: 1, carriedOver: 0, gaps: 1 });
    expectProgressPartition(p);
  });

  it('progress endpoint and document summary agree after a full review pass', async () => {
    const d = await freshExtracted('invoiceV1');
    const v = byField(d.values);
    await reviewOk(v.invoice_number.id, { action: 'approve' });
    await reviewOk(v.issue_date.id, { action: 'approve' });
    await reviewOk(v.due_date.id, { action: 'approve' });
    await reviewOk(v.vendor_name.id, { action: 'correct', value: 'Meridian Office Supplies LLC' });
    await reviewOk(v.total_amount.id, { action: 'approve' });

    const p = await getProgress(d.id);
    expect(p).toEqual({ total: 5, pending: 0, approved: 4, corrected: 1, carriedOver: 0, gaps: 0 });
    const summary = (await api<DocumentSummary[]>('GET', '/documents')).body.find((x) => x.id === d.id)!;
    expect(summary.progress).toEqual(p);
    const detail = await getDetail(d.id);
    expect(detail.progress).toEqual(p);
    const states = detail.values.map((x: ValueDTO) => x.reviewState).sort();
    expect(states).toEqual(['approved', 'approved', 'approved', 'approved', 'corrected']);
  });
});
