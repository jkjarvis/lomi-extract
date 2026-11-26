/**
 * Text normalisation for evidence matching. This is deliberately NOT fuzzy matching: it only removes differences
 * that carry no meaning (whitespace layout, typographic quotes/dashes, PDF string escapes). After normalisation a
 * quote must be an exact substring of the document text.
 */

const SINGLE_QUOTES = new Set(['‘', '’', '‚', '‛', '′']);
const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟', '″']);
const DASHES = new Set(['‐', '‑', '‒', '–', '—', '―', '−']);

function mapChar(ch: string): string {
  if (SINGLE_QUOTES.has(ch)) return "'";
  if (DOUBLE_QUOTES.has(ch)) return '"';
  if (DASHES.has(ch)) return '-';
  return ch;
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

interface Normalized {
  text: string;
  /** For each char of `text`, the index in the original string where it starts. */
  starts: number[];
  /** For each char of `text`, the index (exclusive) in the original string where it ends. */
  ends: number[];
}

/** Normalise while recording, for every output char, the span of original chars it came from. */
function normalizeWithMap(s: string): Normalized {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpaceStart = -1;
  let pendingSpaceEnd = -1;

  const push = (ch: string, start: number, end: number) => {
    if (pendingSpaceStart >= 0) {
      if (out.length > 0) {
        out.push(' ');
        starts.push(pendingSpaceStart);
        ends.push(pendingSpaceEnd);
      }
      pendingSpaceStart = -1;
    }
    out.push(ch);
    starts.push(start);
    ends.push(end);
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    // PDF string escapes: "\(" → "(", "\)" → ")", "\\" → "\"
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[i + 1]!;
      if (next === '(' || next === ')' || next === '\\') {
        push(next, i, i + 2);
        i += 2;
        continue;
      }
    }
    if (isWhitespace(ch)) {
      if (pendingSpaceStart < 0) pendingSpaceStart = i;
      pendingSpaceEnd = i + 1;
      i += 1;
      continue;
    }
    push(mapChar(ch), i, i + 1);
    i += 1;
  }
  return { text: out.join(''), starts, ends };
}

/**
 * - collapse any run of whitespace to a single space; trim
 * - smart quotes → ' and " ; en/em dash → -
 * - strip PDF-escape backslashes before ( ) \
 */
export function normalizeText(s: string): string {
  return normalizeWithMap(s).text;
}

/**
 * Locate `quote` inside `text` (both normalised). Returns offsets into the ORIGINAL text, end exclusive, or null.
 * The first occurrence wins.
 */
export function findEvidence(text: string, quote: string): { start: number; end: number } | null {
  if (typeof quote !== 'string' || typeof text !== 'string') return null;
  const q = normalizeText(quote);
  if (q.length === 0) return null;
  const n = normalizeWithMap(text);
  const idx = n.text.indexOf(q);
  if (idx < 0) return null;
  return { start: n.starts[idx]!, end: n.ends[idx + q.length - 1]! };
}
