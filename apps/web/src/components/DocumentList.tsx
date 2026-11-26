import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentSummary } from '../api.js';
import { api, isBusy } from '../api.js';
import { timeAgo } from '../format.js';
import { ProgressBar, StatusBadge, usePolling } from './common.js';

const TYPES = [
  { value: 'invoice', label: 'Invoice' },
  { value: 'lease', label: 'Lease' },
  { value: 'market_report', label: 'Market report' },
];

function UploadForm({ onUploaded }: { onUploaded: () => void }) {
  const [type, setType] = useState('invoice');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api.upload(type, file, title.trim() || undefined);
      setTitle('');
      setFile(null);
      setInputKey((k) => k + 1);
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="upload card" onSubmit={submit}>
      <strong>Upload a document</strong>
      <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Document type">
        {TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <input placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input key={inputKey} type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button type="submit" disabled={!file || busy}>
        {busy ? 'Uploading…' : 'Upload'}
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

export function DocumentList({ open }: { open: (id: string) => void }) {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const retryInFlight = useRef(new Set<string>()); // synchronous guard for clicks within one tick

  const load = useCallback(() => {
    return api
      .list()
      .then((d) => {
        setDocs(d);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  usePolling(() => void load(), !!docs?.some((d) => isBusy(d.status)));

  // One retry per click: the row's button stays disabled until the reloaded list shows its new status.
  const retry = async (id: string) => {
    if (retryInFlight.current.has(id)) return;
    retryInFlight.current.add(id);
    setRetrying((s) => new Set(s).add(id));
    try {
      await api.retry(id).catch((err: Error) => setError(err.message));
      await load();
    } finally {
      retryInFlight.current.delete(id);
      setRetrying((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  const toReview = docs?.reduce((n, d) => n + d.progress.pending, 0) ?? 0;

  return (
    <div className="page">
      <UploadForm onUploaded={load} />
      <div className="list-header">
        <h2>Documents</h2>
        {docs && <span className="muted">{toReview > 0 ? `${toReview} values waiting for review` : 'Nothing waiting for review'}</span>}
      </div>
      {error && <div className="error banner">{error}</div>}
      {!docs ? (
        <p className="muted">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="muted">No documents yet. Upload one above.</p>
      ) : (
        <table className="docs">
          <thead>
            <tr>
              <th>Document</th>
              <th>Type</th>
              <th>Version</th>
              <th>Status</th>
              <th>Review</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} onClick={() => open(d.id)} className={d.progress.pending > 0 || d.status === 'failed' ? 'needs' : ''}>
                <td>
                  <a href={`#/documents/${d.id}`} onClick={(e) => e.preventDefault()}>
                    {d.title}
                  </a>
                  <div className="muted small">{d.id}</div>
                </td>
                <td>{TYPES.find((t) => t.value === d.type)?.label ?? d.type}</td>
                <td>v{d.currentVersion}</td>
                <td>
                  <StatusBadge status={d.status} />
                  {d.status === 'failed' && (
                    <div className="small">
                      <span className="error">{d.error}</span>{' '}
                      <button
                        className="link"
                        disabled={retrying.has(d.id)}
                        onClick={(e) => {
                          e.stopPropagation();
                          void retry(d.id);
                        }}
                      >
                        {retrying.has(d.id) ? 'Retrying…' : 'Retry'}
                      </button>
                    </div>
                  )}
                </td>
                <td>{d.status === 'extracted' ? <ProgressBar progress={d.progress} /> : <span className="muted">—</span>}</td>
                <td className="muted small">{timeAgo(d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
