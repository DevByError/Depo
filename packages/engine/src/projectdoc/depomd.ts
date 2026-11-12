import fs from "node:fs";
import path from "node:path";
import { detectStack } from "../agent/stack";

/**
 * DEPO.md: the project's own memory file, the way CLAUDE.md is for Claude Code. It lives at the
 * root of the project, so it is read at the start of every task and travels with the code.
 * Depo creates it on the first task that changes something and brings it up to date at the end of
 * every task: what happened (Status log), what comes next (Next) and what is still wrong (Known
 * issues). The update is written into the private copy, so it shows in Diff Review like any other
 * file and nothing reaches the real project without approval. People and agents can edit every
 * line; Depo only touches the three sections it owns and the lines it tagged itself.
 */

export const DEPO_MD = "DEPO.md";
const STATUS = "Status log (newest first)";
const NEXT = "Next";
const ISSUES = "Known issues";
/** Tag on the lines Depo wrote in Known issues, so a later clean run can clear exactly those. */
const AUTO = "(Depo";
const MAX_LOG = 40;
const MAX_ISSUES = 15;

export interface DepoEntry {
  /** ISO time of the end of the task. */
  at: string;
  title: string;
  /** What the owner asked for. */
  request: string;
  /** The agent's final answer, or what Depo reported. */
  answer: string;
  /** "review" (changes to look at), "done" (nothing changed), "failed". */
  outcome: string;
  /** Titles of the plan steps that passed. */
  done: string[];
  /** Plan steps that did not pass, with why. */
  blocked: { title: string; note: string }[];
  /** Steps that never started. */
  pending: string[];
  /** Files the run changed, when known. */
  files?: string[];
}

export function readDepoMd(root: string): string {
  try {
    return fs.readFileSync(path.join(root, DEPO_MD), "utf8");
  } catch {
    return "";
  }
}

/**
 * What goes into the system prompt: the top of the file (what the project is, commands, rules), then
 * Next and Known issues in full, then as many of the newest log entries as fit.
 */
export function depoMdForPrompt(root: string, budget: number): string {
  const text = readDepoMd(root).replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  if (text.length <= budget) return text;
  const sections = split(text);
  const head = sections.find((s) => s.title === "")?.body ?? "";
  const keep = [head, ...sections.filter((s) => s.title !== "" && s.title !== STATUS).map(render)];
  let out = keep.join("\n\n").trim();
  const log = sections.find((s) => s.title === STATUS);
  if (log) {
    const entries = entriesOf(log.body);
    let used = out.length;
    const picked: string[] = [];
    for (const e of entries) {
      if (used + e.length + 2 > budget) break;
      picked.push(e);
      used += e.length + 2;
    }
    if (picked.length) out += `\n\n## ${STATUS}\n${picked.join("\n")}`;
  }
  return out.length > budget ? `${out.slice(0, budget - 20).trimEnd()}\n[DEPO.md cut]` : out;
}

interface Section {
  title: string;
  body: string;
}

/** The text before the first `## ` heading has the title "". */
function split(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { title: "", body: "" };
  for (const line of text.split("\n")) {
    const m = /^##\s+(.*?)\s*$/.exec(line);
    if (m) {
      out.push(cur);
      cur = { title: m[1] ?? "", body: "" };
    } else cur.body += `${cur.body ? "\n" : ""}${line}`;
  }
  out.push(cur);
  return out.map((s) => ({ ...s, body: s.body.replace(/^\n+|\s+$/g, "") }));
}

function render(s: Section): string {
  return s.title ? `## ${s.title}\n${s.body}` : s.body;
}

/** Log entries start with "- " at the start of a line; their continuation lines are indented. */
function entriesOf(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("- ") || out.length === 0) out.push(line);
    else out[out.length - 1] += `\n${line}`;
  }
  return out.filter((e) => e.trim());
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};
const day = (iso: string) => iso.slice(0, 10);

