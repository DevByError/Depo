import type { ChatItem, JsonValue } from "@depo/shared";
import { agentKey } from "./agent-color";
import { formatBytes } from "./format";

/**
 * Turns the agent's raw transcript items into short, human lines for the chat's step list:
 * "Read app/main.py · 13 lines", "Ran python -m pytest -q · 2 passed". Everything here is pure, so it
 * is easy to test. Tool output and arguments are untrusted text: these helpers only read them.
 */

export type StepKind =
  | "read"
  | "list"
  | "find"
  | "search"
  | "write"
  | "edit"
  | "delete"
  | "command"
  | "test"
  | "git"
  | "map"
  | "memory"
  | "board"
  | "message"
  | "diagram"
  | "screenshot"
  | "deck"
  | "audit"
  | "security"
  | "performance"
  | "block"
  | "fonts"
  | "tool";

export interface StepSummary {
  kind: StepKind;
  /** What happened, e.g. "Read app/main.py". */
  title: string;
  /** A short result, e.g. "13 lines", "1 change", "2 passed". */
  meta: string | null;
  failed: boolean;
  /** Why it failed, in one line. */
  reason: string | null;
  /** run_command only: the exit code, when the output states it. */
  exitCode: number | null;
}

type Args = Record<string, JsonValue> | undefined;

function str(args: Args, key: string): string | null {
  const v = args?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** "4s", "1m 20s", "3m 05s", "1h 05m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function quote(s: string, max = 40): string {
  return `'${clip(s, max)}'`;
}

export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? ""
  );
}

function lines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim());
}

/** Remove simple Markdown marks so a line reads as plain text. */
export function plainText(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:])/g, "$1$2")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*[-*]\s+/, "")
    .trim();
}

// ---- test runner summaries -----------------------------------------------------------------

export interface TestSummary {
  passed: number;
  failed: number;
  /** "2 passed" or "1 failed, 1 passed". */
  text: string;
}

function testText(passed: number, failed: number): string {
  if (failed && passed) return `${failed} failed, ${passed} passed`;
  if (failed) return `${failed} failed`;
  return `${passed} passed`;
}

/** Reads the summary line of common test runners (pytest, jest/vitest, bun, cargo). */
export function parseTestSummary(output: string): TestSummary | null {
  const py = output
    .split("\n")
    .reverse()
    .find((l) => /\d+ (passed|failed|errors?)\b.* in [\d.]+s/.test(l));
  if (py) {
    const passed = Number(py.match(/(\d+) passed/)?.[1] ?? 0);
    const failed = Number(py.match(/(\d+) failed/)?.[1] ?? 0) + Number(py.match(/(\d+) errors?/)?.[1] ?? 0);
    return { passed, failed, text: testText(passed, failed) };
  }
  const js = output.match(/Tests?:?\s+(?:(\d+) failed[, |]+)?(\d+) passed/);
  if (js) {
    const passed = Number(js[2]);
    const failed = Number(js[1] ?? 0);
    return { passed, failed, text: testText(passed, failed) };
  }
  const bun = output.match(/(\d+) pass\s+(\d+) fail/);
  if (bun) {
    const passed = Number(bun[1]);
    const failed = Number(bun[2]);
    return { passed, failed, text: testText(passed, failed) };
  }
  const cargo = output.match(/test result: \w+\. (\d+) passed; (\d+) failed/);
  if (cargo) {
    const passed = Number(cargo[1]);
    const failed = Number(cargo[2]);
    return { passed, failed, text: testText(passed, failed) };
  }
  return null;
}

const TEST_COMMAND =
  /\b(pytest|jest|vitest|mocha|bun test|(npm|pnpm|yarn)( run)? test|cargo test|go test|unittest|phpunit|rspec|dotnet test|mvn test|gradle test)\b/i;

/** The first line that explains a failure, else the last line of the output. */
export function failureReason(output: string): string | null {
  const all = lines(output);
  const hit = all.find((l) =>
    /\b(FAILED|ERROR|Error|error:|Traceback|AssertionError|Exception|not found|No such file|denied|refused)\b/.test(
      l,
    ),
  );
  const line = hit ?? all.at(-1);
  return line ? clip(line, 160) : null;
}

