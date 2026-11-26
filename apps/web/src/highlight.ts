export interface Span {
  id: string;
  start: number;
  end: number;
}

export interface Segment {
  text: string;
  start: number;
  /** Ids of every span covering this segment (empty = plain text). */
  ids: string[];
}

/** Split `text` into segments so overlapping evidence spans can all be highlighted. */
export function segment(text: string, spans: Span[]): Segment[] {
  const valid = spans.filter((s) => s.start >= 0 && s.end > s.start && s.end <= text.length);
  const cuts = new Set<number>([0, text.length]);
  for (const s of valid) {
    cuts.add(s.start);
    cuts.add(s.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b <= a) continue;
    out.push({ text: text.slice(a, b), start: a, ids: valid.filter((s) => s.start <= a && s.end >= b).map((s) => s.id) });
  }
  return out;
}
