// Runs once before the suite: the stack must already be up (`docker compose up -d` from REPO_ROOT).
// Waits for /health and resets the worker to default mock knobs so a previous aborted run can't leak
// MOCK_LLM_FAIL=always etc. into this one. Deliberately does not import ./helpers (which imports vitest's expect).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

function repoRoot(): string {
  if (process.env.REPO_ROOT) return process.env.REPO_ROOT;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some((f) => existsSync(join(dir, f)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '/Users/jkjarvis/workspace/lomi/lomi-extract';
}

export default async function setup(): Promise<void> {
  const api = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
  const deadline = Date.now() + 180_000;
  let last = '';
  for (;;) {
    try {
      const r = await fetch(`${api}/health`);
      if (r.status === 200) break;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = String(e);
    }
    if (Date.now() > deadline) {
      throw new Error(`API at ${api} not healthy (${last}). Start the stack first: docker compose up -d (in ${repoRoot()})`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (process.env.SKIP_WORKER_RESET !== '1') {
    await run('docker', ['compose', 'up', '-d', '--no-deps', '--force-recreate', 'worker'], {
      cwd: repoRoot(),
      env: { ...process.env, MOCK_LLM_DELAY_MS: '0', MOCK_LLM_FAIL: 'never', MOCK_LLM_HALLUCINATE: '' },
      timeout: 240_000,
    });
  }
}
