/**
 * Black-box helpers for the integration suite. Everything here talks to the running stack only through:
 *   - the HTTP API (CONTRACT §3), - `docker compose` from REPO_ROOT, - Postgres / Redis connection URLs (§6).
 * No implementation code is imported.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { Redis } from 'ioredis';
import { expect } from 'vitest';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

// ───────────────────────────── configuration ─────────────────────────────

export const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
export const WEB_URL = (process.env.WEB_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://lomi:lomi@localhost:5432/lomi';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

function walkUp(start: string, test: (dir: string) => string | null): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const hit = test(dir);
    if (hit) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export const REPO_ROOT: string =
  process.env.REPO_ROOT ??
  walkUp(here, (d) =>
    ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some((f) => existsSync(join(d, f))) ? d : null,
  ) ??
  '/Users/jkjarvis/workspace/lomi/lomi-extract';

export const FIXTURES_DIR: string =
  process.env.FIXTURES_DIR ??
  (existsSync(join(REPO_ROOT, 'fixtures', 'documents.json'))
    ? join(REPO_ROOT, 'fixtures')
    : walkUp(here, (d) => {
        for (const c of [join(d, 'fixtures'), join(d, 'take-home-assignment', 'fixtures')]) {
          if (existsSync(join(c, 'documents.json'))) return c;
        }
        return null;
      }) ?? join(REPO_ROOT, 'fixtures'));

// ───────────────────────────── contract types (§3) ─────────────────────────────

export type Status = 'queued' | 'extracting' | 'extracted' | 'failed';
export type DocType = 'invoice' | 'lease' | 'market_report';
export type ReviewState = 'pending' | 'approved' | 'corrected' | 'carried_over';

export interface ProgressCounts {
  total: number;
  pending: number;
  approved: number;
  corrected: number;
  carriedOver: number;
  gaps: number;
}
export interface Review {
  action: 'approve' | 'correct';
  value: string | null;
  note: string | null;
  createdAt: string;
}
export interface ValueDTO {
  id: string;
  field: string;
  type: string;
  value: unknown | null;
  rawValue: string | null;
  evidence: { quote: string; start: number; end: number } | null;
  gap: { reason: string; detail?: string } | null;
  reviewState: ReviewState;
  review: Review | null;
  effectiveValue: unknown | null;
  previous: {
    version: number;
    value: unknown | null;
    evidenceQuote: string | null;
    reviewState: string;
    review: Review | null;
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
  versions: Array<{ version: number; status: Status | 'superseded'; createdAt: string }>;
  text: string | null;
  values: ValueDTO[];
}

// ───────────────────────────── fixtures ─────────────────────────────

export const FIXTURE_FILES = {
  invoiceV1: 'invoice-001.pdf',
  invoiceV2: 'invoice-001.v2.pdf',
  lease: 'lease-excerpt-001.pdf',
  marketReport: 'market-report-excerpt-001.pdf',
} as const;
export type FixtureName = keyof typeof FIXTURE_FILES;
export const FIXTURE_TYPE: Record<FixtureName, DocType> = {
  invoiceV1: 'invoice',
  invoiceV2: 'invoice',
  lease: 'lease',
  marketReport: 'market_report',
};

export function readFixture(name: FixtureName): Buffer {
  return readFileSync(join(FIXTURES_DIR, 'documents', FIXTURE_FILES[name]));
}

export function expectedFields(): Record<DocType, Array<{ field: string; type: string }>> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'expected-fields.json'), 'utf8'));
}

export function manifest(): Array<{ id: string; type: DocType; title: string; versions: Array<{ version: number; file: string }> }> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'documents.json'), 'utf8'));
}

/** Canonical values (CONTRACT §5). `null` = must be a gap. */
export const CANONICAL: Record<FixtureName, Record<string, unknown>> = {
  invoiceV1: {
    invoice_number: 'INV-2025-0847',
    issue_date: '2025-09-14',
    due_date: '2025-10-14',
    vendor_name: 'MERIDIAN OFFICE SUPPLIES LLC',
    total_amount: { amount: 5230.29, currency: 'USD' },
  },
  invoiceV2: {
    invoice_number: 'INV-2025-0847',
    issue_date: '2025-09-14',
    due_date: '2025-11-13',
    vendor_name: 'MERIDIAN OFFICE SUPPLIES LLC',
    total_amount: { amount: 6126.45, currency: 'USD' },
  },
  lease: {
    tenant_name: 'Dana Okafor',
    monthly_rent: { amount: 2350, currency: 'USD' },
    security_deposit: { amount: 3525, currency: 'USD' },
    lease_start: '2025-03-01',
    term_months: 24,
  },
  marketReport: {
    report_quarter: 'Q3 2025',
    market_area: 'Eastport-Harborview Submarket',
    vacancy_rate: 4.2,
    average_rent_1br: { amount: 1985, currency: 'USD' },
    year_over_year_rent_growth: 3.8,
    median_household_income: null,
  },
};
const CASE_INSENSITIVE = new Set(['vendor_name']);

