import { describe, expect, it } from 'vitest';
import { normalizeText, validateExtraction, type LlmField, type ValidatedValue } from '@lomi/core';
import { TEXTS, VARIANTS, type FixtureName } from './fixture-texts';
import { CANONICAL, CASE_INSENSITIVE_FIELDS, FIXTURE_TYPE, GOOD_ANSWERS, SPEC, byField, withField } from './helpers';

// CONTRACT §2 validateExtraction — rules, in order:
//  absent → missing_from_response; value null/empty → not_found(detail=reason); evidence null/empty → evidence_missing;
//  evidence not in text → evidence_not_in_text; raw value not in evidence → value_not_in_evidence;
//  normalizeValue fails → unparseable_value; else value + evidence{quote: exact substring at offsets, start, end}.

const INVOICE = SPEC.invoice;
const V1 = TEXTS.invoiceV1.parsed;

function run(text: string, llm: LlmField[], spec = INVOICE) {
  return byField(validateExtraction(text, spec, llm));
}

/** Structural invariants every ValidatedValue must satisfy. */
function expectWellFormed(v: ValidatedValue, text: string) {
  expect(v.gap === null, `${v.field}: gap must be non-null ⇔ value === null`).toBe(v.value !== null);
  if (v.evidence) {
    expect(v.evidence.quote, `${v.field}: evidence.quote must be the exact substring at its offsets`).toBe(
      text.slice(v.evidence.start, v.evidence.end),
    );
  }
  if (v.value !== null) {
    expect(v.evidence, `${v.field}: a non-gap value must carry evidence`).not.toBeNull();
  }
}

function expectGap(v: ValidatedValue | undefined, reason: string) {
  expect(v, 'value present in output').toBeDefined();
  expect(v!.gap?.reason, `${v!.field}: expected gap ${reason}, got ${JSON.stringify(v!.gap)} value=${JSON.stringify(v!.value)}`).toBe(reason);
  expect(v!.value).toBeNull();
}

describe('validateExtraction — shape', () => {
  it('returns exactly one value per spec field, in spec order, with the spec type', () => {
    const reversed = [...GOOD_ANSWERS.invoiceV1].reverse();
    const out = validateExtraction(V1, INVOICE, reversed);
    expect(out.map((v) => v.field)).toEqual(INVOICE.map((s) => s.field));
    expect(out.map((v) => v.type)).toEqual(INVOICE.map((s) => s.type));
    out.forEach((v) => expectWellFormed(v, V1));
  });

  it('ignores extra fields not in the spec', () => {
    const llm = [...GOOD_ANSWERS.invoiceV1, { field: 'po_number', value: 'PO-1', evidence: 'Invoice Number' }];
    const out = validateExtraction(V1, INVOICE, llm);
    expect(out).toHaveLength(5);
    expect(out.map((v) => v.field)).not.toContain('po_number');
  });

  it('duplicates: the first entry for a field wins (valid first, bogus second)', () => {
    const llm = [
      ...GOOD_ANSWERS.invoiceV1,
      { field: 'invoice_number', value: 'INV-9999', evidence: 'INV-9999' },
    ];
    const out = validateExtraction(V1, INVOICE, llm);
    expect(out).toHaveLength(5);
    expect(byField(out).invoice_number.value).toBe('INV-2025-0847');
  });

  it('duplicates: the first entry for a field wins (gap first, valid second)', () => {
    const llm: LlmField[] = [
      { field: 'invoice_number', value: null, evidence: null, reason: 'first' },
      ...GOOD_ANSWERS.invoiceV1,
    ];
    const out = validateExtraction(V1, INVOICE, llm);
    expect(out.filter((v) => v.field === 'invoice_number')).toHaveLength(1);
    expectGap(byField(out).invoice_number, 'not_found');
  });

  it('keeps the LLM raw value in rawValue', () => {
    const out = run(V1, GOOD_ANSWERS.invoiceV1);
    expect(out.total_amount.rawValue).toBe('$5,230.29');
    expect(out.issue_date.rawValue).toBe('2025-09-14');
  });

  it('an empty LLM response gives a missing_from_response gap for every field', () => {
    const out = validateExtraction(V1, INVOICE, []);
    expect(out).toHaveLength(5);
    for (const v of out) {
      expectGap(v, 'missing_from_response');
      expect(v.evidence).toBeNull();
    }
  });

  it('an empty document text turns every proposed value into evidence_not_in_text', () => {
    const out = validateExtraction('', INVOICE, GOOD_ANSWERS.invoiceV1);
    for (const v of out) expectGap(v, 'evidence_not_in_text');
  });
});

