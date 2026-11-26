import { computeProgress } from '@lomi/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentDetail as Detail, Value } from '../api.js';
import { ApiError, api, isBusy } from '../api.js';
import { attentionOf, friendlyError, isNewField, sortForReview, typeLabel } from '../format.js';
import { DocText } from './DocText.js';
import { ProgressBar, StatusBadge, usePolling } from './common.js';
import { ValueCard } from './ValueCard.js';

function Summary({ values }: { values: Value[] }) {
  const counts = { changed: 0, gap: 0, pending: 0, done: 0 };
  for (const v of values) counts[attentionOf(v)] += 1;
  const fresh = values.filter((v) => attentionOf(v) === 'pending' && isNewField(v)).length;
  const unreviewed = counts.pending - fresh;
  const carried = values.filter((v) => v.reviewState === 'carried_over').length;
  const todo = counts.changed + counts.gap + counts.pending;
  return (
    <div className={`summary ${todo ? 'todo' : 'clear'}`}>
      {todo ? (
        <>
          <strong>{todo} need your review</strong>
          {counts.changed > 0 && <span className="chip changed">{counts.changed} changed</span>}
          {counts.gap > 0 && <span className="chip gap">{counts.gap} gap{counts.gap > 1 ? 's' : ''}</span>}
          {fresh > 0 && <span className="chip pending">{fresh} new</span>}
          {unreviewed > 0 && <span className="chip pending">{unreviewed} unchanged, not yet reviewed</span>}
        </>
      ) : (
        <strong>All {values.length} values reviewed</strong>
      )}
      {carried > 0 && <span className="chip carried">{carried} carried over</span>}
    </div>
  );
}

/** Review order is decided when values are loaded, not on every review: a card must not jump away from under the cursor. */
function orderFor(values: Value[], order: string[]): Value[] {
  const byId = new Map(values.map((v) => [v.id, v]));
  const known = order.flatMap((id) => byId.get(id) ?? []);
  const unknown = sortForReview(values.filter((v) => !order.includes(v.id)));
  return [...known, ...unknown];
}

