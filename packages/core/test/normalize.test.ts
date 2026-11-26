import { describe, expect, it } from 'vitest';
import { normalizeValue, parseNumberWords } from '../src/index.js';

const ok = (value: unknown) => ({ ok: true, value });

describe('normalizeValue money', () => {
  it.each([
    ['$5,230.29', 5230.29],
    ['$1,985 per month', 1985],
    ['USD 2,350.00', 2350],
    ['2350', 2350],
    ['$ 3,525.00', 3525],
    ['$1,234.567', 1234.57],
  ])('%s → %d USD', (raw, amount) => {
    expect(normalizeValue('money', raw)).toEqual(ok({ amount, currency: 'USD' }));
  });
  it('detects other currencies', () => {
    expect(normalizeValue('money', '€1.200,00'.replace('.', ''))).toMatchObject({ ok: true, value: { currency: 'EUR' } });
  });
  it('fails without digits', () => {
    expect(normalizeValue('money', 'not stated').ok).toBe(false);
  });
});

describe('normalizeValue date', () => {
  it.each([
    ['2025-10-14', '2025-10-14'],
    ['March 1, 2025', '2025-03-01'],
    ['Mar 1 2025', '2025-03-01'],
    ['1 March 2025', '2025-03-01'],
    ['09/14/2025', '2025-09-14'],
    ['September 14th, 2025', '2025-09-14'],
    ['Sept. 14, 2025', '2025-09-14'],
  ])('%s → %s', (raw, iso) => {
    expect(normalizeValue('date', raw)).toEqual(ok(iso));
  });
  it('rejects impossible dates and garbage', () => {
    expect(normalizeValue('date', '2025-02-30').ok).toBe(false);
    expect(normalizeValue('date', '13/40/2025').ok).toBe(false);
    expect(normalizeValue('date', 'soon').ok).toBe(false);
  });
});

describe('normalizeValue number', () => {
  it.each([
    ['24', 24],
    ['twenty-four (24)', 24],
    ['twenty-four', 24],
    ['24 months', 24],
    ['1,200', 1200],
    ['one hundred and twenty', 120],
  ])('%s → %d', (raw, n) => {
    expect(normalizeValue('number', raw)).toEqual(ok(n));
  });
  it('fails on non-numbers', () => {
    expect(normalizeValue('number', 'several').ok).toBe(false);
  });
  it('parseNumberWords stops at the first non-number word', () => {
    expect(parseNumberWords('twenty-four months and three days')).toBe(24);
    expect(parseNumberWords('none')).toBeNull();
  });
});

describe('normalizeValue percent', () => {
  it.each([
    ['4.2%', 4.2],
    ['4.2 %', 4.2],
    ['4.2 percent', 4.2],
    ['3.8', 3.8],
  ])('%s → %d', (raw, n) => {
    expect(normalizeValue('percent', raw)).toEqual(ok(n));
  });
});

describe('normalizeValue string', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeValue('string', '  MERIDIAN   OFFICE\nSUPPLIES LLC ')).toEqual(ok('MERIDIAN OFFICE SUPPLIES LLC'));
  });
  it('rejects empty', () => {
    expect(normalizeValue('string', '   ').ok).toBe(false);
  });
  it('never throws on bad input', () => {
    expect(() => normalizeValue('money', undefined as unknown as string)).not.toThrow();
    expect(normalizeValue('bogus' as never, 'x').ok).toBe(false);
  });
});