describe('validateExtraction — gap reasons', () => {
  it('missing_from_response: field absent from LLM output', () => {
    const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'due_date', null));
    expectGap(out.due_date, 'missing_from_response');
    expect(out.due_date.evidence).toBeNull();
    expect(out.invoice_number.value).toBe('INV-2025-0847');
  });

  it('not_found: value null, detail carries the LLM reason', () => {
    const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'due_date', { value: null, evidence: null, reason: 'No due date printed' }));
    expectGap(out.due_date, 'not_found');
    expect(out.due_date.gap!.detail).toBe('No due date printed');
    expect(out.due_date.evidence).toBeNull();
  });

  it('not_found: empty-string value', () => {
    const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'due_date', { value: '' }));
    expectGap(out.due_date, 'not_found');
  });

  it('not_found takes precedence over evidence_missing when both are null', () => {
    const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'due_date', { value: null, evidence: null }));
    expectGap(out.due_date, 'not_found');
  });

  it.each([[null], ['']])('evidence_missing: value given but evidence is %j', (evidence) => {
    const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'total_amount', { evidence }));
    expectGap(out.total_amount, 'evidence_missing');
    expect(out.total_amount.evidence).toBeNull();
  });

  describe('evidence_not_in_text (hallucination defense)', () => {
    it.each([
      ['fabricated sentence', '$5,230.29', 'The amount due is $5,230.29'],
      ['plausible but altered', '$5,230.29', 'Total Due: $5,230.29 USD'],
      ['near-miss digit', 'INV-2025-0848', 'Invoice Number: INV-2025-0848'],
      ['evidence from v2 used on v1', '2025-11-13', 'Due Date: 2025-11-13'],
    ])('%s → gap, never kept', (_label, value, evidence) => {
      const field = value.startsWith('INV') ? 'invoice_number' : value.startsWith('$') ? 'total_amount' : 'due_date';
      const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, field, { value, evidence }));
      expectGap(out[field], 'evidence_not_in_text');
      expect(out[field].evidence).toBeNull();
      expect(out[field].rawValue).toBe(value);
    });

    it('precedes value_not_in_evidence (evidence absent AND value not in it)', () => {
      const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'total_amount', { value: '$1.00', evidence: 'Grand total: $9.99' }));
      expectGap(out.total_amount, 'evidence_not_in_text');
    });
  });

  describe('value_not_in_evidence', () => {
    it('total claimed with the Subtotal quote (real quote, wrong value)', () => {
      const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'total_amount', { value: '$5,230.29', evidence: 'Subtotal: $4,815.00' }));
      expectGap(out.total_amount, 'value_not_in_evidence');
    });

    it('due date claimed with the issue-date quote', () => {
      const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'due_date', { value: '2025-10-14', evidence: 'Issue Date: 2025-09-14' }));
      expectGap(out.due_date, 'value_not_in_evidence');
    });

    it('market report distractors: prior-quarter vacancy, 2BR rent, outlook growth', () => {
      const R = TEXTS.marketReport.parsed;
      let llm = withField(GOOD_ANSWERS.marketReport, 'vacancy_rate', { value: '4.2%', evidence: '4.9% in the prior quarter' });
      llm = withField(llm, 'average_rent_1br', { value: '$1,985', evidence: 'Two-bedroom units averaged $2,540' });
      llm = withField(llm, 'year_over_year_rent_growth', { value: '3.8%', evidence: '3% as affordability pressure builds' });
      const out = run(R, llm, SPEC.market_report);
      expectGap(out.vacancy_rate, 'value_not_in_evidence');
      expectGap(out.average_rent_1br, 'value_not_in_evidence');
      expectGap(out.year_over_year_rent_growth, 'value_not_in_evidence');
      expect(out.market_area.value).toBe('Eastport-Harborview Submarket');
    });

    it('string value not in a real quote', () => {
      const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'vendor_name', { value: 'Lomi Labs Inc.', evidence: 'MERIDIAN OFFICE SUPPLIES LLC' }));
      expectGap(out.vendor_name, 'value_not_in_evidence');
    });
  });

  describe('value-in-evidence comparison', () => {
    it('is case-insensitive', () => {
      const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'vendor_name', { value: 'Meridian Office Supplies LLC' }));
      expect(out.vendor_name.gap).toBeNull();
      expect(out.vendor_name.value).toBe('Meridian Office Supplies LLC');
    });

    it('normalises whitespace and quotes on both sides', () => {
      const out = run(TEXTS.lease.parsed, withField(GOOD_ANSWERS.lease, 'tenant_name', { value: '  Dana \n Okafor ' }), SPEC.lease);
      expect(out.tenant_name.gap).toBeNull();
      expect(out.tenant_name.value).toBe('Dana Okafor');
    });

    it('accepts 24 for "twenty-four (24) months" (number)', () => {
      const out = run(TEXTS.lease.parsed, GOOD_ANSWERS.lease, SPEC.lease);
      expect(out.term_months.gap).toBeNull();
      expect(out.term_months.value).toBe(24);
    });

    it('accepts "24 months" for quote "twenty-four (24) months" via the digits rule', () => {
      const out = run(TEXTS.lease.parsed, withField(GOOD_ANSWERS.lease, 'term_months', { value: '24 months' }), SPEC.lease);
      expect(out.term_months.gap, JSON.stringify(out.term_months.gap)).toBeNull();
      expect(out.term_months.value).toBe(24);
    });

    it('accepts "4.2 percent" for quote "... declined to 4.2%" via the digits rule (percent)', () => {
      const out = run(
        TEXTS.marketReport.parsed,
        withField(GOOD_ANSWERS.marketReport, 'vacancy_rate', { value: '4.2 percent' }),
        SPEC.market_report,
      );
      expect(out.vacancy_rate.gap, JSON.stringify(out.vacancy_rate.gap)).toBeNull();
      expect(out.vacancy_rate.value).toBe(4.2);
    });
  });

  describe('unparseable_value', () => {
    it('date field whose (in-evidence) value is not a date', () => {
      const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'due_date', { value: 'Net 30', evidence: 'Payment Terms: Net 30' }));
      expectGap(out.due_date, 'unparseable_value');
    });

    it('number field whose (in-evidence) value is not a number', () => {
      const out = run(
        TEXTS.lease.parsed,
        withField(GOOD_ANSWERS.lease, 'term_months', { value: 'months', evidence: 'twenty-four (24) months' }),
        SPEC.lease,
      );
      expectGap(out.term_months, 'unparseable_value');
    });

    it('money field whose (in-evidence) value has no amount', () => {
      const out = run(V1, withField(GOOD_ANSWERS.invoiceV1, 'total_amount', { value: 'Total Due', evidence: 'Total Due: $5,230.29' }));
      expectGap(out.total_amount, 'unparseable_value');
    });
  });
});

