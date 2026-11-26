import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LlmField, PrevValue, ValidatedValue } from '../src/index.js';
import { EXPECTED_FIELDS, computeProgress, decideCarryOver, deepEqual, validateExtraction } from '../src/index.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const v1Text = fixture('invoice-v1');
const v2Text = fixture('invoice-v2');

const v1Llm: LlmField[] = [
  { field: 'invoice_number', value: 'INV-2025-0847', evidence: 'Invoice Number: INV-2025-0847' },
  { field: 'issue_date', value: '2025-09-14', evidence: 'Issue Date: 2025-09-14' },
  { field: 'due_date', value: '2025-10-14', evidence: 'Due Date: 2025-10-14' },
  { field: 'vendor_name', value: 'MERIDIAN OFFICE SUPPLIES LLC', evidence: 'MERIDIAN OFFICE SUPPLIES LLC' },
  { field: 'total_amount', value: '$5,230.29', evidence: 'Total Due: $5,230.29' },
];
const v2Llm: LlmField[] = [
  { field: 'invoice_number', value: 'INV-2025-0847', evidence: 'Invoice Number: INV-2025-0847' },
  { field: 'issue_date', value: '2025-09-14', evidence: 'Issue Date: 2025-09-14' },
  { field: 'due_date', value: '2025-11-13', evidence: 'Due Date: 2025-11-13' },
  { field: 'vendor_name', value: 'MERIDIAN OFFICE SUPPLIES LLC', evidence: 'MERIDIAN OFFICE SUPPLIES LLC' },
  { field: 'total_amount', value: '$6,126.45', evidence: 'Total Due: $6,126.45' },
];

function asPrev(v: ValidatedValue, reviewState: PrevValue['reviewState']): PrevValue {
  return { field: v.field, value: v.value, evidenceQuote: v.evidence?.quote ?? null, reviewState };
}

const next = (over: Partial<ValidatedValue> = {}): ValidatedValue => ({
  field: 'f',
  type: 'string',
  value: 'A',
  rawValue: 'A',
  evidence: { quote: 'Label: A', start: 0, end: 8 },
  gap: null,
  ...over,
});

describe('decideCarryOver on the invoice fixture v1 → v2', () => {
  it('carries exactly the three unchanged reviews; due_date and total_amount change', () => {
    const v1 = validateExtraction(v1Text, EXPECTED_FIELDS.invoice, v1Llm);
    const v2 = validateExtraction(v2Text, EXPECTED_FIELDS.invoice, v2Llm);
    const decisions = Object.fromEntries(
      v2.map((n) => [n.field, decideCarryOver(asPrev(v1.find((p) => p.field === n.field)!, 'approved'), n, v2Text).kind]),
    );
    expect(decisions).toEqual({
      invoice_number: 'carry_over',
      issue_date: 'carry_over',
      due_date: 'changed',
      vendor_name: 'carry_over',
      total_amount: 'changed',
    });
  });

  it('a corrected or already carried-over review also carries', () => {
    const v1 = validateExtraction(v1Text, EXPECTED_FIELDS.invoice, v1Llm);
    const v2 = validateExtraction(v2Text, EXPECTED_FIELDS.invoice, v2Llm);
    expect(decideCarryOver(asPrev(v1[0]!, 'corrected'), v2[0]!, v2Text).kind).toBe('carry_over');
    expect(decideCarryOver(asPrev(v1[0]!, 'carried_over'), v2[0]!, v2Text).kind).toBe('carry_over');
  });

  it('position does not matter: text shifted by inserted lines still carries', () => {
    const shifted = `NEW COVER PAGE\n\n${'filler line\n'.repeat(40)}${v1Text}`;
    const v1 = validateExtraction(v1Text, EXPECTED_FIELDS.invoice, v1Llm);
    const vs = validateExtraction(shifted, EXPECTED_FIELDS.invoice, v1Llm);
    for (const n of vs) {
      expect(decideCarryOver(asPrev(v1.find((p) => p.field === n.field)!, 'approved'), n, shifted).kind).toBe('carry_over');
    }
  });

  it('whitespace/layout reflow of the evidence still carries', () => {
    const reflowed = v1Text.replace('Total Due:      $5,230.29', 'Total Due:\n$5,230.29');
    const v1 = validateExtraction(v1Text, EXPECTED_FIELDS.invoice, v1Llm);
    const vr = validateExtraction(reflowed, EXPECTED_FIELDS.invoice, v1Llm);
    const t = 4;
    expect(decideCarryOver(asPrev(v1[t]!, 'approved'), vr[t]!, reflowed).kind).toBe('carry_over');
  });
});

