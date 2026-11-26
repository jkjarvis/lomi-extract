import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeValue, type FieldType, type NormalizeResult } from '@lomi/core';

// CONTRACT §2 normalizeValue — never throws; returns { ok: true, value } | { ok: false, reason }.

function ok(type: FieldType, raw: string): unknown {
  const r = normalizeValue(type, raw);
  expect(r, `normalizeValue(${type}, ${JSON.stringify(raw)}) should be ok`).toMatchObject({ ok: true });
  return (r as Extract<NormalizeResult, { ok: true }>).value;
}

function notOk(type: FieldType, raw: string) {
  let r: NormalizeResult | undefined;
  expect(() => {
    r = normalizeValue(type, raw);
  }, `normalizeValue(${type}, ${JSON.stringify(raw)}) must not throw`).not.toThrow();
  expect(r!.ok, `normalizeValue(${type}, ${JSON.stringify(raw)}) should NOT be ok, got ${JSON.stringify(r)}`).toBe(false);
  const reason = (r as Extract<NormalizeResult, { ok: false }>).reason;
  expect(typeof reason).toBe('string');
  expect(reason.length, 'a failure must carry a non-empty reason').toBeGreaterThan(0);
}

describe('normalizeValue — money → { amount, currency: "USD" }', () => {
  it.each([
    ['$5,230.29', 5230.29],
    ['$6,126.45', 6126.45],
    ['$1,985 per month', 1985],
    ['USD 2,350.00', 2350],
    ['2350', 2350],
    ['$2,350.00', 2350],
    ['$3,525.00', 3525],
    ['$4,815.00', 4815],
    ['$0.50', 0.5],
    ['$1,000,000.00', 1000000],
    ['  $5,230.29  ', 5230.29],
  ])('%j → amount %d USD', (raw, amount) => {
    expect(ok('money', raw)).toEqual({ amount, currency: 'USD' });
  });

  it('always uses currency USD and a finite number amount', () => {
    for (const raw of ['$5,230.29', 'USD 2,350.00', '2350', '$1,985 per month']) {
      const v = ok('money', raw) as { amount: unknown; currency: unknown };
      expect(v.currency).toBe('USD');
      expect(typeof v.amount).toBe('number');
      expect(Number.isFinite(v.amount)).toBe(true);
    }
  });

  it('amount has at most 2 decimal places', () => {
    const v = ok('money', '$5,230.29') as { amount: number };
    expect(Math.round(v.amount * 100) / 100).toBe(v.amount);
  });

  it.each([[''], ['   '], ['abc'], ['N/A'], ['$'], ['USD'], ['not stated'], ['per month']])(
    'rejects %j',
    (raw) => notOk('money', raw),
  );
});

describe('normalizeValue — date → YYYY-MM-DD', () => {
  it.each([
    ['2025-10-14', '2025-10-14'],
    ['2025-09-14', '2025-09-14'],
    ['March 1, 2025', '2025-03-01'],
    ['Mar 1 2025', '2025-03-01'],
    ['1 March 2025', '2025-03-01'],
    ['09/14/2025', '2025-09-14'],
    ['February 28, 2027', '2027-02-28'],
    ['2024-02-29', '2024-02-29'],
    ['  2025-11-13 ', '2025-11-13'],
  ])('%j → %j', (raw, expected) => {
    expect(ok('date', raw)).toBe(expected);
  });

  it.each([
    ['2025-02-30'],
    ['2025-02-29'], // not a leap year
    ['2025-13-01'],
    ['2025-00-10'],
    ['2025-04-31'],
    ['02/30/2025'],
    ['February 30, 2025'],
    ['not a date'],
    [''],
    ['   '],
    ['Net 30'],
  ])('rejects invalid date %j', (raw) => notOk('date', raw));

  describe('is timezone independent', () => {
    const originalTz = process.env.TZ;
    afterAll(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });
    for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      describe(tz, () => {
        beforeAll(() => {
          process.env.TZ = tz;
        });
        it.each([
          ['March 1, 2025', '2025-03-01'],
          ['1 March 2025', '2025-03-01'],
          ['09/14/2025', '2025-09-14'],
          ['2025-10-14', '2025-10-14'],
        ])(`${tz}: %j → %j`, (raw, expected) => {
          expect(ok('date', raw)).toBe(expected);
        });
      });
    }
  });
});