/** A new DEPO.md for a project that has none: what Depo can see from the files. */
export function newDepoMd(root: string, projectName: string): string {
  const stack = detectStack(root);
  const kind = [...stack.languages, ...stack.frameworks, ...stack.databases].join(", ");
  const commands: string[] = [];
  if (stack.runCommand) commands.push(`- Run: \`${stack.runCommand}\``);
  if (stack.testCommand) commands.push(`- Test: \`${stack.testCommand}\``);
  return [
    `# DEPO.md: ${projectName}`,
    "",
    "Project memory for Depo's agents. They read this first in every task. Depo brings the status log, Next and Known issues up to date when a task ends; the rest is yours to edit.",
    "",
    "## What this project is",
    kind ? `Stack: ${kind}.` : "(Describe the project in a few lines: what it does, who uses it.)",
    "",
    "## Commands",
    ...(commands.length ? commands : ["(How to install, run and test.)"]),
    "",
    "## Working rules",
    "- Read a file before you change it; run the tests after a change.",
    "- (Add the rules of this project here: naming, folders, what never to touch.)",
    "",
    `## ${STATUS}`,
    "",
    `## ${NEXT}`,
    "1. (Nothing recorded yet.)",
    "",
    `## ${ISSUES}`,
    "- None recorded.",
    "",
  ].join("\n");
}

/** What the task said it did, unless it only pasted code (then the steps and files say it). */
function summaryOf(e: DepoEntry): string {
  const answer = e.answer.trim();
  const code =
    answer.startsWith("```") ||
    /^(import|export|const|function|class|def)\b/.test(answer) ||
    (answer.match(/[{};]/g)?.length ?? 0) > 12;
  if (answer && !code) return answer;
  if (e.done.length) return `Did: ${e.done.slice(0, 3).join("; ")}.`;
  return e.request;
}

function entryText(e: DepoEntry): string {
  const head = `- ${day(e.at)} (${e.outcome === "review" ? "ready for review" : e.outcome === "failed" ? "failed" : "no changes"}; ${clip(e.title, 90)})`;
  const lines = [`${head}: ${clip(summaryOf(e), 360)}`];
  if (e.done.length) lines.push(`  Done: ${clip(e.done.join("; "), 300)}.`);
  if (e.blocked.length)
    lines.push(`  Not finished: ${clip(e.blocked.map((b) => `${b.title} (${b.note})`).join("; "), 400)}.`);
  if (e.files?.length)
    lines.push(
      `  Files: ${e.files.slice(0, 8).join(", ")}${e.files.length > 8 ? `, +${e.files.length - 8} more` : ""}.`,
    );
  return lines.join("\n");
}

/**
 * Bring DEPO.md up to date after a task and write it. Creates it when the project has none.
 * `current` is the file's text when there is one (so tests can run without a disk).
 */
export function updatedDepoMd(current: string, e: DepoEntry, fallback: () => string): string {
  const base = (current.trim() ? current : fallback()).replace(/\r\n/g, "\n");
  const sections = split(base);
  const get = (title: string): Section => {
    let s = sections.find((x) => x.title === title);
    if (!s) {
      s = { title, body: "" };
      sections.push(s);
    }
    return s;
  };

  // Status log: the new entry first, the newest MAX_LOG kept.
  const log = get(STATUS);
  log.body = [entryText(e), ...entriesOf(log.body)].slice(0, MAX_LOG).join("\n");

  // Next: the steps that did not pass, then the steps that never started. A clean task says so.
  const next = get(NEXT);
  const todo = [
    ...e.blocked.map((b) => `Finish: ${clip(b.title, 120)} (${clip(b.note, 120)}).`),
    ...e.pending.map((p) => `Do: ${clip(p, 140)}.`),
  ];
  if (e.outcome === "failed" && !todo.length)
    todo.push("Retry the last request; it failed before any step ran.");
  next.body = todo.length
    ? todo.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "1. Nothing is waiting from the last task. Ask for the next change.";

  // Known issues: the lines Depo tagged are replaced by this task's; the owner's own lines stay.
  const issues = get(ISSUES);
  const own = issues.body
    .split("\n")
    .filter((l) => l.trim() && !l.includes(AUTO) && !/^-\s*None recorded\.?$/i.test(l.trim()));
  const mine = e.blocked.map((b) => `- ${clip(b.title, 120)}: ${clip(b.note, 160)} ${AUTO}, ${day(e.at)})`);
  const all = [...mine, ...own].slice(0, MAX_ISSUES);
  issues.body = all.length ? all.join("\n") : "- None recorded.";

  return `${sections
    .map(render)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/** Read, update and write DEPO.md in a folder (the private copy). */
export function recordInDepoMd(root: string, projectName: string, e: DepoEntry): void {
  const next = updatedDepoMd(readDepoMd(root), e, () => newDepoMd(root, projectName));
  fs.writeFileSync(path.join(root, DEPO_MD), next, "utf8");
}
