import type { FieldType, Value } from './api.js';

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
