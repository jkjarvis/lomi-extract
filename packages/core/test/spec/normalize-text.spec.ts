import { describe, expect, it } from 'vitest';
import { normalizeText } from '@lomi/core';

// CONTRACT §2 normalizeText:
// - collapse any run of whitespace (spaces, tabs, \r, \n) to a single space; trim
// - smart quotes ‘’“” → ' and " ; en/em dash – — → -
// - strip PDF-escape backslashes before ( ) \  (i.e. "\(" → "(")

describe('normalizeText — whitespace', () => {
  it.each([
    ['a  b', 'a b'],
    ['a\tb', 'a b'],
    ['a\nb', 'a b'],
    ['a\r\nb', 'a b'],
    ['a\rb', 'a b'],
    ['a \t\r\n  \n\t b', 'a b'],
    ['Total Due:      $5,230.29', 'Total Due: $5,230.29'],
    ['twenty-four (24)\nmonths', 'twenty-four (24) months'],
    ['twenty-four (24)\r\nmonths', 'twenty-four (24) months'],
  ])('collapses whitespace run in %j → %j', (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });

  it.each([
    ['  leading', 'leading'],
    ['trailing  ', 'trailing'],
    ['\r\n\t  both \n\n', 'both'],
  ])('trims %j → %j', (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });

  it('returns empty string for empty / whitespace-only input', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText('   ')).toBe('');
    expect(normalizeText('\r\n\t \n')).toBe('');
  });
});

describe('normalizeText — typography', () => {
  it('maps smart single quotes ‘ ’ to straight apostrophe', () => {
    expect(normalizeText('Landlord\u2019s ‘prior’ consent')).toBe("Landlord's 'prior' consent");
  });

  it('maps smart double quotes “ ” to straight double quote', () => {
    expect(normalizeText('Residential LP (\u201CLandlord\u201D)')).toBe('Residential LP ("Landlord")');
  });

  it('maps en dash – and em dash — to hyphen', () => {
    expect(normalizeText('Eastport\u2013Harborview')).toBe('Eastport-Harborview');
    expect(normalizeText('twenty\u2014four')).toBe('twenty-four');
  });

  it('leaves already-straight quotes, hyphens and letter case untouched', () => {
    const s = `INV-2025-0847 "Tenant" Landlord's Q3 2025`;
    expect(normalizeText(s)).toBe(s);
  });
});

describe('normalizeText — PDF escape backslashes', () => {
  it('strips the backslash before ( and )', () => {
    expect(normalizeText('Sales Tax \\(8.625%\\): $415.29')).toBe('Sales Tax (8.625%): $415.29');
    expect(normalizeText('INVOICE \\(REVISED\\)')).toBe('INVOICE (REVISED)');
    expect(normalizeText('twenty-four \\(24\\)')).toBe('twenty-four (24)');
  });

  it('turns an escaped backslash "\\\\" into a single backslash', () => {
    // JS literal 'a\\\\b' is the 4-char string a\\b (two backslashes) → a\b
    expect(normalizeText('a\\\\b')).toBe('a\\b');
  });

  it('does not touch backslashes that are not PDF escapes', () => {
    expect(normalizeText('C:\\temp')).toBe('C:\\temp');
  });

  it('combines all rules at once', () => {
    const input = '  Dana Okafor \\(\u201CTenant\u201D\\).\r\n2. TERM\u2014twenty-four \\(24\\)\n\tmonths  ';
    expect(normalizeText(input)).toBe('Dana Okafor ("Tenant"). 2. TERM-twenty-four (24) months');
  });
});

describe('normalizeText — properties', () => {
  it.each([
    'MERIDIAN OFFICE SUPPLIES LLC\n482 Commerce Way',
    '  a \t b \r\n c  ',
    'Residential LP (\u201CLandlord\u201D) \u2013 Dana',
    'Sales Tax \\(8.625%\\): $415.29',
  ])('is idempotent for %j', (s) => {
    const once = normalizeText(s);
    // NB: idempotence is only asserted for inputs whose first pass cannot create new escape sequences.
    expect(normalizeText(once)).toBe(once);
  });

  it('never yields leading/trailing whitespace or double spaces', () => {
    const out = normalizeText(' \n x \t\t y \r\n\r\n z \n');
    expect(out).toBe('x y z');
    expect(out).not.toMatch(/\s{2,}|^\s|\s$/);
  });
});
