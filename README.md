# Lomi extract

PDFs come in and an LLM extracts the expected fields. Each value has to carry a verbatim quote, and that quote is checked against the parsed text. A reviewer approves or corrects every value. When a document is revised, reviews carry over wherever the evidence is unchanged.

## Run it

```sh
docker compose up            # postgres, redis, migrate+seed (one-shot), api :3001, worker, web :8080
./scripts/smoke.sh           # end-to-end check: approve v1 → upload the revised invoice → 2 pending + 3 carried over
```

No `.env` is needed. The default LLM is a deterministic **mock**. To use a real model:

```sh
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... docker compose up -d worker   # claude-sonnet-5-5 (ANTHROPIC_MODEL to change)
LLM_PROVIDER=openai OPENAI_API_KEY=... docker compose up -d worker
```

If a port is taken, override it with `POSTGRES_PORT`, `REDIS_PORT`, `API_PORT` or `WEB_PORT`.

**What to click first**
1. Open http://localhost:8080. The three seeded documents are already `Extracted`, each with values to review.
2. Open the invoice. Every value sits beside its quote, and clicking a card highlights the quote in the document text. Approve all five values (or correct one and add a note).
3. Click **Upload new version** and pick `fixtures/documents/invoice-001.v2.pdf`. About a second later you get **2 changed** (due date, total), each showing what v1 said and how it was reviewed, plus **3 carried over**. The `v1` tab still shows v1 exactly as it was reviewed, read-only.
4. Open the market report. *Median household income* is a gap with its reason; it can be corrected but not approved.

Dev loop without Docker for the apps: `pnpm install && pnpm build`, run `docker compose up -d postgres redis migrate`, then `pnpm dev:api`, `pnpm dev:worker` and `pnpm dev:web` (Vite on :5173 proxies `/api`).

Checks: `pnpm build && pnpm lint && pnpm typecheck && pnpm test` (unit tests, no Docker). With the stack up, `pnpm test:integration` runs the black-box tests and `CHAOS=1 pnpm test:integration` also kills and restarts the worker and flushes Redis.

## Layout

```
packages/core        pure domain logic: normalisation, evidence matching, validation, carry-over, progress (no I/O)
packages/extraction  PDF → text, prompt, LLM providers (anthropic / openai / mock)
packages/db          Prisma schema + migrations, idempotent seed, the run state machine (conditional UPDATEs)
packages/config      shared tsconfig + eslint
apps/api             Fastify HTTP API
apps/worker          BullMQ consumer + reconciler
apps/web             Vite + React review UI (nginx in Docker, proxies /api)
tests/integration    black-box + chaos tests against the running stack
```

The split follows the rules most likely to be wrong. "Is this value supported by its quote?" and "is this unchanged since the last version?" live in `core` as pure functions, so they can be tested exhaustively against the real fixture text without a database. `db` owns every run state transition, so the API and worker can't drift apart on what "claim" or "supersede" means. Turbo runs `build → typecheck/lint/test` along the dependency graph (`^build`).

## Schema

```
documents(id, type, title, current_version)
document_versions(id, document_id, version_no, file_bytes, file_sha256, parsed_text, text_sha256)   unique(document_id, version_no)
extraction_runs(id, version_id, status, attempt, recoveries, lease_until, worker_id, error, prompt, raw_response, provider, model)
                 partial unique(version_id) where status in (queued, extracting)
extracted_values(id, version_id, run_id, field, type, value jsonb, raw_value, evidence_quote/start/end, gap_reason/detail,
                 review_state, changed, previous_value_id → extracted_values)   unique(version_id, field)
reviews(id, value_id, action approve|correct, value, note, carried_from_review_id, created_at)   append-only
```

- **Versions are immutable** and keep their own parsed text, so evidence offsets and the review UI for vN always refer to vN's text, even after vN+1 exists. The PDF bytes sit in Postgres too, which is fine at this scale (see the 10k section).
- **Values belong to a version, not to a document.** `unique(version_id, field)` makes duplicate extraction physically impossible. `previous_value_id` links a value to the value it was compared against in the prior version, which is how the UI shows "previously: X, approved".
- **Reviews are history.** The latest review is the effective one, and `review_state` on the value is a denormalised copy for cheap counts. A correction sits beside the extracted value and never overwrites it, so you can always see what the model said versus what the human said. Carry-over copies the previous effective review onto the new value (`carried_from_review_id`) rather than pointing at the old one, so later re-reviews stay per-version.
- **Runs are the durable job record.** Status, attempt, the error, the exact prompt and the raw response are all kept per run for debugging.

## Redis vs Postgres

**Postgres is the truth and Redis is a doorbell.** A BullMQ job carries only `{runId}`; it never holds data and is never the only record of work.

- **Upload:** one transaction inserts the version and a `queued` run, then the API returns 202. The enqueue happens afterwards and isn't awaited, and a failure is only logged. If Redis is down, the upload still succeeds.
- **Claim:** `UPDATE … SET status='extracting', lease_until=now()+LEASE WHERE id=? AND status='queued'`. Only one worker can win. A duplicate job, a superseded run or an already-finished run is a no-op.
- **Heartbeat:** the worker extends the lease every `LEASE_MS/3`. If the heartbeat finds the run no longer ours (superseded or recovered), the worker aborts.
- **Commit:** a single transaction `SELECT … FOR UPDATE`s the run, checks `status='extracting' AND attempt = mine`, inserts all values, applies carry-over and marks the run `extracted`. Late, duplicate and superseded runs commit nothing. `attempt` is a fencing token: every recovery bumps it, so a worker presumed dead that wakes up later cannot write.
- **Failure** (LLM error, unparseable PDF, missing API key) becomes `failed` with the error, prompt and raw response, never an exception that gets lost. `POST /retry` queues a fresh run.
- **Reconciler** (worker boot, then every `RECONCILE_INTERVAL_MS`):
  1. `extracting` runs with an expired lease go back to `queued` with attempt+1, or to `failed` after `MAX_RUN_ATTEMPTS` (3).
  2. Every `queued` run is (re-)added to BullMQ, deduplicated by the job id `run-<id>-a<attempt>`.

  On boot it also reclaims runs held under its own `WORKER_ID`, so a killed and restarted worker resumes in seconds instead of waiting out the lease.
