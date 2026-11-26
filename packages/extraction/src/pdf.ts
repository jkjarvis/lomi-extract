import { createHash } from 'node:crypto';
import { getDocumentProxy } from 'unpdf';

export class PdfParseError extends Error {
  override name = 'PdfParseError';
}

export function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

interface Item {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!; // lower median
}

/** Rebuild readable lines from positioned text items (one page). Keeps column layout and paragraph breaks. */
export function layoutPage(items: Item[]): string {
  const visible = items.filter((i) => i.str.length > 0);
  if (visible.length === 0) return '';

  const charW =
    median(visible.filter((i) => i.str.trim().length > 0 && i.w > 0).map((i) => i.w / i.str.length)) ??
    (median(visible.map((i) => i.h)) ?? 10) * 0.5;
  const marginX = Math.min(...visible.map((i) => i.x));

  // Group into lines by baseline (top of page first).
  const sorted = [...visible].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; h: number; items: Item[] }[] = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(1, it.h * 0.3));
    if (line) line.items.push(it);
    else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  lines.sort((a, b) => b.y - a.y);

  const gaps = lines.slice(1).map((l, i) => lines[i]!.y - l.y);
  const lineGap = median(gaps) ?? 0;

  const out: string[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0 && lineGap > 0 && lines[idx - 1]!.y - line.y > lineGap * 1.5) out.push('');
    let s = '';
    let prevEnd: number | null = null;
    for (const it of line.items.sort((a, b) => a.x - b.x)) {
      if (it.str.trim().length === 0) continue; // explicit spacing is reconstructed from positions
      const col = Math.max(0, Math.round((it.x - marginX) / charW));
      if (col > s.length) s = s.padEnd(col, ' ');
      else if (prevEnd !== null && it.x - prevEnd > charW * 0.25 && !s.endsWith(' ')) s += ' ';
      s += it.str;
      prevEnd = it.x + it.w;
    }
    out.push(s.replace(/\s+$/, ''));
  });
  return out.join('\n');
}

/** Extract the text of a PDF. Deterministic for a given file, so parsed text can be stored and re-derived. */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  if (!isPdf(bytes)) throw new PdfParseError('File is not a PDF (missing %PDF- header)');
  let pdf;
  try {
    // pdf.js may detach the buffer it is given, so hand it a copy.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    throw new PdfParseError(`Could not open PDF: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const pages: string[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const raw of content.items) {
        if (!('str' in raw)) continue;
        const t = raw.transform as number[];
        items.push({ str: raw.str, x: t[4] ?? 0, y: t[5] ?? 0, w: raw.width, h: raw.height || Math.abs(t[3] ?? 10) });
      }
      pages.push(layoutPage(items));
    }
    const text = pages.join('\n\n').trim();
    if (text.length === 0) throw new PdfParseError('PDF contains no extractable text (scanned image?)');
    return text;
  } catch (err) {
    if (err instanceof PdfParseError) throw err;
    throw new PdfParseError(`Could not read PDF text: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await pdf.destroy().catch(() => undefined);
  }
}
