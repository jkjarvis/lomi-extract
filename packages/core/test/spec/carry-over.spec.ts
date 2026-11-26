import { describe, expect, it } from 'vitest';
import { decideCarryOver, validateExtraction, type PrevValue, type ValidatedValue } from '@lomi/core';
import { TEXTS, VARIANTS } from './fixture-texts';
import { GOOD_ANSWERS, SPEC, byField, withField } from './helpers';

// CONTRACT §2 decideCarryOver:
// carry_over iff prev.reviewState ∈ {approved, corrected, carried_over} AND prev.value !== null AND next.value !== null
//   AND deepEqual(prev.value, next.value) AND prev.evidenceQuote !== null AND findEvidence(nextText, prev.evidenceQuote) !== null.
// Rule fails → 'changed' when prev.reviewState !== 'pending' or prev.value/next.value differ; 'new' if prev pending AND unchanged.
// prev undefined → 'new'. Position in the document is irrelevant.

const INVOICE = SPEC.invoice;
type ReviewState = PrevValue['reviewState'];

function toPrev(v: ValidatedValue, reviewState: ReviewState): PrevValue {
  return { field: v.field, value: v.value, evidenceQuote: v.evidence?.quote ?? null, reviewState };
}

function decisions(prevText: string, nextText: string, reviewState: ReviewState = 'approved') {
  const prev = byField(validateExtraction(prevText, INVOICE, GOOD_ANSWERS.invoiceV1));
  const next = validateExtraction(nextText, INVOICE, GOOD_ANSWERS.invoiceV2);
  const out: Record<string, string> = {};
  for (const n of next) out[n.field] = decideCarryOver(toPrev(prev[n.field], reviewState), n, nextText).kind;
  return out;
}

const value = (field: string, v: unknown, quote: string | null, start = 0): ValidatedValue => ({
  field,
  type: 'string',
  value: v,
  rawValue: v === null ? null : String(v),
  evidence: quote === null || v === null ? null : { quote, start, end: start + quote.length },
  gap: v === null ? { reason: 'not_found' } : null,
});

describe('decideCarryOver — invoice v1 → v2 (real fixture texts)', () => {
  for (const variant of VARIANTS) {
    it(`[${variant}] carries invoice_number, issue_date, vendor_name; due_date and total_amount changed`, () => {
      const d = decisions(TEXTS.invoiceV1[variant], TEXTS.invoiceV2[variant]);
      expect(d).toEqual({
        invoice_number: 'carry_over',
        issue_date: 'carry_over',
        vendor_name: 'carry_over',
        due_date: 'changed',
        total_amount: 'changed',
      });
    });
  }

  it('across renderings (v1 parsed by one extractor, v2 by another) the result is the same', () => {
    expect(decisions(TEXTS.invoiceV1.parsed, TEXTS.invoiceV2.escaped)).toEqual(
      decisions(TEXTS.invoiceV1.escaped, TEXTS.invoiceV2.flat),
    );
  });

  it.each<ReviewState>(['approved', 'corrected', 'carried_over'])(
    'previous reviewState %s carries the unchanged fields',
    (state) => {
      const d = decisions(TEXTS.invoiceV1.parsed, TEXTS.invoiceV2.parsed, state);
      expect(d.invoice_number).toBe('carry_over');
      expect(d.issue_date).toBe('carry_over');
      expect(d.vendor_name).toBe('carry_over');
      expect(d.due_date).toBe('changed');
      expect(d.total_amount).toBe('changed');
    },
  );

  it('previous all pending: unchanged fields are "new" (stay pending), changed fields are "changed"', () => {
    const d = decisions(TEXTS.invoiceV1.parsed, TEXTS.invoiceV2.parsed, 'pending');
    expect(d).toEqual({
      invoice_number: 'new',
      issue_date: 'new',
      vendor_name: 'new',
      due_date: 'changed',
      total_amount: 'changed',
    });
  });
});

