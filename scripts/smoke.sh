#!/usr/bin/env bash
# Bring the stack up (mock LLM), then check the re-extraction flow end to end.
# Needs only Docker: the check itself runs with Node inside the api container.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> docker compose up -d --build"
docker compose up -d --build

echo "==> waiting for the API"
for _ in $(seq 1 90); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> smoke: approve v1 of doc-invoice-001, upload invoice-001.v2.pdf"
docker compose exec -T -e FIXTURES_DIR=/app/fixtures api node --input-type=module - < scripts/smoke.mjs
