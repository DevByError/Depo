import type { TerminalLine, TerminalStream, TerminalTone } from "@depo/shared";
import { redactString } from "../redact";

/**
 * The kept output of one Terminal run: the newest lines (2000 by default), with colour codes
 * turned into a tone per line, secrets redacted, and sequence numbers so a client can ask for
 * "everything after line N" when it reconnects.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes are control characters
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes are control characters
const SGR = /\x1b\[([0-9;]*)m/g;

const RANK: Record<TerminalTone, number> = { danger: 5, warning: 4, success: 3, info: 2, muted: 1 };

const SGR_TONE: Record<number, TerminalTone> = {
  31: "danger",
  91: "danger",
  33: "warning",
  93: "warning",
  32: "success",
  92: "success",
  34: "info",
  94: "info",
  36: "info",
  96: "info",
  90: "muted",
  2: "muted",
};

/** The strongest colour a line's ANSI codes ask for (red beats yellow beats green …). */
export function ansiTone(raw: string): TerminalTone | undefined {
  let best: TerminalTone | undefined;
  for (const m of raw.matchAll(SGR)) {
    const codes = (m[1] || "0").split(";").map((c) => Number(c || 0));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i] as number;
      // 256-colour and true-colour codes carry extra numbers that are not colours of their own.
      if (c === 38 || c === 48) {
        i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
        continue;
      }
      const tone = SGR_TONE[c];
      if (tone && (!best || RANK[tone] > RANK[best])) best = tone;
    }
  }
  return best;
}

/** Most tools print no colours here (NO_COLOR is set), so plain words at the start count too. */
export function wordTone(text: string): TerminalTone | undefined {
  if (/^\s*(error\b|ERROR\b|Error:|FAIL(ED)?\b|\(fail\)|✖|×|✗|E {3})/.test(text)) return "danger";
  if (/^\s*(warning\b|WARN(ING)?\b|warn\b|Warning:|⚠)/.test(text)) return "warning";
  if (/^\s*(PASS(ED)?\b|\(pass\)|✓|✔|ok\s)/.test(text)) return "success";
  return undefined;
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

export class LineRing {
  private lines: TerminalLine[] = [];
  private seq = 0;
  private partial: Record<"out" | "err", string> = { out: "", err: "" };
  /** Lines not yet handed out with `takeNew` (for live events). */
  private fresh: TerminalLine[] = [];

  constructor(
    private readonly max = 2000,
    private readonly maxLine = 2000,
  ) {}

  get count(): number {
    return this.seq;
  }

  push(stream: "out" | "err", chunk: string): void {
    const text = this.partial[stream] + chunk.replace(/\r\n/g, "\n");
    const parts = text.split("\n");
    this.partial[stream] = parts.pop() ?? "";
    for (const p of parts) this.add(stream, p);
    if (this.partial[stream].length > this.maxLine * 2) {
      this.add(stream, this.partial[stream]);
      this.partial[stream] = "";
    }
  }

  /** Depo's own line (start, stop, exit code). */
  note(text: string): void {
    for (const l of text.split("\n")) this.add("depo", l);
  }

  /** Keep what is left of unfinished lines (the command ended). */
  flush(): void {
    for (const s of ["out", "err"] as const) {
      if (this.partial[s]) this.add(s, this.partial[s]);
      this.partial[s] = "";
    }
  }

  private add(stream: TerminalStream, raw: string): void {
    // Progress bars redraw with \r: keep what the line finally showed.
    const last = raw.split("\r").filter(Boolean).pop() ?? "";
    const tone = ansiTone(last);
    const shown = stripAnsi(last);
    const text = redactString(shown.length > this.maxLine ? `${shown.slice(0, this.maxLine)} …` : shown);
    const line: TerminalLine = { seq: ++this.seq, stream, text };
    const t = stream === "depo" ? undefined : (tone ?? wordTone(text));
    if (t) line.tone = t;
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    this.fresh.push(line);
    if (this.fresh.length > this.max) this.fresh.splice(0, this.fresh.length - this.max);
  }

  /** Lines added since the last call. */
  takeNew(): TerminalLine[] {
    const out = this.fresh;
    this.fresh = [];
    return out;
  }

  since(after: number): { lines: TerminalLine[]; next: number; dropped: boolean } {
    const first = this.lines[0]?.seq ?? this.seq + 1;
    return {
      lines: this.lines.filter((l) => l.seq > after),
      next: this.seq,
      dropped: first > after + 1,
    };
  }

  /** The newest output as plain text, at most `maxChars` (kept with the run after it ends). */
  tailText(maxChars: number): string {
    const out: string[] = [];
    let size = 0;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i] as TerminalLine;
      const text = l.stream === "depo" ? `[depo] ${l.text}` : l.text;
      if (size + text.length + 1 > maxChars) break;
      out.push(text);
      size += text.length + 1;
    }
    return out.reverse().join("\n");
  }
}

/** Lines back from text kept with a finished run (after an engine restart). */
export function linesFromText(text: string, total: number): TerminalLine[] {
  if (!text) return [];
  const rows = text.split("\n");
  const start = Math.max(0, total - rows.length);
  return rows.map((r, i) => {
    const depo = r.startsWith("[depo] ");
    const line: TerminalLine = {
      seq: start + i + 1,
      stream: depo ? "depo" : "out",
      text: depo ? r.slice(7) : r,
    };
    const tone = depo ? undefined : wordTone(r);
    if (tone) line.tone = tone;
    return line;
  });
}
