import { describe, expect, it } from 'vitest';
import {
  api,
  describeRes,
  expectCanonicalValues,
  expectEvidenceInvariants,
  expectOneValuePerField,
  expectProgressPartition,
  expectedFields,
  getDetail,
  getProgress,
  manifest,
  waitForStatus,
  type DocumentSummary,
  type FixtureName,
} from './helpers';

// CONTRACT §3 (health, list), §4 (seed), §5 (canonical values). Assumes the seed docs have not been re-versioned by hand.

const SEED: Array<{ id: string; fixture: FixtureName }> = [
  { id: 'doc-invoice-001', fixture: 'invoiceV1' },
  { id: 'doc-lease-001', fixture: 'lease' },
  { id: 'doc-report-001', fixture: 'marketReport' },
];

describe('health', () => {
  it('GET /health → 200 { ok: true }', async () => {
    const r = await api('GET', '/health');
    expect(r.status, describeRes(r)).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
  });

  it('GET /documents → 200 array ordered by createdAt asc', async () => {
    const r = await api<DocumentSummary[]>('GET', '/documents');
    expect(r.status, describeRes(r)).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const times = r.body.map((d) => Date.parse(d.createdAt));
    times.forEach((t) => expect(Number.isNaN(t), 'createdAt must be a parseable date').toBe(false));
    expect(times, 'documents must be ordered by createdAt asc').toEqual([...times].sort((a, b) => a - b));
  });

  it('unknown routes/ids use the error envelope { error: { code, message } }', async () => {
    const r = await api('GET', '/documents/does-not-exist-404');
    expect(r.status).toBe(404);
    expect(typeof r.body?.error?.code, describeRes(r)).toBe('string');
    expect(typeof r.body?.error?.message, describeRes(r)).toBe('string');
  });
});

describe('seed (version 1 of each fixture document)', () => {
  it('the three seed documents exist with ids, types and titles from fixtures/documents.json', async () => {
    const r = await api<DocumentSummary[]>('GET', '/documents');
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.map((d) => [d.id, d]));
    for (const m of manifest()) {
      const d = byId[m.id];
      expect(d, `seed document ${m.id} missing from GET /documents`).toBeDefined();
      expect(d.type).toBe(m.type);
      expect(d.title).toBe(m.title);
      expect(d.currentVersion, `${m.id} must be seeded with version 1 only`).toBe(1);
    }
  });

  for (const { id, fixture } of SEED) {
    it(`${id}: version 1 only, eventually extracted, canonical values, evidence verbatim`, async () => {
      const { detail } = await waitForStatus(id, ['extracted', 'failed'], 120_000);
      expect(detail.status, `${id} should extract (error=${detail.error})`).toBe('extracted');
      expect(detail.error).toBeNull();
      expect(detail.version).toBe(1);
      expect(detail.currentVersion).toBe(1);
      expect(detail.versions.map((v) => v.version), 'only version 1 is seeded').toEqual([1]);
      expect(detail.versions[0].status).toBe('extracted');

      await expectOneValuePerField(detail);
      expectCanonicalValues(detail, fixture);
      expectEvidenceInvariants(detail);

      // types echo the expected-fields spec
      const spec = Object.fromEntries(expectedFields()[detail.type as 'invoice'].map((s) => [s.field, s.type]));
      for (const v of detail.values) expect(v.type, v.field).toBe(spec[v.field]);

      // ?version=1 is the same view
      const v1 = await getDetail(id, 1);
      expect(v1.version).toBe(1);
      expect(v1.values.map((v) => v.id).sort()).toEqual(detail.values.map((v) => v.id).sort());

      const p = await getProgress(id);
      expect(p.total).toBe(detail.values.length);
      expectProgressPartition(p);
      expect(p.gaps).toBe(detail.values.filter((v) => v.value === null).length);
    });
  }

  it('doc-report-001: median_household_income is a gap with a reason (not in the document)', async () => {
    const { detail } = await waitForStatus('doc-report-001', ['extracted'], 120_000);
    const v = detail.values.find((x) => x.field === 'median_household_income');
    expect(v, 'median_household_income must be present as a value row').toBeDefined();
    expect(v!.value).toBeNull();
    expect(v!.gap).not.toBeNull();
    expect(v!.gap!.reason.length).toBeGreaterThan(0);
    expect(v!.evidence).toBeNull();
    const p = await getProgress('doc-report-001');
    expect(p.total).toBe(6);
    expect(p.gaps).toBe(1);
  });

  it('GET ?version=N for a version that does not exist → 404', async () => {
    const r = await api('GET', '/documents/doc-invoice-001?version=99');
    expect(r.status, describeRes(r)).toBe(404);
  });
});
