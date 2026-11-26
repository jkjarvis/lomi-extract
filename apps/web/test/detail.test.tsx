// The review screen, rendered for real (jsdom + React Testing Library) against a stubbed API.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentDetail as Detail, DocumentSummary, Review, Value } from '../src/api.js';
import { DocumentDetail } from '../src/components/DocumentDetail.js';
import { DocumentList } from '../src/components/DocumentList.js';

// ---------- a tiny fake API ----------

interface Call {
  method: string;
  url: string;
  body: unknown;
}
type Handler = (call: Call) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;

function fakeApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : (init?.body ?? null);
      const call = { method, url, body };
      calls.push(call);
      const handler = routes[`${method} ${url}`];
      if (!handler) return new Response(JSON.stringify({ error: { code: 'not_found', message: `no route ${method} ${url}` } }), { status: 404 });
      const r = await handler(call);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

// ---------- fixtures: invoice v2 after re-extraction ----------

const TEXT = [
  'MERIDIAN OFFICE SUPPLIES LLC',
  'Invoice Number: INV-2025-0847',
  'Issue Date: 2025-09-14',
  'Due Date: 2025-11-13',
  'TOTAL DUE: $6,126.45',
].join('\n');
const ev = (quote: string) => ({ quote, start: TEXT.indexOf(quote), end: TEXT.indexOf(quote) + quote.length });
const approve: Review = { action: 'approve', value: null, note: null, createdAt: '2026-11-01T00:00:00.000Z' };
const correction = (value: string, note: string | null = null): Review => ({ action: 'correct', value, note, createdAt: '2026-11-01T00:00:00.000Z' });

const base = (over: Partial<Value> & Pick<Value, 'id' | 'field'>): Value => ({
  type: 'string',
  value: null,
  rawValue: null,
  evidence: null,
  gap: null,
  reviewState: 'pending',
  review: null,
  effectiveValue: null,
  previous: null,
  changed: false,
  ...over,
});

const VALUES: Value[] = [
  base({
    id: 'v-num',
    field: 'invoice_number',
    value: 'INV-2025-0847',
    effectiveValue: 'INV-2025-0847',
    rawValue: 'INV-2025-0847',
    evidence: ev('Invoice Number: INV-2025-0847'),
    reviewState: 'carried_over',
    review: approve,
    previous: { version: 1, value: 'INV-2025-0847', evidenceQuote: 'Invoice Number: INV-2025-0847', reviewState: 'approved', review: approve },
  }),
  base({
    id: 'v-issue',
    field: 'issue_date',
    type: 'date',
    rawValue: '2025-09-14',
    gap: { reason: 'evidence_not_in_text', detail: 'Quote "Issued on 14 Sept" does not appear in the document text' },
  }),
  base({
    id: 'v-due',
    field: 'due_date',
    type: 'date',
    value: '2025-11-13',
    effectiveValue: '2025-11-13',
    rawValue: '2025-11-13',
    evidence: ev('Due Date: 2025-11-13'),
    changed: true,
    previous: { version: 1, value: '2025-10-14', evidenceQuote: 'Due Date: 2025-10-14', reviewState: 'approved', review: approve },
  }),
  base({
    id: 'v-vendor',
    field: 'vendor_name',
    value: 'MERIDIAN OFFICE SUPPLIES LLC',
    effectiveValue: 'Meridian Office Supplies LLC',
    rawValue: 'MERIDIAN OFFICE SUPPLIES LLC',
    evidence: ev('MERIDIAN OFFICE SUPPLIES LLC'),
    reviewState: 'carried_over',
    review: correction('Meridian Office Supplies LLC', 'title case'),
    previous: { version: 1, value: 'MERIDIAN OFFICE SUPPLIES LLC', evidenceQuote: 'MERIDIAN OFFICE SUPPLIES LLC', reviewState: 'corrected', review: correction('Meridian Office Supplies LLC', 'title case') },
  }),
  base({
    id: 'v-total',
    field: 'total_amount',
    type: 'money',
    value: { amount: 6126.45, currency: 'USD' },
    effectiveValue: { amount: 6126.45, currency: 'USD' },
    rawValue: '$6,126.45',
    evidence: ev('TOTAL DUE: $6,126.45'),
    changed: true,
    previous: {
      version: 1,
      value: { amount: 5230.29, currency: 'USD' },
      evidenceQuote: 'TOTAL DUE: $5,230.29',
      reviewState: 'corrected',
      review: correction('5230.30', 'rounding'),
    },
  }),
];

