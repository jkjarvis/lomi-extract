# Lomi extraction — interface contract (shared by implementation AND independent test authors)

Repo root (pnpm 9+ workspaces + Turborepo, Node 22, TypeScript strict, ESM).
Test runner everywhere: **vitest**. Fixtures live in `fixtures/`.

## 1. Package layout & names
```
apps/api            @lomi/api      Fastify HTTP API, port 3001
apps/worker         @lomi/worker   BullMQ worker + reconciler
apps/web            @lomi/web      Vite + React UI, port 5173 (dev) / 8080 (docker, nginx)
packages/core       @lomi/core     PURE domain logic (no I/O)
packages/db         @lomi/db       Prisma schema, migrations, seed, client export
packages/extraction @lomi/extraction  pdf→text, LLM providers (anthropic, openai, mock)
packages/config     @lomi/config   shared tsconfig/eslint
tests/integration   @lomi/integration-tests  black-box tests against the running HTTP API (+ pg/redis for chaos)
```
Root scripts: `pnpm build`, `pnpm test` (unit, no docker), `pnpm lint`, `pnpm typecheck` — all via `turbo run`.
`pnpm test:integration` runs `tests/integration` (requires the stack up: `docker compose up -d`).

## 2. `@lomi/core` public API (exported from `packages/core/src/index.ts`)
```ts
export type FieldType = 'string' | 'date' | 'money' | 'number' | 'percent';
export interface FieldSpec { field: string; type: FieldType }

// Whitespace/typography normalisation used for evidence matching:
// - collapse any run of whitespace (spaces, tabs, \r, \n) to a single space; trim
// - smart quotes ‘’“” → ' and " ; en/em dash – — → -
// - strip PDF-escape backslashes before ( ) \  (i.e. "\(" → "(")
export function normalizeText(s: string): string;

// Locate `quote` inside `text` using normalizeText on both sides (NOT fuzzy: after normalisation it must be an exact
// substring). Returns offsets into the ORIGINAL `text` (start inclusive, end exclusive) or null. Empty/whitespace quote → null.
export function findEvidence(text: string, quote: string): { start: number; end: number } | null;

// Normalise a raw extracted string to a canonical value. Never throws.
// money   → { amount: number (decimal, 2dp), currency: 'USD' }  from "$5,230.29", "$1,985 per month", "USD 2,350.00", "2350"
// date    → 'YYYY-MM-DD'  from "2025-10-14", "March 1, 2025", "Mar 1 2025", "1 March 2025", "09/14/2025"(US M/D/Y)
// number  → number        from "24", "twenty-four (24)", "twenty-four", "24 months", "1,200"
// percent → number        from "4.2%", "4.2 %", "4.2 percent"   (4.2, not 0.042)
// string  → trimmed string with internal whitespace collapsed
export type NormalizeResult = { ok: true; value: unknown } | { ok: false; reason: string };
export function normalizeValue(type: FieldType, raw: string): NormalizeResult;

// Raw LLM output for ONE field (what providers return):
export interface LlmField { field: string; value: string | null; evidence: string | null; reason?: string | null }

export type GapReason = 'not_found' | 'evidence_missing' | 'evidence_not_in_text' | 'value_not_in_evidence'
                      | 'unparseable_value' | 'missing_from_response';

export interface ValidatedValue {
  field: string; type: FieldType;
  value: unknown | null;          // canonical (normalizeValue) or null for a gap
  rawValue: string | null;        // what the LLM said
  evidence: { quote: string; start: number; end: number } | null;
  gap: { reason: GapReason; detail?: string } | null;   // non-null ⇔ value === null
}

// Turn LLM output into validated values for EVERY field in `spec` (exactly one per spec field, in spec order; extra fields
// in `llm` are ignored; duplicates: first wins). Rules, in order:
// - field absent from llm → gap 'missing_from_response'
// - value null/empty → gap 'not_found' (detail = llm reason if given)
// - evidence null/empty → gap 'evidence_missing'
// - findEvidence(text, evidence) null → gap 'evidence_not_in_text'
// - rawValue not contained in the evidence quote (compare normalizeText, case-insensitive; for money/number/percent also
//   accept if the digits of the value appear in the quote, e.g. value "24" with quote "twenty-four (24) months") → gap 'value_not_in_evidence'
// - normalizeValue fails → gap 'unparseable_value'
// - else value = normalised value, evidence = {quote: <exact substring of text at offsets>, start, end}
export function validateExtraction(text: string, spec: FieldSpec[], llm: LlmField[]): ValidatedValue[];

// Carry-over decision for one field when version N is extracted and version N-1 exists.
export interface PrevValue {
  field: string; value: unknown | null; evidenceQuote: string | null;
  reviewState: 'pending' | 'approved' | 'corrected' | 'carried_over';
}
export type CarryDecision =
  | { kind: 'carry_over' }      // keep previous review (approved/corrected) → new value reviewState 'carried_over'
  | { kind: 'changed' }         // new value pending; UI shows previous value + review
  | { kind: 'new' };            // no previous value for this field (or previous was pending/never reviewed) → pending
// Rule: carry_over iff prev.reviewState ∈ {approved, corrected, carried_over} AND prev.value !== null AND next.value !== null
//   AND deepEqual(prev.value, next.value) AND prev.evidenceQuote !== null
//   AND findEvidence(nextText, prev.evidenceQuote) !== null.
// If prev exists but the rule fails → 'changed' when prev.reviewState !== 'pending' or prev.value/next.value differ; 'new' if prev
// was pending AND unchanged (it just stays pending). Position in the document is irrelevant.
export function decideCarryOver(prev: PrevValue | undefined, next: ValidatedValue, nextText: string): CarryDecision;

export interface ProgressCounts { total: number; pending: number; approved: number; corrected: number; carriedOver: number; gaps: number }
// counts over the CURRENT version's values: pending/approved/corrected/carriedOver partition `total` by reviewState;
// `gaps` = number of values with value === null (a gap is also counted in exactly one of the review buckets).
export function computeProgress(values: Array<{ reviewState: PrevValue['reviewState']; value: unknown | null }>): ProgressCounts;

export const EXPECTED_FIELDS: Record<'invoice' | 'lease' | 'market_report', FieldSpec[]>; // mirrors fixtures/expected-fields.json
```

