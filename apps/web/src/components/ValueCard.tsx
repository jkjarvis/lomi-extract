import { useState } from 'react';
import type { Review, Value } from '../api.js';
import { api } from '../api.js';
import { attentionOf, fieldLabel, formatValue, gapLabel } from '../format.js';

const STATE_CHIP: Record<string, { label: string; cls: string }> = {
  changed: { label: 'Changed — review again', cls: 'chip changed' },
  gap: { label: 'Gap — needs a value', cls: 'chip gap' },
  pending: { label: 'Needs review', cls: 'chip pending' },
  approved: { label: 'Approved', cls: 'chip approved' },
  confirmed_missing: { label: 'Confirmed missing', cls: 'chip approved' },
  corrected: { label: 'Corrected', cls: 'chip corrected' },
  carried_over: { label: 'Carried over', cls: 'chip carried' },
};

function reviewText(r: Review | null, type: Value['type']): string {
  if (!r) return 'not reviewed';
  if (r.action === 'approve') return 'approved';
  if (r.action === 'confirm_missing') return `confirmed missing${r.note ? ` (${r.note})` : ''}`;
  return `corrected to “${formatValue(type, r.value)}”${r.note ? ` (${r.note})` : ''}`;
}

export function ValueCard({
  value: v,
  readOnly,
  active,
  onFocus,
  onReviewed,
}: {
  value: Value;
  readOnly: boolean;
  active: boolean;
  onFocus: () => void;
  onReviewed: (v: Value) => void;
}) {
  const attention = attentionOf(v);
  const confirmedMissing = v.review?.action === 'confirm_missing' && v.reviewState !== 'pending';
  const chip = STATE_CHIP[attention === 'done' ? (confirmedMissing ? 'confirmed_missing' : v.reviewState) : attention]!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<Value>) => {
    setBusy(true);
    setError(null);
    try {
      onReviewed(await fn());
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startCorrect = () => {
    setDraft(v.review?.action === 'correct' && v.review.value ? v.review.value : (v.rawValue ?? ''));
    setNote('');
    setEditing(true);
  };

  const corrected = v.review?.action === 'correct';

  return (
    <div className={`value-card attn-${attention} ${active ? 'active' : ''}`} onClick={onFocus}>
      <div className="value-head">
        <span className="field">{fieldLabel(v.field)}</span>
        <span className={chip.cls}>{chip.label}</span>
        {v.reviewState === 'carried_over' && v.previous && <span className="muted small">from v{v.previous.version}</span>}
      </div>

      <div className="value-main">
        {v.value === null && !corrected ? (
          <span className="gap-value">No value</span>
        ) : (
          <span className="the-value">{formatValue(v.type, v.effectiveValue)}</span>
        )}
        {corrected && (
          <span className="muted small">
            {' '}
            extracted: <s>{formatValue(v.type, v.value)}</s>
          </span>
        )}
      </div>

      {v.gap && (
        <div className="gap-reason">
          <strong>{gapLabel(v.gap.reason)}</strong>
          {v.gap.claimedEvidence !== undefined ? (
            // A rejected claim: show what the model said so the reviewer can judge it. Not evidence, not highlighted.
            <div className="claimed small">
              {v.rawValue !== null && (
                <div>
                  The model claimed: <span className="claimed-value">{v.rawValue}</span>
                </div>
              )}
              <div>
                {v.gap.reason === 'evidence_not_in_text' ? 'Its quote (not found in this document):' : 'Its quote (does not contain that value):'}
              </div>
              <blockquote className="quote claimed-quote">{v.gap.claimedEvidence}</blockquote>
            </div>
          ) : (
            v.gap.detail && <div className="small">{v.gap.detail}</div>
          )}
        </div>
      )}

      {v.evidence && (
        <blockquote className="quote" title="Source passage (click to locate in the document)">
          {v.evidence.quote}
        </blockquote>
      )}

      {v.previous && (attention === 'changed' || (v.changed && v.reviewState !== 'carried_over')) && (
        <div className="previous">
          <div>
            <strong>Previously in v{v.previous.version}:</strong> {formatValue(v.type, v.previous.value)}{' '}
            <span className="muted">— {reviewText(v.previous.review, v.type)}</span>
          </div>
          {v.previous.evidenceQuote && <blockquote className="quote old">{v.previous.evidenceQuote}</blockquote>}
        </div>
      )}

      {v.review && attention === 'done' && (
        <div className="muted small">
          {v.reviewState === 'carried_over' ? 'Review carried over: ' : 'Review: '}
          {reviewText(v.review, v.type)}
        </div>
      )}

      {!readOnly && !editing && (
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          {v.value === null ? (
            <>
              <button className={attention === 'done' ? 'secondary' : 'primary'} disabled={busy} onClick={startCorrect}>
                Correct
              </button>
              <button
                className="secondary"
                disabled={busy || confirmedMissing}
                title="The field really isn't in this document: mark the gap as reviewed"
                onClick={() => void run(() => api.confirmMissing(v.id))}
              >
                Confirm missing
              </button>
            </>
          ) : (
            <>
              <button className={attention === 'done' ? 'secondary' : 'primary'} disabled={busy} onClick={() => void run(() => api.approve(v.id))}>
                Approve
              </button>
              <button className="secondary" disabled={busy} onClick={startCorrect}>
                Correct
              </button>
            </>
          )}
        </div>
      )}

      {!readOnly && editing && (
        <form
          className="correct-form"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void run(() => api.correct(v.id, draft.trim(), note.trim() || undefined));
          }}
        >
          <input autoFocus placeholder="Correct value" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="primary" type="submit" disabled={busy || !draft.trim()}>
            Save correction
          </button>
          <button type="button" className="link" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}
