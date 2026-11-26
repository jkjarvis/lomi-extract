import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXTRACTION_QUEUE, jobIdFor } from '../src/runs.js';

describe('run coordination helpers', () => {
  it('job ids are unique per (run, attempt) and contain no ":" (BullMQ restriction)', () => {
    expect(jobIdFor('abc', 1)).toBe('run-abc-a1');
    expect(jobIdFor('abc', 2)).not.toBe(jobIdFor('abc', 1));
    expect(jobIdFor('abc', 1)).not.toContain(':');
    expect(EXTRACTION_QUEUE).toBe('extraction');
  });

  it('the migration enforces one value per (version, field) and one active run per version', () => {
    const sql = readFileSync(new URL('../prisma/migrations/20261126000000_init/migration.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/UNIQUE INDEX "extracted_values_version_id_field_key"/);
    expect(sql).toMatch(/extraction_runs_one_active_per_version[\s\S]*WHERE "status" IN \('queued', 'extracting'\)/);
  });
});