- **Failure modes:**
  - `FLUSHALL`: jobs vanish, the reconciler re-adds every queued run within one tick, and in-flight work still commits to Postgres.
  - Worker `SIGKILL`: the restart reclaims its runs; a different worker takes over after lease expiry (≤ 30 s + 10 s).
  - `SIGTERM`: in-flight runs are handed back to `queued` immediately.
  - Redis down at upload: the run waits as `queued` until Redis returns.
  - Postgres down: the API returns 5xx and the worker retries; nothing half-written survives because every write is a single transaction.
  - Redis runs with persistence off on purpose, to prove it holds nothing that matters.

Verified manually and in `tests/integration/test/chaos.test.ts`:
- Worker killed mid-extraction (8 s mock delay): extracted after about 14 s via boot reclaim, or about 39 s via lease expiry with a new worker id.
- FLUSHALL with a job waiting and no restart: completed within one reconcile tick.
- FLUSHALL followed by a restart: nothing lost.

## Decisions the brief left open

- **Correction model: beside, not replace.** `value` is always what the model extracted. `review` is the latest human decision, and `effectiveValue` is the correction (normalised) or the value. History is kept.
- **"Unchanged" means same value AND the same supporting passage is still present, anywhere.** A review carries over only if:
  - the new canonical value deep-equals the old one, and
  - the old, reviewed quote still occurs (whitespace/typography-normalised, not fuzzy) somewhere in the new version's text.

  Position is irrelevant, so inserted paragraphs and shifted lines don't matter. A value that matches but whose surrounding passage was reworded goes back to review, because the reviewer approved that passage, not just the number. On the fixture this yields exactly `due_date` and `total_amount` as changed, even though the v2 text shifts and repeats "2025-09-14" in a new paragraph. The comparison target is the latest earlier version that has values, so a superseded vN-1 is skipped. A gap never carries over.
- **New version during extraction → supersede.** In-flight runs of older versions are marked `superseded` in the same transaction that creates the new version. Their workers notice at heartbeat or commit and drop the result. The old version stays queryable (`versions[].status = superseded`). Rejecting would make the user wait for a result they've already replaced, and queueing would spend LLM money on a dead version.
- **Polling, not streaming.** Extractions are rare and take seconds, and the only live state is a status flip. The UI polls every 2 s, only while something is `queued`/`extracting`, and stops otherwise. SSE or WebSockets would add a connection layer for no benefit here.
- **Parsed text is stored per version.** Parsing is deterministic, but storing it pins what the evidence was validated against (and `text_sha256` makes that auditable). It is parsed once by the worker, so a parse error is a visible `failed` state and the upload stays instant.
- **Hallucination defence:**
  - the quote must exist verbatim (after whitespace, smart-quote and PDF-escape normalisation) in this version's text;
  - the value must appear in the quote, so the subtotal-vs-total and prior-quarter-vacancy distractors are caught;
  - the value must parse for its type.

  Anything else becomes a gap with a reason, and the prompt tells the model a gap beats a guess.
- **PDF text keeps layout.** pdf.js items are re-laid out by x/y position (columns and blank lines preserved), so the text panel looks like the document and quotes highlight in place.

## Cut for time

- **Auth and users:** reviews have no reviewer identity.
- **Pagination and search** on the document list.
- **Real-LLM tests in CI:** the mock covers automated tests, and live calls are opt-in. I could not run the Anthropic/OpenAI providers against a live key in this environment.
- **Per-field confidence and multi-page citations.**
- **Production-slim Docker images:** runtime images carry the built workspace including dev dependencies.
- **Retry/backoff for transient LLM errors** inside a run: failures go straight to `failed` and the user retries.
- **A UI test (Playwright):** the UI was checked by hand plus unit tests of its pure helpers.

## Next

- Store PDFs in object storage (S3) with only the key in Postgres.
- Add automatic retry with backoff for 429/5xx, while keeping `failed` for permanent errors.
- Add reviewer identity and timestamps in the UI; keyboard-driven review (j/k, a = approve, c = correct).
- Add a golden-set eval against real models, with the stored prompt/raw response as the dataset.
- Add a "why did this go back to review?" diff of old vs new passage.

## At 10,000 documents

- **List and progress:** `GET /documents` currently loads every version's values to compute progress. Denormalise `status` and `progress` onto `documents` (updated in the commit and review transactions), paginate, and index `(status, updated_at)`.
- **Blobs:** move PDF bytes out of Postgres into object storage, and consider moving `parsed_text`/`raw_response` to TOAST-friendly side tables or cold storage.
- **Workers:** scale them horizontally. This is already safe, because claims and commits are fenced, but give each replica a unique `WORKER_ID`. Add BullMQ rate limiting per LLM provider, priority for interactive uploads over bulk backfills, and the provider's batch API for backfills.
- **Reconciler:** it scans `queued` and expired runs. Keep it to indexed queries (`status, lease_until` is indexed) with a `LIMIT`, and run it on one elected worker (advisory lock) instead of every replica.
- **Operations:** add cost and latency metrics per run (tokens are already in the raw response), alerts on failure rate, and a dead-letter view of `failed` runs.
