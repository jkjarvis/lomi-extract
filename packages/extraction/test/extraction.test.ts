import { readFileSync } from 'node:fs';
import type { DocType } from '@lomi/core';
import { EXPECTED_FIELDS, decideCarryOver, validateExtraction } from '@lomi/core';
import { describe, expect, it } from 'vitest';
import {
  LlmError,
  MockProvider,
  PdfParseError,
  buildUserPrompt,
  isPdf,
  layoutPage,
  parseLlmFields,
  pdfToText,
  resolveProviderName,
} from '../src/index.js';

const pdf = (name: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/documents/${name}`, import.meta.url)));

async function extractFixture(name: string, docType: DocType, env: NodeJS.ProcessEnv = {}, attempt = 1) {
  const text = await pdfToText(pdf(name));
  const fields = EXPECTED_FIELDS[docType];
  const res = await new MockProvider(env).extract({ docType, fields, text, attempt });
  const values = validateExtraction(text, fields, res.fields);
  return { text, res, values, byField: Object.fromEntries(values.map((v) => [v.field, v])) };
}

describe('pdfToText', () => {
  it('extracts readable lines, unescapes PDF parens, keeps paragraph breaks', async () => {
    const text = await pdfToText(pdf('invoice-001.pdf'));
    expect(text.startsWith('MERIDIAN OFFICE SUPPLIES LLC\n482 Commerce Way')).toBe(true);
    expect(text).toContain('Sales Tax (8.625%): $415.29');
    expect(text).not.toContain('\\(');
    expect(text).toMatch(/Total Due:\s+\$5,230\.29/);
    expect(text).toContain('Eastport, CA 94702\n\nINVOICE');
  });

  it('matches the parsed-text fixtures used by @lomi/core tests', async () => {
    for (const [file, txt] of [
      ['invoice-001.pdf', 'invoice-v1'],
      ['invoice-001.v2.pdf', 'invoice-v2'],
      ['lease-excerpt-001.pdf', 'lease'],
      ['market-report-excerpt-001.pdf', 'market-report'],
    ]) {
      const expected = readFileSync(new URL(`../../core/test/fixtures/${txt}.txt`, import.meta.url), 'utf8');
      expect(await pdfToText(pdf(file!))).toBe(expected);
    }
  });

  it('is deterministic', async () => {
    expect(await pdfToText(pdf('lease-excerpt-001.pdf'))).toBe(await pdfToText(pdf('lease-excerpt-001.pdf')));
  });

  it('rejects non-PDF bytes and broken PDFs with PdfParseError', async () => {
    await expect(pdfToText(new TextEncoder().encode('hello'))).rejects.toBeInstanceOf(PdfParseError);
    await expect(pdfToText(new TextEncoder().encode('%PDF-1.4 garbage'))).rejects.toBeInstanceOf(PdfParseError);
  });

  it('isPdf checks the magic bytes', () => {
    expect(isPdf(new TextEncoder().encode('%PDF-1.7'))).toBe(true);
    expect(isPdf(new TextEncoder().encode('%PDX-1.7'))).toBe(false);
    expect(isPdf(new Uint8Array())).toBe(false);
  });

  it('layoutPage reconstructs columns from positions', () => {
    const out = layoutPage([
      { str: 'Total Due:', x: 0, y: 100, w: 60, h: 10 },
      { str: ' ', x: 60, y: 100, w: 36, h: 10 },
      { str: '$5', x: 96, y: 100, w: 12, h: 10 },
      { str: 'Next', x: 0, y: 86, w: 24, h: 10 },
      { str: 'Para', x: 0, y: 58, w: 24, h: 10 },
    ]);
    expect(out).toBe('Total Due:      $5\nNext\n\nPara');
  });
});

describe('mock provider on the fixtures (contract §5)', () => {
  it('invoice v1', async () => {
    const { byField } = await extractFixture('invoice-001.pdf', 'invoice');
    expect(byField.invoice_number!.value).toBe('INV-2025-0847');
    expect(byField.issue_date!.value).toBe('2025-09-14');
    expect(byField.due_date!.value).toBe('2025-10-14');
    expect(String(byField.vendor_name!.value).toUpperCase()).toBe('MERIDIAN OFFICE SUPPLIES LLC');
    expect(byField.total_amount!.value).toEqual({ amount: 5230.29, currency: 'USD' });
  });

  it('invoice v2', async () => {
    const { byField } = await extractFixture('invoice-001.v2.pdf', 'invoice');
    expect(byField.due_date!.value).toBe('2025-11-13');
    expect(byField.total_amount!.value).toEqual({ amount: 6126.45, currency: 'USD' });
    expect(byField.invoice_number!.value).toBe('INV-2025-0847');
    expect(byField.issue_date!.value).toBe('2025-09-14');
  });

  it('lease', async () => {
    const { byField } = await extractFixture('lease-excerpt-001.pdf', 'lease');
    expect(byField.tenant_name!.value).toBe('Dana Okafor');
    expect(byField.monthly_rent!.value).toEqual({ amount: 2350, currency: 'USD' });
    expect(byField.security_deposit!.value).toEqual({ amount: 3525, currency: 'USD' });
    expect(byField.lease_start!.value).toBe('2025-03-01');
    expect(byField.term_months!.value).toBe(24);
  });

  it('market report, with median household income as a gap', async () => {
    const { byField, values } = await extractFixture('market-report-excerpt-001.pdf', 'market_report');
    expect(byField.report_quarter!.value).toBe('Q3 2025');
    expect(byField.market_area!.value).toBe('Eastport-Harborview Submarket');
    expect(byField.vacancy_rate!.value).toBe(4.2);
    expect(byField.average_rent_1br!.value).toEqual({ amount: 1985, currency: 'USD' });
    expect(byField.year_over_year_rent_growth!.value).toBe(3.8);
    expect(byField.median_household_income!.value).toBeNull();
    expect(byField.median_household_income!.gap?.reason).toBe('not_found');
    expect(values.filter((v) => v.gap)).toHaveLength(1);
  });

  it('every non-gap value has evidence that is an exact substring at its offsets', async () => {
    for (const [name, type] of [
      ['invoice-001.pdf', 'invoice'],
      ['invoice-001.v2.pdf', 'invoice'],
      ['lease-excerpt-001.pdf', 'lease'],
      ['market-report-excerpt-001.pdf', 'market_report'],
    ] as const) {
      const { text, values } = await extractFixture(name, type);
      for (const v of values.filter((x) => x.evidence)) {
        expect(text.slice(v.evidence!.start, v.evidence!.end)).toBe(v.evidence!.quote);
      }
    }
  });

  it('v1 → v2 end to end: exactly due_date and total_amount need re-review', async () => {
    const v1 = await extractFixture('invoice-001.pdf', 'invoice');
    const v2 = await extractFixture('invoice-001.v2.pdf', 'invoice');
    const kinds = v2.values.map((n) => {
      const p = v1.byField[n.field]!;
      return [n.field, decideCarryOver({ field: p.field, value: p.value, evidenceQuote: p.evidence?.quote ?? null, reviewState: 'approved' }, n, v2.text).kind];
    });
    expect(Object.fromEntries(kinds)).toEqual({
      invoice_number: 'carry_over',
      issue_date: 'carry_over',
      due_date: 'changed',
      vendor_name: 'carry_over',
      total_amount: 'changed',
    });
  });

  it('stores the prompt and a JSON raw response', async () => {
    const { res } = await extractFixture('invoice-001.pdf', 'invoice');
    expect(res.prompt).toContain('total_amount');
    expect(res.prompt).toContain('Total Due:');
    expect(JSON.parse(res.rawResponse).fields).toHaveLength(5);
    expect(res.provider).toBe('mock');
  });
});

describe('mock knobs', () => {
  it('MOCK_LLM_FAIL=always throws LlmError', async () => {
    await expect(extractFixture('invoice-001.pdf', 'invoice', { MOCK_LLM_FAIL: 'always' })).rejects.toBeInstanceOf(LlmError);
  });

  it('MOCK_LLM_FAIL=once fails only attempt 1', async () => {
    await expect(extractFixture('invoice-001.pdf', 'invoice', { MOCK_LLM_FAIL: 'once' }, 1)).rejects.toThrow(/once/);
    const { values } = await extractFixture('invoice-001.pdf', 'invoice', { MOCK_LLM_FAIL: 'once' }, 2);
    expect(values.every((v) => v.gap === null)).toBe(true);
  });

  it('MOCK_LLM_HALLUCINATE turns those fields into evidence_not_in_text gaps', async () => {
    const { byField } = await extractFixture('invoice-001.pdf', 'invoice', { MOCK_LLM_HALLUCINATE: 'total_amount, due_date' });
    expect(byField.total_amount!.gap?.reason).toBe('evidence_not_in_text');
    expect(byField.due_date!.gap?.reason).toBe('evidence_not_in_text');
    expect(byField.invoice_number!.gap).toBeNull();
  });

  it('MOCK_LLM_DELAY_MS delays and is abortable', async () => {
    const text = await pdfToText(pdf('invoice-001.pdf'));
    const p = new MockProvider({ MOCK_LLM_DELAY_MS: '60' });
    const t0 = Date.now();
    await p.extract({ docType: 'invoice', fields: EXPECTED_FIELDS.invoice, text, attempt: 1 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);

    const ac = new AbortController();
    const slow = new MockProvider({ MOCK_LLM_DELAY_MS: '10000' }).extract({
      docType: 'invoice',
      fields: EXPECTED_FIELDS.invoice,
      text,
      attempt: 1,
      signal: ac.signal,
    });
    ac.abort(new Error('shutdown'));
    await expect(slow).rejects.toThrow('shutdown');
  });

  it('reads knobs per call, not at construction', async () => {
    const env: NodeJS.ProcessEnv = {};
    const p = new MockProvider(env);
    const text = await pdfToText(pdf('invoice-001.pdf'));
    env.MOCK_LLM_FAIL = 'always';
    await expect(p.extract({ docType: 'invoice', fields: EXPECTED_FIELDS.invoice, text, attempt: 1 })).rejects.toThrow();
  });
});

describe('helpers', () => {
  it('parseLlmFields accepts {fields} or arrays, coerces numbers, rejects junk', () => {
    expect(parseLlmFields({ fields: [{ field: 'a', value: 24, evidence: 'x' }] }, '')).toEqual([
      { field: 'a', value: '24', evidence: 'x', reason: null },
    ]);
    expect(parseLlmFields([{ field: 'a', value: null, evidence: null, reason: 'nope' }], '')).toHaveLength(1);
    expect(() => parseLlmFields({ nope: 1 }, '{"nope":1}')).toThrow(LlmError);
  });

  it('resolveProviderName defaults to mock without keys', () => {
    expect(resolveProviderName({})).toBe('mock');
    expect(resolveProviderName({ ANTHROPIC_API_KEY: 'k' })).toBe('anthropic');
    expect(resolveProviderName({ OPENAI_API_KEY: 'k' })).toBe('openai');
    expect(resolveProviderName({ LLM_PROVIDER: 'mock', ANTHROPIC_API_KEY: 'k' })).toBe('mock');
  });

  it('user prompt lists every field and wraps the document', () => {
    const p = buildUserPrompt('lease', EXPECTED_FIELDS.lease, 'TEXT');
    for (const f of EXPECTED_FIELDS.lease) expect(p).toContain(f.field);
    expect(p).toContain('<<<DOCUMENT\nTEXT\nDOCUMENT>>>');
  });
});
