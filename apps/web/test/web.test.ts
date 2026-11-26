import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/App.js';
import type { Value } from '../src/api.js';
import { attentionOf, fieldLabel, formatValue, sortForReview } from '../src/format.js';
import { segment } from '../src/highlight.js';

const val = (over: Partial<Value>): Value => ({
  id: 'x', field: 'f', type: 'string', value: 'A', rawValue: 'A', evidence: null, gap: null, reviewState: 'pending',
  review: null, effectiveValue: 'A', previous: null, changed: false, ...over,
});

describe('segment', () => {
  it('splits text around spans, including overlaps', () => {
    const segs = segment('abcdefghij', [{ id: 'a', start: 2, end: 5 }, { id: 'b', start: 4, end: 7 }]);
    expect(segs.map((s) => [s.text, s.ids])).toEqual([
      ['ab', []], ['cd', ['a']], ['e', ['a', 'b']], ['fg', ['b']], ['hij', []],
    ]);
  });
  it('ignores out-of-range spans', () => {
    expect(segment('abc', [{ id: 'z', start: 2, end: 9 }])).toEqual([{ text: 'abc', start: 0, ids: [] }]);
  });
});

describe('format', () => {
  it('formats canonical values', () => {
    expect(formatValue('money', { amount: 5230.29, currency: 'USD' })).toBe('$5,230.29');
    expect(formatValue('percent', 4.2)).toBe('4.2%');
    expect(formatValue('number', 1200)).toBe('1,200');
    expect(formatValue('date', '2025-10-14')).toBe('2025-10-14');
    expect(formatValue('money', null)).toBe('—');
  });
  it('labels fields', () => {
    expect(fieldLabel('average_rent_1br')).toBe('Average rent 1BR');
  });
  it('orders what needs attention first: changed, gaps, new, then done', () => {
    const vs = [
      val({ id: 'done', reviewState: 'carried_over' }),
      val({ id: 'new' }),
      val({ id: 'gap', value: null }),
      val({ id: 'chg', changed: true }),
    ];
    expect(sortForReview(vs).map((v) => v.id)).toEqual(['chg', 'gap', 'new', 'done']);
    expect(attentionOf(val({ reviewState: 'approved', changed: true }))).toBe('done');
  });
});

describe('parseRoute', () => {
  it('parses list and detail routes', () => {
    expect(parseRoute('')).toEqual({ page: 'list' });
    expect(parseRoute('#/documents/doc-invoice-001')).toEqual({ page: 'detail', id: 'doc-invoice-001', version: undefined });
    expect(parseRoute('#/documents/doc-invoice-001/v/1')).toEqual({ page: 'detail', id: 'doc-invoice-001', version: 1 });
  });
});
