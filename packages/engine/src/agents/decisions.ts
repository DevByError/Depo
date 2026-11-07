import type { DecisionKind, JsonValue, Review, WorkMode } from "@depo/shared";

/**
 * Plain-language decision lines for the Team screen. Everything here is pure: it turns what an
 * agent wrote (untrusted model output) into short, readable text and never acts on it.
 */

export const MODE_LABEL: Record<WorkMode, string> = {
  single: "Single agent",
  full: "Full system",
  backend: "Backend only",
  frontend: "Frontend only",
  ai: "AI integration",
  import: "Study project",
  fix: "Fix / debug",
  refactor: "Refactor / upgrade",
  ask: "Ask / explain",
  business: "Business",
};

const GRADE_LABEL: Record<Review["findings"][number]["grade"], string> = {
  blocking: "Blocking",
  should_fix: "Should fix",
  nice_to_have: "Nice to have",
};

/** Text without Markdown marks or code blocks, on one line. */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut at a word boundary and add an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** The first one or two sentences of a message, for a one-line summary. */
export function firstSentences(text: string, count = 2, max = 220): string {
  const plain = plainText(text);
  if (!plain) return "";
  const parts = plain.split(/(?<=[.!?])\s+(?=["'(A-Z0-9])/);
  return clip(parts.slice(0, Math.max(1, count)).join(" "), max);
}

/** A shorter task title for a sentence. */
export function shortTitle(title: string, max = 70): string {
  return clip(plainText(title), max);
}

/**
 * The architecture decisions in a piece of decisions.md: one per heading ("## ADR-3: Use
 * Postgres"), or the first sentence when the text has no headings.
 */
export function adrEntries(content: string): { title: string; body: string }[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const out: { title: string; body: string }[] = [];
  let current: { title: string; body: string[] } | null = null;
  const push = () => {
    if (current?.title)
      out.push({ title: current.title, body: clip(plainText(current.body.join("\n")), 500) });
  };
  for (const line of lines) {
    const h = /^\s{0,3}#{1,4}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h?.[1]) {
      push();
      const title = clip(
        plainText(h[1])
          .replace(/^(?:ADR|Decision)[\s-]*\d*\s*[:.\-–]\s*/i, "")
          .trim(),
        120,
      );
      current = { title, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  push();
  if (out.length > 0) return out.slice(0, 6);
  const plain = plainText(content);
  if (!plain) return [];
  const title = firstSentences(plain, 1, 120);
  const body = plain.length > title.length ? clip(plain, 500) : "";
  return [{ title, body }];
}

/** The option a Thinking agent recommends, from options.md or its final message. */
export function recommendationOf(text: string): string | null {
  if (!text.trim()) return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // A "Recommendation" heading: the first sentence of the paragraph under it.
  const hi = lines.findIndex((l) => /^\s{0,3}#{1,6}\s+.*recommend/i.test(l));
  if (hi >= 0) {
    const inline = plainText(lines[hi] ?? "").replace(/^.*?recommend\w*\s*[:\-–]?\s*/i, "");
    if (inline.length > 3) return firstSentences(inline, 1, 160);
    const next = lines.slice(hi + 1).find((l) => l.trim() && !/^\s*#/.test(l));
    if (next) return firstSentences(next, 1, 160);
  }
  // "Recommendation: Option B ..." on one line.
  for (const l of lines) {
    const m = /\brecommend(?:ation|ed)?\b[^:]{0,30}:\s*(.+)/i.exec(plainText(l));
    if (m?.[1] && m[1].length > 3) return firstSentences(m[1], 1, 160);
  }
  // "I recommend ..." / "We recommend ..." anywhere.
  const sentences = plainText(text).split(/(?<=[.!?])\s+/);
  const s = sentences.find((x) => /\b(?:I|we)\s+(?:would\s+)?recommend\b/i.test(x));
  if (s) return clip(s.replace(/^.*?\b(?:I|we)\s+(?:would\s+)?recommend\s+/i, ""), 160);
  return null;
}

export interface ReviewCounts {
  blocking: number;
  shouldFix: number;
  niceToHave: number;
  /** The top issues, most serious first, as "Blocking: src/app.ts:4 what is wrong". */
  top: string[];
}

export function reviewCounts(review: Review, topN = 3): ReviewCounts {
  const order = { blocking: 0, should_fix: 1, nice_to_have: 2 } as const;
  const sorted = [...review.findings].sort((a, b) => order[a.grade] - order[b.grade]);
  return {
    blocking: review.findings.filter((f) => f.grade === "blocking").length,
    shouldFix: review.findings.filter((f) => f.grade === "should_fix").length,
    niceToHave: review.findings.filter((f) => f.grade === "nice_to_have").length,
    top: sorted.slice(0, topN).map((f) => {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : "";
      return `${GRADE_LABEL[f.grade]}: ${where}${clip(plainText(f.text), 200)}`;
    }),
  };
}

/** "Reasoning approved Backend API (0 blocking, 2 should fix)". */
export function reviewText(reviewer: string, title: string, review: Review): string {
  const c = reviewCounts(review);
  const counts = [`${c.blocking} blocking`, `${c.shouldFix} should fix`];
  if (c.niceToHave > 0) counts.push(`${c.niceToHave} nice to have`);
  const t = shortTitle(title);
  return review.verdict === "approve" || c.blocking === 0
    ? `${reviewer} approved ${t} (${counts.join(", ")})`
    : `${reviewer} asked for changes to ${t} (${counts.join(", ")})`;
}

/** Decision details without undefined values (the event schema only takes JSON). */
export function decisionDetails(
  kind: DecisionKind,
  extra: Record<string, JsonValue | undefined>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { kind };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
  return out;
}

/** "A, B and C". */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
