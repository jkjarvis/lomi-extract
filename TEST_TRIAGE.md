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
