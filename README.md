# Lomi extract

An LLM extracts fields from PDFs. Each extracted value has to quote the text it came from, and that quote is checked against the parsed document. A person approves or corrects every value, and when a revised version is uploaded, reviews carry over wherever the evidence hasn't changed.

**Stack:** pnpm + Turborepo · Node/TypeScript · Fastify · BullMQ (Redis) · Postgres (Prisma) · React (Vite).

## Quick start

```sh
docker compose up -d --build --wait   # postgres, redis, migrate + seed, api :3001, worker, web :8080
./scripts/smoke.sh                    # end-to-end: approve v1 → upload revised invoice → 2 pending + 3 carried over
```

- **No `.env` needed.** The LLM defaults to a deterministic mock. To use a real model, set `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`, or `LLM_PROVIDER=openai` with `OPENAI_API_KEY` (see [`.env.example`](.env.example)).
- **Port taken?** Set `POSTGRES_PORT`, `REDIS_PORT`, `API_PORT` or `WEB_PORT`, and the URLs below become `localhost:$WEB_PORT` and so on. Put them in `.env` (see [`.env.example`](.env.example)) or export them in every shell, so the `docker compose` calls in `smoke.sh` and the tests see the same ports; the integration suites also need `API_URL`, `WEB_URL`, `REDIS_URL` and `DATABASE_URL` pointing at them.
- **Local dev:** `pnpm install && pnpm build`, then `docker compose up -d postgres redis migrate`, then `pnpm dev:api`, `pnpm dev:worker` and `pnpm dev:web`. The API and worker default to `redis://localhost:6379` and Postgres on `localhost:5432`; if you overrode those ports, export `REDIS_URL` and `DATABASE_URL` to match.

