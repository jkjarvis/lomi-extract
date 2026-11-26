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
});
