# Test triage: independent spec suites vs. the implementation

An independent QA author wrote the spec suites from `CONTRACT.md` and the brief, without seeing the implementation. The source is `../spec-tests`, and the copies in this repo are:

- `packages/core/test/spec/`: 7 files, 368 tests, part of `@lomi/core`'s vitest run (`pnpm test`).
- `tests/spec-integration/`: 13 files, 59 tests, workspace package `@lomi/spec-integration-tests`, run with `pnpm test:spec-integration`.

## Failures

**None.** Both spec suites passed on the first run against a fresh stack (`docker compose down -v && docker compose up -d --build`). I made no code or test changes to get them green. The integration spec suite then passed twice more on the same stack, which makes 3/3 consecutive green runs (59/59 each, about 155 s each). No test was retried, skipped, loosened or deleted.

| Test | Failure | Root cause | Decision | Justification |
|---|---|---|---|---|
| (none) | – | – | – | Core spec 368/368 and integration spec 59/59 on the first run; integration spec stable over 3 runs. |

To rule out vacuous passes, I checked:
- No `[integration] … DB-level count skipped` warnings were logged. The Postgres one-row-per-field check (`extracted_values`, `version_id`, `field`) and the prompt/raw-response table discovery both found real tables, so those assertions ran for real.
- The chaos tests really went through their states. The failure tests observed `failed`, and the supersede tests observed a `superseded` v1 run. Kill/restart/FLUSHALL recovered in about 9–19 s, well inside the 90 s bound.

## Changes made to the spec suites while copying them in (none weaken an assertion)

