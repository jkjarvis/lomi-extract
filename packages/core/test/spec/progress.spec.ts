import { describe, expect, it } from 'vitest';
import { computeProgress, type PrevValue } from '@lomi/core';

// CONTRACT §2 computeProgress: pending/approved/corrected/carriedOver partition `total` by reviewState;
// gaps = number of values with value === null (a gap is ALSO counted in exactly one review bucket).

type Row = { reviewState: PrevValue['reviewState']; value: unknown | null };
const row = (reviewState: Row['reviewState'], value: unknown | null = 'x'): Row => ({ reviewState, value });

describe('computeProgress', () => {
  it('empty list → all zeros', () => {
    expect(computeProgress([])).toEqual({ total: 0, pending: 0, approved: 0, corrected: 0, carriedOver: 0, gaps: 0 });
  });

  it('freshly extracted invoice: 5 pending, no gaps', () => {
    expect(computeProgress(Array.from({ length: 5 }, () => row('pending')))).toEqual({
      total: 5, pending: 5, approved: 0, corrected: 0, carriedOver: 0, gaps: 0,
    });
  });

  it('freshly extracted market report: 6 pending, 1 gap (median_household_income)', () => {
    const rows = [...Array.from({ length: 5 }, () => row('pending')), row('pending', null)];
    expect(computeProgress(rows)).toEqual({ total: 6, pending: 6, approved: 0, corrected: 0, carriedOver: 0, gaps: 1 });
  });

  it('after invoice v2 re-extraction: 2 pending + 3 carried over', () => {
    const rows = [row('carried_over'), row('carried_over'), row('pending'), row('carried_over'), row('pending')];
    expect(computeProgress(rows)).toEqual({ total: 5, pending: 2, approved: 0, corrected: 0, carriedOver: 3, gaps: 0 });
  });

  it('mixed states; a corrected gap counts in corrected AND gaps', () => {
    const rows = [
      row('pending'),
      row('approved'),
      row('approved'),
      row('corrected'),
      row('corrected', null),
      row('carried_over'),
      row('pending', null),
    ];
    const p = computeProgress(rows);
    expect(p).toEqual({ total: 7, pending: 2, approved: 2, corrected: 2, carriedOver: 1, gaps: 2 });
    expect(p.pending + p.approved + p.corrected + p.carriedOver).toBe(p.total);
  });

  it('treats only null as a gap (falsy values like 0 or "" are values)', () => {
    const rows = [row('approved', 0), row('approved', ''), row('approved', false), row('approved', null)];
    expect(computeProgress(rows).gaps).toBe(1);
  });

});
