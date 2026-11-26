import type { FieldType, Value } from './api.js';
import { ApiError } from './api.js';

export const DOC_TYPES = [
  { value: 'invoice', label: 'Invoice' },
  { value: 'lease', label: 'Lease' },
  { value: 'market_report', label: 'Market report' },
] as const;

/** The one human label for a document type, used by the list and the detail header alike. */
export function typeLabel(type: string): string {
  return DOC_TYPES.find((t) => t.value === type)?.label ?? fieldLabel(type);
}

const FRIENDLY_ERRORS: Record<string, string> = {
  not_pdf: "That file isn't a PDF.",
  file_required: 'Choose a PDF file first.',
  file_too_large: 'That file is larger than 10 MB.',
};

/** What to tell a person about a failed request: plain wording for the errors a user can cause, else the API message. */
export function friendlyError(err: unknown): string {
  if (err instanceof ApiError && FRIENDLY_ERRORS[err.code]) return FRIENDLY_ERRORS[err.code]!;
  return err instanceof Error ? err.message : String(err);
}

export function fieldLabel(field: string): string {
  const s = field.replace(/_/g, ' ').replace(/\b1br\b/i, '1BR');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatValue(type: FieldType, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string' && type !== 'money') return v;
  switch (type) {
    case 'money': {
      if (typeof v === 'object' && v && 'amount' in v) {
        const { amount, currency } = v as { amount: number; currency?: string };
        try {
          return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount);
        } catch {
          return `${currency ?? ''} ${amount}`.trim();
        }
      }
      return String(v);
    }
    case 'percent':
      return typeof v === 'number' ? `${v}%` : String(v);
    case 'number':
      return typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

const GAP_REASONS: Record<string, string> = {
  not_found: 'Not found in the document',
  evidence_missing: 'Model gave a value without a quote',
  evidence_not_in_text: 'Quoted evidence is not in the document (possible hallucination)',
  value_not_in_evidence: 'Value is not supported by its quote',
  unparseable_value: 'Value could not be parsed',
  missing_from_response: 'Model did not return this field',
};

export function gapLabel(reason: string): string {
  return GAP_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

export type Attention = 'gap' | 'changed' | 'pending' | 'done';

/**
 * A pending value is "new" only when the field had no value in the previous version. A pending value WITH a previous
 * value that isn't `changed` is unchanged since a version where it was never reviewed.
 */
export function isNewField(v: Value): boolean {
  return v.previous === null;
}

/** What the reviewer should make of a value, in priority order. */
export function attentionOf(v: Value): Attention {
  if (v.reviewState !== 'pending') return 'done';
  if (v.value === null) return 'gap';
  if (v.changed) return 'changed';
  return 'pending';
}

const ORDER: Record<Attention, number> = { changed: 0, gap: 1, pending: 2, done: 3 };

export function sortForReview(values: Value[]): Value[] {
  return values.map((v, i) => ({ v, i })).sort((a, b) => ORDER[attentionOf(a.v)] - ORDER[attentionOf(b.v)] || a.i - b.i).map((x) => x.v);
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
