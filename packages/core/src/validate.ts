import type { FieldSpec, FieldType } from './fields.js';
import { allNumbers, firstNumber, normalizeValue, parseDate } from './normalize.js';
import { findEvidence, normalizeText } from './text.js';

/** Raw LLM output for ONE field (what providers return). */
export interface LlmField {
  field: string;
  value: string | null;
  evidence: string | null;
  reason?: string | null;
}

export type GapReason =
  | 'not_found'
  | 'evidence_missing'
  | 'evidence_not_in_text'
  | 'value_not_in_evidence'
  | 'unparseable_value'
  | 'missing_from_response';

export interface ValidatedValue {
  field: string;
  type: FieldType;
  value: unknown | null;
  rawValue: string | null;
  evidence: { quote: string; start: number; end: number } | null;
  gap: { reason: GapReason; detail?: string } | null;
}

const NUMERIC_TYPES: ReadonlySet<FieldType> = new Set(['money', 'number', 'percent']);

function isBlank(s: string | null | undefined): boolean {
  return s == null || String(s).trim().length === 0;
}

/**
 * Is the extracted value actually supported by its quote? Textual containment (normalised, case-insensitive),
 * or for numeric types the same number appearing in the quote ("24" in "twenty-four (24) months",
 * "5230.29" in "$5,230.29"), or for dates the same calendar date written another way.
 */
export function valueInEvidence(type: FieldType, rawValue: string, quote: string): boolean {
  const v = normalizeText(rawValue).toLowerCase();
  const q = normalizeText(quote).toLowerCase();
  if (v.length > 0) {
    if (!NUMERIC_TYPES.has(type)) {
      if (q.includes(v)) return true;
    } else if (containsAtDigitBoundary(q, v)) {
      return true; // "24" must not match inside "2024"
    }
  }

  if (NUMERIC_TYPES.has(type)) {
    const n = firstNumber(rawValue);
    if (n !== null && allNumbers(quote).some((x) => x === n)) return true;
    const digits = rawValue.replace(/\D/g, '');
    if (digits.length > 0) {
      const tokens = quote.match(/\d[\d,.]*/g) ?? [];
      if (tokens.some((t) => t.replace(/\D/g, '') === digits)) return true;
    }
  }

  if (type === 'date') {
    const d = parseDate(rawValue);
    if (d !== null && candidateDates(quote).includes(d)) return true;
  }
  return false;
}

function containsAtDigitBoundary(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    const before = haystack[i - 1] ?? '';
    const after = haystack[i + needle.length] ?? '';
    const digitEdgeBefore =
      /\d/.test(needle[0] ?? '') && (/\d/.test(before) || (/[.,]/.test(before) && /\d/.test(haystack[i - 2] ?? '')));
    const digitEdgeAfter = /\d/.test(needle[needle.length - 1] ?? '') && (/\d/.test(after) || (/[.,]/.test(after) && /\d/.test(haystack[i + needle.length + 1] ?? '')));
    if (!digitEdgeBefore && !digitEdgeAfter) return true;
    from = i + 1;
  }
}

function candidateDates(quote: string): string[] {
  // Try every suffix that starts at a word boundary so each date in the quote is considered.
  const out = new Set<string>();
  const s = normalizeText(quote);
  for (let i = 0; i < s.length; i++) {
    if (i === 0 || /[\s(,]/.test(s[i - 1]!)) {
      const d = parseDate(s.slice(i));
      if (d) out.add(d);
    }
  }
  return [...out];
}

/** Turn LLM output into exactly one validated value per spec field, in spec order. */
export function validateExtraction(text: string, spec: FieldSpec[], llm: LlmField[]): ValidatedValue[] {
  const byField = new Map<string, LlmField>();
  for (const f of Array.isArray(llm) ? llm : []) {
    if (f && typeof f.field === 'string' && !byField.has(f.field)) byField.set(f.field, f);
  }

  return spec.map(({ field, type }): ValidatedValue => {
    const gap = (reason: GapReason, detail?: string, rawValue: string | null = null): ValidatedValue => ({
      field,
      type,
      value: null,
      rawValue,
      evidence: null,
      gap: detail ? { reason, detail } : { reason },
    });

    const item = byField.get(field);
    if (!item) return gap('missing_from_response', 'The model did not return this field.');

    const rawValue = isBlank(item.value) ? null : String(item.value);
    if (rawValue === null) {
      return gap('not_found', isBlank(item.reason) ? undefined : String(item.reason).trim());
    }
    if (isBlank(item.evidence)) {
      return gap('evidence_missing', 'The model returned a value without a supporting quote.', rawValue);
    }
    const evidence = String(item.evidence);
    const loc = findEvidence(text, evidence);
    if (!loc) {
      return gap('evidence_not_in_text', `Quoted evidence does not appear in the document: "${evidence}"`, rawValue);
    }
    if (!valueInEvidence(type, rawValue, evidence)) {
      return gap('value_not_in_evidence', `Value "${rawValue}" is not supported by its quote "${evidence}"`, rawValue);
    }
    const norm = normalizeValue(type, rawValue);
    if (!norm.ok) return gap('unparseable_value', norm.reason, rawValue);

    return {
      field,
      type,
      value: norm.value,
      rawValue,
      evidence: { quote: text.slice(loc.start, loc.end), start: loc.start, end: loc.end },
      gap: null,
    };
  });
}
