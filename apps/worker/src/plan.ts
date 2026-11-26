import type { ReviewState, ValidatedValue } from '@lomi/core';
import { decideCarryOver } from '@lomi/core';

export interface PrevReview {
  id: string;
  action: 'approve' | 'correct' | 'confirm_missing';
  value: string | null;
  note: string | null;
}

export interface PrevValueRow {
  id: string;
  field: string;
  value: unknown | null;
  evidenceQuote: string | null;
  reviewState: ReviewState;
  latestReview: PrevReview | null;
}

export interface PlannedValue {
  validated: ValidatedValue;
  reviewState: ReviewState;
  changed: boolean;
  previousValueId: string | null;
  /** Review copied forward from the previous version (carry-over), if any. */
  carriedReview: PrevReview | null;
}

/**
 * Decide, for each freshly validated value, what review state it starts in relative to the previous version.
 * Pure: the worker applies the plan inside the same transaction that commits the run.
 */
export function planValues(validated: ValidatedValue[], prev: PrevValueRow[], nextText: string): PlannedValue[] {
  const prevByField = new Map(prev.map((p) => [p.field, p]));
  return validated.map((v): PlannedValue => {
    const p = prevByField.get(v.field);
    if (!p) return { validated: v, reviewState: 'pending', changed: false, previousValueId: null, carriedReview: null };
    const decision = decideCarryOver(
      { field: p.field, value: p.value, evidenceQuote: p.evidenceQuote, reviewState: p.reviewState },
      v,
      nextText,
    );
    if (decision.kind === 'carry_over' && p.latestReview) {
      return { validated: v, reviewState: 'carried_over', changed: false, previousValueId: p.id, carriedReview: p.latestReview };
    }
    const changed = decision.kind === 'changed' || decision.kind === 'carry_over'; // carry_over without a review row: be safe
    return { validated: v, reviewState: 'pending', changed, previousValueId: p.id, carriedReview: null };
  });
}
