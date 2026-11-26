/**
 * Chaos tests restart/kill the worker and flush Redis. Opt-in: CHAOS=1 pnpm test:integration
 * They restore the worker to default settings at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, compose, fixture, pdfForm, sleep, waitForApi, waitForStatus } from './helpers.js';

const enabled = process.env.CHAOS === '1';

describe.skipIf(!enabled)('chaos', () => {
  beforeAll(() => waitForApi());
  afterAll(() => {
    compose('up -d worker', { MOCK_LLM_DELAY_MS: '0', MOCK_LLM_FAIL: 'never', MOCK_LLM_HALLUCINATE: '' });
  });

  it('worker killed mid-extraction → document still completes', async () => {
    compose('up -d worker', { MOCK_LLM_DELAY_MS: '8000' });
    await sleep(3000);
    const up = await api('POST', '/documents', pdfForm(fixture('lease-excerpt-001.pdf'), { type: 'lease' }));
    await waitForStatus(up.body.id, ['extracting'], 20_000);
    compose('kill worker');
    compose('up -d worker', { MOCK_LLM_DELAY_MS: '8000' });
    const done = await waitForStatus(up.body.id, ['extracted', 'failed'], 90_000);
    expect(done.status).toBe('extracted');
    expect(done.values).toHaveLength(5);
  });

  it('FLUSHALL + restart loses nothing; queued work still completes', async () => {
    compose('up -d worker', { MOCK_LLM_DELAY_MS: '4000' });
    await sleep(3000);
    const before = (await api('GET', '/documents/doc-invoice-001')).body;
    const up = await api('POST', '/documents', pdfForm(fixture('invoice-001.pdf'), { type: 'invoice' }));
    compose('exec -T redis redis-cli FLUSHALL');
    compose('restart worker');
    const done = await waitForStatus(up.body.id, ['extracted'], 90_000);
    expect(done.values).toHaveLength(5);
    const after = (await api('GET', '/documents/doc-invoice-001')).body;
    expect(after.values.map((v: any) => [v.id, v.reviewState])).toEqual(before.values.map((v: any) => [v.id, v.reviewState]));
  });

  it('LLM failure → failed with error → retry → extracted', async () => {
    compose('up -d worker', { MOCK_LLM_FAIL: 'always' });
    await sleep(3000);
    const up = await api('POST', '/documents', pdfForm(fixture('invoice-001.pdf'), { type: 'invoice' }));
    const failed = await waitForStatus(up.body.id, ['failed'], 30_000);
    expect(failed.error).toMatch(/Mock LLM failure/);
    compose('up -d worker', { MOCK_LLM_FAIL: 'never' });
    await sleep(3000);
    expect((await api('POST', `/documents/${up.body.id}/retry`)).status).toBe(202);
    const done = await waitForStatus(up.body.id, ['extracted'], 30_000);
    expect(done.values).toHaveLength(5);
    expect((await api('POST', `/documents/${up.body.id}/retry`)).status).toBe(409);
  });

  it('hallucinated evidence becomes a gap', async () => {
    compose('up -d worker', { MOCK_LLM_HALLUCINATE: 'total_amount' });
    await sleep(3000);
    const up = await api('POST', '/documents', pdfForm(fixture('invoice-001.pdf'), { type: 'invoice' }));
    const done = await waitForStatus(up.body.id, ['extracted'], 30_000);
    const total = done.values.find((v: any) => v.field === 'total_amount');
    expect(total.value).toBeNull();
    expect(total.gap.reason).toBe('evidence_not_in_text');
  });

  it('extraction is queued through Redis (BullMQ), and the job carries nothing but the run id', async () => {
    compose('stop worker');
    const up = await api('POST', '/documents', pdfForm(fixture('invoice-001.pdf'), { type: 'invoice' }));
    expect(up.status).toBe(202);
    let keys: string[] = [];
    for (let i = 0; i < 20 && keys.length === 0; i++) {
      keys = compose(`exec -T redis redis-cli --scan --pattern 'bull:extraction:run-*-a1'`).split('\n').filter(Boolean);
      if (keys.length === 0) await sleep(250);
    }
    expect(keys.length).toBeGreaterThanOrEqual(1);
    const data = keys.map((k) => JSON.parse(compose(`exec -T redis redis-cli HGET ${k} data`)) as Record<string, unknown>);
    for (const d of data) expect(Object.keys(d)).toEqual(['runId']);
    compose('up -d worker', { MOCK_LLM_DELAY_MS: '0', MOCK_LLM_FAIL: 'never', MOCK_LLM_HALLUCINATE: '' });
    const done = await waitForStatus(up.body.id, ['extracted'], 60_000);
    expect(done.values).toHaveLength(5);
  });

  it('new version while the previous is extracting → previous superseded', async () => {
    compose('up -d worker', { MOCK_LLM_DELAY_MS: '5000' });
    await sleep(3000);
    const up = await api('POST', '/documents', pdfForm(fixture('invoice-001.pdf'), { type: 'invoice' }));
    await waitForStatus(up.body.id, ['extracting'], 20_000);
    await api('POST', `/documents/${up.body.id}/versions`, pdfForm(fixture('invoice-001.v2.pdf')));
    const done = await waitForStatus(up.body.id, ['extracted'], 60_000);
    expect(done.currentVersion).toBe(2);
    expect(done.versions.find((v: any) => v.version === 1).status).toBe('superseded');
    expect((await api('GET', `/documents/${up.body.id}?version=1`)).status).toBe(200);
  });
});