/** run_command output: "Exit code 1.\n<output>", "Timed out after 300s.", or "Cancelled.". */
export function parseCommandResult(text: string): {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
} {
  const [head = "", ...rest] = text.split("\n");
  const code = head.match(/^Exit code (-?\d+)\.$/);
  const timedOut = /^Timed out after /.test(head);
  const cancelled = /^Cancelled\.$/.test(head);
  if (code || timedOut || cancelled)
    return { exitCode: code ? Number(code[1]) : null, timedOut, cancelled, output: rest.join("\n") };
  return { exitCode: null, timedOut: false, cancelled: false, output: text };
}

// ---- agents -----------------------------------------------------------------------------------

const AGENT_NAMES: Record<string, string> = {
  manager: "Manager",
  thinking: "Thinking",
  reasoning: "Reasoning",
  "project-management": "Project Management",
  "ui-ux-design": "UI/UX Design",
  diagram: "Diagram",
  backend: "Backend",
  frontend: "Frontend",
  database: "Database",
  integration: "Integration",
  "ai-integration": "AI Integration",
  testing: "Testing",
  security: "Security",
  enhancement: "Enhancement",
  "devops-docs": "DevOps & Docs",
  "devops-documentation": "DevOps & Docs",
  coder: "Coder",
  starter: "Depo starter",
  tester: "Depo tester",
};

/** "backend@1.0.0" -> "Backend", "ui-ux-design" -> "UI/UX Design". */
export function agentName(tag: string | null | undefined): string {
  if (!tag) return "";
  const id = tag.split("@")[0]?.trim() ?? "";
  if (AGENT_NAMES[id]) return AGENT_NAMES[id];
  // Display names ("DevOps and Documentation", "Coder Agent") map to the same short names.
  const key = agentKey(id);
  if (AGENT_NAMES[key]) return AGENT_NAMES[key];
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : `${w[0]?.toUpperCase() ?? ""}${w.slice(1)}`))
    .join(" ");
}

const MESSAGE_VERB: Record<string, (to: string) => string> = {
  handoff: (to) => `Handed work to ${to}`,
  request: (to) => `Sent a request to ${to}`,
  review: (to) => `Asked ${to} for a review`,
  question: (to) => `Asked ${to} a question`,
  result: (to) => `Sent results to ${to}`,
  blocker: (to) => `Reported a blocker to ${to}`,
};

// ---- tool steps -------------------------------------------------------------------------------

function humanTool(name: string): string {
  const words = name
    .replace(/^mcp__?/, "")
    .split(/[_\s]+|__/)
    .filter(Boolean)
    .join(" ");
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : "Used a tool";
}

