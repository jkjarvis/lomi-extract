import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FieldSpec, LlmField, ValidatedValue } from '@lomi/core';
import type { FixtureName } from './fixture-texts';

/**
 * Walk up from this file looking for the fixtures folder. Works both from
 * `spec-tests/core` (finds `take-home-assignment/fixtures`) and from
 * `lomi-extract/packages/core/test/spec` (finds `lomi-extract/fixtures`).
 * `FIXTURES_DIR` overrides.
 */
export function findFixturesDir(): string {
  if (process.env.FIXTURES_DIR) return resolve(process.env.FIXTURES_DIR);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    for (const candidate of [join(dir, 'fixtures'), join(dir, 'take-home-assignment', 'fixtures')]) {
      if (existsSync(join(candidate, 'expected-fields.json'))) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate fixtures/expected-fields.json — set FIXTURES_DIR');
}

/** Field specs written out literally (independent of EXPECTED_FIELDS, which is tested separately). */
export const SPEC: Record<'invoice' | 'lease' | 'market_report', FieldSpec[]> = {
  invoice: [
    { field: 'invoice_number', type: 'string' },
    { field: 'issue_date', type: 'date' },
    { field: 'due_date', type: 'date' },
    { field: 'vendor_name', type: 'string' },
    { field: 'total_amount', type: 'money' },
  ],
  lease: [
    { field: 'tenant_name', type: 'string' },
    { field: 'monthly_rent', type: 'money' },
    { field: 'security_deposit', type: 'money' },
    { field: 'lease_start', type: 'date' },
    { field: 'term_months', type: 'number' },
  ],
  market_report: [
    { field: 'report_quarter', type: 'string' },
    { field: 'market_area', type: 'string' },
    { field: 'vacancy_rate', type: 'percent' },
    { field: 'average_rent_1br', type: 'money' },
    { field: 'year_over_year_rent_growth', type: 'percent' },
    { field: 'median_household_income', type: 'money' },
  ],
};

export const FIXTURE_TYPE: Record<FixtureName, keyof typeof SPEC> = {
  invoiceV1: 'invoice',
  invoiceV2: 'invoice',
  lease: 'lease',
  marketReport: 'market_report',
};

const f = (field: string, value: string | null, evidence: string | null, reason?: string): LlmField =>
  reason === undefined ? { field, value, evidence } : { field, value, evidence, reason };

/** What a GOOD LLM would answer for each fixture (label-anchored quotes, normalised spacing like an LLM would emit). */
export const GOOD_ANSWERS: Record<FixtureName, LlmField[]> = {
  invoiceV1: [
    f('invoice_number', 'INV-2025-0847', 'Invoice Number: INV-2025-0847'),
    f('issue_date', '2025-09-14', 'Issue Date: 2025-09-14'),
    f('due_date', '2025-10-14', 'Due Date: 2025-10-14'),
    f('vendor_name', 'MERIDIAN OFFICE SUPPLIES LLC', 'MERIDIAN OFFICE SUPPLIES LLC'),
    // NB: single space in the quote, the PDF has a run of spaces → exercises whitespace normalisation.
    f('total_amount', '$5,230.29', 'Total Due: $5,230.29'),
  ],
  invoiceV2: [
    f('invoice_number', 'INV-2025-0847', 'Invoice Number: INV-2025-0847'),
    f('issue_date', '2025-09-14', 'Issue Date: 2025-09-14'),
    f('due_date', '2025-11-13', 'Due Date: 2025-11-13'),
    f('vendor_name', 'MERIDIAN OFFICE SUPPLIES LLC', 'MERIDIAN OFFICE SUPPLIES LLC'),
    f('total_amount', '$6,126.45', 'Total Due: $6,126.45'),
  ],
  lease: [
    // Quote with straight parens/quotes; the text may hold escaped parens.
    f('tenant_name', 'Dana Okafor', 'Dana Okafor ("Tenant")'),
    f('monthly_rent', '$2,350.00', 'monthly rent of $2,350.00'),
    // spans a PDF line break ("Tenant shall\ndeposit with ...")
    f('security_deposit', '$3,525.00', 'Tenant shall deposit with Landlord the sum of $3,525.00'),
    f('lease_start', 'March 1, 2025', 'commencing on March 1, 2025'),
    // spans a PDF line break AND escaped parens
    f('term_months', '24', 'twenty-four (24) months'),
  ],
  marketReport: [
    f('report_quarter', 'Q3 2025', 'Reporting Period: Q3 2025'),
    f('market_area', 'Eastport-Harborview Submarket', 'Market Area: Eastport-Harborview Submarket'),
    f('vacancy_rate', '4.2%', 'The overall vacancy rate declined to 4.2%'),
    f('average_rent_1br', '$1,985 per month', 'Average asking rent for a one-bedroom unit reached $1,985 per month'),
    f('year_over_year_rent_growth', '3.8%', 'a year-over-year increase of 3.8%'),
    f('median_household_income', null, null, 'The document does not state a median household income.'),
  ],
};

/** Canonical values from CONTRACT §5 (null = gap). */
export const CANONICAL: Record<FixtureName, Record<string, unknown>> = {
  invoiceV1: {
    invoice_number: 'INV-2025-0847',
    issue_date: '2025-09-14',
    due_date: '2025-10-14',
    vendor_name: 'MERIDIAN OFFICE SUPPLIES LLC',
    total_amount: { amount: 5230.29, currency: 'USD' },
  },
  invoiceV2: {
    invoice_number: 'INV-2025-0847',
    issue_date: '2025-09-14',
    due_date: '2025-11-13',
    vendor_name: 'MERIDIAN OFFICE SUPPLIES LLC',
    total_amount: { amount: 6126.45, currency: 'USD' },
  },
  lease: {
    tenant_name: 'Dana Okafor',
    monthly_rent: { amount: 2350, currency: 'USD' },
    security_deposit: { amount: 3525, currency: 'USD' },
    lease_start: '2025-03-01',
    term_months: 24,
  },
  marketReport: {
    report_quarter: 'Q3 2025',
    market_area: 'Eastport-Harborview Submarket',
    vacancy_rate: 4.2,
    average_rent_1br: { amount: 1985, currency: 'USD' },
    year_over_year_rent_growth: 3.8,
    median_household_income: null,
  },
};

/** Fields compared case-insensitively (contract: vendor_name "case-insensitive match ok"). */
export const CASE_INSENSITIVE_FIELDS = new Set(['vendor_name']);

export function byField(values: ValidatedValue[]): Record<string, ValidatedValue> {
  const out: Record<string, ValidatedValue> = {};
  for (const v of values) out[v.field] = v;
  return out;
}

/** Replace (or drop with `null`) the answer for one field. */
export function withField(answers: LlmField[], field: string, patch: Partial<LlmField> | null): LlmField[] {
  if (patch === null) return answers.filter((a) => a.field !== field);
  return answers.map((a) => (a.field === field ? { ...a, ...patch } : a));
}