// ───────────────────────────── HTTP ─────────────────────────────

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  ms: number;
  headers: Headers;
}

export async function api<T = any>(
  method: string,
  path: string,
  opts: { json?: unknown; form?: FormData; base?: string } = {},
): Promise<ApiResponse<T>> {
  const init: RequestInit = { method, headers: {} };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  } else if (opts.form) {
    init.body = opts.form;
  }
  const t0 = performance.now();
  const res = await fetch(`${opts.base ?? API_URL}${path}`, init);
  const raw = await res.text();
  const ms = performance.now() - t0;
  let body: any = raw;
  if ((res.headers.get('content-type') ?? '').includes('json') && raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      /* keep text */
    }
  }
  return { status: res.status, body, ms, headers: res.headers };
}

export function describeRes(r: ApiResponse): string {
  return `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 600)}`;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function pdfForm(
  file: Buffer | null,
  fields: Record<string, string> = {},
  filename = 'upload.pdf',
  contentType = 'application/pdf',
): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('file', new Blob([toArrayBuffer(file)], { type: contentType }), filename);
  return form;
}

let uploadCounter = 0;
export function uniqueTitle(prefix: string): string {
  uploadCounter += 1;
  return `[it] ${prefix} ${new Date().toISOString()} #${uploadCounter}`;
}

/** POST /documents — raw response (no assertions). */
export function uploadDocumentRaw(type: string, file: Buffer | null, title?: string) {
  return api<DocumentSummary>('POST', '/documents', {
    form: pdfForm(file, title === undefined ? { type } : { type, title }, 'document.pdf'),
  });
}

/** POST /documents with a fixture, asserting the 202 contract. */
export async function uploadFixture(name: FixtureName, title = uniqueTitle(name)): Promise<DocumentSummary> {
  const r = await uploadDocumentRaw(FIXTURE_TYPE[name], readFixture(name), title);
  expect(r.status, `upload ${name}: ${describeRes(r)}`).toBe(202);
  expect(typeof r.body.id, 'upload response must carry the document id').toBe('string');
  return r.body;
}

/** POST /documents/:id/versions with a fixture, asserting 202. */
export async function uploadVersion(docId: string, name: FixtureName): Promise<DocumentSummary> {
  const r = await api<DocumentSummary>('POST', `/documents/${encodeURIComponent(docId)}/versions`, {
    form: pdfForm(readFixture(name), {}, FIXTURE_FILES[name]),
  });
  expect(r.status, `upload version ${name} to ${docId}: ${describeRes(r)}`).toBe(202);
  return r.body;
}

export async function getDetail(docId: string, version?: number): Promise<DocumentDetail> {
  const r = await api<DocumentDetail>('GET', `/documents/${encodeURIComponent(docId)}${version ? `?version=${version}` : ''}`);
  expect(r.status, `GET /documents/${docId}${version ? `?version=${version}` : ''}: ${describeRes(r)}`).toBe(200);
  return r.body;
}

export async function getProgress(docId: string): Promise<ProgressCounts> {
  const r = await api<ProgressCounts>('GET', `/documents/${encodeURIComponent(docId)}/progress`);
  expect(r.status, `GET progress ${docId}: ${describeRes(r)}`).toBe(200);
  return r.body;
}

export function review(valueId: string, body: unknown) {
  return api<ValueDTO>('POST', `/values/${encodeURIComponent(valueId)}/review`, { json: body });
}

export async function reviewOk(valueId: string, body: unknown): Promise<ValueDTO> {
  const r = await review(valueId, body);
  expect(r.status, `review ${valueId} ${JSON.stringify(body)}: ${describeRes(r)}`).toBe(200);
  return r.body;
}

export function retry(docId: string) {
  return api('POST', `/documents/${encodeURIComponent(docId)}/retry`);
}

