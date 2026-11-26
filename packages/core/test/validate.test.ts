import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LlmField } from '../src/index.js';
import { EXPECTED_FIELDS, validateExtraction, valueInEvidence } from '../src/index.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const invoice = fixture('invoice-v1');
const lease = fixture('lease');
const report = fixture('market-report');

const goodInvoice: LlmField[] = [
  { field: 'invoice_number', value: 'INV-2025-0847', evidence: 'Invoice Number: INV-2025-0847' },
  { field: 'issue_date', value: '2025-09-14', evidence: 'Issue Date: 2025-09-14' },
  { field: 'due_date', value: '2025-10-14', evidence: 'Due Date: 2025-10-14' },
  { field: 'vendor_name', value: 'MERIDIAN OFFICE SUPPLIES LLC', evidence: 'MERIDIAN OFFICE SUPPLIES LLC' },
  { field: 'total_amount', value: '$5,230.29', evidence: 'Total Due: $5,230.29' },
];

describe('validateExtraction', () => {
  it('accepts a good invoice extraction with canonical values and exact offsets', () => {
    const out = validateExtraction(invoice, EXPECTED_FIELDS.invoice, goodInvoice);
    expect(out.map((v) => v.field)).toEqual(EXPECTED_FIELDS.invoice.map((f) => f.field));
    expect(out.every((v) => v.gap === null)).toBe(true);
    const total = out.find((v) => v.field === 'total_amount')!;
    expect(total.value).toEqual({ amount: 5230.29, currency: 'USD' });
    expect(total.rawValue).toBe('$5,230.29');
    // evidence quote is the exact original substring (with the PDF's column padding)
    expect(total.evidence!.quote).toBe('Total Due:      $5,230.29');
    expect(invoice.slice(total.evidence!.start, total.evidence!.end)).toBe(total.evidence!.quote);
  });

  it('returns exactly one value per spec field in spec order; extras ignored; first duplicate wins', () => {
    const llm: LlmField[] = [
      { field: 'bogus', value: 'x', evidence: 'INVOICE' },
      { field: 'due_date', value: '2025-10-14', evidence: 'Due Date: 2025-10-14' },
      { field: 'due_date', value: '2025-09-14', evidence: 'Issue Date: 2025-09-14' },
    ];
    const out = validateExtraction(invoice, EXPECTED_FIELDS.invoice, llm);
    expect(out).toHaveLength(5);
    expect(out[2]!.value).toBe('2025-10-14');
    expect(out[0]!.gap?.reason).toBe('missing_from_response');
  });

  it('null value → not_found gap carrying the model reason', () => {
    const out = validateExtraction(report, EXPECTED_FIELDS.market_report, [
      { field: 'median_household_income', value: null, evidence: null, reason: 'Not mentioned in the report.' },
    ]);
    const v = out.find((x) => x.field === 'median_household_income')!;
    expect(v.value).toBeNull();
    expect(v.gap).toEqual({ reason: 'not_found', detail: 'Not mentioned in the report.' });
  });

  it('empty value string is a not_found gap', () => {
    const [v] = validateExtraction(invoice, [{ field: 'due_date', type: 'date' }], [{ field: 'due_date', value: '  ', evidence: 'x' }]);
    expect(v!.gap?.reason).toBe('not_found');
  });

  it('value without evidence → evidence_missing', () => {
    const [v] = validateExtraction(invoice, [{ field: 'due_date', type: 'date' }], [{ field: 'due_date', value: '2025-10-14', evidence: null }]);
    expect(v!.gap?.reason).toBe('evidence_missing');
    expect(v!.value).toBeNull();
  });

  it('hallucinated evidence → evidence_not_in_text (never kept)', () => {
    const [v] = validateExtraction(invoice, [{ field: 'total_amount', type: 'money' }], [
      { field: 'total_amount', value: '$5,230.29', evidence: 'Grand Total: $5,230.29' },
    ]);
    expect(v!.gap?.reason).toBe('evidence_not_in_text');
    expect(v!.value).toBeNull();
    expect(v!.evidence).toBeNull();
    expect(v!.rawValue).toBe('$5,230.29');
  });

  it('subtotal distractor: real quote that does not contain the value → value_not_in_evidence', () => {
    const [v] = validateExtraction(invoice, [{ field: 'total_amount', type: 'money' }], [
      { field: 'total_amount', value: '$4,815.00', evidence: 'Total Due: $5,230.29' },
    ]);
    expect(v!.gap?.reason).toBe('value_not_in_evidence');
  });

  it('accepts number values whose digits appear in the quote (twenty-four (24) months)', () => {
    const [v] = validateExtraction(lease, [{ field: 'term_months', type: 'number' }], [
      { field: 'term_months', value: '24', evidence: 'term of this Lease shall be twenty-four (24) months' },
    ]);
    expect(v!.gap).toBeNull();
    expect(v!.value).toBe(24);
    expect(v!.evidence!.quote).toContain('\n'); // the quote spans a PDF line break
  });

  it('accepts reformatted money values (2350.00 vs $2,350.00)', () => {
    const [v] = validateExtraction(lease, [{ field: 'monthly_rent', type: 'money' }], [
      { field: 'monthly_rent', value: '2350.00', evidence: 'monthly rent of $2,350.00' },
    ]);
    expect(v!.value).toEqual({ amount: 2350, currency: 'USD' });
  });

  it('value comparison is case-insensitive', () => {
    const [v] = validateExtraction(invoice, [{ field: 'vendor_name', type: 'string' }], [
      { field: 'vendor_name', value: 'Meridian Office Supplies LLC', evidence: 'MERIDIAN OFFICE SUPPLIES LLC' },
    ]);
    expect(v!.gap).toBeNull();
    expect(v!.value).toBe('Meridian Office Supplies LLC');
  });

  it('accepts an ISO date value whose quote writes the date in words', () => {
    const [v] = validateExtraction(lease, [{ field: 'lease_start', type: 'date' }], [
      { field: 'lease_start', value: '2025-03-01', evidence: 'commencing on March 1, 2025' },
    ]);
    expect(v!.value).toBe('2025-03-01');
  });

  it('rejects a date that is not the one in the quote', () => {
    const [v] = validateExtraction(lease, [{ field: 'lease_start', type: 'date' }], [
      { field: 'lease_start', value: '2027-02-28', evidence: 'commencing on March 1, 2025' },
    ]);
    expect(v!.gap?.reason).toBe('value_not_in_evidence');
  });

  it('unparseable value → unparseable_value', () => {
    const [v] = validateExtraction(lease, [{ field: 'lease_start', type: 'date' }], [
      { field: 'lease_start', value: 'March', evidence: 'commencing on March 1, 2025' },
    ]);
    expect(v!.gap?.reason).toBe('unparseable_value');
  });

  it('prior-quarter vacancy distractor is rejected', () => {
    const [v] = validateExtraction(report, [{ field: 'vacancy_rate', type: 'percent' }], [
      { field: 'vacancy_rate', value: '4.9%', evidence: 'vacancy rate declined to 4.2%' },
    ]);
    expect(v!.gap?.reason).toBe('value_not_in_evidence');
  });

  it('tolerates garbage llm input', () => {
    const out = validateExtraction(invoice, EXPECTED_FIELDS.invoice, null as unknown as LlmField[]);
    expect(out.every((v) => v.gap?.reason === 'missing_from_response')).toBe(true);
  });
});

describe('valueInEvidence', () => {
  it('does not accept a number that only appears inside a bigger number', () => {
    expect(valueInEvidence('number', '24', 'in 2024 the term was set')).toBe(false);
  });
});

describe('valueInEvidence boundaries', () => {
  it.each([
    ['money', '$5,230.29', 'Total Due:      $5,230.29', true],
    ['money', '5,230.29', 'Total Due: $5,230.29', true],
    ['money', '230.29', 'Total Due: $5,230.29', false],
    ['percent', '4.2%', 'declined to 4.2%, down', true],
    ['percent', '4.2', 'declined to 14.25%', false],
    ['number', '24', 'twenty-four (24) months', true],
    ['string', 'okafor', 'Dana Okafor ("Tenant")', true],
  ] as const)('%s %s in %s → %s', (type, v, q, expected) => {
    expect(valueInEvidence(type, v, q)).toBe(expected);
  });
});
