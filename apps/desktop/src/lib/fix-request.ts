import type { Problem, RuntimeProblem, Task, TerminalRun, TestRun } from "@depo/shared";
import { agentName } from "./step-summary";

/**
 * Drafts for "Fix with an agent": what failed, where (file and line), the message, a short code
 * or output excerpt (at most 40 lines) and where it ran. The owner can edit the draft before it
 * is sent, and the agent still works in a private copy first.
 */

export const MAX_EXCERPT_LINES = 40;
const MAX_LINE_CHARS = 300;
const MAX_DRAFT_CHARS = 12_000;

function cut(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  return lines;
}

/** The last lines of some output (failures are usually at the end). */
export function tailExcerpt(text: string, max = MAX_EXCERPT_LINES): string {
  return splitLines(text).slice(-max).map(cut).join("\n");
}

/** The first lines of something (a traceback, a list). */
export function headExcerpt(text: string, max = MAX_EXCERPT_LINES): string {
  return splitLines(text).slice(0, max).map(cut).join("\n");
}

/** Lines around `line` (1-based) of a file, numbered, at most 40. */
export function codeExcerpt(fileText: string, line: number, around = 6): string {
  const all = fileText.replace(/\r\n?/g, "\n").split("\n");
  const from = Math.max(1, line - around);
  const to = Math.min(all.length, line + around, from + MAX_EXCERPT_LINES - 1);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const mark = n === line ? ">" : " ";
    out.push(`${mark} ${String(n).padStart(width)} | ${cut(all[n - 1] ?? "")}`);
  }
  return out.join("\n");
}

function fence(text: string): string {
  // A fence longer than any run of backticks inside, so the excerpt cannot close it early.
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
}

/** Where it happened, as the last part of a draft. */
export function whereText(taskId: string | null, target: string): string {
  return taskId
    ? `Where: the private copy of the task "${target}" (its changes are not applied yet).`
    : "Where: my project folder.";
}

function at(file: string | null, line: number | null, column: number | null): string {
  if (!file) return "";
  if (line === null) return file;
  return column === null ? `${file}:${line}` : `${file}:${line}:${column}`;
}

const WORD: Record<Problem["severity"], string> = { error: "error", warning: "warning", info: "note" };

function finish(parts: (string | null | false)[]): string {
  const text = parts.filter((p): p is string => !!p).join("\n\n");
  return text.length > MAX_DRAFT_CHARS ? `${text.slice(0, MAX_DRAFT_CHARS)}\n[cut]` : text;
}

/** One problem from a check, with the code around it when it was read. */
export function draftForProblem(
  p: Problem,
  where: { taskId: string | null; target: string },
  code?: string | null,
): string {
  const place = at(p.file, p.line, p.column);
  return finish([
    `Fix this ${WORD[p.severity]} that ${p.tool} found${place ? ` in ${place}` : ""}:\n${p.code ? `${p.code}: ` : ""}${p.message}`,
    code && p.line !== null ? `Code around line ${p.line}:\n${fence(code)}` : null,
    whereText(where.taskId, where.target),
    "Find the cause and fix it, then run diagnostics to check that it is gone.",
  ]);
}

/** Every problem of one file. */
export function draftForFile(
  file: string,
  problems: Problem[],
  where: { taskId: string | null; target: string },
): string {
  const tools = [...new Set(problems.map((p) => p.tool))].join(" and ");
  const list = problems.slice(0, MAX_EXCERPT_LINES).map((p) => {
    const pos = p.line === null ? "" : `line ${p.line}${p.column === null ? "" : `:${p.column}`} `;
    return cut(`- ${pos}${WORD[p.severity]}${p.code ? ` ${p.code}` : ""}: ${p.message.split("\n")[0]}`);
  });
  if (problems.length > MAX_EXCERPT_LINES) list.push(`- and ${problems.length - MAX_EXCERPT_LINES} more`);
  return finish([
    `Fix the problems that ${tools} found in ${file}:\n${list.join("\n")}`,
    whereText(where.taskId, where.target),
    "Fix them, then run diagnostics to check that they are gone.",
  ]);
}

/** A crash in a running app, or a console error from a page check. */
export function draftForRuntime(p: RuntimeProblem, where: { taskId: string | null; target: string }): string {
  const place = at(p.file, p.line, p.column);
  const what =
    p.source === "preview"
      ? `The running app reported this error${p.count > 1 ? ` (${p.count} times)` : ""}:`
      : `A page check found this console error in the browser${p.count > 1 ? ` (${p.count} times)` : ""}:`;
  const excerpt = p.excerpt.trim() ? headExcerpt(p.excerpt) : "";
  return finish([
    `${what}\n${p.message}${place ? `\nAt ${place}.` : ""}`,
    excerpt ? `${p.source === "preview" ? "From the log" : "Details"}:\n${fence(excerpt)}` : null,
    whereText(where.taskId, where.target),
    p.source === "preview"
      ? "Find the cause and fix it, then start the app again and check that the error is gone."
      : "Find the cause and fix it, then check the page again.",
  ]);
}

/** A test run with failures. */
export function draftForTestRun(run: TestRun): string {
  const who = run.source === "terminal" ? "I ran" : `the ${agentName(run.by) || "Testing"} agent ran`;
  const failures = run.failures.slice(0, 12).map((f) => {
    const place = at(f.file, f.line, null);
    const msg = headExcerpt(f.message, 3).replace(/\n/g, " / ");
    return cut(`- ${f.name}${place ? ` (${place})` : ""}${msg ? `: ${msg}` : ""}`);
  });
  if (run.failures.length > 12) failures.push(`- and ${run.failures.length - 12} more`);
  const count = run.failed ? `${run.failed} test${run.failed === 1 ? "" : "s"} failed` : "Tests failed";
  return finish([
    `${count} when ${who} \`${run.command}\`.${run.summary ? ` Summary: ${run.summary}` : ""}`,
    failures.length > 0 ? `Failures:\n${failures.join("\n")}` : null,
    failures.length === 0 && run.outputTail.trim()
      ? `End of the output:\n${fence(tailExcerpt(run.outputTail))}`
      : null,
    whereText(run.taskId, run.target),
    "Fix the code so the tests pass. Change a test only if the test itself is wrong. Then run the tests again.",
  ]);
}

/** A Terminal command that exited non-zero (or hit the time limit). */
export function draftForTerminalRun(run: TerminalRun, output: string): string {
  const how =
    run.state === "timed_out"
      ? "This command did not finish within the time limit"
      : `This command failed${run.exitCode === null ? "" : ` with exit code ${run.exitCode}`}`;
  const tail = tailExcerpt(output);
  return finish([
    `${how}:\n\`${run.command}\``,
    tail
      ? `Output (last ${Math.min(MAX_EXCERPT_LINES, tail.split("\n").length)} lines):\n${fence(tail)}`
      : null,
    whereText(run.taskId, run.target),
    run.state === "timed_out"
      ? "Find out why it hangs or runs so long and fix it, then run the command again."
      : "Find the cause and fix it so the command succeeds, then run it again.",
  ]);
}

/**
 * Where the request goes: a task copy whose task is in review or done gets it as a follow-up,
 * anything else starts a new task.
 */
export function fixDestination(taskId: string | null, tasks: Pick<Task, "id" | "status" | "title">[]) {
  if (!taskId) return null;
  const task = tasks.find((t) => t.id === taskId);
  return task && (task.status === "review" || task.status === "done") ? task : null;
}
