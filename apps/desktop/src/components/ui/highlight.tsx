import type { Marks } from "@depo/shared";
import { Fragment } from "react";

/** Text with the matched parts marked. Marks are [start, end) ranges; bad ranges are ignored. */
export function Highlight({ text, marks }: { text: string; marks: Marks }) {
  if (!marks.length) return <>{text}</>;
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [a, b] of [...marks].sort((x, y) => x[0] - y[0])) {
    const start = Math.max(a, at);
    const end = Math.min(b, text.length);
    if (end <= start) continue;
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <mark key={i} className="rounded-[2px] bg-accent-soft px-px text-fg">
            {p.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}
