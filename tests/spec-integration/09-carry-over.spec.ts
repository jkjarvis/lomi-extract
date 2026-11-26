import { beforeAll, describe, expect, it } from 'vitest';
import {
  byField,
  CANONICAL,
  describeRes,
  expectCanonicalValues,
  expectEvidenceInvariants,
  expectOneValuePerField,
  expectProgressPartition,
  getDetail,
  getProgress,
  restartWorker,
  review,
  reviewOk,
  uploadFixture,
  uploadVersion,
  waitForStatus,
} from './helpers';

// Brief §3 + CONTRACT §7.7: after reviewing every v1 value, uploading the revised invoice leaves EXACTLY the two
// changed values (due_date, total_amount) pending with previous value + review shown; the other three are carried
// over with their review (including a correction). v1 stays queryable with its reviews.

const CHANGED = ['due_date', 'total_amount'];
const CARRIED = ['invoice_number', 'issue_date', 'vendor_name'];
const CORRECTION = { action: 'correct', value: 'Meridian Office Supplies LLC', note: 'use registered casing' } as const;

describe('re-extraction carry-over (invoice v1 → v2)', () => {
  beforeAll(async () => {
    await restartWorker();
  });

  it('exactly due_date & total_amount go back to pending; the rest carry over with their reviews', async () => {
    // v1: extract and review everything (one correction).
    const doc = await uploadFixture('invoiceV1');
    const ex1 = await waitForStatus(doc.id, ['extracted', 'failed'], 90_000);
    expect(ex1.detail.status, `error=${ex1.detail.error}`).toBe('extracted');
    expectCanonicalValues(ex1.detail, 'invoiceV1');
    const v1 = byField(ex1.detail.values);
    for (const f of ['invoice_number', 'issue_date', 'due_date', 'total_amount']) await reviewOk(v1[f].id, { action: 'approve' });
    await reviewOk(v1.vendor_name.id, CORRECTION);
    expect(await getProgress(doc.id)).toMatchObject({ total: 5, pending: 0, approved: 4, corrected: 1, carriedOver: 0 });
    const v1Reviewed = await getDetail(doc.id, 1);

    // v2 arrives.
    const up = await uploadVersion(doc.id, 'invoiceV2');
    expect(up.id).toBe(doc.id);
    expect(up.currentVersion).toBe(2);
    expect(up.status).toBe('queued');

    const ex2 = await waitForStatus(doc.id, ['extracted', 'failed'], 90_000);
    const d2 = ex2.detail;
    expect(d2.status, `error=${d2.error}`).toBe('extracted');
    expect(d2.currentVersion).toBe(2);
    expect(d2.version).toBe(2);
    expect([...d2.versions].sort((a, b) => a.version - b.version).map((v) => [v.version, v.status])).toEqual([
      [1, 'extracted'],
      [2, 'extracted'],
    ]);
    expect(d2.text).toContain('REVISED');
    await expectOneValuePerField(d2);
    expectCanonicalValues(d2, 'invoiceV2');
    expectEvidenceInvariants(d2); // evidence offsets index v2's text

    const v2 = byField(d2.values);
    for (const f of CHANGED) {
      const x = v2[f];
      expect(x.reviewState, `${f} changed → pending`).toBe('pending');
      expect(x.changed, `${f}.changed`).toBe(true);
      expect(x.review, `${f}: no review yet on v2`).toBeNull();
      expect(x.previous, `${f}: previous must be shown`).not.toBeNull();
      expect(x.previous!.version).toBe(1);
      expect(x.previous!.value).toEqual(CANONICAL.invoiceV1[f]);
      expect(x.previous!.reviewState).toBe('approved');
      expect(x.previous!.review).toMatchObject({ action: 'approve' });
      const ws = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      expect(ws(x.previous!.evidenceQuote), `${f}: previous evidence quote is v1's quote`).toBe(ws(v1[f].evidence!.quote));
      expect(x.id).not.toBe(v1[f].id);
    }
    expect(v2.due_date.value).toBe('2025-11-13');
    expect(v2.total_amount.value).toEqual({ amount: 6126.45, currency: 'USD' });

    for (const f of CARRIED) {
      const x = v2[f];
      expect(x.reviewState, `${f} unchanged → carried_over`).toBe('carried_over');
      expect(x.changed, `${f}.changed`).toBe(false);
      expect(x.review, `${f}: carried review`).not.toBeNull();
      expect(x.previous?.version, `${f}: has a v1 predecessor`).toBe(1);
      expect(x.id).not.toBe(v1[f].id);
    }
    expect(v2.invoice_number.review?.action).toBe('approve');
    expect(v2.issue_date.review?.action).toBe('approve');
    expect(v2.invoice_number.effectiveValue).toBe('INV-2025-0847');
    // the correction itself is carried
    expect(v2.vendor_name.review).toMatchObject(CORRECTION);
    expect(v2.vendor_name.effectiveValue).toBe(CORRECTION.value);

    const p = await getProgress(doc.id);
    expect(p).toEqual({ total: 5, pending: 2, approved: 0, corrected: 0, carriedOver: 3, gaps: 0 });
    expect(d2.progress).toEqual(p);

    // v1 is untouched and still queryable.
    const v1Again = await getDetail(doc.id, 1);
    expect(v1Again.version).toBe(1);
    expect(v1Again.currentVersion).toBe(2);
    expect(v1Again.text).not.toContain('REVISED');
    expect(v1Again.values.sort((a, b) => a.field.localeCompare(b.field))).toEqual(
      v1Reviewed.values.sort((a, b) => a.field.localeCompare(b.field)),
    );
    expectEvidenceInvariants(v1Again); // v1 evidence still indexes v1 text
    expect(byField(v1Again.values).vendor_name.review).toMatchObject(CORRECTION);

    // Reviewing a non-current version's value → 409, and nothing changes.
    const r409 = await review(v1.due_date.id, { action: 'correct', value: '2025-10-15' });
    expect(r409.status, describeRes(r409)).toBe(409);
    expect(byField((await getDetail(doc.id, 1)).values).due_date.reviewState).toBe('approved');

    // Finish the v2 review → nothing pending.
    await reviewOk(v2.due_date.id, { action: 'approve' });
    await reviewOk(v2.total_amount.id, { action: 'approve' });
    const p2 = await getProgress(doc.id);
    expect(p2).toEqual({ total: 5, pending: 0, approved: 2, corrected: 0, carriedOver: 3, gaps: 0 });
    expectProgressPartition(p2);

    // v3 = same text again → everything carries (approved and carried_over predecessors both carry).
    await uploadVersion(doc.id, 'invoiceV2');
    const ex3 = await waitForStatus(doc.id, ['extracted', 'failed'], 90_000);
    expect(ex3.detail.status).toBe('extracted');
    expect(ex3.detail.currentVersion).toBe(3);
    const p3 = await getProgress(doc.id);
    expect(p3).toEqual({ total: 5, pending: 0, approved: 0, corrected: 0, carriedOver: 5, gaps: 0 });
    const v3 = byField(ex3.detail.values);
    expect(v3.vendor_name.review).toMatchObject(CORRECTION);
    for (const x of ex3.detail.values) {
      expect(x.changed, x.field).toBe(false);
      expect(x.previous?.version, x.field).toBe(2);
    }
    // all three versions remain queryable
    for (const n of [1, 2, 3]) expect((await getDetail(doc.id, n)).version).toBe(n);
  });

  it('unreviewed v1 → same PDF as v2: everything stays pending, nothing flagged as changed', async () => {
    const doc = await uploadFixture('invoiceV1');
    await waitForStatus(doc.id, ['extracted'], 90_000);
    await uploadVersion(doc.id, 'invoiceV1');
    const { detail } = await waitForStatus(doc.id, ['extracted', 'failed'], 90_000);
    expect(detail.currentVersion).toBe(2);
    for (const x of detail.values) {
      expect(x.reviewState, x.field).toBe('pending');
      expect(x.changed, x.field).toBe(false);
    }
    expect(await getProgress(doc.id)).toMatchObject({ total: 5, pending: 5, carriedOver: 0 });
  });

  it('unreviewed v1 → revised v2: changed values are flagged changed with previous shown, others stay pending', async () => {
    const doc = await uploadFixture('invoiceV1');
    await waitForStatus(doc.id, ['extracted'], 90_000);
    await uploadVersion(doc.id, 'invoiceV2');
    const { detail } = await waitForStatus(doc.id, ['extracted', 'failed'], 90_000);
    const v = byField(detail.values);
    for (const f of CHANGED) {
      expect(v[f].changed, f).toBe(true);
      expect(v[f].reviewState, f).toBe('pending');
      expect(v[f].previous?.value, f).toEqual(CANONICAL.invoiceV1[f]);
      expect(v[f].previous?.review ?? null, f).toBeNull();
    }
    for (const f of CARRIED) {
      expect(v[f].changed, f).toBe(false);
      expect(v[f].reviewState, f).toBe('pending');
    }
  });
});