// ───────────────────────────── polling ─────────────────────────────

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WaitResult {
  detail: DocumentDetail;
  /** distinct consecutive document statuses observed while polling (includes 'unreachable' when the API was down) */
  history: string[];
}

/**
 * Poll GET /documents/:id until `status` ∈ statuses. Tolerates the API being temporarily unreachable
 * (e.g. during a restart). Throws with the observed status history on timeout.
 */
export async function waitForStatus(
  docId: string,
  statuses: Status[],
  timeoutMs = 120_000,
  opts: { intervalMs?: number; history?: string[] } = {},
): Promise<WaitResult> {
  const history = opts.history ?? [];
  const push = (s: string) => {
    if (history[history.length - 1] !== s) history.push(s);
  };
  const deadline = Date.now() + timeoutMs;
  let last: DocumentDetail | null = null;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const r = await api<DocumentDetail>('GET', `/documents/${encodeURIComponent(docId)}`);
      if (r.status === 200) {
        last = r.body;
        push(r.body.status);
        if (statuses.includes(r.body.status)) return { detail: r.body, history };
      } else {
        push(`http_${r.status}`);
        lastErr = describeRes(r);
      }
    } catch (e) {
      push('unreachable');
      lastErr = String(e);
    }
    await sleep(opts.intervalMs ?? 300);
  }
  throw new Error(
    `document ${docId} did not reach [${statuses.join('|')}] within ${timeoutMs} ms` +
      ` — last status=${last?.status ?? 'n/a'} error=${JSON.stringify(last?.error ?? null)}` +
      ` history=${history.join(' → ')}${lastErr ? ` lastErr=${lastErr}` : ''}` +
      (last?.status === 'extracting' ? ' (STUCK in extracting?)' : ''),
  );
}

/**
 * Wait until the document is terminal; `failed` is acceptable ONLY if it is retryable:
 * we POST /retry (must be 202) and then require `extracted`.
 */
export async function settleExtracted(
  docId: string,
  timeoutMs = 120_000,
): Promise<WaitResult & { retried: boolean }> {
  const t0 = Date.now();
  const first = await waitForStatus(docId, ['extracted', 'failed'], timeoutMs);
  if (first.detail.status === 'extracted') return { ...first, retried: false };
  expect(first.detail.error, 'a failed document must carry a non-empty error').toBeTruthy();
  const r = await retry(docId);
  expect(r.status, `failed document must be retryable: ${describeRes(r)}`).toBe(202);
  const second = await waitForStatus(docId, ['extracted'], Math.max(30_000, timeoutMs - (Date.now() - t0)), {
    history: first.history,
  });
  return { ...second, retried: true };
}

export async function waitForHealth(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await api('GET', '/health');
      if (r.status === 200 && r.body && r.body.ok === true) return;
      last = describeRes(r);
    } catch (e) {
      last = String(e);
    }
    await sleep(500);
  }
  throw new Error(`API not healthy within ${timeoutMs} ms: ${last}`);
}

// ───────────────────────────── docker compose ─────────────────────────────

export const DEFAULT_KNOBS = { MOCK_LLM_DELAY_MS: '0', MOCK_LLM_FAIL: 'never', MOCK_LLM_HALLUCINATE: '' };
export type Knobs = Partial<typeof DEFAULT_KNOBS>;
let currentKnobs: typeof DEFAULT_KNOBS = { ...DEFAULT_KNOBS };

export async function compose(args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', ['compose', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (e: any) {
    throw new Error(`docker compose ${args.join(' ')} failed (cwd=${REPO_ROOT}): ${e?.stderr || e?.message || e}`);
  }
}

async function waitForServiceRunning(service: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await compose(['ps', '--status', 'running', '--services'], currentKnobs).catch(() => '');
    if (out.split(/\s+/).includes(service)) return;
    await sleep(500);
  }
  throw new Error(`service ${service} not running within ${timeoutMs} ms`);
}

/** Recreate the worker with the given mock-LLM knobs (unspecified knobs reset to defaults). */
export async function restartWorker(knobs: Knobs = {}): Promise<void> {
  currentKnobs = { ...DEFAULT_KNOBS, ...knobs };
  await compose(['up', '-d', '--no-deps', '--force-recreate', 'worker'], currentKnobs);
  await waitForServiceRunning('worker');
}

/** SIGKILL the worker (no graceful shutdown). */
export async function killWorker(): Promise<void> {
  await compose(['kill', 'worker'], currentKnobs);
}