**What to click first** (on a fresh stack: `smoke.sh` re-versions the seeded invoice, so after running it reset with `docker compose down -v && docker compose up -d`)
1. Open http://localhost:8080. The three seeded documents are already **Extracted**.
2. Open the invoice. Each value sits beside its quote, and clicking a value highlights the quote in the text. Approve all five, or correct one.
3. Click **Upload new version** and choose `fixtures/documents/invoice-001.v2.pdf`. You get **2 changed** (due date and total, each showing v1's value and review) and **3 carried over**. The `v1` tab is still there, read-only.
4. Open the market report. **Median household income** is a gap with a reason: you can correct it or confirm it is missing, but not approve it.

## Layout

| Path | Role |
|---|---|
| [`packages/core`](packages/core/src) | Pure rules (no I/O): [evidence matching](packages/core/src/text.ts), [normalisation](packages/core/src/normalize.ts), [validation and gaps](packages/core/src/validate.ts), [carry-over](packages/core/src/carryover.ts), [progress](packages/core/src/progress.ts) |
| [`packages/extraction`](packages/extraction/src) | [PDF → text](packages/extraction/src/pdf.ts), [prompt](packages/extraction/src/prompt.ts), providers: [anthropic](packages/extraction/src/providers/anthropic.ts), [openai](packages/extraction/src/providers/openai.ts), [mock](packages/extraction/src/providers/mock.ts) |
| [`packages/db`](packages/db) | [Prisma schema](packages/db/prisma/schema.prisma), migrations, [run state machine](packages/db/src/runs.ts), [idempotent seed](packages/db/src/seed.ts) |
| [`apps/api`](apps/api/src) | Fastify routes ([`app.ts`](apps/api/src/app.ts)) and DTOs ([`dto.ts`](apps/api/src/dto.ts)) |
| [`apps/worker`](apps/worker/src) | BullMQ consumer ([`process.ts`](apps/worker/src/process.ts)), fenced commit ([`commit.ts`](apps/worker/src/commit.ts)), [reconciler](apps/worker/src/reconciler.ts) |
| [`apps/web`](apps/web/src) | Review UI: [list](apps/web/src/components/DocumentList.tsx), [detail](apps/web/src/components/DocumentDetail.tsx), [value card](apps/web/src/components/ValueCard.tsx) |
| [`tests/`](tests) | Black-box integration suites, including an [independent spec suite](tests/spec-integration) |

**Why this split.** The two rules most likely to be wrong are "does this quote support the value?" and "is this value unchanged since the last version?". Both live in `core` as pure functions, so they're tested exhaustively against the real fixture text. Every run state transition lives in `db`, so the API and worker can't disagree. Turbo runs `build → lint/typecheck/test` along the dependency graph ([`turbo.json`](turbo.json)).

## Schema ([`schema.prisma`](packages/db/prisma/schema.prisma))

```
documents          id, type, title, current_version
document_versions  document_id, version_no, file_bytes, parsed_text, text_sha256        unique(document_id, version_no)
extraction_runs    version_id, status, attempt, lease_until, worker_id, error, prompt, raw_response
                   partial unique(version_id) WHERE status IN (queued, extracting)
extracted_values   version_id, field, value, raw_value, evidence quote/start/end, gap_reason, claimed_evidence,
                   review_state, changed, previous_value_id                                 unique(version_id, field)
reviews            value_id, action (approve|correct|confirm_missing), value, note, carried_from_review_id   append-only
```

- **Versions are immutable** and store their own parsed text, so vN's evidence and review screen always use vN's text.
- **Values belong to a version.** `unique(version_id, field)` makes a duplicate extraction impossible. `previous_value_id` is what drives the "previously: X, approved" view.
- **Reviews are an append-only history.** A correction sits beside the extracted value and never overwrites it. The latest review is the effective one.
- **Runs are the durable job record.** Each one stores its status, attempt, error, prompt and raw LLM response.

## Redis vs Postgres

**Postgres is the source of truth; Redis only signals work.** A BullMQ job carries just `{runId}`.

| Step | What happens |
|---|---|
| Upload | One transaction inserts the version plus a `queued` run, then returns 202. The enqueue isn't awaited, so the upload succeeds even if Redis is down. |
| Claim | `UPDATE … WHERE status='queued'`. Exactly one worker wins, so duplicate jobs do nothing. |
| Heartbeat | Extends the lease every `LEASE_MS/3`. If the run has been superseded or recovered, the worker aborts. |
| Commit | One transaction: `FOR UPDATE` the run, check `status='extracting' AND attempt = mine`, write the values, apply carry-over, mark the run `extracted`. `attempt` acts as a fencing token. |
| Failure | An LLM error, unparseable PDF or missing key sets the run to `failed` with the error, prompt and response. `POST /documents/:id/retry` re-queues it. |
| Reconciler | Runs on worker boot and every `RECONCILE_INTERVAL_MS`. Expired leases go back to `queued` (or `failed` after 3 attempts), and every queued run is re-added to BullMQ, deduplicated by job id. |

- **`FLUSHALL`:** the reconciler re-adds queued runs within one tick, and nothing is lost.
- **Worker killed:** it reclaims its own runs on restart; a different worker takes over once the lease expires (about 30 s).
- **`SIGTERM`:** in-flight runs go back to `queued` straight away.
- **Postgres down:** the API returns 5xx and the worker retries. Every write is a single transaction.
- **Redis persistence is off on purpose,** to show it holds nothing that matters.

## Decisions the brief left open

- **Corrections are stored beside the value, not over it.** `value` is always the model's output, `review` is the latest human decision, and `effectiveValue` is the correction if there is one, otherwise the value.
- **"Unchanged" means the same value and the same supporting passage.** A review carries over only when the new value deep-equals the old one and the reviewed quote still appears somewhere in the new text. Position doesn't matter. On the fixture this gives exactly `due_date` and `total_amount` as changed, even though the v2 text shifts. Gaps never carry over.
- **Gaps reach "done" by correction or by `confirm_missing`** (gaps only; recorded as an approved review, value stays `null`). Approving a gap is still refused, and a confirmed gap never carries over: absence has no quote to re-check, so each version asks again.
- **A new version during extraction supersedes the old one.** Older in-flight runs are marked `superseded` in the same transaction that creates the new version, and their results are dropped. The old version stays queryable. Rejecting the upload would make the user wait for a result they've already replaced; queueing would spend LLM calls on a dead version.
- **Polling, not streaming.** The UI polls every 2 s, and only while something is `queued` or `extracting`.
- **Parsed text is stored per version** (with `text_sha256`), which pins what the evidence was validated against.
- **Defences against hallucinated values:**
  - the quote must appear verbatim in this version's text, after normalising whitespace and typography (no fuzzy matching);
  - the value must appear inside its quote, which catches distractors like subtotal vs total;
  - the value must parse as its type.

  Anything that fails becomes a gap with a reason. The rejected claim (raw value and quote) is kept beside the gap so the reviewer sees what the model said, but it is never used as evidence.

## Tests

The spec suites were written by an independent QA author from the brief and [`CONTRACT.md`](CONTRACT.md) alone, without seeing the code. [`TEST_TRIAGE.md`](TEST_TRIAGE.md) has the run results, coverage, bugs found and a map from each requirement in the brief to its tests.

| Suite | Run | Needs |
|---|---|---|
| Unit (incl. independent [core spec](packages/core/test/spec)) | `pnpm test` | nothing |
| DB-backed (state machine, commit races, API end to end) | `pnpm test:db` | `docker compose up -d postgres` |
| Entry points (real processes: boot, SIGTERM, DB/Redis outages) | `pnpm test:process` | postgres + redis |
| Coverage (all of the above, merged) | `pnpm coverage` | postgres + redis |
| [Independent integration spec](tests/spec-integration) | `pnpm test:spec-integration` | fresh stack |
| [Integration + chaos](tests/integration) | `CHAOS=1 pnpm test:integration` | fresh stack |
| [Smoke](scripts/smoke.sh) | `./scripts/smoke.sh` | Docker |

The integration suites are destructive: they kill the worker, flush this stack's Redis and create many documents. Run them one at a time against a fresh stack (`docker compose down -v && docker compose up -d --build --wait`). Run the spec suite before `smoke.sh`, which re-versions the seed invoice.

## Cut for time

- No auth or reviewer identity, and no pagination or search.
- **Real LLM providers have not been run against a live API.** They are tested through their real SDKs over a stubbed HTTP layer. Live calls are opt-in.
- No automatic backoff for transient LLM errors: a failure goes to `failed` and the user retries.
- Runtime images aren't slimmed.

Implementation deviations from the contract are listed in [`DEVIATIONS.md`](DEVIATIONS.md).

## Next

- Move PDFs to object storage and keep only the key in Postgres.
- Retry with backoff on 429/5xx, keeping `failed` for permanent errors.
- Add reviewer identity and keyboard-driven review.
- Build a golden-set eval against real models, using the stored prompts and responses as the dataset.

## At 10,000 documents

- **List:** denormalise `status`/`progress` onto `documents`, paginate, and index `(status, updated_at)`.
- **Blobs:** move PDFs to object storage, and move `parsed_text`/`raw_response` to side tables.
- **Workers:** scale horizontally, which is already safe because claims and commits are fenced. Give each worker a unique `WORKER_ID`, rate-limit per provider, prioritise interactive uploads, and use batch APIs for backfills.
- **Reconciler:** keep its scans indexed and limited, and run it on a single elected worker (advisory lock).
- **Ops:** per-run cost and latency metrics, failure-rate alerts, and a dead-letter view of failed runs.
