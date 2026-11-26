import { beforeAll, describe, expect, it } from 'vitest';
import { api, fixture, pdfForm, waitForApi, waitForStatus } from './helpers.js';

beforeAll(() => waitForApi());

describe('seeded fixtures (mock LLM)', () => {
  it('extract the expected canonical values, with the median income gap', async () => {
    const inv = await waitForStatus('doc-invoice-001', ['extracted']);
    const report = await waitForStatus('doc-report-001', ['extracted']);
    const lease = await waitForStatus('doc-lease-001', ['extracted']);
    const v1 = (await api('GET', '/documents/doc-invoice-001?version=1')).body;
    const by = (d: any) => Object.fromEntries(d.values.map((v: any) => [v.field, v]));
    expect(by(v1).total_amount.value).toEqual({ amount: 5230.29, currency: 'USD' });
    expect(by(v1).due_date.value).toBe('2025-10-14');
    expect(inv.versions[0].version).toBe(1);
    expect(by(lease).term_months.value).toBe(24);
    expect(by(lease).tenant_name.value).toBe('Dana Okafor');
    expect(by(report).vacancy_rate.value).toBe(4.2);
    expect(by(report).median_household_income.value).toBeNull();
    expect(by(report).median_household_income.gap.reason).toBe('not_found');
  });
});

describe('upload → review → new version', () => {
  it('returns 202 immediately, extracts, and carries over unchanged reviews', async () => {
    const t0 = Date.now();
    const up = await api('POST', '/documents', pdfForm(fixture('invoice-001.pdf'), { type: 'invoice', title: 'IT invoice' }));
    expect(up.status).toBe(202);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(up.body.status).toBe('queued');
    const id = up.body.id as string;

    const v1 = await waitForStatus(id, ['extracted']);
    expect(v1.values).toHaveLength(5);
    for (const v of v1.values) {
      const r = await api('POST', `/values/${v.id}/review`, { action: 'approve' });
      expect(r.status).toBe(200);
      expect(r.body.reviewState).toBe('approved');
    }

    const nv = await api('POST', `/documents/${id}/versions`, pdfForm(fixture('invoice-001.v2.pdf')));
    expect(nv.status).toBe(202);
    expect(nv.body.currentVersion).toBe(2);
    await waitForStatus(id, ['extracted']);

    const progress = (await api('GET', `/documents/${id}/progress`)).body;
    expect(progress).toMatchObject({ total: 5, pending: 2, carriedOver: 3, approved: 0 });

    const v2 = (await api('GET', `/documents/${id}`)).body;
    const changed = v2.values.filter((v: any) => v.changed).map((v: any) => v.field).sort();
    expect(changed).toEqual(['due_date', 'total_amount']);
    for (const v of v2.values.filter((x: any) => x.changed)) {
      expect(v.reviewState).toBe('pending');
      expect(v.previous).toMatchObject({ version: 1, reviewState: 'approved' });
    }

    const old = (await api('GET', `/documents/${id}?version=1`)).body;
    expect(old.values.every((v: any) => v.reviewState === 'approved')).toBe(true);
    const stale = await api('POST', `/values/${old.values[0].id}/review`, { action: 'approve' });
    expect(stale.status).toBe(409);
  });

  it('rejects bad uploads', async () => {
    expect((await api('POST', '/documents', pdfForm(Buffer.from('not a pdf'), { type: 'invoice' }))).status).toBe(400);
    expect((await api('POST', '/documents', pdfForm(fixture('invoice-001.pdf'), { type: 'nope' }))).status).toBe(400);
    expect((await api('POST', '/documents/does-not-exist/versions', pdfForm(fixture('invoice-001.pdf')))).status).toBe(404);
  });
});
