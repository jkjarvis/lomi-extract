import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_FIELDS } from '@lomi/core';
import { SPEC, findFixturesDir } from './helpers';

describe('EXPECTED_FIELDS', () => {
  it('deep-equals fixtures/expected-fields.json (same types, same fields, same order)', () => {
    const json = JSON.parse(readFileSync(join(findFixturesDir(), 'expected-fields.json'), 'utf8'));
    expect(EXPECTED_FIELDS).toEqual(json);
  });

  it('matches the literal field list used by these tests', () => {
    expect(EXPECTED_FIELDS).toEqual(SPEC);
  });

  it('has exactly the three document types', () => {
    expect(Object.keys(EXPECTED_FIELDS).sort()).toEqual(['invoice', 'lease', 'market_report']);
  });
});
