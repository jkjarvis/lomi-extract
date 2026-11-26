import { describe, expect, it } from 'vitest';
import type { DocumentRow, ValueRow } from '../src/dto.js';
import { effectiveValue, toDetail, toSummary, toValueDTO } from '../src/dto.js';

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

const baseValue = (over: Partial<ValueRow> = {}): ValueRow => ({
  id: 'v1',
  field: 'total_amount',
  type: 'money',
  value: { amount: 5230.29, currency: 'USD' },
  rawValue: '$5,230.29',
  evidenceQuote: 'Total Due: $5,230.29',
  evidenceStart: 10,
  evidenceEnd: 30,
  gapReason: null,
  gapDetail: null,
  reviewState: 'pending',
  changed: false,
  reviews: [],
  previousValue: null,
  ...over,
});

describe('toValueDTO', () => {
  it('maps a pending value', () => {
    const dto = toValueDTO(baseValue());
    expect(dto).toMatchObject({
      id: 'v1',
      evidence: { quote: 'Total Due: $5,230.29', start: 10, end: 30 },
      gap: null,
      review: null,
      effectiveValue: { amount: 5230.29, currency: 'USD' },
      previous: null,
      changed: false,
    });
  });

  it('a correction lives beside the value: value unchanged, effectiveValue is the normalised correction', () => {
    const dto = toValueDTO(baseValue({ reviewState: 'corrected', reviews: [{ action: 'correct', value: '$5,300.00', note: 'typo', createdAt: t(5) }] }));
    expect(dto.value).toEqual({ amount: 5230.29, currency: 'USD' });
    expect(dto.effectiveValue).toEqual({ amount: 5300, currency: 'USD' });
    expect(dto.review).toEqual({ action: 'correct', value: '$5,300.00', note: 'typo', createdAt: t(5).toISOString() });
  });

  it('unparseable corrections fall back to the raw string', () => {
    expect(effectiveValue('date', '2025-01-01', { action: 'correct', value: 'see contract', note: null, createdAt: t(1) })).toBe('see contract');
  });

  it('gaps expose reason/detail and a null value', () => {
    const dto = toValueDTO(baseValue({ value: null, evidenceQuote: null, evidenceStart: null, evidenceEnd: null, gapReason: 'not_found', gapDetail: 'absent' }));
    expect(dto.value).toBeNull();
    expect(dto.evidence).toBeNull();
    expect(dto.gap).toEqual({ reason: 'not_found', detail: 'absent' });
    expect(dto.effectiveValue).toBeNull();
  });

  it('includes the previous version value and review', () => {
    const prev = { ...baseValue({ id: 'p', reviewState: 'approved', reviews: [{ action: 'approve' as const, value: null, note: null, createdAt: t(2) }] }), version: { versionNo: 1 } };
    const dto = toValueDTO(baseValue({ changed: true, previousValue: prev }));
    expect(dto.previous).toEqual({
      version: 1,
      value: { amount: 5230.29, currency: 'USD' },
      evidenceQuote: 'Total Due: $5,230.29',
      reviewState: 'approved',
      review: { action: 'approve', value: null, note: null, createdAt: t(2).toISOString() },
    });
    expect(dto.changed).toBe(true);
  });
});

describe('toSummary / toDetail', () => {
  const doc: DocumentRow = {
    id: 'doc-1',
    type: 'invoice',
    title: 'Inv',
    currentVersion: 2,
    createdAt: t(0),
    updatedAt: t(9),
    versions: [
      { versionNo: 1, createdAt: t(0), runs: [{ status: 'superseded', error: 'x', attempt: 1, createdAt: t(0) }], values: [] },
      {
        versionNo: 2,
        createdAt: t(3),
        runs: [
          { status: 'failed', error: 'boom', attempt: 1, createdAt: t(3) },
          { status: 'extracted', error: null, attempt: 2, createdAt: t(4) },
        ],
        values: [
          { reviewState: 'pending', value: 1 },
          { reviewState: 'carried_over', value: null },
        ],
      },
    ],
  };

  it('status comes from the latest run of the current version; error only when failed', () => {
    const s = toSummary(doc);
    expect(s.status).toBe('extracted');
    expect(s.error).toBeNull();
    expect(s.progress).toEqual({ total: 2, pending: 1, approved: 0, corrected: 0, carriedOver: 1, gaps: 1 });
  });

  it('failed status carries the error', () => {
    const failed = { ...doc, versions: [doc.versions[0]!, { ...doc.versions[1]!, runs: [doc.versions[1]!.runs[0]!] }] };
    expect(toSummary(failed)).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('detail lists versions with their own status and orders values by the field spec', () => {
    const d = toDetail(doc, { ...doc.versions[1]!, parsedText: 'TEXT' }, [
      baseValue({ id: 'b', field: 'total_amount' }),
      baseValue({ id: 'a', field: 'invoice_number', type: 'string', value: 'X' }),
    ]);
    expect(d.versions).toEqual([
      { version: 1, status: 'superseded', createdAt: t(0).toISOString() },
      { version: 2, status: 'extracted', createdAt: t(3).toISOString() },
    ]);
    expect(d.values.map((v) => v.field)).toEqual(['invoice_number', 'total_amount']);
    expect(d.version).toBe(2);
    expect(d.text).toBe('TEXT');
  });
});
