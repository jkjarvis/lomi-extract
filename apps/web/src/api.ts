// HTTP client and DTO types (mirrors CONTRACT.md §3).

export type Status = 'queued' | 'extracting' | 'extracted' | 'failed';
export type ReviewState = 'pending' | 'approved' | 'corrected' | 'carried_over';
export type FieldType = 'string' | 'date' | 'money' | 'number' | 'percent';

export interface ProgressCounts {
  total: number;
  pending: number;
  approved: number;
  corrected: number;
  carriedOver: number;
  gaps: number;
}

export interface Review {
  action: 'approve' | 'correct' | 'confirm_missing';
  value: string | null;
  note: string | null;
  createdAt: string;
}

export interface Value {
  id: string;
  field: string;
  type: FieldType;
  value: unknown | null;
  rawValue: string | null;
  evidence: { quote: string; start: number; end: number } | null;
  /** claimedEvidence: for hallucination gaps, the quote the model claimed (context only, never evidence). */
  gap: { reason: string; detail?: string; claimedEvidence?: string } | null;
  reviewState: ReviewState;
  review: Review | null;
  effectiveValue: unknown | null;
  previous: { version: number; value: unknown | null; evidenceQuote: string | null; reviewState: string; review: Review | null } | null;
  changed: boolean;
}

export interface DocumentSummary {
  id: string;
  type: string;
  title: string;
  currentVersion: number;
  status: Status;
  error: string | null;
  progress: ProgressCounts;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  version: number;
  versions: Array<{ version: number; status: Status | 'superseded'; createdAt: string }>;
  text: string | null;
  values: Value[];
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? res.statusText);
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  list: () => request<DocumentSummary[]>('/documents'),
  get: (id: string, version?: number) =>
    request<DocumentDetail>(`/documents/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`),
  upload: (type: string, file: File, title?: string) => {
    const form = new FormData();
    form.set('type', type);
    if (title) form.set('title', title);
    form.set('file', file);
    return request<DocumentSummary>('/documents', { method: 'POST', body: form });
  },
  uploadVersion: (id: string, file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<DocumentSummary>(`/documents/${encodeURIComponent(id)}/versions`, { method: 'POST', body: form });
  },
  retry: (id: string) => request<DocumentSummary>(`/documents/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  approve: (valueId: string) => request<Value>(`/values/${valueId}/review`, json({ action: 'approve' })),
  /** Gaps only: the field is genuinely not in the document. */
  confirmMissing: (valueId: string) => request<Value>(`/values/${valueId}/review`, json({ action: 'confirm_missing' })),
  correct: (valueId: string, value: string, note?: string) =>
    request<Value>(`/values/${valueId}/review`, json({ action: 'correct', value, note: note || undefined })),
};

export const isBusy = (s: Status) => s === 'queued' || s === 'extracting';
