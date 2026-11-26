// Branches the coverage report showed unexercised (gap pass): number words with scales, unknown types,
// numeric values written in another locale, dates written differently from the quote, array equality.
import { describe, expect, it } from 'vitest';
import type { FieldSpec } from '../src/index.js';
import { decideCarryOver, normalizeValue, validateExtraction } from '../src/index.js';

describe('normalizeValue edge cases', () => {
  it('number words with hundred/thousand scales', () => {
    expect(normalizeValue('number', 'one thousand two hundred')).toEqual({ ok: true, value: 1200 });
    expect(normalizeValue('number', 'two hundred and fifty units')).toEqual({ ok: true, value: 250 });
  });

  it('an unknown field type is a reason, not a throw', () => {
    const r = normalizeValue('colour' as never, 'red');
    expect(r.ok).toBe(false);
  });
});

describe('validateExtraction: value-in-evidence fallbacks', () => {
  it('a money value written with other separators still matches the quote by its digits', () => {
    const text = 'Monthly Rent: 2,350.00 per month';
    const [v] = validateExtraction(text, [{ field: 'monthly_rent', type: 'money' }], [{ field: 'monthly_rent', value: '2.350,00', evidence: 'Monthly Rent: 2,350.00' }]);
    expect(v!.gap).toBeNull();
  });

  it('a date the model rewrote ("September 14, 2025") matches the ISO date in its quote', () => {
    const text = 'Issue Date: 2025-09-14';
    const [v] = validateExtraction(text, [{ field: 'issue_date', type: 'date' }], [{ field: 'issue_date', value: 'September 14, 2025', evidence: 'Issue Date: 2025-09-14' }]);
    expect(v).toMatchObject({ value: '2025-09-14', gap: null });
  });

  it('but a different date is not supported by the quote', () => {
    const text = 'Issue Date: 2025-09-14';
    const [v] = validateExtraction(text, [{ field: 'issue_date', type: 'date' }], [{ field: 'issue_date', value: '2025-09-15', evidence: 'Issue Date: 2025-09-14' }]);
    expect(v!.gap?.reason).toBe('value_not_in_evidence');
  });
});

describe('decideCarryOver with structured values', () => {
  it('compares arrays and objects structurally', () => {
    const spec: FieldSpec[] = [{ field: 'total_amount', type: 'money' }];
    const text = 'TOTAL DUE: $5,230.29';
    const [next] = validateExtraction(text, spec, [{ field: 'total_amount', value: '$5,230.29', evidence: 'TOTAL DUE: $5,230.29' }]);
    const prev = { field: 'total_amount', value: { currency: 'USD', amount: 5230.29 }, evidenceQuote: 'TOTAL DUE: $5,230.29', reviewState: 'approved' as const };
    expect(decideCarryOver(prev, next!, text).kind).toBe('carry_over');
    expect(decideCarryOver({ ...prev, value: [5230.29] }, next!, text).kind).toBe('changed');
  });
});
