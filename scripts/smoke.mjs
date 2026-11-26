// Smoke test of the re-extraction flow. Runs anywhere Node 22 runs; smoke.sh executes it inside the api container.
// approve every v1 value of doc-invoice-001 → upload invoice-001.v2.pdf → expect 2 pending + 3 carried over.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_URL ?? 'http://127.0.0.1:3001';
const FIXTURES = process.env.FIXTURES_DIR ?? path.resolve(process.cwd(), 'fixtures');
const DOC = 'doc-invoice-001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body) {
  const init = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) Object.assign(init, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const res = await fetch(`${API}${url}`, init);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function waitExtracted(timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const d = await call('GET', `/documents/${DOC}`);
    if (d.status === 'extracted') return d;
    if (d.status === 'failed') throw new Error(`extraction failed: ${d.error}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for extraction (status ${d.status})`);
    await sleep(500);
  }
}

async function uploadVersion(file) {
  const form = new FormData();
  form.set('file', new Blob([readFileSync(path.join(FIXTURES, 'documents', file))], { type: 'application/pdf' }), file);
  const t0 = Date.now();
  const s = await call('POST', `/documents/${DOC}/versions`, form);
  console.log(`  uploaded ${file} as v${s.currentVersion} (202 in ${Date.now() - t0} ms, status ${s.status})`);
}

async function reviewAll(doc) {
  for (const v of doc.values) {
    if (v.reviewState !== 'pending') continue;
    if (v.value === null) await call('POST', `/values/${v.id}/review`, { action: 'correct', value: 'n/a', note: 'smoke' });
    else await call('POST', `/values/${v.id}/review`, { action: 'approve' });
  }
}

let doc = await waitExtracted();
if (doc.currentVersion !== 1) {
  // Re-runs: put the original invoice back on top so the v1 → v2 comparison is the same as on a fresh stack.
  console.log(`  ${DOC} is at v${doc.currentVersion}; re-uploading the original invoice first`);
  await uploadVersion('invoice-001.pdf');
  doc = await waitExtracted();
}
await reviewAll(doc);
const before = await call('GET', `/documents/${DOC}/progress`);
console.log(`  reviewed v${doc.currentVersion}:`, JSON.stringify(before));
if (before.pending !== 0) throw new Error('expected every value reviewed before uploading v2');

await uploadVersion('invoice-001.v2.pdf');
const v2 = await waitExtracted();
const p = await call('GET', `/documents/${DOC}/progress`);
console.log(`  after v${v2.currentVersion}:`, JSON.stringify(p));
const changed = v2.values.filter((v) => v.changed).map((v) => v.field).sort();
const carried = v2.values.filter((v) => v.reviewState === 'carried_over').map((v) => v.field).sort();
console.log(`  changed (pending): ${changed.join(', ')}  |  carried over: ${carried.join(', ')}`);

const ok =
  p.pending === 2 && p.carriedOver === 3 &&
  JSON.stringify(changed) === JSON.stringify(['due_date', 'total_amount']) &&
  v2.values.filter((v) => v.changed).every((v) => v.previous && v.previous.review);
const prev = await call('GET', `/documents/${DOC}?version=${v2.currentVersion - 1}`);
const prevIntact = prev.values.every((v) => v.reviewState !== 'pending');
if (!ok || !prevIntact) {
  console.error('SMOKE FAILED');
  process.exit(1);
}
console.log('SMOKE PASSED: 2 pending (due_date, total_amount) + 3 carried over; previous version intact');