const progress = { total: 5, pending: 3, approved: 0, corrected: 0, carriedOver: 2, gaps: 1 };
const detail = (over: Partial<Detail> = {}): Detail => ({
  id: 'doc-1',
  type: 'invoice',
  title: 'Invoice — Meridian',
  currentVersion: 2,
  status: 'extracted',
  error: null,
  progress,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  version: 2,
  versions: [
    { version: 1, status: 'extracted', createdAt: '2026-11-01T00:00:00.000Z' },
    { version: 2, status: 'extracted', createdAt: '2026-11-02T00:00:00.000Z' },
  ],
  text: TEXT,
  values: VALUES,
  ...over,
});

const card = (label: string) => screen.getByText(label, { selector: '.field' }).closest('.value-card') as HTMLElement;
const go = vi.fn();

async function renderDetail(doc: Detail = detail(), routes: Record<string, Handler> = {}, version?: number) {
  const calls = fakeApi({ [`GET /api/documents/doc-1${version ? `?version=${version}` : ''}`]: () => ({ json: doc }), ...routes });
  render(<DocumentDetail id="doc-1" version={version} go={go} />);
  await screen.findByText(doc.title);
  return calls;
}

describe('detail view: what needs attention is obvious', () => {
  it('summarises the work: changed, gaps, and carried over counted separately', async () => {
    await renderDetail();
    const summary = document.querySelector('.summary') as HTMLElement;
    expect(summary).toHaveTextContent('3 need your review');
    expect(within(summary).getByText('2 changed')).toBeTruthy();
    expect(within(summary).getByText('1 gap')).toBeTruthy();
    expect(within(summary).getByText('2 carried over')).toBeTruthy();
  });

  it('orders cards changed → gap → new → done', async () => {
    await renderDetail();
    const order = [...document.querySelectorAll('.value-card .field')].map((n) => n.textContent);
    expect(order).toEqual(['Due date', 'Total amount', 'Issue date', 'Invoice number', 'Vendor name']);
  });

  it('a gap is shown, with its reason and detail, and cannot be approved', async () => {
    await renderDetail();
    const c = card('Issue date');
    expect(within(c).getByText('Gap — needs a value')).toBeTruthy();
    expect(within(c).getByText('No value')).toBeTruthy();
    expect(within(c).getByText('Quoted evidence is not in the document (possible hallucination)')).toBeTruthy();
    expect(within(c).getByText(/Issued on 14 Sept/)).toBeTruthy();
    expect(within(c).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(within(c).getByRole('button', { name: 'Correct' })).toBeEnabled();
  });

  it('carried-over, changed and new-pending values carry different labels', async () => {
    const fresh = base({ id: 'v-new', field: 'tenant_name', value: 'Dana Okafor', effectiveValue: 'Dana Okafor', rawValue: 'Dana Okafor' });
    await renderDetail(detail({ values: [...VALUES, fresh] }));
    expect(within(card('Invoice number')).getByText('Carried over')).toBeTruthy();
    expect(within(card('Invoice number')).getByText('from v1')).toBeTruthy();
    expect(within(card('Invoice number')).getByText(/Review carried over: approved/)).toBeTruthy();
    expect(within(card('Vendor name')).getByText(/Review carried over: corrected to “Meridian Office Supplies LLC” \(title case\)/)).toBeTruthy();
    expect(within(card('Due date')).getByText('Changed — review again')).toBeTruthy();
    expect(within(card('Tenant name')).getByText('Needs review')).toBeTruthy();
    expect(within(card('Tenant name')).queryByText(/Previously in/)).toBeNull();
    // Carried-over cards don't nag with the previous-version box; changed ones do.
    expect(within(card('Invoice number')).queryByText(/Previously in/)).toBeNull();
  });

  it('a changed value shows the previous version\'s value, quote and review beside the new one', async () => {
    await renderDetail();
    const due = card('Due date');
    expect(within(due).getByText('2025-11-13', { selector: '.the-value' })).toBeTruthy();
    const prevDue = due.querySelector('.previous') as HTMLElement;
    expect(prevDue).toHaveTextContent('Previously in v1: 2025-10-14 — approved');
    expect(within(prevDue).getByText('Due Date: 2025-10-14')).toBeTruthy();

    const prevTotal = card('Total amount').querySelector('.previous') as HTMLElement;
    expect(prevTotal).toHaveTextContent('Previously in v1: $5,230.29 — corrected to “5230.30” (rounding)');
  });

  it('every value sits beside its source quote, and the quote is highlighted in this version\'s text', async () => {
    await renderDetail();
    expect(within(card('Total amount')).getByText('TOTAL DUE: $6,126.45', { selector: 'blockquote' })).toBeTruthy();
    const marks = [...document.querySelectorAll('pre.doc-text mark')].map((m) => m.textContent);
    expect(marks).toEqual(['MERIDIAN OFFICE SUPPLIES LLC', 'Invoice Number: INV-2025-0847', 'Due Date: 2025-11-13', 'TOTAL DUE: $6,126.45']);
    expect(document.querySelector('pre.doc-text')!.textContent).toBe(TEXT);
  });
});

describe('detail view: approve / correct', () => {
  it('Approve calls the API and the card updates in place', async () => {
    const calls = await renderDetail(detail(), {
      'POST /api/values/v-due/review': () => ({ json: { ...VALUES[2]!, reviewState: 'approved', review: approve } }),
    });
    await userEvent.click(within(card('Due date')).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(card('Due date')).getByText('Approved')).toBeTruthy());
    expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', url: '/api/values/v-due/review', body: { action: 'approve' } }]);
    expect(document.querySelector('.summary')).toHaveTextContent('2 need your review');
  });

  it('Correct requires a value; with one, it sends value + note and shows the correction beside the extracted value', async () => {
    const corrected: Value = {
      ...VALUES[4]!,
      reviewState: 'corrected',
      review: correction('$6,200.00', 'per vendor'),
      effectiveValue: { amount: 6200, currency: 'USD' },
    };
    const calls = await renderDetail(detail(), { 'POST /api/values/v-total/review': () => ({ json: corrected }) });
    const c = card('Total amount');
    await userEvent.click(within(c).getByRole('button', { name: 'Correct' }));
    const input = within(c).getByPlaceholderText('Correct value');
    expect(input).toHaveValue('$6,126.45'); // pre-filled with what the model read
    await userEvent.clear(input);
    const save = within(c).getByRole('button', { name: 'Save correction' });
    expect(save).toBeDisabled();
    await userEvent.type(input, '   {Enter}'); // whitespace only: still nothing to save
    expect(calls.some((x) => x.method === 'POST')).toBe(false);

    await userEvent.clear(input);
    await userEvent.type(input, '$6,200.00');
    await userEvent.type(within(c).getByPlaceholderText('Note (optional)'), 'per vendor');
    await userEvent.click(save);
    await waitFor(() => expect(within(card('Total amount')).getByText('Corrected')).toBeTruthy());
    expect(calls.filter((x) => x.method === 'POST')).toEqual([
      { method: 'POST', url: '/api/values/v-total/review', body: { action: 'correct', value: '$6,200.00', note: 'per vendor' } },
    ]);
    const after = card('Total amount');
    expect(within(after).getByText('$6,200.00', { selector: '.the-value' })).toBeTruthy();
    expect(within(after).getByText('$6,126.45', { selector: 's' })).toBeTruthy(); // extracted value kept beside
    expect(within(after).queryByPlaceholderText('Correct value')).toBeNull();
  });

  it('a gap can be filled by a correction (no note → none sent)', async () => {
    const filled: Value = { ...VALUES[1]!, reviewState: 'corrected', review: correction('2025-09-14'), effectiveValue: '2025-09-14' };
    const calls = await renderDetail(detail(), { 'POST /api/values/v-issue/review': () => ({ json: filled }) });
    const c = card('Issue date');
    await userEvent.click(within(c).getByRole('button', { name: 'Correct' }));
    await userEvent.clear(within(c).getByPlaceholderText('Correct value'));
    await userEvent.type(within(c).getByPlaceholderText('Correct value'), '2025-09-14{Enter}');
    await waitFor(() => expect(within(card('Issue date')).getByText('Corrected')).toBeTruthy());
    expect(calls.find((x) => x.method === 'POST')!.body).toEqual({ action: 'correct', value: '2025-09-14' });
  });

  it('Cancel closes the form without calling the API', async () => {
    const calls = await renderDetail();
    const c = card('Due date');
    await userEvent.click(within(c).getByRole('button', { name: 'Correct' }));
    await userEvent.click(within(c).getByRole('button', { name: 'Cancel' }));
    expect(within(c).queryByPlaceholderText('Correct value')).toBeNull();
    expect(calls.some((x) => x.method === 'POST')).toBe(false);
  });

  it('an API error is shown on the card and nothing changes', async () => {
    await renderDetail(detail(), {
      'POST /api/values/v-due/review': () => ({ status: 409, json: { error: { code: 'version_not_current', message: 'Value belongs to version 1' } } }),
    });
    await userEvent.click(within(card('Due date')).getByRole('button', { name: 'Approve' }));
    expect(await within(card('Due date')).findByText('Value belongs to version 1')).toBeTruthy();
    expect(within(card('Due date')).getByText('Changed — review again')).toBeTruthy();
  });
});

