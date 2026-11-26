import type { FieldType, ProgressCounts, ReviewState } from '@lomi/core';
import { EXPECTED_FIELDS, computeProgress, emptyProgress, isDocType, normalizeValue } from '@lomi/core';

export type Status = 'queued' | 'extracting' | 'extracted' | 'failed';
export type RunStatus = Status | 'superseded';

export type ReviewAction = 'approve' | 'correct' | 'confirm_missing';

export interface ReviewDTO {
  action: ReviewAction;
  value: string | null;
  note: string | null;
  createdAt: string;
}

export interface ValueDTO {
  id: string;
  field: string;
  type: FieldType;
  value: unknown | null;
  rawValue: string | null;
  evidence: { quote: string; start: number; end: number } | null;
  /** `claimedEvidence`: for hallucination gaps, the quote the model claimed (context only; never evidence). */
  gap: { reason: string; detail?: string; claimedEvidence?: string } | null;
  reviewState: ReviewState;
  review: ReviewDTO | null;
  effectiveValue: unknown | null;
  previous: {
    version: number;
    value: unknown | null;
    evidenceQuote: string | null;
    reviewState: string;
    review: ReviewDTO | null;
  } | null;
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
  versions: Array<{ version: number; status: RunStatus; createdAt: string }>;
  text: string | null;
  values: ValueDTO[];
}

// ---- row shapes (structural, so tests can build them without Prisma) ----

export interface ReviewRow {
  action: ReviewAction;
  value: string | null;
  note: string | null;
  createdAt: Date;
}

export interface RunRow {
  status: RunStatus;
  error: string | null;
  attempt: number;
  createdAt: Date;
}

export interface ValueRow {
  id: string;
  field: string;
  type: string;
  value: unknown;
  rawValue: string | null;
  evidenceQuote: string | null;
  evidenceStart: number | null;
  evidenceEnd: number | null;
  gapReason: string | null;
  gapDetail: string | null;
  claimedEvidence?: string | null;
  reviewState: ReviewState;
  changed: boolean;
  reviews: ReviewRow[]; // latest first
  previousValue?:
    | (Omit<ValueRow, 'previousValue'> & { version: { versionNo: number } })
    | null;
}

export interface VersionRow {
  versionNo: number;
  createdAt: Date;
  parsedText?: string | null;
  runs: RunRow[]; // latest first
  values?: Array<Pick<ValueRow, 'reviewState' | 'value'>>;
}

export interface DocumentRow {
  id: string;
  type: string;
  title: string;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
  versions: VersionRow[];
}

// ---- mapping ----

export function latestRun(runs: RunRow[]): RunRow | undefined {
  return [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.attempt - a.attempt)[0];
}

/** A version's status is its latest run's status. */
export function versionStatus(v: Pick<VersionRow, 'runs'>): RunStatus {
  return latestRun(v.runs)?.status ?? 'queued';
}

function documentStatus(current: VersionRow | undefined): { status: Status; error: string | null } {
  const run = current ? latestRun(current.runs) : undefined;
  if (!run) return { status: 'queued', error: null };
  // The current version's run can't be superseded; guard anyway so `superseded` never leaks as a document status.
  const status: Status = run.status === 'superseded' ? 'queued' : run.status;
  return { status, error: status === 'failed' ? run.error : null };
}

function jsonValue(v: unknown): unknown | null {
  return v === undefined ? null : v;
}

export function toReviewDTO(r: ReviewRow | undefined): ReviewDTO | null {
  return r ? { action: r.action, value: r.value, note: r.note, createdAt: r.createdAt.toISOString() } : null;
}

/** Corrections live beside the value: effective = the latest correction (normalised if it parses), else the value. */
export function effectiveValue(type: FieldType, value: unknown | null, review: ReviewRow | undefined): unknown | null {
  if (review?.action !== 'correct' || review.value === null) return value;
  const norm = normalizeValue(type, review.value);
  return norm.ok ? norm.value : review.value.trim();
}

export function toValueDTO(v: ValueRow): ValueDTO {
  const type = v.type as FieldType;
  const latest = v.reviews[0];
  const prev = v.previousValue ?? null;
  return {
    id: v.id,
    field: v.field,
    type,
    value: jsonValue(v.value),
    rawValue: v.rawValue,
    evidence:
      v.evidenceQuote !== null && v.evidenceStart !== null && v.evidenceEnd !== null
        ? { quote: v.evidenceQuote, start: v.evidenceStart, end: v.evidenceEnd }
        : null,
    gap: v.gapReason
      ? {
          reason: v.gapReason,
          ...(v.gapDetail ? { detail: v.gapDetail } : {}),
          ...(v.claimedEvidence ? { claimedEvidence: v.claimedEvidence } : {}),
        }
      : null,
    reviewState: v.reviewState,
    review: toReviewDTO(latest),
    effectiveValue: effectiveValue(type, jsonValue(v.value), latest),
    previous: prev
      ? {
          version: prev.version.versionNo,
          value: jsonValue(prev.value),
          evidenceQuote: prev.evidenceQuote,
          reviewState: prev.reviewState,
          review: toReviewDTO(prev.reviews[0]),
        }
      : null,
    changed: v.changed,
  };
}

export function fieldOrder(docType: string, field: string): number {
  const spec = isDocType(docType) ? EXPECTED_FIELDS[docType] : [];
  const i = spec.findIndex((f) => f.field === field);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

export function toSummary(doc: DocumentRow): DocumentSummary {
  const current = doc.versions.find((v) => v.versionNo === doc.currentVersion);
  const { status, error } = documentStatus(current);
  const values = current?.values ?? [];
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    currentVersion: doc.currentVersion,
    status,
    error,
    progress: values.length ? computeProgress(values.map((v) => ({ reviewState: v.reviewState, value: jsonValue(v.value) }))) : emptyProgress(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toDetail(doc: DocumentRow, shown: VersionRow & { parsedText: string | null }, values: ValueRow[]): DocumentDetail {
  return {
    ...toSummary(doc),
    version: shown.versionNo,
    versions: [...doc.versions]
      .sort((a, b) => a.versionNo - b.versionNo)
      .map((v) => ({ version: v.versionNo, status: versionStatus(v), createdAt: v.createdAt.toISOString() })),
    text: shown.parsedText,
    values: [...values].sort((a, b) => fieldOrder(doc.type, a.field) - fieldOrder(doc.type, b.field)).map(toValueDTO),
  };
}
