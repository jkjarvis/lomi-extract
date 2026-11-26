import { readFileSync } from 'node:fs';
import { EXPECTED_FIELDS, validateExtraction } from '@lomi/core';
import { MockProvider, pdfToText } from '@lomi/extraction';
import { describe, expect, it } from 'vitest';
import type { PrevValueRow } from '../src/plan.js';
import { planValues } from '../src/plan.js';

const pdf = (n: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/documents/${n}`, import.meta.url)));

async function extract(file: string) {
  const text = await pdfToText(pdf(file));
  const res = await new MockProvider({}).extract({ docType: 'invoice', fields: EXPECTED_FIELDS.invoice, text, attempt: 1 });
  return { text, values: validateExtraction(text, EXPECTED_FIELDS.invoice, res.fields) };
}

describe('planValues', () => {
  it('first version: everything pending, nothing changed, no previous', async () => {
    const v1 = await extract('invoice-001.pdf');
    const plan = planValues(v1.values, [], v1.text);
    expect(plan.every((p) => p.reviewState === 'pending' && !p.changed && p.previousValueId === null)).toBe(true);
  });

  it('invoice v2 after all-approved v1: 3 carried with their reviews, 2 changed pending', async () => {
    const v1 = await extract('invoice-001.pdf');
    const v2 = await extract('invoice-001.v2.pdf');
    const prev: PrevValueRow[] = v1.values.map((v, i) => ({
      id: `val-${v.field}`,
      field: v.field,
      value: v.value,
      evidenceQuote: v.evidence?.quote ?? null,
      reviewState: i === 3 ? 'corrected' : 'approved',
      latestReview: i === 3
        ? { id: 'rev-3', action: 'correct', value: 'Meridian Office Supplies, LLC', note: 'proper casing' }
        : { id: `rev-${i}`, action: 'approve', value: null, note: null },
    }));
    const plan = planValues(v2.values, prev, v2.text);
    const by = Object.fromEntries(plan.map((p) => [p.validated.field, p]));
    expect(plan.filter((p) => p.reviewState === 'carried_over').map((p) => p.validated.field)).toEqual([
      'invoice_number',
      'issue_date',
      'vendor_name',
    ]);
    expect(plan.filter((p) => p.reviewState === 'pending').map((p) => p.validated.field)).toEqual(['due_date', 'total_amount']);
    expect(by.due_date!.changed).toBe(true);
    expect(by.total_amount!.changed).toBe(true);
    expect(by.vendor_name!.carriedReview).toMatchObject({ action: 'correct', value: 'Meridian Office Supplies, LLC' });
    expect(plan.every((p) => p.previousValueId === `val-${p.validated.field}`)).toBe(true);
  });

  it('unreviewed previous values stay pending and are not marked changed when identical', async () => {
    const v1 = await extract('invoice-001.pdf');
    const prev: PrevValueRow[] = v1.values.map((v) => ({
      id: v.field, field: v.field, value: v.value, evidenceQuote: v.evidence?.quote ?? null, reviewState: 'pending', latestReview: null,
    }));
    const plan = planValues(v1.values, prev, v1.text);
    expect(plan.every((p) => p.reviewState === 'pending' && !p.changed)).toBe(true);
  });

  it('a gap confirmed missing in v1 never carries over: the same gap in v2 is pending again, with v1 shown as previous', async () => {
    const v1 = await extract('invoice-001.pdf');
    const gapped = v1.values.map((v) =>
      v.field === 'due_date' ? { ...v, value: null, evidence: null, gap: { reason: 'not_found' as const } } : v,
    );
    const prev: PrevValueRow[] = gapped.map((v) => ({
      id: `val-${v.field}`,
      field: v.field,
      value: v.value,
      evidenceQuote: v.evidence?.quote ?? null,
      reviewState: 'approved',
      latestReview: v.value === null
        ? { id: 'rev-gap', action: 'confirm_missing', value: null, note: 'not on this invoice' }
        : { id: `rev-${v.field}`, action: 'approve', value: null, note: null },
    }));
    const plan = planValues(gapped, prev, v1.text);
    const due = plan.find((p) => p.validated.field === 'due_date')!;
    expect(due).toMatchObject({ reviewState: 'pending', carriedReview: null, previousValueId: 'val-due_date' });
    expect(due.validated.value).toBeNull();
    expect(plan.filter((p) => p.reviewState === 'carried_over')).toHaveLength(4);
  });
});