describe('normalizeValue — number', () => {
  it.each([
    ['24', 24],
    ['twenty-four (24)', 24],
    ['twenty-four', 24],
    ['24 months', 24],
    ['1,200', 1200],
    [' 24 ', 24],
  ])('%j → %d', (raw, expected) => {
    expect(ok('number', raw)).toBe(expected);
  });

  it.each([[''], ['   '], ['many'], ['N/A'], ['months']])('rejects %j', (raw) => notOk('number', raw));
});

describe('normalizeValue — percent (4.2, not 0.042)', () => {
  it.each([
    ['4.2%', 4.2],
    ['4.2 %', 4.2],
    ['4.2 percent', 4.2],
    ['3.8%', 3.8],
    ['0.5%', 0.5],
  ])('%j → %d', (raw, expected) => {
    expect(ok('percent', raw)).toBe(expected);
  });

  it.each([[''], ['   '], ['high'], ['%'], ['percent']])('rejects %j', (raw) => notOk('percent', raw));
});

describe('normalizeValue — string', () => {
  it.each([
    ['INV-2025-0847', 'INV-2025-0847'],
    ['  Dana Okafor  ', 'Dana Okafor'],
    ['MERIDIAN   OFFICE\nSUPPLIES\tLLC', 'MERIDIAN OFFICE SUPPLIES LLC'],
    ['Q3 2025', 'Q3 2025'],
    ['Eastport-Harborview Submarket', 'Eastport-Harborview Submarket'],
  ])('%j → %j', (raw, expected) => {
    expect(ok('string', raw)).toBe(expected);
  });
});

describe('normalizeValue — never throws', () => {
  const nasty = [
    '',
    ' ',
    '\u0000',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e309',
    '-',
    '--5',
    '-$50.00',
    '($50.00)',
    '$5,230.29 USD',
    '1.2.3',
    '$$$',
    '%%%',
    '9'.repeat(400),
    'null',
    'undefined',
    '{"amount":1}',
    '\u{1F4B0} 100',
    '0000-00-00',
    '99/99/9999',
    '2025-10-14T00:00:00Z',
    'twenty-four (25)',
  ];
  const types: FieldType[] = ['string', 'date', 'money', 'number', 'percent'];

  for (const type of types) {
    const cases = nasty.map((raw) => [JSON.stringify(raw).slice(0, 40), raw] as const);
    it.each(cases)(`${type}: %s returns a well-formed result`, (_label, raw) => {
      let r: NormalizeResult | undefined;
      expect(() => {
        r = normalizeValue(type, raw);
      }).not.toThrow();
      expect(r).toBeDefined();
      expect(typeof r!.ok).toBe('boolean');
      if (!r!.ok) {
        expect(typeof r!.reason).toBe('string');
        return;
      }
      // If it IS accepted, the canonical value must still be well-formed for its type.
      const v = r!.value;
      switch (type) {
        case 'money': {
          const m = v as { amount: number; currency: string };
          expect(Number.isFinite(m.amount), `money amount must be finite for ${JSON.stringify(raw)}`).toBe(true);
          expect(m.currency).toBe('USD');
          break;
        }
        case 'number':
        case 'percent':
          expect(typeof v).toBe('number');
          expect(Number.isFinite(v as number), `${type} must be finite for ${JSON.stringify(raw)}`).toBe(true);
          break;
        case 'date': {
          expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          // and it must be a real calendar date
          const d = new Date(`${v as string}T00:00:00Z`);
          expect(d.toISOString().slice(0, 10)).toBe(v);
          break;
        }
        case 'string':
          expect(typeof v).toBe('string');
          break;
      }
    });
  }
});
