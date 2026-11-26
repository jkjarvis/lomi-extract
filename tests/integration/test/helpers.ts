import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const API = process.env.API_URL ?? 'http://localhost:3001';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const fixture = (name: string) => readFileSync(path.join(ROOT, 'fixtures/documents', name));

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await fetch(`${API}${url}`, init);
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

export function pdfForm(file: Buffer, fields: Record<string, string> = {}, name = 'doc.pdf') {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('file', new Blob([new Uint8Array(file)], { type: 'application/pdf' }), name);
  return form;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForStatus(id: string, wanted: string[], timeoutMs = 60_000) {
  const t0 = Date.now();
  let last: any;
  while (Date.now() - t0 < timeoutMs) {
    last = (await api('GET', `/documents/${id}`)).body;
    if (wanted.includes(last?.status)) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${id} → ${wanted.join('|')} (last: ${last?.status})`);
}

export function compose(args: string, env: Record<string, string> = {}) {
  return execSync(`docker compose ${args}`, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'pipe' }).toString();
}

export async function waitForApi(timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await fetch(`${API}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('API did not become healthy');
}