## 3. HTTP API (`@lomi/api`, base `http://localhost:3001`, JSON, errors as `{ error: { code, message } }`)
- `GET /health` → 200 `{ ok: true }` once DB reachable.
- `GET /documents` → 200 `DocumentSummary[]` ordered by createdAt asc.
- `POST /documents` multipart: `type` ∈ invoice|lease|market_report, `file` (application/pdf), optional `title`.
  → **202** `DocumentSummary` with status `queued` — must return without waiting for the LLM (target < 300 ms).
  400 on bad type / missing or non-PDF file (check `%PDF-` magic bytes), 413 if > 10 MB.
- `POST /documents/:id/versions` multipart `file` → **202** `DocumentSummary` (new version current, status `queued`).
  404 unknown doc. If the previous current version is still `queued`/`extracting`, that run becomes `superseded`.
- `GET /documents/:id?version=N` → 200 `DocumentDetail` (default = current version). 404 unknown doc/version.
- `GET /documents/:id/progress` → 200 `ProgressCounts` for the current version.
- `POST /documents/:id/retry` → 202 if current version status is `failed` (new run queued); 409 otherwise.
- `POST /values/:id/review` body `{ action: 'approve' }` | `{ action: 'correct', value: string, note?: string }` → 200 `ValueDTO`.
  400 on invalid body (correct without value). 404 unknown value. 409 if the value belongs to a non-current version.
  Re-reviewing is allowed (latest review wins; history kept). Corrections are stored BESIDE the extracted value (never overwrite it).
  Approving a gap is 400 (`code: 'gap_requires_correction'`) — a gap can only be corrected.
```ts
type Status = 'queued' | 'extracting' | 'extracted' | 'failed';
interface DocumentSummary { id: string; type: string; title: string; currentVersion: number; status: Status;
  error: string | null; progress: ProgressCounts; createdAt: string; updatedAt: string }
interface DocumentDetail extends DocumentSummary {
  version: number;                // the version being shown
  versions: Array<{ version: number; status: Status | 'superseded'; createdAt: string }>;
  text: string | null;            // parsed text of the shown version (null until parsed)
  values: ValueDTO[];             // [] until extracted; exactly one per expected field once extracted
}
interface ValueDTO { id: string; field: string; type: FieldType; value: unknown | null; rawValue: string | null;
  evidence: { quote: string; start: number; end: number } | null; gap: { reason: string; detail?: string } | null;
  reviewState: 'pending' | 'approved' | 'corrected' | 'carried_over';
  review: { action: 'approve' | 'correct'; value: string | null; note: string | null; createdAt: string } | null; // latest effective review (for carried_over: the carried review)
  effectiveValue: unknown | null;   // corrected value if corrected, else value
  previous: { version: number; value: unknown | null; evidenceQuote: string | null; reviewState: string;
              review: ValueDTO['review'] } | null;   // set when this version has a predecessor with this field
  changed: boolean }                // true when decision was 'changed'
```
Document `status` = status of the current version's latest run (`superseded` never shows as a document status).

