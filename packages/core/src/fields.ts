export type FieldType = 'string' | 'date' | 'money' | 'number' | 'percent';

export interface FieldSpec {
  field: string;
  type: FieldType;
}

export type DocType = 'invoice' | 'lease' | 'market_report';

export const DOC_TYPES: readonly DocType[] = ['invoice', 'lease', 'market_report'];

export function isDocType(value: unknown): value is DocType {
  return typeof value === 'string' && (DOC_TYPES as readonly string[]).includes(value);
}

/** Mirrors fixtures/expected-fields.json (asserted by a unit test). */
export const EXPECTED_FIELDS: Record<DocType, FieldSpec[]> = {
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
