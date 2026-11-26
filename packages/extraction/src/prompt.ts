import type { DocType, FieldSpec } from '@lomi/core';

/** Short semantic hints per field. They steer the model away from the obvious distractors in real documents. */
export const FIELD_HINTS: Record<string, string> = {
  invoice_number: 'The invoice identifier exactly as printed.',
  issue_date: 'The date the invoice was issued.',
  due_date: 'The date payment is due.',
  vendor_name: 'The company issuing the invoice (the seller), not the bill-to customer.',
  total_amount: 'The final total due including tax. Not the subtotal, not a line item, not the tax.',
  tenant_name: 'The tenant (not the landlord).',
  monthly_rent: 'The recurring monthly rent amount. Not a late fee or deposit.',
  security_deposit: 'The security deposit amount.',
  lease_start: 'The date the lease term begins (commencement date).',
  term_months: 'The length of the initial lease term, in months.',
  report_quarter: 'The reporting period, e.g. "Q3 2025".',
  market_area: 'The geographic market or submarket the report covers.',
  vacancy_rate: 'The current overall vacancy rate for the reporting period. Not a prior-period or forecast figure.',
  average_rent_1br: 'Average rent for a one-bedroom unit. Not two-bedroom or overall average.',
  year_over_year_rent_growth: 'Year-over-year rent growth for the reporting period. Not a forecast.',
  median_household_income: 'Median household income for the market area.',
};

const TYPE_HINTS: Record<FieldSpec['type'], string> = {
  string: 'text',
  date: 'a date',
  money: 'a money amount',
  number: 'a number',
  percent: 'a percentage',
};

export const SYSTEM_PROMPT = `You extract structured values from business documents for a human review queue.
Every value you return will be checked by a program against the document text, then by a reviewer.

Rules:
- For each requested field return: "value" exactly as written in the document, "evidence" = a VERBATIM quote copied
  character-for-character from the document that contains both the field's label (e.g. "Total Due:") and the value,
  and "reason" = null.
- Keep quotes short: the label and the value, usually one line or one sentence fragment. Never paraphrase, never fix
  typos, never join text from different places.
- If the document does not state the field, return value null, evidence null, and a short "reason" saying what you
  looked for. Never guess, infer, compute, or use outside knowledge. A missing value is better than a wrong one.
- Beware of look-alike values (subtotals vs totals, prior-period vs current figures, other parties, other unit types).
- Return every requested field exactly once.`;

export function buildUserPrompt(docType: DocType, fields: FieldSpec[], text: string): string {
  const list = fields
    .map((f) => `- ${f.field} (${TYPE_HINTS[f.type]}): ${FIELD_HINTS[f.field] ?? ''}`.trimEnd())
    .join('\n');
  return `Document type: ${docType}

Fields to extract:
${list}

Document text (between the markers):
<<<DOCUMENT
${text}
DOCUMENT>>>`;
}

/** The full prompt as stored per run (system + user), for debugging. */
export function renderPrompt(docType: DocType, fields: FieldSpec[], text: string): string {
  return `[system]\n${SYSTEM_PROMPT}\n\n[user]\n${buildUserPrompt(docType, fields, text)}`;
}

const NULLABLE_STRING = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;

/** JSON schema for the structured response. */
export function responseSchema(fields: FieldSpec[]) {
  return {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: fields.map((f) => f.field) },
            // anyOf (not a type array) is the nullable form both Anthropic and OpenAI structured outputs document.
            value: NULLABLE_STRING,
            evidence: NULLABLE_STRING,
            reason: NULLABLE_STRING,
          },
          required: ['field', 'value', 'evidence', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields'],
    additionalProperties: false,
  } as const;
}
