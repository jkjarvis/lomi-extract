import { useEffect, useRef } from 'react';
import type { ProgressCounts, Status } from '../api.js';

/** Call `fn` every `ms` while `active`. Extraction takes seconds and is rare, so polling beats a socket here. */
export function usePolling(fn: () => void, active: boolean, ms = 2000) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

const STATUS_LABEL: Record<Status | 'superseded', string> = {
  queued: 'Queued',
  extracting: 'Extracting…',
  extracted: 'Extracted',
  failed: 'Failed',
  superseded: 'Superseded',
};

export function StatusBadge({ status }: { status: Status | 'superseded' }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function ProgressBar({ progress }: { progress: ProgressCounts }) {
  const { total, pending, approved, corrected, carriedOver } = progress;
  if (total === 0) return <span className="muted">—</span>;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="progress" title={`${approved} approved · ${corrected} corrected · ${carriedOver} carried over · ${pending} pending`}>
      <div className="progress-bar">
        <span className="seg approved" style={{ width: pct(approved) }} />
        <span className="seg corrected" style={{ width: pct(corrected) }} />
        <span className="seg carried" style={{ width: pct(carriedOver) }} />
      </div>
      <span className="progress-label">
        {pending > 0 ? <strong className="attn">{pending} to review</strong> : <span className="ok">All reviewed</span>}
        <span className="muted">
          {' '}
          · {total - pending}/{total} done{progress.gaps ? ` · ${progress.gaps} gap${progress.gaps > 1 ? 's' : ''}` : ''}
        </span>
      </span>
    </div>
  );
}
