import { describe, expect, it } from 'vitest';
import { WEB_URL } from './helpers';

// Brief §5: one `docker compose up` starts everything, including the review UI (CONTRACT §6: web on 8080).

describe('UI smoke', () => {
  it('GET / on the web service → 200 HTML', async () => {
    const res = await fetch(`${WEB_URL}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/);
    const html = await res.text();
    expect(html.toLowerCase()).toMatch(/<!doctype html|<html/);
  });
});