describe('decideCarryOver — whole-document shift', () => {
  const v1 = TEXTS.invoiceV1.parsed;
  const shifted =
    'COPY FOR YOUR RECORDS\nPage 1 of 1\n\n\n\n' +
    v1
      .split('\n')
      .map((l) => `    ${l}   `)
      .join('\r\n\r\n') +
    '\n\nThank you for your business.';

  it('every field carries when the text is prepended/re-flowed but values and quotes are intact', () => {
    const prev = byField(validateExtraction(v1, INVOICE, GOOD_ANSWERS.invoiceV1));
    const next = validateExtraction(shifted, INVOICE, GOOD_ANSWERS.invoiceV1);
    for (const n of next) {
      expect(n.gap, `${n.field} should validate on the shifted text`).toBeNull();
      expect(decideCarryOver(toPrev(prev[n.field], 'approved'), n, shifted).kind, n.field).toBe('carry_over');
    }
  });

  it('offsets differ between versions but the decision does not depend on position', () => {
    const prev = byField(validateExtraction(v1, INVOICE, GOOD_ANSWERS.invoiceV1));
    const next = byField(validateExtraction(shifted, INVOICE, GOOD_ANSWERS.invoiceV1));
    expect(next.total_amount.evidence!.start).not.toBe(prev.total_amount.evidence!.start);
    expect(decideCarryOver(toPrev(prev.total_amount, 'approved'), next.total_amount, shifted)).toEqual({ kind: 'carry_over' });
  });
});

