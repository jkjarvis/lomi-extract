import { describe, expect, it } from 'vitest';
import { discoverRunLogTable, restartWorker, uploadFixture, waitForStatus, withDb } from './helpers';

// Brief: "Keep the prompt and the raw LLM response stored or logged per extraction so it's debuggable."
// CONTRACT §5: "Prompt and raw response are stored per run (Postgres) and are visible via DB."
// Column names are not part of the contract, so the table is discovered via information_schema.

describe('prompt + raw LLM response are stored per run in Postgres', () => {
  it('a finished extraction has a run row with non-empty prompt and raw response', async () => {
    await restartWorker();
    const doc = await uploadFixture('lease');
    await waitForStatus(doc.id, ['extracted'], 90_000);

    await withDb(async (c) => {
      const t = await discoverRunLogTable(c);
      expect(t, 'no table with a prompt column and a (raw) response column found in the current schema').not.toBeNull();
      const { rows } = await c.query(
        `SELECT "${t!.promptCol}"::text AS prompt, "${t!.responseCol}"::text AS response FROM "${t!.table}"
         WHERE "${t!.promptCol}" IS NOT NULL AND "${t!.responseCol}" IS NOT NULL`,
      );
      expect(rows.length, `${t!.table} has no run with both prompt and response`).toBeGreaterThan(0);
      // The lease prompt must contain the lease text; its response must mention the tenant.
      const hit = rows.find((r) => r.prompt.includes('Dana Okafor') && r.response.includes('Dana Okafor'));
      expect(hit, 'expected a run whose prompt contains the lease text and whose response contains the tenant').toBeDefined();
    });
  });
});