describe('detail view: versions and statuses', () => {
  it('an earlier version is read-only and says so', async () => {
    const v1 = detail({
      version: 1,
      values: [base({ id: 'old', field: 'due_date', type: 'date', value: '2025-10-14', effectiveValue: '2025-10-14', reviewState: 'approved', review: approve })],
    });
    await renderDetail(v1, {}, 1);
    expect(screen.getByText(/You are viewing v1, an earlier version \(read-only\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Go to current v2' }));
    expect(go).toHaveBeenCalledWith('/documents/doc-1');
  });

  it('the version switcher lists every version and marks the current one', async () => {
    await renderDetail();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['v1', 'v2 (current)']);
    await userEvent.click(screen.getByRole('tab', { name: 'v1' }));
    expect(go).toHaveBeenCalledWith('/documents/doc-1/v/1');
  });

  it('failed: the error is visible and Retry calls the API', async () => {
    const failed = detail({ status: 'failed', error: 'PdfParseError: Could not open PDF', values: [], versions: [{ version: 2, status: 'failed', createdAt: '' }] });
    const calls = await renderDetail(failed, { 'POST /api/documents/doc-1/retry': () => ({ status: 202, json: { ...failed, status: 'queued' } }) });
    expect(screen.getByText(/Extraction failed: PdfParseError: Could not open PDF/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry extraction' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/documents/doc-1/retry')).toBe(true));
  });

  it('while extracting it says so and polls until the values arrive', async () => {
    let n = 0;
    const busy = detail({ status: 'extracting', values: [], text: null, versions: [{ version: 2, status: 'extracting', createdAt: '' }] });
    fakeApi({ 'GET /api/documents/doc-1': () => ({ json: n++ === 0 ? busy : detail() }) });
    render(<DocumentDetail id="doc-1" go={go} />);
    expect(await screen.findByText(/Extracting values with the LLM/)).toBeTruthy();
    expect(screen.getByText('Text is available once the PDF has been parsed.')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('3 need your review')).toBeTruthy(), { timeout: 4000 });
    expect(screen.queryByText(/Extracting values with the LLM/)).toBeNull();
  });

  it('404 → a clear message', async () => {
    fakeApi({});
    render(<DocumentDetail id="doc-1" go={go} />);
    expect(await screen.findByText('Document or version not found')).toBeTruthy();
  });
});