describe('decideCarryOver rules', () => {
  const prev = (over: Partial<PrevValue> = {}): PrevValue => ({
    field: 'f',
    value: 'A',
    evidenceQuote: 'Label: A',
    reviewState: 'approved',
    ...over,
  });

  it('no previous value → new', () => {
    expect(decideCarryOver(undefined, next(), 'Label: A').kind).toBe('new');
  });
  it('same value but the reviewed passage changed → changed', () => {
    expect(decideCarryOver(prev(), next(), 'Label (amended): A').kind).toBe('changed');
  });
  it('same passage but different canonical value → changed', () => {
    expect(decideCarryOver(prev(), next({ value: 'B' }), 'Label: A Label: B').kind).toBe('changed');
  });
  it('previously pending and unchanged → new (still pending, nothing to show)', () => {
    expect(decideCarryOver(prev({ reviewState: 'pending' }), next(), 'Label: A').kind).toBe('new');
  });
  it('previously pending and value changed → changed', () => {
    expect(decideCarryOver(prev({ reviewState: 'pending' }), next({ value: 'B' }), 'Label: A').kind).toBe('changed');
  });
  it('v1 gap → v2 found → changed', () => {
    expect(decideCarryOver(prev({ value: null, evidenceQuote: null, reviewState: 'corrected' }), next(), 'Label: A').kind).toBe('changed');
    expect(decideCarryOver(prev({ value: null, evidenceQuote: null, reviewState: 'pending' }), next(), 'Label: A').kind).toBe('changed');
  });
  it('v1 found → v2 gap → changed', () => {
    expect(decideCarryOver(prev(), next({ value: null, evidence: null }), 'nothing').kind).toBe('changed');
  });
  it('a reviewed gap never silently carries', () => {
    expect(decideCarryOver(prev({ value: null, evidenceQuote: null, reviewState: 'corrected' }), next({ value: null, evidence: null }), 'x').kind).toBe('changed');
  });
  it('money objects compare structurally', () => {
    const m = { amount: 5230.29, currency: 'USD' };
    expect(decideCarryOver(prev({ value: m, evidenceQuote: 'Total: $5,230.29' }), next({ value: { currency: 'USD', amount: 5230.29 } }), 'Total:  $5,230.29').kind).toBe('carry_over');
  });
});

describe('deepEqual', () => {
  it('handles primitives, arrays, objects', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'b')).toBe(false);
    expect(deepEqual([1, { a: 2 }], [1, { a: 2 }])).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe('computeProgress', () => {
  it('partitions by review state and counts gaps separately', () => {
    const p = computeProgress([
      { reviewState: 'pending', value: 'a' },
      { reviewState: 'pending', value: null },
      { reviewState: 'approved', value: 1 },
      { reviewState: 'corrected', value: null },
      { reviewState: 'carried_over', value: 2 },
      { reviewState: 'carried_over', value: 3 },
    ]);
    expect(p).toEqual({ total: 6, pending: 2, approved: 1, corrected: 1, carriedOver: 2, gaps: 2 });
  });
  it('empty → zeros', () => {
    expect(computeProgress([])).toEqual({ total: 0, pending: 0, approved: 0, corrected: 0, carriedOver: 0, gaps: 0 });
  });
});
