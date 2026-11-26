import type { FieldType } from './fields.js';

export type NormalizeResult = { ok: true; value: unknown } | { ok: false; reason: string };

export interface Money {
  amount: number;
  currency: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const NUMBER_TOKEN_RE = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?|-?\.\d+/;

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** First numeric token in `s` ("$5,230.29" → 5230.29), or null. */
export function firstNumber(s: string): number | null {
  const m = NUMBER_TOKEN_RE.exec(s);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** All numeric tokens in `s`. */
export function allNumbers(s: string): number[] {
  const re = new RegExp(NUMBER_TOKEN_RE.source, 'g');
  const out: number[] = [];
  for (const m of s.matchAll(re)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };

/** "twenty-four" → 24, "one hundred and twenty" → 120. Returns null if no number words are present. */
export function parseNumberWords(s: string): number | null {
  const words = s.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of words) {
    if (w in UNITS) {
      current += UNITS[w]!;
      seen = true;
    } else if (w in TENS) {
      current += TENS[w]!;
      seen = true;
    } else if (w === 'hundred') {
      current = (current || 1) * 100;
      seen = true;
    } else if (w in SCALES) {
      total += (current || 1) * SCALES[w]!;
      current = 0;
      seen = true;
    } else if (w === 'and' && seen) {
      continue;
    } else if (seen) {
      break; // stop at the first non-number word after a number phrase ("twenty-four months")
    }
  }
  return seen ? total + current : null;
}

function isoDate(y: number, m: number, d: number): string | null {
  if (!(y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Find a date in free text and return it as YYYY-MM-DD, or null. */
export function parseDate(raw: string): string | null {
  const s = collapse(raw);
  let m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i').exec(s);
  if (m) return isoDate(Number(m[3]), MONTHS[m[1]!.toLowerCase()]!, Number(m[2]));
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'i').exec(s);
  if (m) return isoDate(Number(m[3]), MONTHS[m[2]!.toLowerCase()]!, Number(m[1]));
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(s); // US M/D/Y
  if (m) return isoDate(Number(m[3]), Number(m[1]), Number(m[2]));
  return null;
}

function detectCurrency(s: string): string {
  if (/€|\bEUR\b/i.test(s)) return 'EUR';
  if (/£|\bGBP\b/i.test(s)) return 'GBP';
  return 'USD'; // "$", "USD", "US$" or no symbol at all
}

/** Normalise a raw extracted string to a canonical value. Never throws. */
export function normalizeValue(type: FieldType, raw: string): NormalizeResult {
  try {
    if (typeof raw !== 'string') return { ok: false, reason: 'value is not a string' };
    const s = collapse(raw);
    if (s.length === 0) return { ok: false, reason: 'empty value' };
    switch (type) {
      case 'string':
        return { ok: true, value: s };
      case 'money': {
        const n = firstNumber(s);
        if (n === null) return { ok: false, reason: `no amount found in "${s}"` };
        const money: Money = { amount: Math.round(n * 100) / 100, currency: detectCurrency(s) };
        return { ok: true, value: money };
      }
      case 'date': {
        const d = parseDate(s);
        return d ? { ok: true, value: d } : { ok: false, reason: `unrecognised date "${s}"` };
      }
      case 'number': {
        const n = firstNumber(s) ?? parseNumberWords(s);
        return n === null ? { ok: false, reason: `no number found in "${s}"` } : { ok: true, value: n };
      }
      case 'percent': {
        const n = firstNumber(s);
        return n === null ? { ok: false, reason: `no percentage found in "${s}"` } : { ok: true, value: n };
      }
      default:
        return { ok: false, reason: `unknown field type ${String(type)}` };
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
