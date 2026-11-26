# Deviations from CONTRACT.md

Everything in the contract is implemented as written, except for the points below. Each is either a stricter reading or a superset that the contract doesn't forbid.

1. **Attempt numbering continues across runs of a version.** `POST /documents/:id/retry` creates a new run whose `attempt` is the version's highest attempt + 1, not 1. As a result `MOCK_LLM_FAIL=once` fails only the *first* attempt of a version's extraction, so retrying after a `once` failure succeeds. Under a literal "attempt 1 of each run" reading it would fail again forever. `attempt` is also the fencing token, and keeping it monotonic per version keeps it meaningful. Lease-expiry recoveries bump `attempt` within the same run, as the contract says.
2. **Value-in-evidence check (`validateExtraction`).**
   - For `money`/`number`/`percent`, a textual match must sit on digit boundaries, so `"24"` does not count as contained in `"2024"`.
   - For `date`, a value also passes if the quote contains the same calendar date written differently (`"2025-03-01"` against `"commencing on March 1, 2025"`). A genuinely different date still becomes a `value_not_in_evidence` gap.
3. **Host ports can be overridden** with `POSTGRES_PORT`, `REDIS_PORT`, `API_PORT` and `WEB_PORT`. The defaults are exactly the contract's (5432/6379/3001/8080). The service-to-service ports inside compose are unchanged.
4. **Compose defaults `LLM_PROVIDER` to `mock` even when an API key is exported.** This keeps `docker compose up` and the chaos tests deterministic. To use a real model, set `LLM_PROVIDER=anthropic` (or `openai`) together with the key. Outside compose, `createProvider()` follows the contract (anthropic/openai if a key is present, otherwise mock).
5. **Small additions that are not in the contract:**
   - `?version=abc` (not a positive integer) returns `400 invalid_version`. An unknown but well-formed version is still 404.
   - `GET /health` returns `503 {ok:false}` while the DB is unreachable.
   - Error codes used: `invalid_type`, `file_required`, `not_pdf`, `not_multipart`, `file_too_large`, `invalid_body`, `not_found`, `not_failed` (retry 409), `version_not_current` (review 409), `gap_requires_correction`, `not_a_gap` (`confirm_missing` on a value that isn't a gap).
   - Review action `confirm_missing` (gaps only); see the addendum at the end of [`CONTRACT.md`](CONTRACT.md).
   - `effectiveValue` for a correction is the correction normalised with `normalizeValue` for the field type (e.g. `"$5,300"` becomes `{amount:5300,currency:'USD'}`). If it doesn't parse, it falls back to the trimmed string. Corrections are never rejected for their content.
   - New documents get ids of the form `doc-<uuid>`.
6. **Anthropic structured output uses `output_config.format` (JSON schema), not forced tool use.** `claude-sonnet-5-5` rejects a forced `tool_choice` with a 400. The result is the same: schema-valid JSON.
