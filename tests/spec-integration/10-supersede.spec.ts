import { afterAll, describe, expect, it } from 'vitest';
import {
  api,
  byField,
  describeRes,
  expectCanonicalValues,
  expectOneValuePerField,
  getDetail,
  restartWorker,
  sleep,
  uploadFixture,
  uploadVersion,
  waitForStatus,
} from './helpers';

// Brief: "A new version can arrive while the previous one is still extracting." CONTRACT §3 (/versions: the previous
// queued/extracting run becomes `superseded`), §7.8; `superseded` never shows as a document status.

const sortVersions = <T extends { version: number }>(vs: T[]) => [...vs].sort((a, b) => a.version - b.version);

describe('new version while the previous one is still extracting', () => {
  afterAll(async () => {
    await restartWorker();
  });

  for (const when of ['queued', 'extracting'] as const) {
    it(`v2 uploaded while v1 is ${when} → v1 run superseded, v2 extracted, v1 still queryable`, async () => {
      await restartWorker({ MOCK_LLM_DELAY_MS: '8000' });
      const doc = await uploadFixture('invoiceV1');
      if (when === 'extracting') await waitForStatus(doc.id, ['extracting'], 60_000, { intervalMs: 200 });

      const up = await uploadVersion(doc.id, 'invoiceV2');
      expect(up.currentVersion).toBe(2);
      expect(up.status).toBe('queued');

      const history: string[] = [];
      const { detail } = await waitForStatus(doc.id, ['extracted', 'failed'], 120_000, { intervalMs: 250, history });
      expect(detail.status, `error=${detail.error} history=${history.join(' → ')}`).toBe('extracted');
      expect(history, 'superseded is never a document status').not.toContain('superseded');
      expect(detail.currentVersion).toBe(2);
      expect(detail.version).toBe(2);
      const versions = sortVersions(detail.versions);
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      expect(versions[0].status, 'v1 run must be superseded').toBe('superseded');
      expect(versions[1].status).toBe('extracted');

      await expectOneValuePerField(detail);
      expectCanonicalValues(detail, 'invoiceV2');
      expect(byField(detail.values).due_date.value).toBe('2025-11-13');

      // Give a late v1 run time to (wrongly) commit, then check nothing changed.
      await sleep(10_000);
      const later = await getDetail(doc.id);
      expect(later.status).toBe('extracted');
      expect(later.currentVersion).toBe(2);
      expect(sortVersions(later.versions)[0].status, 'a superseded run must stay superseded').toBe('superseded');
      expect(later.values.map((v) => v.id).sort()).toEqual(detail.values.map((v) => v.id).sort());
      await expectOneValuePerField(later);

      // v1 is still queryable.
      const r = await api('GET', `/documents/${doc.id}?version=1`);
      expect(r.status, describeRes(r)).toBe(200);
      expect(r.body.version).toBe(1);
      expect(r.body.status, 'document status is the current version’s').not.toBe('superseded');

      // list view never shows superseded
      const list = await api('GET', '/documents');
      expect(list.body.find((d: any) => d.id === doc.id).status).not.toBe('superseded');
    });
  }
});
