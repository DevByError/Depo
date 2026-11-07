import { useEffect, useMemo, useState } from "react";
import { highlightCode, highlightKey, isTooLarge, peekHighlight } from "./highlighter";
import type { LanguageId } from "./languages";
import { splitLines, type Token } from "./tokens";

/**
 * plain: no known language; loading: colours on their way; ready: highlighted; large: over the
 * size limit, shown without colours; failed: the grammar could not load.
 */
export type HighlightState = "plain" | "loading" | "ready" | "large" | "failed";

export interface Highlighted {
  state: HighlightState;
  /**
   * One entry per line of the code; null until highlighted (render the plain text meanwhile).
   * While new code loads this keeps the previous version's colours, so a streaming block does not
   * flicker; render through `Tokens`, which ignores a line whose text changed.
   */
  lines: Token[][] | null;
}

/** Highlight a piece of code for rendering. Cached results show at once, without a plain flash. */
export function useHighlight(code: string | null | undefined, lang: LanguageId | null): Highlighted {
  const job = useMemo(() => {
    if (code == null || !lang) return null;
    if (isTooLarge(code)) return { code, lang, key: null };
    return { code, lang, key: highlightKey(code, lang) };
  }, [code, lang]);
  const [done, setDone] = useState<{ key: string; lines: Token[][] | null } | null>(null);
  const cached = job?.key ? peekHighlight(job.key) : undefined;

  useEffect(() => {
    if (!job?.key || peekHighlight(job.key)) return;
    let live = true;
    const key = job.key;
    void highlightCode(job.code, job.lang, key).then((r) => {
      if (live) setDone({ key, lines: r.status === "ready" ? r.lines : null });
    });
    return () => {
      live = false;
    };
  }, [job]);

  if (!job) return { state: "plain", lines: null };
  if (!job.key) return { state: "large", lines: null };
  if (cached) return { state: "ready", lines: cached };
  if (done?.key === job.key)
    return done.lines ? { state: "ready", lines: done.lines } : { state: "failed", lines: null };
  return { state: "loading", lines: done?.lines ?? null };
}

/** A diff row: " " context, "-" removed, "+" added. */
export interface DiffRowText {
  t: string;
  text: string;
}

/**
 * Tokens for each row of a diff hunk. The old side (context and removed lines) and the new side
 * (context and added lines) are highlighted as two pieces of code, so a comment or string that spans
 * lines keeps its colour on every row. `large` when the hunk is over the size limit.
 */
export function useDiffHighlight(
  rows: DiffRowText[],
  lang: LanguageId | null,
): { tokens: (Token[] | null)[]; large: boolean } {
  const { oldText, newText, hasOld } = useMemo(
    () => ({
      oldText: rows
        .filter((r) => r.t !== "+")
        .map((r) => r.text)
        .join("\n"),
      newText: rows
        .filter((r) => r.t !== "-")
        .map((r) => r.text)
        .join("\n"),
      hasOld: rows.some((r) => r.t === "-"),
    }),
    [rows],
  );
  const before = useHighlight(hasOld ? oldText : null, lang);
  const after = useHighlight(newText, lang);
  const tokens = useMemo(() => {
    let o = 0;
    let n = 0;
    return rows.map((r) => {
      if (r.t === "-") return before.lines?.[o++] ?? null;
      if (r.t === "+") return after.lines?.[n++] ?? null;
      o++;
      return after.lines?.[n++] ?? null;
    });
  }, [rows, before.lines, after.lines]);
  return { tokens, large: before.state === "large" || after.state === "large" };
}

/** Tokens for each line of `code`, or null per line while not highlighted. */
export function linesOf(code: string, h: Highlighted): { text: string; tokens: Token[] | null }[] {
  return splitLines(code).map((text, i) => ({ text, tokens: h.lines?.[i] ?? null }));
}
