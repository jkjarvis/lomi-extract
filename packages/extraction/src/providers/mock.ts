import type { DocType, LlmField } from '@lomi/core';
import { renderPrompt } from '../prompt.js';
import type { ExtractionRequest, ExtractionResult, LlmProvider } from '../types.js';
import { LlmError, abortableSleep } from '../types.js';

/**
 * Deterministic stand-in for an LLM. It behaves like a good model would: label-anchored verbatim quotes, no guesses.
 * Test knobs are read from the environment on every call (MOCK_LLM_DELAY_MS, MOCK_LLM_FAIL, MOCK_LLM_HALLUCINATE).
 */

const MONEY = String.raw`\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?`;
const MONTH = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`;
const DATE = String.raw`(?:\d{4}-\d{2}-\d{2}|${MONTH}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}/\d{1,2}/\d{4})`;
const LP = String.raw`\\?\(`; // "(" possibly PDF-escaped
const RP = String.raw`\\?\)`;

interface Rule {
  /** Regex whose full match is the evidence quote and group 1 the value. */
  re: RegExp;
  notFound: string;
}

const RULES: Record<DocType, Record<string, Rule | ((text: string) => LlmField)>> = {
  invoice: {
    invoice_number: { re: /Invoice\s+(?:Number|No\.?|#)\s*:?\s*([A-Z0-9][A-Z0-9-]*\d)/i, notFound: 'No invoice number label found.' },
    issue_date: { re: new RegExp(String.raw`(?:Issue|Invoice)\s+Date\s*:\s*(${DATE})`, 'i'), notFound: 'No issue date label found.' },
    due_date: { re: new RegExp(String.raw`Due\s+Date\s*:\s*(${DATE})`, 'i'), notFound: 'No due date label found.' },
    vendor_name: (text) => {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5);
      const line = lines.find((l) => /\b(LLC|Inc\.?|Ltd\.?|Corp\.?|Company|Co\.)$/i.test(l));
      return line
        ? { field: 'vendor_name', value: line, evidence: line, reason: null }
        : { field: 'vendor_name', value: null, evidence: null, reason: 'No vendor name found in the document header.' };
    },
    total_amount: { re: new RegExp(String.raw`(?<![A-Za-z])Total(?:\s+(?:Due|Amount(?:\s+Due)?))?\s*:\s*(${MONEY})`, 'i'), notFound: 'No total due line found.' },
  },
  lease: {
    tenant_name: {
      re: new RegExp(String.raw`([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+)+)\s*${LP}\s*["“]Tenant["”]\s*${RP}`),
      notFound: 'No party defined as "Tenant" found.',
    },
    monthly_rent: { re: new RegExp(String.raw`monthly\s+rent\s+of\s+(${MONEY})`, 'i'), notFound: 'No monthly rent clause found.' },
    security_deposit: {
      re: new RegExp(String.raw`sum\s+of\s+(${MONEY})\s+as\s+a\s+security\s+deposit`, 'i'),
      notFound: 'No security deposit amount found.',
    },
    lease_start: { re: new RegExp(String.raw`commencing\s+on\s+(${DATE})`, 'i'), notFound: 'No commencement date found.' },
    term_months: {
      re: new RegExp(String.raw`term\s+of\s+this\s+Lease\s+shall\s+be\s+((?:[a-z]+(?:-[a-z]+)?\s*)?${LP}\d+${RP}|\d+)\s+months`, 'i'),
      notFound: 'No lease term in months found.',
    },
  },
  market_report: {
    report_quarter: { re: /Reporting\s+Period\s*:\s*(Q[1-4]\s+\d{4})/i, notFound: 'No reporting period found.' },
    market_area: { re: /Market\s+Area\s*:\s*([^\n]+?)\s*(?:\n|$)/i, notFound: 'No market area label found.' },
    vacancy_rate: {
      re: /vacancy\s+rate\s+(?:declined|increased|rose|fell|was|stood|remained)?\s*(?:to|at)?\s*(\d+(?:\.\d+)?\s?%)/i,
      notFound: 'No current vacancy rate found.',
    },
    average_rent_1br: {
      re: new RegExp(String.raw`rent\s+for\s+a\s+one-bedroom\s+unit\s+reached\s+(${MONEY})(?:\s+per\s+month)?`, 'i'),
      notFound: 'No one-bedroom average rent found.',
    },
    year_over_year_rent_growth: {
      re: /year-over-year\s+(?:increase|growth|change)\s+of\s+(\d+(?:\.\d+)?\s?%)/i,
      notFound: 'No year-over-year rent growth figure found.',
    },
    median_household_income: {
      re: new RegExp(String.raw`median\s+household\s+income\s+(?:of|was|is|:)?\s*(${MONEY})`, 'i'),
      notFound: 'The document does not mention median household income.',
    },
  },
};

export function mockExtract(docType: DocType, fieldNames: string[], text: string): LlmField[] {
  const rules = RULES[docType] ?? {};
  return fieldNames.map((field): LlmField => {
    const rule = rules[field];
    if (!rule) return { field, value: null, evidence: null, reason: 'Field not recognised by the mock model.' };
    if (typeof rule === 'function') return rule(text);
    const m = rule.re.exec(text);
    if (!m || !m[1]) return { field, value: null, evidence: null, reason: rule.notFound };
    return { field, value: m[1].trim(), evidence: m[0].trim(), reason: null };
  });
}

export function readMockKnobs(env: NodeJS.ProcessEnv = process.env) {
  const delayMs = Math.max(0, Number(env.MOCK_LLM_DELAY_MS ?? 0) || 0);
  const failRaw = (env.MOCK_LLM_FAIL ?? 'never').trim().toLowerCase();
  const fail: 'never' | 'always' | 'once' = failRaw === 'always' || failRaw === 'once' ? failRaw : 'never';
  const hallucinate = new Set(
    (env.MOCK_LLM_HALLUCINATE ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return { delayMs, fail, hallucinate };
}

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-heuristic-v1';

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const knobs = readMockKnobs(this.env);
    const prompt = renderPrompt(req.docType, req.fields, req.text);
    if (knobs.delayMs > 0) await abortableSleep(knobs.delayMs, req.signal);
    if (knobs.fail === 'always' || (knobs.fail === 'once' && req.attempt <= 1)) {
      throw new LlmError(`Mock LLM failure (MOCK_LLM_FAIL=${knobs.fail}, attempt ${req.attempt})`, null, prompt);
    }
    const fields = mockExtract(
      req.docType,
      req.fields.map((f) => f.field),
      req.text,
    ).map((f) =>
      knobs.hallucinate.has(f.field)
        ? { ...f, value: f.value ?? 'hallucinated value', evidence: `[hallucinated quote that is not in the document: ${f.field}]`, reason: null }
        : f,
    );
    return { fields, prompt, rawResponse: JSON.stringify({ fields }, null, 2), provider: this.name, model: this.model };
  }
}