| File | Change | Why |
|---|---|---|
| `tests/spec-integration/helpers.ts` `flushRedis()` | Originally: FLUSHALL through `ioredis` on `REDIS_URL` (default `redis://localhost:6379`), falling back to `compose exec`. Now: always `docker compose exec -T redis redis-cli FLUSHALL` from `REPO_ROOT`, then asserts `DBSIZE` = 0. When `REDIS_URL` is set, it first writes a nonce through the compose service and requires that `REDIS_URL` can read it back; otherwise it refuses to flush. | Safety. This machine runs an unrelated Redis on 6379, and this stack's Redis is on 6380 (via the gitignored `.env`). The suite's default URL would have flushed the wrong Redis. The semantics are unchanged (FLUSHALL of the stack's Redis, CONTRACT §6 allows "`redis-cli FLUSHALL`"), and the post-condition is still asserted. |
| `tests/spec-integration/helpers.ts` | Removed the unused `resolve` import. | The repo's eslint config (`no-unused-vars`) runs over every package in `turbo run lint`. |
| `tests/spec-integration/package.json` | Renamed `@lomi/integration-tests` to `@lomi/spec-integration-tests` (the implementer's suite already uses that name). Pinned dev deps to the repo's versions (vitest 3.2.4, typescript 5.9.3, @types/node 22.19.1, ioredis 5.11.1; pg 8.13.1, @types/pg 8.11.10 as the author specified). Added `lint`. | Workspace wiring. There is still no `test` script, so `turbo run test` (unit, no docker) never picks it up, as the author intended. |
| root `package.json` | `test:integration` now filters to `@lomi/integration-tests`; new `test:spec-integration` filters to `@lomi/spec-integration-tests`. | Both packages define `test:integration`. Without filters, `turbo run test:integration` would run two destructive suites against the same stack at the same time. |
| `turbo.json` | `test:integration.passThroughEnv` gained `WEB_URL`, `REPO_ROOT`, `FIXTURES_DIR`, `SKIP_WORKER_RESET`. | Turbo's strict env mode would otherwise drop the variables the spec suite reads. |
| `packages/core/vitest.config.ts` (new) | Includes `test/**/*.test.ts` and `test/spec/**/*.spec.ts`; aliases `@lomi/core` to `src/index.ts`. | The spec README's recommended setup. The alias means the specs test current source, not a stale `dist/`. |
| `packages/core/tsconfig.json`, `tsconfig.spec.json` (new), `package.json` | The main tsconfig excludes `test/spec`. `tsconfig.spec.json` typechecks the specs with `moduleResolution: Bundler` (their extensionless imports), `strict`, and `noUncheckedIndexedAccess` off, as they were written. `typecheck` runs both configs, and `test:spec` runs only the spec suite. | The repo base config is `NodeNext` + `noUncheckedIndexedAccess`, which the independently written specs were not authored against. They are still typechecked under `strict` instead of being dropped from typecheck. |

Every file under `test/spec/` and the `*.spec.ts` files under `tests/spec-integration/` is otherwise byte-identical to `../spec-tests`.

## Ambiguities in the spec README vs. this implementation

The spec author listed 21 ambiguities and left them unasserted. Where one touches a documented deviation (`DEVIATIONS.md`), the implementation behaves as follows. None conflicts with a test.

| Spec ambiguity | Implementation | Consistent with brief/contract? |
|---|---|---|
| 7 (digits rule with separators) | DEVIATIONS 2: the digits match must sit on digit boundaries (`24` is not in `2024`); a date also matches a differently written quote of the same date. | Yes. This is stricter than, or a superset of, the contract rule; the spec's distractor tests pass. |
| 10 (`effectiveValue` of a correction) | DEVIATIONS 5: the correction is run through `normalizeValue` (`"$5,300.00"` becomes a money object), with the trimmed string as fallback. For `string` fields that is the raw correction, as the spec asserts. | Yes. The contract says "corrected value if corrected". |
| 15 (`MOCK_LLM_FAIL=once`) | DEVIATIONS 1: attempt numbers continue across retries, so `once` fails only the version's first attempt and a retry succeeds. The spec asserts only a terminal state, and the run ended `extracted`. | Yes. |
| 16 (unspecified edge cases) | Probed by hand: a non-PDF on `/documents/:id/versions` returns `400 not_pdf`; `/retry` on an unknown doc returns `404 not_found`; the default title is the file name without `.pdf`. | Sensible; not required. |

## Final run

2026-11-26 09:20–09:25 UTC. Fresh stack (`docker compose down -v && docker compose up -d --build --wait`), mock LLM, host ports Redis 6380 and web 8081 (`.env`). Everything ran in one sequence:

| Step | Result | Duration |
|---|---|---|
| `pnpm install --frozen-lockfile` | ok | – |
| `pnpm turbo run build lint typecheck test --force` | `Tasks: 28 successful, 28 total`. Unit tests: core 452 (84 implementer + 368 spec), api 22, extraction 21, web 6, worker 3, db 2: **506 passed** | 3.65 s |
| `pnpm --filter @lomi/core test:spec` (core spec alone) | `Test Files 7 passed (7)`, `Tests 368 passed (368)` | 236 ms |
| `pnpm test:spec-integration` (whole suite, one go) | `Test Files 13 passed (13)`, `Tests 59 passed (59)` | 154.16 s |
| `CHAOS=1 pnpm test:integration` (implementer) | `Test Files 2 passed (2)`, `Tests 8 passed (8)` | 50.30 s |
| `./scripts/smoke.sh` | `SMOKE PASSED: 2 pending (due_date, total_amount) + 3 carried over; previous version intact` | – |

Earlier stability runs of `pnpm test:spec-integration` on the same stack: 59/59 in 155.22 s, 156.27 s and 155.61 s.

The spec author estimated 15–25 minutes for the integration suite, but it takes about 2.5 minutes. Recovery after a kill or restart takes about 9–19 s rather than the 60–90 s budget, for two reasons. A graceful shutdown releases in-flight runs back to `queued`. On boot, the worker reconciles before it consumes and reclaims any run still leased under its own `WORKER_ID` (`apps/worker/src/main.ts`, `reconciler.ts`), so recovery doesn't wait for `LEASE_MS` to expire. No timeouts were changed.

---

# Gap pass (2026-11-26)

A second pass to find and close test gaps: measure coverage, exercise the real LLM providers, reach the worker/API branches the black-box suites only hit by luck, add UI component tests, and map every requirement in the brief to a test.

## What was added

| Suite | Where | Tests | Run |
|---|---|---|---|
| Coverage | `coverage` script in every code package, `coverage` turbo task | – | `pnpm coverage` (needs Postgres, see below) |
| LLM providers over stubbed HTTP | `packages/extraction/test/providers.test.ts` | 50 | `pnpm test` |
| Run state machine + seed (real Postgres) | `packages/db/test/db/` | 13 | `pnpm test:db` |
| Worker: processRun / commit / reconcile (real Postgres, stubbed LLM) | `apps/worker/test/db/` + `test/config.test.ts` | 22 + 3 | `pnpm test:db`, `pnpm test` |
| API against real Postgres | `apps/api/test/db/` | 22 | `pnpm test:db` |
| Review UI components (jsdom + React Testing Library) | `apps/web/test/detail.test.tsx` | 19 | `pnpm test` |
| Monorepo / compose structure | `packages/config/test/monorepo.test.ts` | 7 | `pnpm test` |
| Core branch gaps | `packages/core/test/gap-pass.test.ts` | 6 | `pnpm test` |
| Black box: parse failures, Redis doorbell | `tests/integration/test/flow.test.ts`, `chaos.test.ts` | 3 | `CHAOS=1 pnpm test:integration` |

**DB-backed tests.** `api`, `worker` and `db` each have two vitest projects: `unit` (what `pnpm test` runs, no I/O) and `db`. The `db` project's global setup (`@lomi/db/testing`) drops, creates and migrates its own `lomi_test_<pkg>` database on the Postgres at `TEST_DATABASE_URL` (default `postgresql://lomi:lomi@localhost:5432/lomi`, the compose Postgres). It refuses any name outside `lomi_test_*`, never touches the app's `lomi` database, and drops the test database afterwards. `pnpm test:db` and `pnpm coverage` therefore need `docker compose up -d postgres`. `pnpm test` does not.

## Coverage, before → after (lines / branches)

Measured with `@vitest/coverage-v8` over `src/**`. "Before" is unit tests only, as they stood. "After" is `pnpm coverage` (unit + db projects).

| Package | Before | After | What is still uncovered |
|---|---|---|---|
| `@lomi/core` | 98.65 / 94.31 | 99.46 / 95.49 | defensive `catch` in `normalizeValue`, a few digit-boundary branches |
| `@lomi/extraction` | 68.49 / 80.91 | 98.64 / 85.50 | `anthropic.ts` and `openai.ts` went from 10% and 9% to 100% of lines; `pdf.ts` defensive catches |
| `@lomi/db` | 3.73 / 66.66 | 88.88 / 86.66 | `seed.ts` `main()` (the script entry point; `seedFixtures` is covered). `testing.ts` is excluded as test support |
| `@lomi/api` | 56.91 / 77.35 | 90.69 / 92.30 | `server.ts` (process wiring: Redis/BullMQ, listen). `app.ts` is at 99.2% |
| `@lomi/worker` | 5.40 / 85.71 | 72.07 / 90.52 | `main.ts` (BullMQ wiring, signals; exercised by the CHAOS suite). `process.ts`, `commit.ts`, `reconciler.ts`, `config.ts` and `plan.ts` are each at 98.9–100% |
| `@lomi/web` | 20.46 / 77.27 | 94.55 / 84.30 | `main.tsx` (mount), polling interval teardown |

The remaining 0% files are process entry points: `apps/worker/src/main.ts`, `apps/api/src/server.ts`, `apps/web/src/main.tsx`, and `seed.ts main()`. They are exercised only by the integration suites and smoke, which run against containers and are not instrumented.

## Bugs found and fixed

| # | Found by | Bug | Fix |
|---|---|---|---|
| 1 | `providers.test.ts` › JSON without a "fields" array; `worker/test/db` › same case end to end | `parseLlmFields` throws `LlmError` without the prompt. The worker had no prompt yet either (the provider never returned), so a run that failed on a malformed answer had **no prompt stored**. That broke "keep the prompt and raw response per extraction" for exactly the runs you most need to debug. | Both providers re-wrap a prompt-less `LlmError` with the prompt. |
| 2 | Provider request-shape test plus the Anthropic docs | The response schema declared nullable fields as `type: ["string", "null"]`. Anthropic's structured-outputs docs list `anyOf` as the nullable form and don't document type arrays, so a live Anthropic run risked a 400 on every extraction. The providers had never been run live. | `anyOf: [{type: string}, {type: null}]`, which both Anthropic and OpenAI (strict mode) document. |
| 3 | OpenAI refusal test | On a refusal, `content` is null, so the stored raw response was `''` and the refusal text was lost. | Store the whole completion as the raw response. |
| 4 | OpenAI `content_filter` / empty `choices` tests | Both surfaced as a misleading "Model returned invalid JSON". | Explicit `LlmError`s: "blocked by the content filter" and "no choices". |
| 5 | Timeout / abort / network tests | SDK errors with no HTTP status were rendered as `Anthropic API error : Request timed out.`. That error string is what the UI shows on a failed document. | `describeSdkError`: `API error <status>: …`, `request timed out: …`, `request aborted: …`, `connection error: …`. |
| 6 | Anthropic request-shape test (hardening) | `max_tokens: 4000`. Current Claude models think by default, and thinking counts against `max_tokens`, so the JSON answer could be truncated, which becomes a `failed` run. | 16 000. It is a ceiling, not a cost. |

No bugs turned up in the worker, API, DB state machine or UI. The new tests passed against the existing code on the first run. They pin behaviour the black-box suites could only reach through timing: commit-time supersede, the heartbeat aborting on a lost lease, a late commit after another worker took over, concurrent deliveries, the attempt cap, and a failed enqueue repaired by the reconciler.

Non-bug changes made for testability:
- The providers accept `{ fetch, baseURL, timeoutMs, maxRetries }`. Previously the third argument was `timeoutMs`, and only `createProvider` called them.
- `seed.ts` exports `seedFixtures()` and runs `main()` only when executed as a script.

Choice for an empty-text PDF: **failed**, with `PdfParseError: PDF contains no extractable text (scanned image?)`, not a page of gaps. The brief says "a parsing error leaves the document visibly failed and retryable". A text-less PDF is a parsing outcome and not something the LLM can't find. Returning five "not found" gaps would tell a reviewer the document lacks the values when we simply never read it.

## Requirement checklist (brief §0–§6)

Every requirement sentence of the brief, mapped to the tests that assert it. Abbreviations:
- **S-nn** = `tests/spec-integration/nn-*.spec.ts` (independent).
- **I-flow / I-chaos** = `tests/integration/test/{flow,chaos}.test.ts`.
- **core-spec** = `packages/core/test/spec`.
- **prov** = `packages/extraction/test/providers.test.ts`.
- **ext** = `packages/extraction/test/extraction.test.ts`.
- **db-db** = `packages/db/test/db/runs.test.ts`.
- **w-db** = `apps/worker/test/db/process.test.ts`.
- **api-db** = `apps/api/test/db/api.test.ts`.
- **api-unit** = `apps/api/test/app.test.ts`.
- **web** = `apps/web/test/detail.test.tsx`.
- **mono** = `packages/config/test/monorepo.test.ts`.

| § | Requirement | Covered by |
|---|---|---|
| 0 | Single monorepo managed with Turborepo on pnpm workspaces | mono "is a pnpm workspace…" |
| 0 | Task pipeline that does something: build, test, lint wired through `turbo.json` | mono "turbo.json wires…", "every code package builds, tests, lints…"; the final run below executes it |
| 0 | Package boundaries (part of evaluation) | mono "internal dependencies are workspace links, and the pure core has no I/O dependencies" |
| 0 | One `docker compose up` at the root starts everything | mono "one compose file starts…"; S-00 health + seed; S-11 UI; smoke.sh |
| 1 | `POST /documents`: upload a PDF (type + file) | S-01 (202, 400 type/file/non-PDF, 413, rejected upload creates nothing); api-unit validation; api-db "202 immediately…", title default |
| 1 | `POST /documents/:id/versions`: new PDF for an existing document | S-09, S-10; api-db versions (404, 400, supersede, concurrent uploads) |
| 1 | `GET /documents/:id`: current version, status (`queued`/`extracting`/`extracted`/`failed`), values once ready | S-00, S-02 (queued → extracting → extracted), S-04 (failed); api-db "detail before extraction… after…", "failed status carries the run error" |
| 1 | `POST /values/:id/review`: approve as-is or correct | S-08; api-db review block |
| 1 | Correction model picked and consistent across API and UI (ours: beside, never overwriting) | S-08 "stored beside the extracted value"; api-db "correct → stored BESIDE…" (DB row unchanged); web "…shows the correction beside the extracted value" (extracted value struck through) |
| 1 | `GET /documents/:id/progress`: pending / approved / corrected / carried-over counts | S-08 "progress endpoint and document summary agree"; S-09; core-spec progress; api-db progress asserts |
| 1 | Postgres is the system of record for documents, values, reviews | S-06 FLUSHALL before/after snapshots; I-chaos FLUSHALL; db unit migration constraints |
| 1 | Extraction runs through a Redis-backed job queue (BullMQ) | I-chaos "extraction is queued through Redis (BullMQ), and the job carries nothing but the run id"; S-02 "worker stopped → stays queued, extracts once back" |
| 1 | Redis coordinates; anything that must survive lives in Postgres | I-chaos doorbell test (job = `{runId}` only); S-06; mono "Redis is deliberately non-durable" |
| 1 | The two stay consistent when one fails | api-db "does not wait for Redis: a hanging or failing enqueue still returns 202…"; w-db reconcile "enqueues every queued run (repairs a lost enqueue / FLUSHALL) and survives enqueue failures"; S-06; S-03 FLUSHALL mid-run |
| 2 | Extraction is LLM-based: parse PDF text, send to an LLM with structured output, ask for the type's expected fields | ext pdfToText; prov "request shape" ×3 doc types × 2 providers (every field in the prompt, schema enum = expected fields, json_schema/strict); w-db "real provider (Anthropic) with a stubbed HTTP layer" |
| 2 | Uploading feels instant; `POST /documents` never waits for the LLM | S-02 (8 s LLM: 202 < 1 s; several in a row; worker stopped); I-flow "202 immediately"; api-db hanging-enqueue < 1 s |
| 2 | UI shows the document's status while extraction is underway | web "while extracting it says so and polls until the values arrive"; web list "Extracting…" badge |
| 2 | Restart or kill mid-extraction → completes or visibly retryable; never stuck, never lost | S-05 (kill, kill twice, restart, restart api+worker); I-chaos worker kill; w-db graceful shutdown release, heartbeat lease loss; db-db recovery (other worker's expired lease, own id on boot, NULL lease) |
| 2 | …and never stuck in `extracting` forever | db-db "after MAX_RUN_ATTEMPTS recoveries the run fails visibly"; w-db reconcile "caps attempts with a visible failure" |
| 2 | Same version extracted twice never duplicates values (retry, crash recovery, impatient user) | S-03 (FLUSHALL + recreate, concurrent retry burst, reconciler); w-db "concurrent deliveries…", "a second run of an already-extracted version writes nothing", "lease expired and another worker took over…"; db-db claim race; db unit unique (version, field) index |
| 2 | Failure is a state: an **LLM** error leaves the document visibly `failed` and retryable | S-04; I-chaos LLM failure → retry; w-db HTTP 500 → failed → retry → extracted; prov HTTP 429/500/400/timeout/network/abort → `LlmError`; api-db retry 202/409 and attempt numbering |
| 2 | Failure is a state: a **parsing** error leaves it `failed` and retryable | I-flow "a corrupt PDF that passes the %PDF- check → failed… retry is accepted", "a PDF with no extractable text → failed"; w-db parse-failure block; ext "rejects non-PDF bytes and broken PDFs" |
| 2 | Redis FLUSHALL + restart: no value, review or visible outcome lost; mid-extraction docs end completed or retryable | S-06 (both cases); I-chaos FLUSHALL; S-03 |
| 2 | Each value carries its evidence: the exact passage it came from | S-00 "evidence verbatim"; core-spec find-evidence; api-db `text.slice(start, end) === quote`; w-db stored offsets |
| 2 | Evidence validated verbatim against the parsed text **of the version being extracted**; otherwise a gap (`value: null` + reason), never kept | core-spec validate-extraction; S-07; I-chaos hallucination; w-db "a hallucinated quote is stored as a gap", stubbed Anthropic answer with a fake quote → `evidence_not_in_text` |
| 2 | A field the LLM can't find is a gap with a reason, never a guess | S-00 median income gap; prov "a 'not found' answer carries the model's reason", "a partial answer… the missing fields become gaps"; prov system prompt asserts "Never guess, infer, compute…"; core-spec `missing_from_response`/`not_found` |
| 2 | Validation and the review UI for vN use vN's text, including after vN+1 exists | S-09 (v1 text and offsets after v2); w-db "reuses stored parsed text instead of re-parsing"; web "an earlier version is read-only…"; api-db `?version=1` after v2 |
| 2 | Prompt and raw LLM response stored or logged per extraction | S-12; w-db happy path (prompt = `renderPrompt`, raw JSON), Anthropic success/failure/malformed (raw + prompt on failed runs: bug #1); prov "(c) the prompt and the raw response are returned"; db-db failRun keeps debug info |
| 3 | Evidence unchanged → keeps its review (approval or correction), marked carried over | S-09; core-spec carry-over; w-db "v2 of the invoice: 3 reviews carried over (incl. a correction)…"; smoke |
| 3 | Evidence changed → back to pending, previous value and review shown beside it | S-09; api-db "a changed value shows the previous version's value and review"; web "a changed value shows the previous version's value, quote and review" |
| 3 | Nothing from the old version is deleted; earlier versions and reviews remain queryable | S-09; S-10; w-db carry-over "v1 untouched"; api-db 409 test (v1 review unchanged) |
| 3 | New version while the previous is still extracting: decide (supersede), document, we'll try it | S-10 (queued and extracting); I-chaos supersede; api-db supersede; w-db "superseded while extracting → commit dropped", "superseded, then the LLM fails → stays superseded"; db-db supersede fencing; README "Decisions" |
| 3 | "Unchanged" holds up when the whole document's text shifts | core-spec "decideCarryOver — whole-document shift"; core carryover.test "text shifted by inserted lines still carries" |
| 3 | Revised invoice: the reviewer has exactly the changed values to re-review | S-09; smoke; w-db carry-over; ext "v1 → v2 end to end" |
| 4 | Document list with extraction status, current version, review progress | web "shows status, current version and review progress per document…" |
| 4 | Polls / streams / refreshes: pick one and say why (polling while busy) | web polling test; `usePolling` doc comment; README |
| 4 | Detail view: each value beside its source quote (highlight is a bonus) | web "every value sits beside its source quote, and the quote is highlighted in this version's text" |
| 4 | Approve / correct per value | web "Approve calls the API and the card updates in place", "Correct…" |
| 4 | Corrections need a value and optionally a note | web "Correct requires a value…" (Save disabled when empty or whitespace, value + note sent), "a gap can be filled by a correction (no note → none sent)"; api-unit 400s; api-db "400 for a correction without a value (nothing stored)" |
| 4 | Gaps visible with their reasons, never hidden | web "a gap is shown, with its reason and detail, and cannot be approved" |
| 4 | After re-extraction: carried-over distinguishable from newly pending | web "carried-over, changed and new-pending values carry different labels" |
| 4 | …and changed values show their previous value and review | web "a changed value shows the previous version's value, quote and review…" |
| 4 | A reviewer understands what needs attention within five seconds | web "summarises the work…", "orders cards changed → gap → new → done"; web.test `sortForReview` |
| 5 | `docker compose up` starts everything, runs migrations, seeds v1 of the samples | S-00 seed (ids, types, titles, v1 only, extracted); db-db seed "creates v1 … and is idempotent", "never resets review work"; mono compose ordering; smoke |
| 5 | If able to deploy, share a live link | Not testable here (no deployment). |
| 6 | Test what's most likely to break | This document: coverage and the race/failure tests above |

**Unmapped: none**, apart from §5's optional live link, which can't be tested. Four rows had no test before this pass, and each now does:
- Parsing failure → `failed` was only reachable inside the worker.
- The Redis/BullMQ queue was never observed directly.
- The monorepo pipeline was never asserted.
- UI behaviour beyond helper functions was untested.

## Final run (gap pass)

2026-11-26, finished 10:22 UTC. Fresh stack (`docker compose down -v && docker compose up -d --build --wait`), mock LLM, host ports Redis 6380 and web 8081 (`.env`). The migrate container's log shows the refactored `seed.ts` created all three documents.

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | lockfile up to date |
| `pnpm turbo run build lint typecheck test --force` | `Tasks: 29 successful, 29 total`. Unit tests: core 458, extraction 71, web 25, api 22, config 7, worker 6, db 2: **591 passed** (was 506) |
| `pnpm turbo run coverage --force` (unit + db projects) | `Tasks: 9 successful, 9 total`. Tests: core 458, extraction 71, api 44, worker 28, web 25, db 15. DB-backed tests: api 22, worker 22, db 13: **57 passed** |
| `REDIS_URL=redis://localhost:6380 WEB_URL=http://localhost:8081 pnpm test:spec-integration` | `Test Files 13 passed (13)`, `Tests 59 passed (59)`, 155.04 s |
| `CHAOS=1 pnpm test:integration` | `Test Files 2 passed (2)`, `Tests 11 passed (11)` (was 8), 53.93 s |
| `./scripts/smoke.sh` | `SMOKE PASSED: 2 pending (due_date, total_amount) + 3 carried over; previous version intact` |

---

# Entry points (2026-11-26)

The gap pass left four files at 0% (or, for `seed.ts`, its `main()` uncovered): `apps/worker/src/main.ts`, `apps/api/src/server.ts`, `apps/web/src/main.tsx`, and the script path of `packages/db/src/seed.ts`. Only the containers ran them, and those aren't instrumented. This pass runs the real built entry points as child processes under coverage.

## How it works

- **`process` vitest project** in `@lomi/db`, `@lomi/api` and `@lomi/worker` (`test/process/`, `pnpm test:process`, also part of `pnpm coverage`). Each test spawns `node dist/<entry>.js` with `NODE_V8_COVERAGE=<pkg>/coverage/process-v8` and an explicit environment (only PATH and HOME are inherited).
- **Setup.** The global setup fails fast if `dist/` is older than `src/`. Turbo's `coverage` and `test:process` tasks now depend on the package's own `build` as well as `^build`. The setup also creates and migrates a dedicated `lomi_test_{db,api,worker}_proc` database through `@lomi/db/testing` and drops it afterwards.
- **Redis.** Tests use this stack's Redis: the host port comes from `REDIS_PORT` in `.env` (6380 here), else 6379, and `PROCESS_TEST_REDIS_URL` overrides it. The API tests use logical DB 14 and the worker tests use DB 15. `processTestRedisUrl()` refuses DB 0 and any port other than the stack's. That rules out the unrelated Redis on 6379 here. `flushTestRedis()` only `FLUSHDB`s a connection that selected a non-zero DB. The compose worker consumes DB 0, so the running stack never sees the test jobs.
- **Taking a dependency down.** A TCP proxy (`startTcpProxy` in `@lomi/db/testing-process`) sits in front of Postgres or Redis. It can switch between refusing connections and forwarding them, so a test can take a dependency "down" and bring it back without touching the real service.
- **Merging coverage.** `packages/config/coverage-merge.mjs` runs after vitest, which now writes only `coverage-final.json`. The merge has three steps:
  1. Merge the raw V8 dumps first with `@bcoe/v8-coverage`, as vitest and c8 do. V8 omits a block whose count equals its parent's, so merging after conversion would read "absent in this dump" as "never ran".
  2. Convert through the tsc source maps with `v8-to-istanbul`.
  3. Project the hits onto vitest's map. Vitest's map stays canonical: it decides what a statement is, because it drops blank and comment lines and plain v8-to-istanbul doesn't. Statements gain the child's per-line counts. Functions and branches gain the child's count for the block. For a file vitest never loaded, the merge takes the child's real functions and branches in place of vitest's one-function "(empty-report)" stand-in.

  The merge then prints the text table and writes `coverage-summary.json`.
- **Web.** `apps/web/test/main.test.tsx` imports the real `src/main.tsx` into a jsdom document with `<div id="root">` and asserts the shell and the stubbed document list render. No child process is needed.

## Tests added (17)

| File | Tests | What they assert |
|---|---|---|
| `packages/db/test/process/seed.test.ts` | 3 | `node dist/seed.js` twice on a fresh DB: 3 × "created v1", then 3 × "already present, skipped"; exactly 3 documents, 3 versions and 3 queued runs. Started through a symlinked path, it seeds (bug 1). Unreachable DB → exit 1 with `[seed] failed`. |
| `apps/api/test/process/server.test.ts` | 4 | Boots on `PORT=0` (port parsed from the listen log). `/health` 200 `{ok:true}`. An upload returns 202, its run is `queued`, and a BullMQ job `{runId}` with the deduplicated job id lands in Redis. SIGTERM → exit 0 in under 5 s and the port is closed. DB unreachable → `/health` 503 `db_unavailable`; SIGINT → exit 0. Redis unreachable → upload still 202 in under 1.5 s, run durable in Postgres, "enqueue failed; reconciler will pick the run up" logged, `/health` 200. Port taken → non-zero exit, `EADDRINUSE`. |
| `apps/worker/test/process/main.test.ts` | 9 | See the list below. |
| `apps/web/test/main.test.tsx` | 1 | `main.tsx` mounts `<App />` into `#root`: brand link, tagline, and the document list fetched from `/api/documents`. |

The 9 worker tests:
- **Boot reconcile.** A queued run inserted before boot (never enqueued) is extracted with the mock provider, with 5 values. The boot log carries the provider, lease, interval and concurrency.
- **Live job.** A job rung the way the API rings it (a lease document) is extracted end to end: all 5 lease fields, the prompt and the raw response are stored.
- **`RECONCILE_INTERVAL_MS`.** At 60 s, a run inserted after boot is still `queued` and unenqueued 2.5 s later. At 300 ms, the tick enqueues it and also recovers an expired-lease run of a dead worker (attempt 2, "recovered stale runs" logged).
- **SIGTERM mid-extraction** (`MOCK_LLM_DELAY_MS=120000`), with SIGTERM and SIGINT sent back to back:
  - exactly one "shutting down";
  - exit 0 in under 7 s, so before the 8 s force-exit timer;
  - "run released on shutdown";
  - the run is `queued`, attempt 2, with no lease or worker id and no values;
  - a job for attempt 2 is in Redis;
  - a second worker then finishes it.
- **Postgres down at boot.** The worker logs "boot reconcile failed, retrying in 2s" at least twice, doesn't crash and isn't ready. Once the proxy forwards, it becomes ready and extracts the waiting run.
- **Postgres lost after boot.** The ticks log "reconcile failed (will retry)" and the worker stays up. A run inserted meanwhile is extracted once Postgres is back.
- **SIGTERM during the boot retry loop.** Exit 0.
- **Redis down at boot.** The worker warns "redis error", stays alive and isn't ready, because the boot reconcile waits on the enqueue. Once Redis is back, it becomes ready and extracts.
- **Redis lost after boot.** The ticks don't pile up, the process stays up, and a run queued meanwhile is extracted once Redis returns.
- **SIGTERM while the boot reconcile is stuck enqueueing to a dead Redis.** Exit 0 in under 7 s, and the run stays `queued`, attempt 1.

The process suites passed 3 runs in a row (`pnpm test:process`): db 3/3, api 4/4, worker 9/9 each time.

## Coverage, before → after (lines / branches)

"Before" is the gap pass's `pnpm coverage`, re-measured at the start of this pass with identical results. "After" is `pnpm coverage` with the process projects merged in. For the files that were never loaded, vitest reported branches as 100%, but those were placeholder 0/0 counts, so they show as "–".

| Package | Before | After |
|---|---|---|
| `@lomi/core` | 99.46 / 95.49 | 99.46 / 95.49 |
| `@lomi/extraction` | 98.64 / 85.50 | 98.64 / 85.50 |
| `@lomi/db` | 88.88 / 86.66 | **100 / 93.33** |
| `@lomi/api` | 90.69 / 92.30 | **99.46 / 91.71** |
| `@lomi/worker` | 72.07 / 90.52 | **99.09 / 91.2** |
| `@lomi/web` | 94.55 / 84.30 | **96.69 / 84.89** |

The api and worker branch totals moved little or fell, even though more ran. The entry points now contribute their real branches instead of the placeholder's 0/0.

| Entry point | Before | After | Still uncovered |
|---|---|---|---|
| `apps/worker/src/main.ts` | 0 / – | **97.82 / 93.5** | Lines 93–94: the `catch` when closing BullMQ throws. The branch figure moves by one branch (93.54–93.75) between runs, depending on signal and tick timing. |
| `apps/api/src/server.ts` | 0 / – | **100 / 76.92** | The defaults `PORT ?? 3001`, `HOST ?? '0.0.0.0'` and `REDIS_URL ?? 'redis://localhost:6379'`. These are left uncovered on purpose: 3001 is the compose API and 6379 is the unrelated Redis. |
| `apps/web/src/main.tsx` | 0 / – | **100 / 100** | – |
| `packages/db/src/seed.ts` (`main()` included) | 78.33 / 72.72 | **100 / 81.81** | Lines 31 and 33: the manifest-validation throws |

Every source file is now above 0%. The lowest files are `web/src/api.ts` at 90.69% and `extraction/src/pdf.ts` at 94.25%. All four entry points are at 97.8% of lines or more.

## Bugs found and fixed

| # | Found by | Bug | Fix |
|---|---|---|---|
| 1 | `seed.test.ts` › symlinked path | The `main()` guard compared `path.resolve(process.argv[1])` with `import.meta.url`. Node resolves the latter through symlinks, but argv[1] stays as typed. Started as `node node_modules/@lomi/db/dist/seed.js`, which is a pnpm symlink, the seed did nothing and exited **0**: a silent no-op that looks like success. The migrate container runs `node dist/seed.js` from the real path, so compose was not affected. | Compare `realpathSync(process.argv[1])` with `fileURLToPath(import.meta.url)`. |

The worker and API entry points behaved as designed in every scenario above. Nothing in `main.ts` or `server.ts` needed a change.

## Observation (not fixed)

**Postgres recovery after a connection is lost.** When Postgres drops the worker's pooled connection after boot, Prisma kept answering "Server has closed the connection" for about 15 s after Postgres was reachable again. That was 72 failed 200 ms ticks, with the same result at `connection_limit=2`. The proxy log shows the engine opened no new connection in that window.

The worker recovered on its own and extracted the waiting run, and 15 s is well inside the 60–90 s recovery budget. I couldn't reproduce the delay with a bare Prisma client through the same proxy: `SELECT 1`, plain or parameterised, recovered on the first query. So the trigger is something about the worker's usage pattern, and I didn't isolate it. A Postgres outage *at boot* is unaffected, because the boot retry succeeds on the next 2 s attempt. The test allows 45 s for this case.

## Final run (entry points)

2026-11-26, 10:53–11:00 UTC, in one sequence. The mock LLM was in use, with host ports Redis 6380 and web 8081 (`.env`). On the fresh stack, the migrate container's log shows `[seed] … created v1 with a queued run` for all three documents.

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ok |
| `pnpm turbo run build lint typecheck test --force` | `Tasks: 29 successful, 29 total`. Unit tests: core 458, extraction 71, web 26, api 22, config 7, worker 6, db 2: **592 passed** (was 591; +1 `main.tsx`) |
| `pnpm coverage --force` (unit + db + process projects, child coverage merged) | `Tasks: 12 successful, 12 total`, 34.3 s. Tests: core 458, extraction 71, api 48, worker 37, web 26, db 18: **658 passed**, of which 16 process tests (db 3, api 4, worker 9). Merge: db 4, api 4, worker 11 child-process dumps |
| `docker compose down -v && docker compose up -d --build --wait` | all services healthy, 3 seed docs created |
| `REDIS_URL=redis://localhost:6380 WEB_URL=http://localhost:8081 pnpm test:spec-integration` | `Test Files 13 passed (13)`, `Tests 59 passed (59)`, 156.22 s |
| `CHAOS=1 pnpm test:integration` | `Test Files 2 passed (2)`, `Tests 11 passed (11)`, 54.07 s |
| `./scripts/smoke.sh` | `SMOKE PASSED: 2 pending (due_date, total_amount) + 3 carried over; previous version intact` |

Afterwards the stack was reset to fresh (`docker compose down -v && docker compose up -d --build --wait`), with the three seed documents.
