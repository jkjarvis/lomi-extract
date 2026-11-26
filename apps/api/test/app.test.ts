import type { PrismaClient } from '@lomi/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, parseReviewBody } from '../src/app.js';

/** Any DB access in these tests is a bug: validation must reject before touching Postgres. */
const noDb = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    throw new Error(`unexpected prisma access: ${String(prop)}`);
  },
});

function multipart(parts: Array<{ name: string; value: string | Buffer; filename?: string }>) {
  const boundary = '----lomitest' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: application/pdf\r\n\r\n`));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
    }
    chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ prisma: noDb, enqueue: async () => undefined });
});
afterAll(async () => app.close());

describe('POST /documents validation', () => {
  it('400 invalid_type for an unknown type', async () => {
    const res = await app.inject({ method: 'POST', url: '/documents', ...multipart([{ name: 'type', value: 'receipt' }, { name: 'file', value: '%PDF-1.4', filename: 'a.pdf' }]) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'invalid_type', message: expect.any(String) } });
  });

  it('400 file_required without a file', async () => {
    const res = await app.inject({ method: 'POST', url: '/documents', ...multipart([{ name: 'type', value: 'invoice' }]) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('file_required');
  });

  it('400 not_pdf when magic bytes are wrong (even with a .pdf name)', async () => {
    const res = await app.inject({ method: 'POST', url: '/documents', ...multipart([{ name: 'type', value: 'invoice' }, { name: 'file', value: 'hello world', filename: 'fake.pdf' }]) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_pdf');
  });

  it('413 file_too_large past 10 MB', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 10, 0x20)]);
    const res = await app.inject({ method: 'POST', url: '/documents', ...multipart([{ name: 'type', value: 'invoice' }, { name: 'file', value: big, filename: 'big.pdf' }]) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('file_too_large');
  });

  it('400 for a non-multipart request', async () => {
    const res = await app.inject({ method: 'POST', url: '/documents', payload: { type: 'invoice' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_multipart');
  });
});

describe('POST /values/:id/review body validation', () => {
  it.each([
    [{ action: 'correct' }],
    [{ action: 'correct', value: '   ' }],
    [{ action: 'correct', value: 5 }],
    [{ action: 'reject' }],
    [{}],
    [{ action: 'approve', note: 5 }],
  ])('400 for %j', async (body) => {
    const res = await app.inject({ method: 'POST', url: '/values/abc/review', payload: body });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_body');
  });

  it('parseReviewBody trims and normalises notes', () => {
    expect(parseReviewBody({ action: 'correct', value: ' 42 ', note: '  ' })).toEqual({ action: 'correct', value: '42', note: null });
    expect(parseReviewBody({ action: 'approve', note: 'ok' })).toEqual({ action: 'approve', note: 'ok' });
  });
});

describe('errors', () => {
  it('unknown routes use the error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('health is 503 when the DB is unreachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().ok).toBe(false);
  });
});
