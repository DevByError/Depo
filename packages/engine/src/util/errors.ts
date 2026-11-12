/**
 * The exact error, not a summary: the message, the error's name and code, every `cause` down the
 * chain, and the first stack lines that are Depo's own. Shown in the chat and kept in the activity
 * feed so the owner (and the agents on a retry) see precisely what went wrong.
 */
export function describeError(err: unknown): { message: string; detail: string } {
  if (!(err instanceof Error)) {
    const s = typeof err === "string" ? err : safeJson(err);
    return { message: s, detail: "" };
  }
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; cur instanceof Error && !seen.has(cur) && depth < 4; depth++) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    const status = (cur as { status?: unknown }).status;
    lines.push(
      `${depth === 0 ? "Error" : "Caused by"}: ${cur.name}${code !== undefined ? ` (${String(code)})` : ""}${
        status !== undefined ? ` [HTTP ${String(status)}]` : ""
      }: ${cur.message}`,
    );
    cur = (cur as { cause?: unknown }).cause;
  }
  const frames = (err.stack ?? "")
    .split("\n")
    .slice(1)
    .filter((l) => l.includes("packages") || l.includes("engine"))
    .slice(0, 4)
    .map((l) => l.trim());
  if (frames.length) lines.push(`Where: ${frames.join(" <- ")}`);
  return { message: err.message, detail: lines.join("\n") };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
