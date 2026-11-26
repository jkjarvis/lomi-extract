import { describe, expect, it } from 'vitest';
import { findEvidence, normalizeText } from '@lomi/core';
import { TEXTS, VARIANTS } from './fixture-texts';

// CONTRACT §2 findEvidence: normalizeText on both sides, then an EXACT substring (no fuzzy matching).
// Offsets index the ORIGINAL text (start inclusive, end exclusive). Empty/whitespace quote → null.

/** Asserts the quote was found and that the original-text slice normalises to the normalised quote. */
function expectFound(text: string, quote: string) {
  const hit = findEvidence(text, quote);
  expect(hit, `expected quote ${JSON.stringify(quote)} to be found`).not.toBeNull();
  const { start, end } = hit!;
  expect(Number.isInteger(start) && Number.isInteger(end), 'offsets must be integers').toBe(true);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeLessThanOrEqual(text.length);
  expect(end).toBeGreaterThan(start);
  expect(normalizeText(text.slice(start, end)), 'text.slice(start, end) must normalise to the quote').toBe(
    normalizeText(quote),
  );
  return hit!;
}

describe('findEvidence — exact matches', () => {
  const text = 'Invoice Number: INV-2025-0847\nIssue Date: 2025-09-14\nDue Date: 2025-10-14';

  it('finds an exact substring and returns its exact offsets', () => {
    const hit = expectFound(text, 'Issue Date: 2025-09-14');
    const start = text.indexOf('Issue Date: 2025-09-14');
    expect(hit).toEqual({ start, end: start + 'Issue Date: 2025-09-14'.length });
  });

  it('finds a match at offset 0 and at the very end of the text', () => {
    expect(findEvidence(text, 'Invoice Number')).toEqual({ start: 0, end: 14 });
    expect(findEvidence(text, '2025-10-14')).toEqual({ start: text.length - 10, end: text.length });
  });

  it('accepts a quote with surrounding whitespace (trimmed by normalisation)', () => {
    const hit = expectFound(text, '  \n Due Date: 2025-10-14 \t');
    expect(text.slice(hit.start, hit.end)).toBe('Due Date: 2025-10-14');
  });
});

describe('findEvidence — whitespace normalisation', () => {
  it('matches across a line break (quote has a space, text has \\n)', () => {
    const text = TEXTS.lease.parsed;
    const hit = expectFound(text, 'twenty-four (24) months');
    expect(text.slice(hit.start, hit.end)).toBe('twenty-four (24)\nmonths');
  });

  it('matches across \\r\\n line breaks', () => {
    const text = 'shall be twenty-four (24)\r\nmonths, commencing';
    const hit = expectFound(text, 'twenty-four (24) months');
    expect(text.slice(hit.start, hit.end)).toBe('twenty-four (24)\r\nmonths');
  });

  it('matches a single-space quote against a run of spaces (fixed-width PDF columns)', () => {
    const text = TEXTS.invoiceV1.parsed;
    const hit = expectFound(text, 'Total Due: $5,230.29');
    expect(text.slice(hit.start, hit.end)).toBe('Total Due:      $5,230.29');
  });

  it('matches a quote whose own whitespace is irregular', () => {
    expectFound(TEXTS.invoiceV1.parsed, 'Total   Due:\n$5,230.29');
  });

  it('does NOT delete whitespace: a quote missing a space is not found', () => {
    expect(findEvidence('Invoice Number: INV-2025-0847', 'InvoiceNumber: INV-2025-0847')).toBeNull();
  });

  it('does NOT invent whitespace: a quote with an extra space inside a token is not found', () => {
    expect(findEvidence('Invoice Number: INV-2025-0847', 'INV-2025- 0847')).toBeNull();
  });
});

describe('findEvidence — offsets map to the ORIGINAL text', () => {
  it('stays correct when collapsible whitespace and escapes precede the match', () => {
    const text = '\r\n\r\n   A \\(1\\)   \t\t B—C “q”   \nTotal Due:      $5,230.29   tail';
    const hit = expectFound(text, 'Total Due: $5,230.29');
    const start = text.indexOf('Total Due:');
    expect(hit).toEqual({ start, end: text.indexOf('$5,230.29') + '$5,230.29'.length });
  });

  it('returns offsets around escaped parens in the original text', () => {
    const text = 'Subtotal: $4,815.00\nSales Tax \\(8.625%\\): $415.29\nTotal';
    const hit = expectFound(text, 'Sales Tax (8.625%): $415.29');
    expect(text.slice(hit.start, hit.end)).toBe('Sales Tax \\(8.625%\\): $415.29');
  });

  it.each(VARIANTS)('lease "%s" rendering: tenant quote slice is correct', (variant) => {
    const text = TEXTS.lease[variant];
    const hit = expectFound(text, 'Dana Okafor ("Tenant")');
    expect(text.slice(hit.start, hit.start + 'Dana Okafor'.length)).toBe('Dana Okafor');
  });
});