/** One tool call as a short line. */
export function summarizeStep(item: Pick<ChatItem, "toolName" | "text" | "isError" | "args">): StepSummary {
  const tool = item.toolName ?? "";
  const text = item.text ?? "";
  const args = item.args;
  const out = (
    s: Omit<StepSummary, "failed" | "reason" | "exitCode"> & Partial<StepSummary>,
  ): StepSummary => {
    const failed = s.failed ?? item.isError;
    return {
      kind: s.kind,
      title: s.title,
      meta: failed && item.isError ? null : s.meta,
      failed,
      reason: failed ? (s.reason ?? (clip(firstLine(text), 160) || null)) : null,
      exitCode: s.exitCode ?? null,
    };
  };

  switch (tool) {
    case "read_file": {
      const head = text.match(/^(.+?) \((\d+) lines?\)$/m);
      const path = (!item.isError && head?.[1]) || str(args, "path");
      const range = text.match(/\[showing lines (\d+)-(\d+) of (\d+)\]/);
      const meta = range
        ? `lines ${range[1]}–${range[2]} of ${range[3]}`
        : head
          ? plural(Number(head[2]), "line")
          : null;
      return out({ kind: "read", title: path ? `Read ${path}` : "Read a file", meta });
    }
    case "list_dir": {
      const path = str(args, "path") ?? ".";
      const entries = lines(text).filter((l) => !/^\[list truncated\]$/.test(l));
      const empty = text.trim() === "(empty)";
      return out({
        kind: "list",
        title: path === "." || path === "./" ? "Listed the project" : `Listed ${path}`,
        meta: empty ? "empty" : plural(entries.length, "item"),
      });
    }
    case "find_files": {
      const glob = str(args, "glob");
      const none = /^No files match\./.test(text.trim());
      const found = lines(text).filter((l) => !l.startsWith("[")).length;
      return out({
        kind: "find",
        title: glob ? `Found files matching ${glob}` : "Found files",
        meta: none ? "no matches" : plural(found, "file"),
      });
    }
    case "search": {
      const pattern = str(args, "pattern");
      const none = /^No matches\./.test(text.trim());
      const hits = lines(text).filter((l) => /^.+?:\d+: /.test(l)).length;
      const more = text.includes("[more matches omitted]") ? "+" : "";
      return out({
        kind: "search",
        title: pattern ? `Searched for ${quote(pattern)}` : "Searched the code",
        meta: none ? "no matches" : `${hits}${more} ${hits === 1 && !more ? "match" : "matches"}`,
      });
    }
    case "semantic_search": {
      const query = str(args, "query");
      const none = /^Nothing found/.test(text.trim());
      const hits = lines(text).filter((l) => /^\S.*:\d+-\d+\s+\(/.test(l)).length;
      return out({
        kind: "search",
        title: query ? `Searched for ${quote(query)}` : "Searched the code",
        meta: none ? "nothing found" : plural(hits, "result"),
      });
    }
    case "find_symbol": {
      const name = str(args, "name");
      const none = /^No declaration/.test(text.trim());
      const hits = lines(text).filter((l) => /^\S.*:\d+-\d+\s/.test(l)).length;
      return out({
        kind: "search",
        title: name ? `Looked up ${name}` : "Looked up a symbol",
        meta: none ? "not found" : plural(hits, "place"),
      });
    }
    case "repo_map": {
      const folder = str(args, "folder");
      return out({
        kind: "map",
        title: folder ? `Mapped the code in ${folder}` : "Mapped the code",
        meta: null,
      });
    }
    case "write_file": {
      const done = text.match(/^(Created|Wrote) (.+) \((\d+) bytes\)\./);
      const path = done?.[2] ?? str(args, "path");
      const content = typeof args?.content === "string" ? args.content : null;
      const verb = done?.[1] === "Created" ? "Created" : "Wrote";
      const meta = content
        ? plural(content.replace(/\n…$/, "").split("\n").length, "line")
        : done
          ? formatBytes(Number(done[3]))
          : null;
      return out({ kind: "write", title: path ? `${verb} ${path}` : "Wrote a file", meta });
    }
    case "edit_file": {
      const done = text.match(/^Applied (\d+) edit\(s\) to (.+)\.$/m);
      const path = done?.[2] ?? str(args, "path");
      const n = done ? Number(done[1]) : Array.isArray(args?.edits) ? args.edits.length : null;
      return out({
        kind: "edit",
        title: path ? `Edited ${path}` : "Edited a file",
        meta: n === null ? null : plural(n, "change"),
      });
    }
    case "delete_file": {
      const done = text.match(/^Deleted (.+)\.$/);
      const path = done?.[1] ?? str(args, "path");
      return out({ kind: "delete", title: path ? `Deleted ${path}` : "Deleted a file", meta: null });
    }
    case "run_command": {
      const command = str(args, "command");
      const r = parseCommandResult(text);
      const tests = r.timedOut || r.cancelled ? null : parseTestSummary(r.output);
      const isTest = !!tests || (!!command && TEST_COMMAND.test(command));
      const failed = item.isError || r.timedOut || (r.exitCode !== null && r.exitCode !== 0);
      const meta = r.timedOut
        ? "timed out"
        : r.cancelled
          ? "stopped"
          : tests
            ? tests.text
            : r.exitCode === 0
              ? isTest
                ? "passed"
                : "done"
              : r.exitCode !== null
                ? `exit code ${r.exitCode}`
                : null;
      return out({
        kind: isTest ? "test" : "command",
        title: command ? `Ran ${clip(command, 80)}` : "Ran a command",
        meta: item.isError ? null : meta,
        failed,
        reason: item.isError
          ? clip(firstLine(text), 160) || null
          : r.timedOut
            ? clip(firstLine(text), 160)
            : failed
              ? failureReason(r.output)
              : null,
        exitCode: r.exitCode,
      });
    }
    case "git_status":
      return out({ kind: "git", title: "Checked what changed", meta: null });
    case "git_diff":
      return out({ kind: "git", title: "Read the changes so far", meta: null });
    case "remember":
      return out({ kind: "memory", title: "Saved a note to project memory", meta: str(args, "kind") });
    case "bb_read": {
      const section = str(args, "section");
      return out({
        kind: "board",
        title: section ? `Read ${section} from the blackboard` : "Listed the blackboard",
        meta: null,
      });
    }
    case "bb_write": {
      const section = str(args, "section");
      return out({
        kind: "board",
        title: section ? `Wrote ${section} to the blackboard` : "Wrote to the blackboard",
        meta: str(args, "mode") === "append" ? "added" : null,
      });
    }
    case "send_message": {
      const to = agentName(str(args, "to")) || "another agent";
      const type = str(args, "type") ?? "";
      const verb = MESSAGE_VERB[type] ?? ((t: string) => `Sent a message to ${t}`);
      return out({ kind: "message", title: verb(to), meta: null });
    }
    case "render_diagram": {
      const path = str(args, "path");
      return out({
        kind: "diagram",
        title: path ? `Checked the diagram ${path}` : "Checked a diagram",
        meta: null,
      });
    }
    case "render_screenshot": {
      const page = str(args, "page");
      return out({
        kind: "screenshot",
        title: page ? `Took a screenshot of ${page}` : "Took a screenshot",
        meta: null,
      });
    }
    case "review_screenshot": {
      const path = str(args, "path");
      return out({
        kind: "screenshot",
        title: path ? `Reviewed ${path}` : "Reviewed a screenshot",
        meta: null,
      });
    }
    case "check_page": {
      const head = text.match(/^Page check qa_[0-9a-f]{28} of (\S+), (\d+) widths? in /);
      let page = str(args, "file") ?? str(args, "url");
      if (!page && head?.[1]) {
        try {
          page = new URL(head[1].replace(/,$/, "")).pathname;
        } catch {
          page = null;
        }
      }
      const bits: string[] = [];
      if (head?.[2]) bits.push(plural(Number(head[2]), "width"));
      if (/^The page passed\./m.test(text)) bits.push("passed");
      else if (head) {
        const summary = text.match(/^Summary: (.*)$/m)?.[1] ?? "";
        const num = (re: RegExp) => Number(summary.match(re)?.[1] ?? 0);
        const a11y = summary.match(/(?:^|\. )Accessibility: ([^.(]*)/)?.[1] ?? "";
        const problems = [
          [num(/(?:^|\. )(\d+) console errors?/), "console error"],
          [num(/(?:^|\. )(\d+) failed requests?/), "failed request"],
          [num(/(?:^|\. )(\d+) requests? to the internet/), "blocked request"],
          [
            Number(a11y.match(/(\d+) critical/)?.[1] ?? 0) + Number(a11y.match(/(\d+) serious/)?.[1] ?? 0),
            "accessibility issue",
          ],
        ] as const;
        const shown = problems.filter(([n]) => n > 0).map(([n, what]) => plural(n, what));
        bits.push(shown.length ? shown.join(", ") : "needs work");
      }
      return out({
        kind: "screenshot",
        title: page ? `Checked the page ${page}` : "Checked a page",
        meta: bits.join(" · ") || null,
      });
    }
    case "make_deck":
      return out({ kind: "deck", title: "Made a slide deck", meta: str(args, "dir") });
    case "record_ux_audit":
      return out({ kind: "audit", title: "Recorded a UX audit", meta: null });
    case "list_fonts":
      return out({ kind: "fonts", title: "Picked fonts", meta: null });
    case "security_scan":
      return out({ kind: "security", title: "Ran a security scan", meta: null });
    case "security_status":
      return out({ kind: "security", title: "Checked the security tools", meta: null });
    case "performance_check": {
      const url = str(args, "url");
      return out({
        kind: "performance",
        title: url ? `Checked performance of ${url}` : "Checked performance",
        meta: str(args, "tool"),
      });
    }
    case "list_blocks":
      return out({ kind: "block", title: "Looked through the building blocks", meta: null });
    case "use_block": {
      const id = str(args, "id");
      return out({
        kind: "block",
        title: id ? `Added the building block ${id}` : "Added a building block",
        meta: null,
      });
    }
    default:
      return out({ kind: "tool", title: humanTool(tool), meta: null });
  }
}

// ---- assistant messages in the step list -------------------------------------------------------

export type NoteInfo =
  | { kind: "handoff"; agent: string; title: string }
  | { kind: "review"; text: string; approved: boolean }
  | { kind: "note"; line: string; more: boolean };

/** Team markers ("**Backend** — Build the API", "**Reasoning** reviewed Backend: approved") or narration. */
export function describeNote(text: string): NoteInfo {
  const t = text.trim();
  if (!t.includes("\n")) {
    const review = t.match(/^\*\*(.+?)\*\* reviewed (.+?): (approved|changes needed)(.*)$/);
    if (review) return { kind: "review", text: plainText(t), approved: review[3] === "approved" };
    const handoff = t.match(/^\*\*(.+?)\*\* — (.+)$/);
    if (handoff?.[1] && handoff[2])
      return { kind: "handoff", agent: handoff[1], title: plainText(handoff[2]) };
  }
  const line = plainText(firstLine(t));
  return { kind: "note", line, more: t.split("\n").filter((l) => l.trim()).length > 1 || line.length > 140 };
}

// ---- the Manager's plan ----------------------------------------------------------------------

export interface PlanTask {
  n: number;
  owner: string;
  title: string;
  after: string[];
}

export interface ParsedPlan {
  summary: string;
  tasks: PlanTask[];
}

/**
 * The Manager's plan message ("**Plan** — summary" then "1. **Backend**: title _(after x, y)_").
 * Returns null unless every line matches, so anything unexpected stays plain Markdown.
 */
export function parsePlan(text: string): ParsedPlan | null {
  const rows = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim());
  const head = rows[0]?.match(/^\*\*Plan\*\*\s*[—–-]\s*(.*)$/);
  if (!head || rows.length < 2) return null;
  const tasks: PlanTask[] = [];
  for (const row of rows.slice(1)) {
    const m = row.trim().match(/^(\d+)\.\s+\*\*(.+?)\*\*:\s+(.+?)(?:\s+_\(after (.+)\)_)?$/);
    if (!m?.[2] || !m[3]) return null;
    tasks.push({
      n: Number(m[1]),
      owner: m[2],
      title: m[3],
      after: m[4] ? m[4].split(/,\s*/).filter(Boolean) : [],
    });
  }
  return { summary: plainText(head[1] ?? ""), tasks };
}

// ---- edit diffs --------------------------------------------------------------------------------

export interface EditHunk {
  search: string;
  replace: string;
}

export interface DiffLine {
  type: "same" | "removed" | "added";
  text: string;
}

/**
 * A small line diff for one search/replace edit: lines both sides share at the start and end stay
 * as context, the middle shows as removed then added. Enough for the short edits agents make.
 */
export function diffLines(search: string, replace: string): DiffLine[] {
  const a = search.replace(/\r\n/g, "\n").split("\n");
  const b = replace.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end])
    end++;
  return [
    ...a.slice(0, start).map((text) => ({ type: "same" as const, text })),
    ...a.slice(start, a.length - end).map((text) => ({ type: "removed" as const, text })),
    ...b.slice(start, b.length - end).map((text) => ({ type: "added" as const, text })),
    ...a.slice(a.length - end).map((text) => ({ type: "same" as const, text })),
  ];
}

/** edit_file's search/replace pairs, when the item carries its arguments. */
export function editHunks(args: Args): EditHunk[] {
  const edits = args?.edits;
  if (!Array.isArray(edits)) return [];
  const out: EditHunk[] = [];
  for (const e of edits) {
    if (e && typeof e === "object" && !Array.isArray(e)) {
      const search = e.search;
      const replace = e.replace;
      if (typeof search === "string" && typeof replace === "string") out.push({ search, replace });
    }
  }
  return out;
}