describe('document list', () => {
  const summary = (over: Partial<DocumentSummary>): DocumentSummary => ({
    id: 'doc-x',
    type: 'invoice',
    title: 'X',
    currentVersion: 1,
    status: 'extracted',
    error: null,
    progress: { total: 0, pending: 0, approved: 0, corrected: 0, carriedOver: 0, gaps: 0 },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    ...over,
  });

  it('shows status, current version and review progress per document; failed rows offer Retry', async () => {
    const calls = fakeApi({
      'GET /api/documents': () => ({
        json: [
          summary({ id: 'a', title: 'Invoice A', currentVersion: 2, progress }),
          summary({ id: 'b', title: 'Lease B', type: 'lease', status: 'extracting' }),
          summary({ id: 'c', title: 'Report C', type: 'market_report', status: 'failed', error: 'LlmError: Model refused' }),
        ],
      }),
      'POST /api/documents/c/retry': () => ({ status: 202, json: summary({ id: 'c' }) }),
    });
    const open = vi.fn();
    render(<DocumentList open={open} />);
    const rowA = (await screen.findByText('Invoice A')).closest('tr') as HTMLElement;
    expect(rowA).toHaveTextContent('v2');
    expect(rowA).toHaveTextContent('Extracted');
    expect(rowA).toHaveTextContent('3 to review');
    expect(rowA).toHaveTextContent('2/5 done · 1 gap');
    expect(screen.getByText('3 values waiting for review')).toBeTruthy();
    const rowB = screen.getByText('Lease B').closest('tr') as HTMLElement;
    expect(rowB).toHaveTextContent('Extracting…');
    const rowC = screen.getByText('Report C').closest('tr') as HTMLElement;
    expect(rowC).toHaveTextContent('Failed');
    expect(rowC).toHaveTextContent('LlmError: Model refused');
    await userEvent.click(within(rowC).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/documents/c/retry')).toBe(true));
    expect(open).not.toHaveBeenCalled(); // Retry doesn't navigate
    await userEvent.click(rowA);
    expect(open).toHaveBeenCalledWith('a');
  });

  it('uploads a PDF with its type and title', async () => {
    const calls = fakeApi({
      'GET /api/documents': () => ({ json: [] }),
      'POST /api/documents': () => ({ status: 202, json: summary({ status: 'queued' }) }),
    });
    render(<DocumentList open={vi.fn()} />);
    expect(await screen.findByText('No documents yet. Upload one above.')).toBeTruthy();
    const upload = screen.getByRole('button', { name: 'Upload' });
    expect(upload).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Document type'), 'lease');
    await userEvent.type(screen.getByPlaceholderText('Title (optional)'), 'My lease');
    const file = new File(['%PDF-1.4'], 'lease.pdf', { type: 'application/pdf' });
    await userEvent.upload(document.querySelector('input[type=file]') as HTMLInputElement, file);
    await userEvent.click(upload);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const form = calls.find((c) => c.method === 'POST')!.body as FormData;
    expect(form.get('type')).toBe('lease');
    expect(form.get('title')).toBe('My lease');
    expect((form.get('file') as File).name).toBe('lease.pdf');
  });
});

describe('App routing', () => {
  it('hash routes switch between the list and a document', async () => {
    const { App } = await import('../src/App.js');
    fakeApi({
      'GET /api/documents': () => ({ json: [] }),
      'GET /api/documents/doc-1': () => ({ json: detail() }),
      'GET /api/documents/doc-1?version=1': () => ({ json: detail({ version: 1 }) }),
    });
    window.location.hash = '';
    render(<App />);
    expect(await screen.findByText('No documents yet. Upload one above.')).toBeTruthy();
    window.location.hash = '#/documents/doc-1';
    expect(await screen.findByText('3 need your review')).toBeTruthy();
    window.location.hash = '#/documents/doc-1/v/1';
    expect(await screen.findByText(/an earlier version \(read-only\)/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '← All documents' }));
    await waitFor(() => expect(window.location.hash).toBe('#/'));
    expect(await screen.findByText('No documents yet. Upload one above.')).toBeTruthy();
  });
});