export function DocumentDetail({ id, version, go }: { id: string; version?: number; go: (path: string) => void }) {
  const [doc, setDoc] = useState<Detail | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const retryInFlight = useRef(false); // synchronous guard: two clicks in one tick both see the old `retrying`

  const load = useCallback(() => {
    return api
      .get(id, version)
      .then((d) => {
        setDoc(d);
        setOrder(sortForReview(d.values).map((v) => v.id));
        setError(null);
      })
      .catch((err: Error) => setError(err instanceof ApiError && err.status === 404 ? 'Document or version not found' : err.message));
  }, [id, version]);
  useEffect(() => {
    void load();
  }, [load]);

  const shownStatus = doc?.versions.find((v) => v.version === doc.version)?.status;
  usePolling(load, !!doc && (isBusy(doc.status) || shownStatus === 'queued' || shownStatus === 'extracting'));

  if (error && !doc) return <div className="page"><div className="error banner">{error}</div></div>;
  if (!doc) return <div className="page muted">Loading…</div>;

  const isCurrent = doc.version === doc.currentVersion;
  const status = shownStatus ?? doc.status;

  // Only the current version can be reviewed, and doc.progress describes the current version: recompute it with the
  // same rule as the API (@lomi/core computeProgress) so the header never goes stale after a review.
  const onReviewed = (nv: Value) =>
    setDoc((d) => {
      if (!d) return d;
      const values = d.values.map((v) => (v.id === nv.id ? nv : v));
      return { ...d, values, progress: d.version === d.currentVersion ? computeProgress(values) : d.progress };
    });

  const uploadVersion = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      await api.uploadVersion(doc.id, file);
      go(`/documents/${doc.id}`);
      await load();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setUploading(false);
      setInputKey((k) => k + 1); // a fresh input, so picking the same file again still fires onChange
    }
  };

  // Disabled from the click until the reloaded document is back: a double click can't queue a second run, and once
  // the status has left `failed` the button is gone.
  const retry = async () => {
    if (retryInFlight.current) return;
    retryInFlight.current = true;
    setRetrying(true);
    try {
      await api.retry(doc.id).catch((err: Error) => setError(err.message));
      await load();
    } finally {
      retryInFlight.current = false;
      setRetrying(false);
    }
  };

  const ordered = orderFor(doc.values, order);
  const noValues = doc.values.length === 0;

  return (
    <div className="page detail">
      <div className="detail-header">
        <button className="link" onClick={() => go('/')}>
          ← All documents
        </button>
        <h2>{doc.title}</h2>
        <div className="header-row">
          <span className="muted">{typeLabel(doc.type)}</span>
          <div className="versions" role="tablist">
            {doc.versions.map((v) => (
              <button
                key={v.version}
                role="tab"
                className={`version-tab ${v.version === doc.version ? 'selected' : ''}`}
                onClick={() => go(`/documents/${doc.id}${v.version === doc.currentVersion ? '' : `/v/${v.version}`}`)}
                title={v.status}
              >
                v{v.version}
                {v.version === doc.currentVersion ? ' (current)' : ''}
                {v.status !== 'extracted' && <span className={`dot status-${v.status}`} />}
              </button>
            ))}
          </div>
          <StatusBadge status={status} />
          {isCurrent && doc.status === 'extracted' && <ProgressBar progress={doc.progress} />}
          <label className="upload-version">
            <input
              key={inputKey}
              type="file"
              accept="application/pdf,.pdf"
              disabled={uploading}
              onChange={(e) => e.target.files?.[0] && void uploadVersion(e.target.files[0])}
            />
            <span className="button secondary">{uploading ? 'Uploading…' : 'Upload new version'}</span>
          </label>
        </div>
        {isBusy(doc.status) && (
          <div className="banner warn small">
            v{doc.currentVersion} is still {doc.status === 'queued' ? 'waiting to be extracted' : 'being extracted'}. Uploading a new version
            now supersedes that extraction: it stops, and v{doc.currentVersion} keeps no values.
          </div>
        )}
        {error && <div className="error banner">{error}</div>}
        {!isCurrent && (
          <div className="banner info">
            You are viewing v{doc.version}, an earlier version (read-only).
            {noValues ? '' : ' Its values and reviews are kept as they were.'}{' '}
            <button className="link" onClick={() => go(`/documents/${doc.id}`)}>
              Go to current v{doc.currentVersion}
            </button>
          </div>
        )}
        {status === 'failed' && isCurrent && (
          <div className="banner failed">
            Extraction failed: {doc.error ?? 'unknown error'}{' '}
            <button disabled={retrying} onClick={() => void retry()}>
              {retrying ? 'Retrying…' : 'Retry extraction'}
            </button>
          </div>
        )}
      </div>

      {(status === 'queued' || status === 'extracting') && (
        <div className="banner info">{status === 'queued' ? 'Waiting for a worker…' : 'Extracting values with the LLM…'} This page updates automatically.</div>
      )}

      <div className="columns">
        <section className="values">
          {status === 'superseded' && noValues && (
            <div className="banner info">This version was superseded before extraction finished — no values were extracted.</div>
          )}
          {status === 'failed' && !isCurrent && noValues && (
            <div className="banner info">Extraction of this version failed and was not retried — no values were extracted.</div>
          )}
          {!noValues && <Summary values={doc.values} />}
          {ordered.map((v) => (
            <ValueCard
              key={v.id}
              value={v}
              readOnly={!isCurrent}
              active={v.id === activeId}
              onFocus={() => setActiveId(v.id)}
              onReviewed={onReviewed}
            />
          ))}
        </section>
        <section className="text-panel">
          <h3>
            Document text <span className="muted small">v{doc.version} · highlighted passages are the evidence</span>
          </h3>
          {doc.text ? (
            <DocText text={doc.text} values={doc.values} activeId={activeId} onSelect={setActiveId} />
          ) : (
            <p className="muted">{status === 'superseded' ? 'This version was never parsed.' : 'Text is available once the PDF has been parsed.'}</p>
          )}
        </section>
      </div>
    </div>
  );
}
