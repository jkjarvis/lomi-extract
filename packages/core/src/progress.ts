import type { ReviewState } from './carryover.js';

export interface ProgressCounts {
  total: number;
  pending: number;
  approved: number;
  corrected: number;
  carriedOver: number;
  gaps: number;
}

export function emptyProgress(): ProgressCounts {
  return { total: 0, pending: 0, approved: 0, corrected: 0, carriedOver: 0, gaps: 0 };
}

export function computeProgress(values: Array<{ reviewState: ReviewState; value: unknown | null }>): ProgressCounts {
  const p = emptyProgress();
  for (const v of values) {
    p.total += 1;
    if (v.value === null || v.value === undefined) p.gaps += 1;
    switch (v.reviewState) {
      case 'pending':
        p.pending += 1;
        break;
      case 'approved':
        p.approved += 1;
        break;
      case 'corrected':
        p.corrected += 1;
        break;
      case 'carried_over':
        p.carriedOver += 1;
        break;
    }
  }
  return p;
}
