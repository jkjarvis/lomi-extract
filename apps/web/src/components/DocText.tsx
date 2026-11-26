import { useEffect, useMemo, useRef } from 'react';
import type { Value } from '../api.js';
import { segment } from '../highlight.js';

/** The version's own parsed text with every evidence quote highlighted; the focused one is emphasised. */
export function DocText({ text, values, activeId, onSelect }: { text: string; values: Value[]; activeId: string | null; onSelect: (id: string) => void }) {
  const spans = useMemo(
    () => values.filter((v) => v.evidence).map((v) => ({ id: v.id, start: v.evidence!.start, end: v.evidence!.end })),
    [values],
  );
  const segs = useMemo(() => segment(text, spans), [text, spans]);
  const pending = useMemo(() => new Set(values.filter((v) => v.reviewState === 'pending').map((v) => v.id)), [values]);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!activeId) return;
    ref.current?.querySelector(`[data-ids~="${activeId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeId]);

  return (
    <pre className="doc-text" ref={ref}>
      {segs.map((s) =>
        s.ids.length === 0 ? (
          <span key={s.start}>{s.text}</span>
        ) : (
          <mark
            key={s.start}
            data-ids={s.ids.join(' ')}
            className={[activeId && s.ids.includes(activeId) ? 'active' : '', s.ids.some((id) => pending.has(id)) ? 'pending' : 'done'].join(' ')}
            onClick={() => onSelect(s.ids[0]!)}
          >
            {s.text}
          </mark>
        ),
      )}
    </pre>
  );
}