/** Start the worker again with the knobs of the last restartWorker() call. */
export async function startWorker(): Promise<void> {
  await compose(['up', '-d', '--no-deps', 'worker'], currentKnobs);
  await waitForServiceRunning('worker');
}

export async function stopWorker(): Promise<void> {
  await compose(['stop', 'worker'], currentKnobs);
}

/** `docker compose restart <services>` (keeps each container's env), then wait for /health. */
export async function restartServices(services: string[]): Promise<void> {
  await compose(['restart', ...services], currentKnobs);
  for (const s of services) await waitForServiceRunning(s);
  await waitForHealth();
}

/**
 * FLUSHALL on THIS compose project's Redis. Always goes through `docker compose exec redis` (run from REPO_ROOT), never
 * through a host port: the host may run an unrelated Redis on the default 6379, and flushing that one would be a disaster.
 * REDIS_URL is used only as an extra identity check when set: a nonce written through the compose service must be
 * readable through REDIS_URL, otherwise the flush is refused.
 */
export async function flushRedis(): Promise<void> {
  const cli = (...args: string[]) => compose(['exec', '-T', 'redis', 'redis-cli', ...args], currentKnobs).then((s) => s.trim());
  if (process.env.REDIS_URL) {
    const nonce = `spec-it:identity:${process.pid}:${Date.now()}`;
    expect(await cli('SET', nonce, '1', 'EX', '60')).toBe('OK');
    const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2, connectTimeout: 5_000 });
    try {
      await redis.connect();
      expect(await redis.get(nonce), `REDIS_URL=${REDIS_URL} is not this stack's Redis; refusing to flush`).toBe('1');
    } finally {
      redis.disconnect();
    }
  }
  expect(await cli('FLUSHALL')).toBe('OK');
  expect(await cli('DBSIZE')).toBe('0');
}

// ───────────────────────────── Postgres (defensive discovery) ─────────────────────────────

export async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const q = (ident: string) => {
  if (!IDENT.test(ident)) throw new Error(`refusing to quote identifier ${ident}`);
  return `"${ident}"`;
};

