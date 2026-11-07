import type { LanguageId } from "./highlight/languages";

/**
 * The text behind "Ask about this", "Change this" and "Copy path:line" on selected lines in Files.
 * Code goes in a fenced block tagged with its language, so the model and the chat both read it.
 */

/** "Ask about this" sends at most this many lines; the agent can read the file for the rest. */
export const ASK_MAX_LINES = 80;
/** "Change this" quotes a short excerpt only; the owner's words matter more than the code. */
export const EXCERPT_LINES = 12;
const MAX_LINE_CHARS = 400;
const ASK_MAX_CHARS = 12_000;
const EXCERPT_MAX_CHARS = 2_000;

export interface LineSelection {
  path: string;
  /** First and last selected line (1-based, inclusive). */
  start: number;
  end: number;
  /** The selected lines' text. */
  lines: string[];
  lang: LanguageId | null;
}

/** "app/main.py:12" or "app/main.py:12-18". */
export function pathLine(path: string, start: number, end: number): string {
  return start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
}

/** "line 12" or "lines 12 to 18". */
export function linesLabel(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start} to ${end}`;
}

/** Up to `maxLines` lines and `maxChars` characters; very long lines are cut. */
function clip(lines: string[], maxLines: number, maxChars: number): string[] {
  const out: string[] = [];
  let chars = 0;
  for (const raw of lines.slice(0, maxLines)) {
    const line = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…` : raw;
    if (out.length > 0 && chars + line.length > maxChars) break;
    out.push(line);
    chars += line.length + 1;
  }
  return out;
}

/** A fenced block whose fence is longer than any run of backticks inside the code. */
export function fenced(code: string, lang: LanguageId | null): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang ?? ""}\n${code}\n${fence}`;
}

function shownNote(shown: number, total: number): string {
  return shown < total ? `\n\nOnly the first ${shown} of ${total} selected lines are shown.` : "";
}

/** The question "Ask about this" sends (ask mode: Depo explains, changes nothing). */
export function askText(s: LineSelection): string {
  const shown = clip(s.lines, ASK_MAX_LINES, ASK_MAX_CHARS);
  return (
    `Explain what ${linesLabel(s.start, s.end)} of \`${s.path}\` do.\n\n` +
    fenced(shown.join("\n"), s.lang) +
    shownNote(shown.length, s.lines.length)
  );
}

/** The composer text "Change this" starts, with the caret where the owner says what to change. */
export function changeText(s: LineSelection): { text: string; cursor: number } {
  const head = `Change ${linesLabel(s.start, s.end)} of \`${s.path}\`: `;
  const shown = clip(s.lines, EXCERPT_LINES, EXCERPT_MAX_CHARS);
  const text = `${head}\n\n${fenced(shown.join("\n"), s.lang)}${shownNote(shown.length, s.lines.length)}`;
  return { text, cursor: head.length };
}
