import { describe, expect, it } from 'vitest';
import {
  api,
  describeRes,
  pdfForm,
  readFixture,
  review,
  uniqueTitle,
  uploadDocumentRaw,
  type DocumentSummary,
} from './helpers';

// CONTRACT §3: 400 bad type / missing or non-PDF file (magic bytes %PDF-), 413 > 10 MB, 404 unknown doc/value.

function expectErrorEnvelope(r: { status: number; body: any }) {
  expect(typeof r.body?.error?.code, `error envelope expected: ${describeRes(r as any)}`).toBe('string');
  expect(typeof r.body?.error?.message, `error envelope expected: ${describeRes(r as any)}`).toBe('string');
}

describe('POST /documents — validation', () => {
  it('valid upload → 202 DocumentSummary with status queued', async () => {
    const title = uniqueTitle('valid upload');
    const r = await uploadDocumentRaw('invoice', readFixture('invoiceV1'), title);
    expect(r.status, describeRes(r)).toBe(202);
    const d: DocumentSummary = r.body;
    expect(typeof d.id).toBe('string');
    expect(d.type).toBe('invoice');
    expect(d.title).toBe(title);
    expect(d.currentVersion).toBe(1);
    expect(d.status).toBe('queued');
    expect(d.error).toBeNull();
    expect(d.progress).toMatchObject({
      total: expect.any(Number),
      pending: expect.any(Number),
      approved: expect.any(Number),
      corrected: expect.any(Number),
      carriedOver: expect.any(Number),
      gaps: expect.any(Number),
    });
    expect(Number.isNaN(Date.parse(d.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(d.updatedAt))).toBe(false);

    const list = await api<DocumentSummary[]>('GET', '/documents');
    expect(list.body.map((x) => x.id)).toContain(d.id);
  });

  it.each([['receipt'], ['']])('bad type %j → 400', async (type) => {
    const r = await uploadDocumentRaw(type, readFixture('invoiceV1'), uniqueTitle('bad type'));
    expect(r.status, describeRes(r)).toBe(400);
    expectErrorEnvelope(r);
  });

  it('missing type → 400', async () => {
    const r = await api('POST', '/documents', { form: pdfForm(readFixture('invoiceV1'), {}) });
    expect(r.status, describeRes(r)).toBe(400);
    expectErrorEnvelope(r);
  });

  it('missing file → 400', async () => {
    const r = await uploadDocumentRaw('invoice', null, uniqueTitle('no file'));
    expect(r.status, describeRes(r)).toBe(400);
    expectErrorEnvelope(r);
  });

  it('non-PDF bytes declared as application/pdf → 400 (magic-byte check)', async () => {
    const fake = Buffer.from('Invoice Number: INV-2025-0847\nTotal Due: $5,230.29\n', 'utf8');
    const r = await api('POST', '/documents', {
      form: pdfForm(fake, { type: 'invoice', title: uniqueTitle('fake pdf') }, 'fake.pdf', 'application/pdf'),
    });
    expect(r.status, describeRes(r)).toBe(400);
    expectErrorEnvelope(r);
  });

  it('PNG bytes → 400', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const r = await api('POST', '/documents', {
      form: pdfForm(png, { type: 'invoice', title: uniqueTitle('png') }, 'image.png', 'image/png'),
    });
    expect(r.status, describeRes(r)).toBe(400);
  });

  it('a rejected upload does not create a document', async () => {
    const title = uniqueTitle('rejected-should-not-exist');
    await api('POST', '/documents', { form: pdfForm(Buffer.from('nope'), { type: 'invoice', title }, 'x.pdf') });
    const list = await api<DocumentSummary[]>('GET', '/documents');
    expect(list.body.map((d) => d.title)).not.toContain(title);
  });

  it('> 10 MB → 413', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x20);
    big.write('%PDF-1.3\n', 0, 'latin1');
    let r;
    try {
      r = await api('POST', '/documents', { form: pdfForm(big, { type: 'invoice', title: uniqueTitle('too big') }) });
    } catch (e) {
      throw new Error(`server dropped the connection instead of answering 413: ${String(e)}`);
    }
    expect(r.status, describeRes(r)).toBe(413);
  });
});

describe('404s', () => {
  const missing = 'no-such-document-00000000';

  it('GET /documents/:id unknown → 404', async () => {
    const r = await api('GET', `/documents/${missing}`);
    expect(r.status, describeRes(r)).toBe(404);
    expectErrorEnvelope(r);
  });

  it('GET /documents/:id/progress unknown → 404', async () => {
    const r = await api('GET', `/documents/${missing}/progress`);
    expect(r.status, describeRes(r)).toBe(404);
  });

  it('POST /documents/:id/versions unknown doc → 404', async () => {
    const r = await api('POST', `/documents/${missing}/versions`, { form: pdfForm(readFixture('invoiceV2')) });
    expect(r.status, describeRes(r)).toBe(404);
  });

  it('POST /values/:id/review unknown value → 404', async () => {
    const r = await review('no-such-value-00000000', { action: 'approve' });
    expect(r.status, describeRes(r)).toBe(404);
    expectErrorEnvelope(r);
  });

  it('POST /values/:id/review unknown value (uuid-shaped id) → 404', async () => {
    const r = await review('00000000-0000-4000-8000-000000000000', { action: 'approve' });
    expect(r.status, describeRes(r)).toBe(404);
  });
});