describe('findEvidence — PDF escapes and typography', () => {
  it('matches an unescaped quote against escaped text', () => {
    expectFound(TEXTS.lease.escaped, 'twenty-four (24) months');
    expectFound(TEXTS.invoiceV2.escaped, 'INVOICE (REVISED)');
  });

  it('matches an escaped quote against unescaped text', () => {
    expectFound(TEXTS.lease.parsed, 'twenty-four \\(24\\) months');
  });

  it('matches straight-quote quote against smart-quote text', () => {
    const text = 'Residential LP (“Landlord”) and Dana Okafor (“Tenant”).';
    const hit = expectFound(text, 'Dana Okafor ("Tenant")');
    expect(text.slice(hit.start, hit.end)).toBe('Dana Okafor (“Tenant”)');
  });

  it('matches smart-quote quote against straight-quote text', () => {
    expectFound(TEXTS.lease.parsed, 'Dana Okafor (“Tenant”)');
    expectFound(TEXTS.lease.parsed, 'Subletting requires Landlord’s prior written consent');
  });

  it('matches en/em dash quote against hyphen text', () => {
    expectFound(TEXTS.marketReport.parsed, 'Market Area: Eastport–Harborview Submarket');
    expectFound(TEXTS.marketReport.parsed, 'a year—over—year increase of 3.8%');
  });
});

describe('findEvidence — not found (no fuzzy matching)', () => {
  const text = TEXTS.invoiceV1.parsed;

  it.each([
    ['one digit different', 'Invoice Number: INV-2025-0848'],
    ['one cent different', 'Total Due: $5,230.28'],
    ['v2 due date against v1 text', 'Due Date: 2025-11-13'],
    ['extra trailing character', 'Total Due: $5,230.29.'],
    ['missing comma', 'Total Due: $5230.29'],
    ['words reordered', 'Due Total: $5,230.29'],
    ['fabricated passage', 'The total amount payable is $5,230.29'],
    ['different letter case', 'invoice number: inv-2025-0847'],
  ])('returns null for a near-miss (%s)', (_label, quote) => {
    expect(findEvidence(text, quote)).toBeNull();
  });

  it.each([[''], [' '], ['   '], ['\n'], ['\r\n\t ']])('returns null for empty/whitespace quote %j', (q) => {
    expect(findEvidence(text, q)).toBeNull();
  });

  it('returns null when the text itself is empty', () => {
    expect(findEvidence('', 'anything')).toBeNull();
  });

  it('returns null for a quote longer than the text', () => {
    expect(findEvidence('INV', 'INV-2025-0847')).toBeNull();
  });
});

describe('findEvidence — every fixture rendering', () => {
  const cases: Array<[keyof typeof TEXTS, string]> = [
    ['invoiceV1', 'Invoice Number: INV-2025-0847'],
    ['invoiceV1', 'Total Due: $5,230.29'],
    ['invoiceV1', 'Sales Tax (8.625%): $415.29'],
    ['invoiceV2', 'INVOICE (REVISED)'],
    ['invoiceV2', 'This revised invoice supersedes the version issued on 2025-09-14 and reflects two additional ergonomic chairs'],
    ['lease', 'Tenant shall deposit with Landlord the sum of $3,525.00'],
    ['lease', 'months, commencing on March 1, 2025'],
    ['marketReport', 'The overall vacancy rate declined to 4.2%, down from 4.9% in the prior quarter'],
    ['marketReport', 'Average asking rent for a one-bedroom unit reached $1,985 per month, a year-over-year increase of 3.8%'],
  ];
  for (const variant of VARIANTS) {
    it.each(cases)(`[${variant}] %s: finds %j`, (name, quote) => {
      expectFound(TEXTS[name][variant], quote);
    });
  }
});
