import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentDetail as Detail, Value } from '../api.js';
import { ApiError, api, isBusy } from '../api.js';
import { attentionOf, sortForReview } from '../format.js';
import { DocText } from './DocText.js';
import { ProgressBar, StatusBadge, usePolling } from './common.js';
import { ValueCard } from './ValueCard.js';

function Summary({ values }: { values: Value[] }) {
  const counts = { changed: 0, gap: 0, pending: 0, done: 0 };
  for (const v of values) counts[attentionOf(v)] += 1;
  const carried = values.filter((v) => v.reviewState === 'carried_over').length;
  const todo = counts.changed + counts.gap + counts.pending;
  return (
    <div className={`summary ${todo ? 'todo' : 'clear'}`}>
      {todo ? (
        <>
          <strong>{todo} need your review</strong>
          {counts.changed > 0 && <span className="chip changed">{counts.changed} changed</span>}
          {counts.gap > 0 && <span className="chip gap">{counts.gap} gap{counts.gap > 1 ? 's' : ''}</span>}
          {counts.pending > 0 && <span className="chip pending">{counts.pending} new</span>}
        </>
      ) : (
        <strong>All {values.length} values reviewed</strong>
      )}
      {carried > 0 && <span className="chip carried">{carried} carried over</span>}
    </div>
  );
}

export function DocumentDetail({ id, version, go }: { id: string; version?: number; go: (path: string) => void }) {
  const [doc, setDoc] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retryInFlight = useRef(false); // synchronous guard: two clicks in one tick both see the old `retrying`

  const load = useCallback(() => {
    return api
      .get(id, version)
      .then((d) => {
        setDoc(d);
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

  const onReviewed = (nv: Value) => setDoc((d) => (d ? { ...d, values: d.values.map((v) => (v.id === nv.id ? nv : v)) } : d));

  const uploadVersion = async (file: File) => {
    setUploading(true);
    try {
      await api.uploadVersion(doc.id, file);
      go(`/documents/${doc.id}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
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

  const ordered = sortForReview(doc.values);

  return (
    <div className="page detail">
      <div className="detail-header">
        <button className="link" onClick={() => go('/')}>
          ← All documents
        </button>
        <h2>{doc.title}</h2>
        <div className="header-row">
          <span className="muted">{doc.type}</span>
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
            <input type="file" accept="application/pdf,.pdf" disabled={uploading} onChange={(e) => e.target.files?.[0] && void uploadVersion(e.target.files[0])} />
            <span className="button secondary">{uploading ? 'Uploading…' : 'Upload new version'}</span>
          </label>
        </div>
        {error && <div className="error banner">{error}</div>}
        {!isCurrent && (
          <div className="banner info">
            You are viewing v{doc.version}, an earlier version (read-only). Its values and reviews are kept as they were.{' '}
            <button className="link" onClick={() => go(`/documents/${doc.id}`)}>
              Go to current v{doc.currentVersion}
            </button>
          </div>
        )}
        {status === 'failed' && isCurrent && (
          <div className="banner failed">
            Extraction failed: {doc.error ?? 'unknown error'} <button disabled={retrying} onClick={() => void retry()}>
              {retrying ? 'Retrying…' : 'Retry extraction'}
            </button>
          </div>
        )}
        {status === 'superseded' && (
          <div className="banner info">This version was replaced by a newer upload before its extraction finished.</div>
        )}
      </div>

      {(status === 'queued' || status === 'extracting') && (
        <div className="banner info">{status === 'queued' ? 'Waiting for a worker…' : 'Extracting values with the LLM…'} This page updates automatically.</div>
      )}

      <div className="columns">
        <section className="values">
          {doc.values.length > 0 && <Summary values={doc.values} />}
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
            <p className="muted">Text is available once the PDF has been parsed.</p>
          )}
        </section>
      </div>
    </div>
  );
}
