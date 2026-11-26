import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPECTED_FIELDS, isDocType } from '../src/index.js';

describe('EXPECTED_FIELDS', () => {
  it('mirrors fixtures/expected-fields.json exactly', () => {
    const json = JSON.parse(readFileSync(new URL('../../../fixtures/expected-fields.json', import.meta.url), 'utf8'));
    expect(EXPECTED_FIELDS).toEqual(json);
  });
  it('isDocType', () => {
    expect(isDocType('lease')).toBe(true);
    expect(isDocType('receipt')).toBe(false);
  });
});
