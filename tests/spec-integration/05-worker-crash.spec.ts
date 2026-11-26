import { afterAll, describe, expect, it } from 'vitest';
import {
  expectCanonicalValues,
  expectOneValuePerField,
  killWorker,
  restartServices,
  restartWorker,
  settleExtracted,
  sleep,
  startWorker,
  uploadFixture,
  waitForStatus,
} from './helpers';

// Brief: "A restart must not lose work. If we docker compose restart (or kill a container) mid-extraction, the system
// comes back and the document either completes or is visibly retryable — never stuck in extracting forever."
// CONTRACT §7.2 (~60 s; lease 30 s + reconcile 10 s + 8 s mock delay).

const RECOVERY_MS = 90_000;

describe('worker crash mid-extraction', () => {
  afterAll(async () => {
    await restartWorker();
  });

  it('docker compose kill worker while extracting, then start it → extracted (or failed→retry→extracted) within 90 s', async () => {
    await restartWorker({ MOCK_LLM_DELAY_MS: '8000' });
    const doc = await uploadFixture('invoiceV1');
    await waitForStatus(doc.id, ['extracting'], 60_000, { intervalMs: 200 });

    await killWorker();
    await sleep(1_000);
    const t0 = Date.now();
    await startWorker();

    const { detail, history, retried } = await settleExtracted(doc.id, RECOVERY_MS);
    expect(Date.now() - t0, `recovery took too long; history ${history.join(' → ')} retried=${retried}`).toBeLessThan(
      RECOVERY_MS + 30_000,
    );
    await expectOneValuePerField(detail);
    expectCanonicalValues(detail, 'invoiceV1');
  });

  it('killing the worker twice in a row still converges', async () => {
    await restartWorker({ MOCK_LLM_DELAY_MS: '8000' });
    const doc = await uploadFixture('lease');
    await waitForStatus(doc.id, ['extracting'], 60_000, { intervalMs: 200 });
    await killWorker();
    await startWorker();
    await sleep(2_000);
    await killWorker();
    await startWorker();
    const { detail } = await settleExtracted(doc.id, 150_000);
    await expectOneValuePerField(detail);
    expectCanonicalValues(detail, 'lease');
  });

  it('docker compose restart worker (graceful) while extracting → extracted (or failed→retry→extracted)', async () => {
    await restartWorker({ MOCK_LLM_DELAY_MS: '8000' });
    const doc = await uploadFixture('marketReport');
    await waitForStatus(doc.id, ['extracting'], 60_000, { intervalMs: 200 });
    await restartServices(['worker']);
    const { detail } = await settleExtracted(doc.id, RECOVERY_MS);
    await expectOneValuePerField(detail);
    expectCanonicalValues(detail, 'marketReport');
  });

  it('docker compose restart api + worker while extracting → completes', async () => {
    await restartWorker({ MOCK_LLM_DELAY_MS: '8000' });
    const doc = await uploadFixture('invoiceV2');
    await waitForStatus(doc.id, ['extracting'], 60_000, { intervalMs: 200 });
    await restartServices(['api', 'worker']);
    const { detail } = await settleExtracted(doc.id, RECOVERY_MS);
    await expectOneValuePerField(detail);
    expectCanonicalValues(detail, 'invoiceV2');
  });
});