describe('retry is one click, one run', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it('detail: Retry is disabled while the request is in flight; a double click sends one POST; the button goes once queued', async () => {
    const failed = detail({ status: 'failed', error: 'LlmError: boom', values: [], versions: [{ version: 2, status: 'failed', createdAt: '' }] });
    const queued = detail({ status: 'queued', error: null, values: [], text: null, versions: [{ version: 2, status: 'queued', createdAt: '' }] });
    let retried = false;
    const gate = deferred();
    const calls = fakeApi({
      'GET /api/documents/doc-1': () => ({ json: retried ? queued : failed }),
      'POST /api/documents/doc-1/retry': async () => {
        await gate.promise;
        retried = true;
        return { status: 202, json: { ...failed, status: 'queued' } };
      },
    });
    render(<DocumentDetail id="doc-1" go={go} />);
    const button = await screen.findByRole('button', { name: 'Retry extraction' });
    await userEvent.dblClick(button);
    await userEvent.click(button);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
    gate.resolve();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull());
    expect(screen.getByText(/Waiting for a worker/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('list: the row\'s Retry is disabled while in flight and a rapid double click sends one POST', async () => {
    const row = (status: DocumentSummary['status']): DocumentSummary => ({
      id: 'c',
      type: 'market_report',
      title: 'Report C',
      currentVersion: 1,
      status,
      error: status === 'failed' ? 'LlmError: boom' : null,
      progress: { total: 0, pending: 0, approved: 0, corrected: 0, carriedOver: 0, gaps: 0 },
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
    });
    let retried = false;
    const gate = deferred();
    const calls = fakeApi({
      'GET /api/documents': () => ({ json: [row(retried ? 'queued' : 'failed')] }),
      'POST /api/documents/c/retry': async () => {
        await gate.promise;
        retried = true;
        return { status: 202, json: row('queued') };
      },
    });
    render(<DocumentList open={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Retry' });
    await userEvent.dblClick(button);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
    gate.resolve();
    await waitFor(() => expect(screen.getByText('Report C').closest('tr')).toHaveTextContent('Queued'));
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});