describe('validateExtraction — evidence offsets', () => {
  it('evidence.quote is the ORIGINAL text at the offsets (not the LLM quote)', () => {
    const out = run(V1, GOOD_ANSWERS.invoiceV1);
    const ev = out.total_amount.evidence!;
    expect(ev.quote).toBe('Total Due:      $5,230.29');
    expect(V1.slice(ev.start, ev.end)).toBe(ev.quote);
    expect(ev.start).toBe(V1.indexOf('Total Due:'));
  });

  it('quote spanning a line break keeps the line break in evidence.quote', () => {
    const L = TEXTS.lease.parsed;
    const ev = run(L, GOOD_ANSWERS.lease, SPEC.lease).term_months.evidence!;
    expect(ev.quote).toBe('twenty-four (24)\nmonths');
    expect(L.slice(ev.start, ev.end)).toBe(ev.quote);
  });

  it('escaped text: evidence.quote keeps the PDF escapes from the original text', () => {
    const L = TEXTS.lease.escaped;
    const ev = run(L, GOOD_ANSWERS.lease, SPEC.lease).term_months.evidence!;
    expect(ev.quote).toBe('twenty-four \\(24\\)\r\nmonths');
    expect(normalizeText(ev.quote)).toBe('twenty-four (24) months');
  });
});

describe('validateExtraction — full fixture runs (canonical values, CONTRACT §5)', () => {
  const fixtures: FixtureName[] = ['invoiceV1', 'invoiceV2', 'lease', 'marketReport'];
  for (const name of fixtures) {
    for (const variant of VARIANTS) {
      it(`${name} [${variant}]`, () => {
        const text = TEXTS[name][variant];
        const spec = SPEC[FIXTURE_TYPE[name]];
        const out = validateExtraction(text, spec, GOOD_ANSWERS[name]);
        expect(out.map((v) => v.field)).toEqual(spec.map((s) => s.field));
        for (const v of out) {
          expectWellFormed(v, text);
          const expected = CANONICAL[name][v.field];
          if (expected === null) {
            expectGap(v, 'not_found');
            expect(v.gap!.detail).toBe('The document does not state a median household income.');
            continue;
          }
          expect(v.gap, `${name}.${v.field} unexpected gap ${JSON.stringify(v.gap)}`).toBeNull();
          if (CASE_INSENSITIVE_FIELDS.has(v.field)) {
            expect(String(v.value).toLowerCase()).toBe(String(expected).toLowerCase());
          } else {
            expect(v.value, `${name}.${v.field}`).toEqual(expected);
          }
          const llmQuote = GOOD_ANSWERS[name].find((a) => a.field === v.field)!.evidence!;
          expect(normalizeText(v.evidence!.quote)).toBe(normalizeText(llmQuote));
        }
      });
    }
  }

  it('market report: median_household_income is a gap with a reason, never a guess', () => {
    const out = run(TEXTS.marketReport.parsed, GOOD_ANSWERS.marketReport, SPEC.market_report);
    const v = out.median_household_income;
    expectGap(v, 'not_found');
    expect(v.evidence).toBeNull();
    expect(v.gap!.detail).toBeTruthy();
  });
});
