// The real browser entry (src/main.tsx), imported as index.html loads it: it mounts <App /> into #root.
import { screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { DocumentSummary } from '../src/api.js';

const doc: DocumentSummary = {
  id: 'doc-invoice-001',
  type: 'invoice',
  title: 'Invoice — Meridian Office Supplies',
  currentVersion: 1,
  status: 'extracted',
  error: null,
  progress: { total: 5, pending: 5, approved: 0, corrected: 0, carriedOver: 0, gaps: 0 },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

it('mounts the app shell into #root and loads the document list from the API', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const fetchMock = vi.fn(async (url: string) =>
    url === '/api/documents'
      ? new Response(JSON.stringify([doc]), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ error: { code: 'not_found', message: url } }), { status: 404 }),
  );
  vi.stubGlobal('fetch', fetchMock);

  await import('../src/main.js');

  const root = document.getElementById('root')!;
  const brand = await within(root).findByRole('link', { name: /lomi\s*review/i });
  expect(brand).toHaveAttribute('href', '#/');
  expect(within(root).getByText(/checked against its source passage/i)).toBeInTheDocument();
  expect(await screen.findByText(doc.title)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/documents', undefined);
});
