import { findEvidence } from './text.js';
import type { ValidatedValue } from './validate.js';

export type ReviewState = 'pending' | 'approved' | 'corrected' | 'carried_over';

export interface PrevValue {
  field: string;
  value: unknown | null;
  evidenceQuote: string | null;
  reviewState: ReviewState;
}

export type CarryDecision = { kind: 'carry_over' } | { kind: 'changed' } | { kind: 'new' };

const REVIEWED: ReadonlySet<ReviewState> = new Set(['approved', 'corrected', 'carried_over']);

/** Structural equality for canonical values (primitives, plain objects, arrays). Key order does not matter. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

/**
 * "Unchanged" is evidence-based, not position-based: a previous review carries over only if the canonical value is
 * identical AND the previously reviewed quote still appears (normalised) somewhere in the new version's text.
 */
export function decideCarryOver(prev: PrevValue | undefined, next: ValidatedValue, nextText: string): CarryDecision {
  if (!prev) return { kind: 'new' };
  const sameValue = deepEqual(prev.value ?? null, next.value ?? null);
  if (
    REVIEWED.has(prev.reviewState) &&
    prev.value !== null &&
    next.value !== null &&
    sameValue &&
    prev.evidenceQuote !== null &&
    findEvidence(nextText, prev.evidenceQuote) !== null
  ) {
    return { kind: 'carry_over' };
  }
  if (prev.reviewState !== 'pending' || !sameValue) return { kind: 'changed' };
  return { kind: 'new' };
}