## 4. Seed
On `docker compose up`, migrations run and documents `doc-invoice-001`, `doc-lease-001`, `doc-report-001` (ids exactly these,
titles/types from `fixtures/documents.json`) are created with **version 1 only**, each with a queued extraction run. Seeding is idempotent.

## 5. LLM providers (`@lomi/extraction`), selected by env `LLM_PROVIDER` = `anthropic` | `openai` | `mock` (default `mock` if no key)
- Prompt and raw response are stored per run (Postgres) and are visible via DB.
- **Mock provider** (deterministic, used by all automated tests) extracts the expected fields from the three fixture
  document types with regex heuristics that mimic a good LLM (label-anchored quotes), and supports test knobs via env:
  - `MOCK_LLM_DELAY_MS` (default 0) — sleep before answering.
  - `MOCK_LLM_FAIL` = `never` (default) | `always` | `once` — throw an error (once = only on attempt 1 of each run).
  - `MOCK_LLM_HALLUCINATE` = comma list of fields whose evidence is replaced by a quote NOT in the text.
  - Knobs are read per job (so tests can change them by restarting the worker with different env).
- Expected mock/LLM answers on fixtures (canonical values):
  - invoice v1: invoice_number "INV-2025-0847", issue_date "2025-09-14", due_date "2025-10-14", vendor_name "MERIDIAN OFFICE SUPPLIES LLC" (case-insensitive match ok), total_amount {amount:5230.29,currency:'USD'}
  - invoice v2: due_date "2025-11-13", total_amount {amount:6126.45,currency:'USD'}, others same as v1
  - lease: tenant_name "Dana Okafor", monthly_rent 2350.00, security_deposit 3525.00, lease_start "2025-03-01", term_months 24
  - market_report: report_quarter "Q3 2025", market_area "Eastport-Harborview Submarket", vacancy_rate 4.2, average_rent_1br 1985.00,
    year_over_year_rent_growth 3.8, median_household_income → **gap** (not in document).

## 6. Docker compose services (root `docker-compose.yml`)
`postgres` (5432, db/user/pass `lomi`), `redis` (6379), `migrate` (one-shot: prisma migrate deploy + seed), `api` (3001),
`worker`, `web` (8080). `docker compose up` from a clean clone works with no `.env` (mock LLM).
Integration tests use `API_URL` (default http://localhost:3001), `DATABASE_URL` (default postgres://lomi:lomi@localhost:5432/lomi),
`REDIS_URL` (default redis://localhost:6379), and may run `docker compose` commands (restart/kill worker, `redis-cli FLUSHALL`)
from the repo root. Worker env knobs for chaos tests are passed through compose from the host shell environment
(e.g. `MOCK_LLM_DELAY_MS=8000 docker compose up -d worker`).

## 7. Required behaviours (black-box testable)
1. Upload returns 202 fast even with `MOCK_LLM_DELAY_MS=8000`; status visible as queued/extracting, later extracted.
2. Kill/restart worker mid-extraction → doc ends `extracted` (or `failed` & retryable) within ~60 s; never stuck `extracting`.
3. Same version extracted twice (retry / redelivery / reconciler) → exactly one value per field for that version.
4. LLM/parse failure → `failed` with `error`; `POST /retry` → eventually `extracted`.
5. `redis-cli FLUSHALL` + restart → no values/reviews/outcomes lost; in-flight docs end extracted or failed-retryable (≤ ~60 s).
   Reconciler runs on worker boot and every `RECONCILE_INTERVAL_MS` (default 10000); lease `LEASE_MS` default 30000.
6. Hallucinated evidence → gap `evidence_not_in_text`; missing field → gap.
7. Upload invoice v2 after reviewing all v1 values → v2 progress = 2 pending (due_date, total_amount, `changed: true`, previous shown)
   + 3 carried_over; v1 still retrievable via `?version=1` with its reviews unchanged.
8. New version while previous extracting → previous run superseded; new version extracted; old version queryable.

## Addendum (additive changes after the spec suites were written)
Nothing above changed; these only add to it.
- `POST /values/:id/review` also accepts `{ action: 'confirm_missing', note?: string }`, **only on a gap** (400 `not_a_gap`
  otherwise). It records a review with `action: 'confirm_missing'` and sets `reviewState: 'approved'`, so a document whose
  field is genuinely absent can reach 0 pending. The value stays `null` (still counted in `gaps`), `effectiveValue` stays
  `null`, and it never carries over (carry-over needs a non-null value), so the gap is pending again in the next version.
  `{ action: 'approve' }` on a gap is still 400 `gap_requires_correction`. `ValueDTO.review.action` gains `'confirm_missing'`.
