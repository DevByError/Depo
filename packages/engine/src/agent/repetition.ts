/**
 * Small models sometimes fall into a loop and write the same lines again and again; Ollama keeps
 * generating until someone stops it, which on a modest PC can be an hour. findRepetition spots a
 * block of lines, or a run of characters, repeating at the end of a reply so the loop can stop it.
 */

export interface Repetition {
  /** Keep the reply up to here: what came before the loop plus one copy of the repeated part. */
  keep: number;
  /** The repeated part. */
  unit: string;
  /** Copies in a row. */
  times: number;
}

/** Longest repeated block of lines looked for. */
const MAX_UNIT_LINES = 16;
/** Longest repeated run of characters looked for (inside one long line). */
const MAX_UNIT_CHARS = 512;
/** Only the end of a long reply is searched: a loop is caught soon after it starts. */
const TAIL_CHARS = 24_000;

interface Line {
  text: string;
  start: number;
}

/** Complete lines of the reply's end, without blank lines (a partial last line is left out). */
function tailLines(text: string): Line[] {
  const end = text.lastIndexOf("\n"); // complete lines stop at the last newline
  let i = 0;
  if (text.length > TAIL_CHARS) {
    const nl = text.indexOf("\n", text.length - TAIL_CHARS);
    if (nl < 0) return [];
    i = nl + 1;
  }
  const out: Line[] = [];
  while (i <= end) {
    const nl = text.indexOf("\n", i);
    const t = text.slice(i, nl).trim();
    if (t) out.push({ text: t, start: i });
    i = nl + 1;
  }
  return out;
}

/** Copies of a block this long needed before it counts as a loop. */
function copiesNeeded(unitChars: number): number {
  return unitChars >= 200 ? 3 : unitChars >= 60 ? 4 : 6;
}

function repeatedLines(text: string): Repetition | null {
  const lines = tailLines(text);
  const n = lines.length;
  for (let size = 1; size <= MAX_UNIT_LINES && size * 3 <= n; size++) {
    const same = (a: number, b: number) => {
      for (let j = 0; j < size; j++) if (lines[a + j]?.text !== lines[b + j]?.text) return false;
      return true;
    };
    const last = n - size;
    let times = 1;
    while (last - times * size >= 0 && same(last - times * size, last)) times++;
    const unit = lines
      .slice(last)
      .map((l) => l.text)
      .join("\n");
    if (times < copiesNeeded(unit.length) || times * unit.length < 400) continue;
    // Keep the first copy: cut where the second one starts.
    const second = lines[n - (times - 1) * size];
    if (second) return { keep: second.start, unit, times };
  }
  return null;
}

function repeatedChars(text: string): Repetition | null {
  for (let p = 1; p <= MAX_UNIT_CHARS; p++) {
    const span = Math.max(4 * p, 400);
    if (span > text.length) break;
    const from = text.length - span;
    let periodic = true;
    for (let i = text.length - 1 - p; i >= from; i--) {
      if (text[i] !== text[i + p]) {
        periodic = false;
        break;
      }
    }
    if (!periodic) continue;
    const unit = text.slice(text.length - p);
    if (!unit.trim()) return null; // runs of spaces or newlines are harmless and end by themselves
    let start = from;
    const floor = Math.max(0, text.length - TAIL_CHARS);
    while (start > floor && text[start - 1] === text[start - 1 + p]) start--;
    return { keep: start + p, unit, times: Math.floor((text.length - start) / p) };
  }
  return null;
}

/** A loop at the end of the reply, or null. */
export function findRepetition(text: string): Repetition | null {
  return repeatedLines(text) ?? repeatedChars(text);
}

/** Checks a growing reply every few hundred characters, so streaming stays cheap. */
export class RepetitionGuard {
  private checkedAt = 0;
  constructor(private readonly every = 256) {}

  check(text: string): Repetition | null {
    if (text.length - this.checkedAt < this.every) return null;
    this.checkedAt = text.length;
    return findRepetition(text);
  }
}