describe('decideCarryOver — rule cases', () => {
  const nextText = 'Header\nInvoice Number: INV-2025-0847\nPayment due: 2025-10-14\nTotal Due: $5,230.29';

  it('undefined prev → new', () => {
    expect(decideCarryOver(undefined, value('invoice_number', 'INV-2025-0847', 'INV-2025-0847', 22), nextText)).toEqual({
      kind: 'new',
    });
  });

  it('same value but the previous evidence passage is gone from the new text → changed', () => {
    const prev: PrevValue = { field: 'due_date', value: '2025-10-14', evidenceQuote: 'Due Date: 2025-10-14', reviewState: 'approved' };
    const next = value('due_date', '2025-10-14', 'Payment due: 2025-10-14');
    expect(decideCarryOver(prev, next, nextText)).toEqual({ kind: 'changed' });
  });

  it('same value, same evidence → carry_over', () => {
    const prev: PrevValue = { field: 'invoice_number', value: 'INV-2025-0847', evidenceQuote: 'Invoice Number: INV-2025-0847', reviewState: 'approved' };
    expect(decideCarryOver(prev, value('invoice_number', 'INV-2025-0847', 'Invoice Number: INV-2025-0847'), nextText)).toEqual({
      kind: 'carry_over',
    });
  });

  it('previous evidence still present but the value differs → changed', () => {
    const prev: PrevValue = { field: 'invoice_number', value: 'INV-2025-0846', evidenceQuote: 'Invoice Number: INV-2025-0847', reviewState: 'approved' };
    expect(decideCarryOver(prev, value('invoice_number', 'INV-2025-0847', 'Invoice Number: INV-2025-0847'), nextText)).toEqual({
      kind: 'changed',
    });
  });

  it('corrected previous with unchanged evidence → carry_over', () => {
    const prev: PrevValue = { field: 'total_amount', value: { amount: 5230.29, currency: 'USD' }, evidenceQuote: 'Total Due:      $5,230.29', reviewState: 'corrected' };
    const next = value('total_amount', { amount: 5230.29, currency: 'USD' }, 'Total Due: $5,230.29');
    expect(decideCarryOver(prev, next, nextText)).toEqual({ kind: 'carry_over' });
  });

  it('carried_over previous (chain v1→v2→v3) with unchanged evidence → carry_over', () => {
    const prev: PrevValue = { field: 'invoice_number', value: 'INV-2025-0847', evidenceQuote: 'Invoice Number: INV-2025-0847', reviewState: 'carried_over' };
    expect(decideCarryOver(prev, value('invoice_number', 'INV-2025-0847', 'Invoice Number: INV-2025-0847'), nextText).kind).toBe('carry_over');
  });

  it('compares values deeply (money objects are different instances, key order differs)', () => {
    const prev: PrevValue = { field: 'total_amount', value: { currency: 'USD', amount: 5230.29 }, evidenceQuote: 'Total Due: $5,230.29', reviewState: 'approved' };
    const next = value('total_amount', { amount: 5230.29, currency: 'USD' }, 'Total Due: $5,230.29');
    expect(decideCarryOver(prev, next, nextText)).toEqual({ kind: 'carry_over' });
  });

  it('money amount differs → changed', () => {
    const prev: PrevValue = { field: 'total_amount', value: { amount: 5230.29, currency: 'USD' }, evidenceQuote: 'Total Due: $5,230.29', reviewState: 'approved' };
    const next = value('total_amount', { amount: 6126.45, currency: 'USD' }, 'Total Due: $5,230.29');
    expect(decideCarryOver(prev, next, nextText)).toEqual({ kind: 'changed' });
  });

  it('approved previous with null evidenceQuote → changed (cannot prove evidence unchanged)', () => {
    const prev: PrevValue = { field: 'invoice_number', value: 'INV-2025-0847', evidenceQuote: null, reviewState: 'approved' };
    expect(decideCarryOver(prev, value('invoice_number', 'INV-2025-0847', 'Invoice Number: INV-2025-0847'), nextText)).toEqual({
      kind: 'changed',
    });
  });

  it('previous pending, value and evidence unchanged → new (it just stays pending)', () => {
    const prev: PrevValue = { field: 'invoice_number', value: 'INV-2025-0847', evidenceQuote: 'Invoice Number: INV-2025-0847', reviewState: 'pending' };
    expect(decideCarryOver(prev, value('invoice_number', 'INV-2025-0847', 'Invoice Number: INV-2025-0847'), nextText)).toEqual({
      kind: 'new',
    });
  });

  it('previous pending, value differs → changed', () => {
    const prev: PrevValue = { field: 'due_date', value: '2025-10-14', evidenceQuote: 'Due Date: 2025-10-14', reviewState: 'pending' };
    expect(decideCarryOver(prev, value('due_date', '2025-11-13', 'Due Date: 2025-11-13'), 'Due Date: 2025-11-13')).toEqual({
      kind: 'changed',
    });
  });

  describe('gaps', () => {
    it('previous gap (pending) → next found → changed', () => {
      const prev: PrevValue = { field: 'due_date', value: null, evidenceQuote: null, reviewState: 'pending' };
      expect(decideCarryOver(prev, value('due_date', '2025-10-14', 'Payment due: 2025-10-14'), nextText)).toEqual({ kind: 'changed' });
    });

    it('previous gap that was corrected → next found → changed (never carried: prev.value is null)', () => {
      const prev: PrevValue = { field: 'due_date', value: null, evidenceQuote: null, reviewState: 'corrected' };
      expect(decideCarryOver(prev, value('due_date', '2025-10-14', 'Payment due: 2025-10-14'), nextText)).toEqual({ kind: 'changed' });
    });

    it('previous gap that was corrected → next still a gap → not carried over (changed)', () => {
      const prev: PrevValue = { field: 'due_date', value: null, evidenceQuote: null, reviewState: 'corrected' };
      expect(decideCarryOver(prev, value('due_date', null, null), nextText)).toEqual({ kind: 'changed' });
    });

    it('previous found & approved → next gap → changed (not carry_over)', () => {
      const prev: PrevValue = { field: 'due_date', value: '2025-10-14', evidenceQuote: 'Payment due: 2025-10-14', reviewState: 'approved' };
      const d = decideCarryOver(prev, value('due_date', null, null), nextText);
      expect(d.kind).not.toBe('carry_over');
      expect(d).toEqual({ kind: 'changed' });
    });

    it('previous gap (pending) → next gap → new (still pending, nothing changed)', () => {
      const prev: PrevValue = { field: 'median_household_income', value: null, evidenceQuote: null, reviewState: 'pending' };
      expect(decideCarryOver(prev, value('median_household_income', null, null), nextText)).toEqual({ kind: 'new' });
    });

    it('hallucinated evidence in v2 makes the v2 value a gap → approved v1 value is NOT carried', () => {
      const v1 = byField(validateExtraction(TEXTS.invoiceV1.parsed, INVOICE, GOOD_ANSWERS.invoiceV1));
      const v2Text = TEXTS.invoiceV1.parsed; // identical text
      const next = byField(
        validateExtraction(v2Text, INVOICE, withField(GOOD_ANSWERS.invoiceV1, 'total_amount', { evidence: 'Total payable: $5,230.29' })),
      );
      expect(next.total_amount.value).toBeNull();
      expect(decideCarryOver(toPrev(v1.total_amount, 'approved'), next.total_amount, v2Text).kind).toBe('changed');
    });
  });
});
