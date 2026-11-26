import type { DocType, FieldSpec, LlmField } from '@lomi/core';

export interface ExtractionRequest {
  docType: DocType;
  fields: FieldSpec[];
  text: string;
  /** Run attempt (fencing token); the mock uses it for MOCK_LLM_FAIL=once. */
  attempt: number;
  signal?: AbortSignal;
}

export interface ExtractionResult {
  fields: LlmField[];
  prompt: string;
  rawResponse: string;
  provider: string;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  extract(req: ExtractionRequest): Promise<ExtractionResult>;
}

/** Test/ops hooks for the HTTP providers. `fetch` lets tests stub the HTTP layer without network access. */
export interface ProviderOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseURL?: string;
  fetch?: typeof fetch;
}

/** Human-readable error for a failed SDK call (status code, timeout, abort, connection), stored as the run's error. */
export function describeSdkError(provider: string, err: unknown): string {
  if (!(err instanceof Error)) return `${provider} request failed: ${String(err)}`;
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') return `${provider} API error ${status}: ${err.message}`;
  if (/timeout/i.test(err.name)) return `${provider} request timed out: ${err.message}`;
  if (/abort/i.test(err.name)) return `${provider} request aborted: ${err.message}`;
  if (/connection/i.test(err.name)) return `${provider} connection error: ${err.message}`;
  return `${provider} request failed: ${err.message}`;
}

/** Any failure talking to the model or interpreting its answer. Carries what we got back, for debugging. */
export class LlmError extends Error {
  override name = 'LlmError';
  constructor(
    message: string,
    readonly rawResponse: string | null = null,
    readonly prompt: string | null = null,
  ) {
    super(message);
  }
}

/** Parse a model's JSON answer into LlmField[]. Accepts {fields:[...]} or a bare array. Throws LlmError. */
export function parseLlmFields(raw: unknown, rawText: string): LlmField[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { fields?: unknown }).fields : null;
  if (!Array.isArray(list)) throw new LlmError('Model response has no "fields" array', rawText);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
  return list
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as { field?: unknown }).field === 'string')
    .map((f) => ({
      field: f.field as string,
      value: str(f.value),
      evidence: str(f.evidence),
      reason: str(f.reason),
    }));
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
