/**
 * Retrieval for the prompt, without an embedding model: a big file is cut into chunks of about
 * forty lines (at blank lines), each chunk is scored against the words of the step with BM25, and
 * the best chunks that fit the budget are shown with their line numbers. Nothing is loaded or
 * downloaded, it runs in a millisecond, and the exact text of the chunk is what the model copies
 * into an edit. Embeddings (the `search` tool, when an embedding model is installed) stay for
 * questions in words that share no words with the code.
 */

export interface Chunk {
  /** 1-based, inclusive. */
  start: number;
  end: number;
  text: string;
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "then",
  "each",
  "its",
  "has",
  "have",
  "will",
  "not",
  "are",
  "all",
  "any",
  "add",
  "make",
  "use",
  "new",
  "step",
  "file",
  "must",
  "should",
  "also",
  "only",
  "one",
  "two",
  "get",
  "set",
]);

/** Lower-case words of a text, camelCase and snake_case split, 3 letters or more, no filler words. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Chunks of roughly `target` lines, cut at the first blank line after the target is reached. */
export function chunkLines(lines: string[], target = 40, hardMax = 70): Chunk[] {
  const out: Chunk[] = [];
  let from = 0;
  while (from < lines.length) {
    let to = Math.min(lines.length, from + target);
    while (to < lines.length && to - from < hardMax && (lines[to - 1] ?? "").trim() !== "") to++;
    out.push({ start: from + 1, end: to, text: lines.slice(from, to).join("\n") });
    from = to;
  }
  return out;
}

/** BM25 scores of the chunks for the query words (higher is better; 0 means no word matched). */
export function scoreChunks(chunks: Chunk[], query: string): number[] {
  const q = [...new Set(words(query))];
  if (!q.length || !chunks.length) return chunks.map(() => 0);
  const docs = chunks.map((c) => words(c.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const n = df.get(w) ?? 0;
      const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
    }
    return score;
  });
}

export interface Retrieved {
  /** The text to show: the kept chunks in file order, with a marker where lines were left out. */
  text: string;
  /** The line ranges kept, 1-based inclusive. */
  ranges: [number, number][];
  totalLines: number;
}

/**
 * The parts of a file that matter for the query, at most `budget` characters: the first lines (the
 * imports), then the best-scoring chunks. Null when nothing matches or nothing fits.
 */
export function relevantParts(body: string, query: string, budget: number): Retrieved | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const chunks = chunkLines(lines);
  const scores = scoreChunks(chunks, query);
  const order = chunks.map((_, i) => i).filter((i) => (scores[i] ?? 0) > 0);
  order.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  const picked = new Set<number>();
  let used = 0;
  const cost = (c: Chunk) => c.text.length + 40;
  // The top of the file holds the imports an edit usually needs to match.
  const head = chunks[0];
  if (head && cost(head) <= budget * 0.4) {
    picked.add(0);
    used += cost(head);
  }
  for (const i of order) {
    const c = chunks[i];
    if (!c || picked.has(i)) continue;
    if (used + cost(c) > budget) continue;
    picked.add(i);
    used += cost(c);
  }
  if (picked.size === 0 || (picked.size === 1 && picked.has(0) && order.length === 0)) return null;
  const kept = [...picked].sort((a, b) => a - b).map((i) => chunks[i] as Chunk);
  const parts: string[] = [];
  let prevEnd = 0;
  for (const c of kept) {
    if (c.start > prevEnd + 1) parts.push(`… (lines ${prevEnd + 1}-${c.start - 1} not shown) …`);
    parts.push(c.text);
    prevEnd = c.end;
  }
  if (prevEnd < lines.length) parts.push(`… (lines ${prevEnd + 1}-${lines.length} not shown) …`);
  return {
    text: parts.join("\n"),
    ranges: kept.map((c) => [c.start, c.end] as [number, number]),
    totalLines: lines.length,
  };
}
