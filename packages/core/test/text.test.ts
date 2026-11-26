import { describe, expect, it } from 'vitest';
import { findEvidence, normalizeText } from '../src/index.js';

describe('normalizeText', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeText('  a \t b\r\n\n c  ')).toBe('a b c');
  });
  it('unifies smart quotes and dashes', () => {
    expect(normalizeText('“Tenant” it’s 1–2 — x')).toBe('"Tenant" it\'s 1-2 - x');
  });
  it('strips PDF escape backslashes before parens and backslash', () => {
    expect(normalizeText('Sales Tax \\(8.625%\\): \\\\x')).toBe('Sales Tax (8.625%): \\x');
  });
  it('is idempotent on plain text', () => {
    const s = 'Total Due: $5,230.29';
    expect(normalizeText(normalizeText(s))).toBe(s);
  });
});

describe('findEvidence', () => {
  const text = 'Line one\nTotal Due:      $5,230.29\nThe initial term shall be twenty-four (24)\nmonths, commencing';

  it('finds an exact substring and returns original offsets', () => {
    const r = findEvidence(text, 'Line one');
    expect(r).toEqual({ start: 0, end: 8 });
  });

  it('matches across collapsed whitespace and maps back to original offsets', () => {
    const r = findEvidence(text, 'Total Due: $5,230.29');
    expect(r).not.toBeNull();
    expect(text.slice(r!.start, r!.end)).toBe('Total Due:      $5,230.29');
  });

  it('matches quotes that span a line break', () => {
    const r = findEvidence(text, 'twenty-four (24) months');
    expect(text.slice(r!.start, r!.end)).toBe('twenty-four (24)\nmonths');
  });

  it('matches PDF-escaped parens in the text against plain parens in the quote', () => {
    const raw = 'Sales Tax \\(8.625%\\): $415.29';
    const r = findEvidence(raw, 'Sales Tax (8.625%): $415.29');
    expect(r).toEqual({ start: 0, end: raw.length });
  });

  it('matches smart quotes in the quote against straight quotes in text', () => {
    const t = 'Dana Okafor ("Tenant").';
    const r = findEvidence(t, 'Dana Okafor (“Tenant”)');
    expect(t.slice(r!.start, r!.end)).toBe('Dana Okafor ("Tenant")');
  });

  it('ignores surrounding whitespace in the quote', () => {
    const r = findEvidence(text, '   Line one \n');
    expect(r).toEqual({ start: 0, end: 8 });
  });

  it('is not fuzzy: a near-miss is null', () => {
    expect(findEvidence(text, 'Total Due: $5,230.30')).toBeNull();
    expect(findEvidence(text, 'total due: $5,230.29')).toBeNull(); // case-sensitive
  });

  it('returns null for empty or whitespace quotes', () => {
    expect(findEvidence(text, '')).toBeNull();
    expect(findEvidence(text, '   \n ')).toBeNull();
  });
});