async function columnsByTable(c: pg.Client): Promise<Map<string, string[]>> {
  const { rows } = await c.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`,
  );
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.table_name, [...(map.get(r.table_name) ?? []), r.column_name]);
  return map;
}

export interface ValuesTable {
  table: string;
  idCol: string;
  fieldCol: string;
  versionCol: string;
}

/** Find the table holding extracted values: has id, field and version_id/versionId columns. */
export async function discoverValuesTable(c: pg.Client): Promise<ValuesTable | null> {
  const tables = await columnsByTable(c);
  const candidates: ValuesTable[] = [];
  for (const [table, cols] of tables) {
    const idCol = cols.find((x) => x === 'id');
    const fieldCol = cols.find((x) => /^field(_?name)?$/i.test(x));
    const versionCol = cols.find((x) => /^(document_?)?version_?id$/i.test(x));
    if (idCol && fieldCol && versionCol) candidates.push({ table, idCol, fieldCol, versionCol });
  }
  candidates.sort((a, b) => Number(/value/i.test(b.table)) - Number(/value/i.test(a.table)));
  return candidates[0] ?? null;
}

/**
 * Per-field row counts in Postgres for the version that owns `valueId` (a value id from the API).
 * Returns null (with a warning) when the schema cannot be discovered — callers then rely on API assertions.
 */
export async function dbValueCountsForVersionOf(valueId: string): Promise<Record<string, number> | null> {
  try {
    return await withDb(async (c) => {
      const t = await discoverValuesTable(c);
      if (!t) {
        console.warn('[integration] could not discover the extracted-values table; DB-level count skipped');
        return null;
      }
      const v = await c.query(`SELECT ${q(t.versionCol)} AS v FROM ${q(t.table)} WHERE ${q(t.idCol)}::text = $1`, [valueId]);
      if (v.rowCount !== 1) {
        console.warn(`[integration] value ${valueId} not found in ${t.table}; DB-level count skipped`);
        return null;
      }
      const { rows } = await c.query<{ field: string; n: number }>(
        `SELECT ${q(t.fieldCol)} AS field, count(*)::int AS n FROM ${q(t.table)} WHERE ${q(t.versionCol)} = $1 GROUP BY 1`,
        [v.rows[0].v],
      );
      return Object.fromEntries(rows.map((r) => [r.field, r.n]));
    });
  } catch (e) {
    console.warn(`[integration] DB-level count skipped: ${String(e)}`);
    return null;
  }
}

/** Find a table storing per-run prompt + raw LLM response (CONTRACT §5). */
export async function discoverRunLogTable(c: pg.Client): Promise<{ table: string; promptCol: string; responseCol: string } | null> {
  const tables = await columnsByTable(c);
  for (const [table, cols] of tables) {
    const promptCol = cols.find((x) => /prompt/i.test(x));
    const responseCol = cols.find((x) => /raw_?(llm_?)?response|response_?raw|llm_?response/i.test(x)) ?? cols.find((x) => /response/i.test(x));
    if (promptCol && responseCol) return { table, promptCol, responseCol };
  }
  return null;
}

// ───────────────────────────── assertions ─────────────────────────────

export function byField(values: ValueDTO[]): Record<string, ValueDTO> {
  return Object.fromEntries(values.map((v) => [v.field, v]));
}

/** Exactly one value per expected field (API level), plus the Postgres-level check when discoverable. */
export async function expectOneValuePerField(detail: DocumentDetail): Promise<void> {
  const spec = expectedFields()[detail.type as DocType];
  const fields = detail.values.map((v) => v.field).sort();
  expect(fields, `${detail.id} v${detail.version}: one value per expected field`).toEqual(spec.map((s) => s.field).sort());
  expect(new Set(detail.values.map((v) => v.id)).size).toBe(detail.values.length);
  const counts = await dbValueCountsForVersionOf(detail.values[0].id);
  if (counts) {
    for (const s of spec) {
      expect(counts[s.field] ?? 0, `Postgres rows for ${detail.id} v${detail.version} field ${s.field}`).toBe(1);
    }
    expect(Object.keys(counts).sort(), 'no extra fields stored in Postgres').toEqual(spec.map((s) => s.field).sort());
  }
}

/** Values equal CONTRACT §5 canonical values; gaps are gaps with a reason. */
export function expectCanonicalValues(detail: DocumentDetail, fixture: FixtureName): void {
  const vals = byField(detail.values);
  for (const [field, expected] of Object.entries(CANONICAL[fixture])) {
    const v = vals[field];
    expect(v, `${detail.id}: missing value for ${field}`).toBeDefined();
    if (expected === null) {
      expect(v.value, `${field} must be a gap`).toBeNull();
      expect(v.gap, `${field} must carry a gap`).not.toBeNull();
      expect(typeof v.gap!.reason === 'string' && v.gap!.reason.length > 0, `${field} gap needs a reason`).toBe(true);
      continue;
    }
    expect(v.gap, `${field}: unexpected gap ${JSON.stringify(v.gap)}`).toBeNull();
    if (CASE_INSENSITIVE.has(field)) {
      expect(String(v.value).toLowerCase(), field).toBe(String(expected).toLowerCase());
    } else {
      expect(v.value, field).toEqual(expected);
    }
  }
}

/** Every non-gap value has evidence that is literally the shown version's text at its offsets. */
export function expectEvidenceInvariants(detail: DocumentDetail): void {
  expect(typeof detail.text, `${detail.id} v${detail.version}: text must be present once extracted`).toBe('string');
  const text = detail.text!;
  for (const v of detail.values) {
    expect(v.gap === null, `${v.field}: gap non-null ⇔ value null`).toBe(v.value !== null);
    if (v.value === null) continue;
    expect(v.evidence, `${v.field}: non-gap value must carry evidence`).not.toBeNull();
    const { quote, start, end } = v.evidence!;
    expect(quote.trim().length, `${v.field}: evidence quote non-empty`).toBeGreaterThan(0);
    expect(text.slice(start, end), `${v.field}: quote must equal text.slice(start, end)`).toBe(quote);
    expect(text.includes(quote), `${v.field}: quote must appear in the version text`).toBe(true);
  }
}

export function expectProgressPartition(p: ProgressCounts): void {
  expect(p.pending + p.approved + p.corrected + p.carriedOver, `progress buckets must partition total: ${JSON.stringify(p)}`).toBe(p.total);
}

/** Stable projection of a document used for before/after comparisons. */
export function snapshotOf(detail: DocumentDetail) {
  return {
    id: detail.id,
    currentVersion: detail.currentVersion,
    status: detail.status,
    version: detail.version,
    values: [...detail.values].sort((a, b) => a.field.localeCompare(b.field)),
  };
}
