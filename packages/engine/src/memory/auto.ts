import fs from "node:fs";
import path from "node:path";
import { generateObject } from "@depo/model-gateway";
import type { JsonValue, MemoryKind } from "@depo/shared";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { detectStack, stackSummary } from "../agent/stack";
import type { AppDb } from "../db";
import { events } from "../db/schema";
import type { Logger } from "../logger";
import type { ModelManager } from "../models/manager";
import { redactString } from "../redact";
import type { ModelScheduler } from "../scheduler/scheduler";
import type { MemoryStore } from "./store";

/**
 * Depo memorises by itself. After every task that finishes (review or done, never when cancelled):
 * 1. deterministic facts, no model call: stack, package manager, the test command that passed,
 *    how to run it, ports, key folders;
 * 2. a short model summary in the background (fast or coder model, background priority) that
 *    proposes at most five durable items: facts, decisions, preferences, conventions.
 * Everything is deduplicated against existing memory, capped, and never stores secrets.
 * The owner's reasons for declining a plan or a command, or rejecting changes, become preferences.
 */

/** Auto items kept per project; the oldest go first. */
export const AUTO_MAX = 40;
const DEFAULT_CONTEXT = 16_384;
const KINDS = ["fact", "decision", "preference", "convention"] as const;

export const MemorySummarySchema = z.object({
  items: z
    .array(z.object({ kind: z.enum(KINDS), text: z.string().min(1).max(400) }))
    .max(10)
    .default([]),
});

export interface AutoMemoryHost {
  db: AppDb;
  logger: Logger;
  memory: MemoryStore;
  models: Pick<ModelManager, "resolve">;
  scheduler?: ModelScheduler | undefined;
  /** The memory.auto setting, read at run time. */
  enabled(): boolean;
}

export interface TaskOutcome {
  projectId: string;
  taskId: string;
  /** What the owner asked for. */
  request: string;
  /** The agent's (or the Manager's) final answer. */
  finalText: string;
  /** Extra notes worth reading, e.g. the team's decisions.md. */
  notes?: string;
  /** The folder with the finished work (the task's private workspace). */
  root: string;
  /** Files the task changed. */
  files: { path: string; kind: "added" | "modified" | "deleted" }[];
}

export interface AutoFact {
  key: string;
  kind: "fact";
  text: string;
}

/** Secrets in any form: what the redactor catches, plus "password is x" and long random tokens. */
export function looksSecret(text: string): boolean {
  if (redactString(text) !== text) return true;
  if (
    /\b(password|passwd|passphrase|secret|api[ _-]?key|token|private key)\b\s*(?:is|was|:|=)\s*\S+/i.test(
      text,
    )
  )
    return true;
  // Long random-looking runs (hex, base64url): letters and digits with few separators. Long
  // identifiers such as test_overlapping_booking_returns_409 have many separators and pass.
  for (const m of text.matchAll(/(?<![A-Za-z0-9_/.-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_/.-])/g)) {
    const s = m[0];
    const separators = (s.match(/[_-]/g) ?? []).length;
    if (/\d/.test(s) && /[A-Za-z]/.test(s) && separators / s.length < 0.08) return true;
  }
  return false;
}

/** One clean sentence, or null when it should not be stored (empty, too short, or secret). */
export function cleanItem(text: string, max = 300): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 8 || looksSecret(t)) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const KEY_FILES = [
  "README.md",
  "run.cmd",
  "run.sh",
  "docker-compose.yml",
  "compose.yaml",
  "Dockerfile",
  ".env.example",
  "openapi.yaml",
  "openapi.json",
  "alembic.ini",
  "manage.py",
];
const SKIP_DIRS = new Set([
  "node_modules",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "coverage",
  "target",
  "out",
]);

/** Top-level folders and key files, plus folders where this task added several files. */
function layout(root: string, files: TaskOutcome["files"]): string | null {
  let dirs: string[] = [];
  let keyFiles: string[] = [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    dirs = entries
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name))
      .map((d) => `${d.name}/`)
      .slice(0, 8);
    keyFiles = KEY_FILES.filter((f) => entries.some((e) => e.isFile() && e.name === f));
  } catch {
    return null;
  }
  const added = new Map<string, number>();
  for (const f of files) {
    if (f.kind !== "added") continue;
    const parts = f.path.replace(/\\/g, "/").split("/");
    if (parts.length < 3) continue;
    const dir = `${parts.slice(0, Math.min(parts.length - 1, 3)).join("/")}/`;
    added.set(dir, (added.get(dir) ?? 0) + 1);
  }
  const busy = [...added]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([d]) => d);
  if (!dirs.length && !keyFiles.length) return null;
  const parts = [];
  if (dirs.length) parts.push(`folders ${dirs.join(", ")}`);
  if (busy.length) parts.push(`code in ${busy.join(", ")}`);
  if (keyFiles.length) parts.push(`key files ${keyFiles.join(", ")}`);
  return `Layout: ${parts.join("; ")}.`;
}

/**
 * Facts read from the files, with no model call. `testCommand` is the command that passed in
 * the task (from its test results); without one the detected command is not claimed to pass.
 */
export function deterministicFacts(
  root: string,
  testCommand: string | null,
  files: TaskOutcome["files"] = [],
): AutoFact[] {
  const s = detectStack(root);
  const out: AutoFact[] = [];
  const add = (key: string, text: string | null) => {
    if (text) out.push({ key: `auto:${key}`, kind: "fact", text });
  };
  const summary = stackSummary(s);
  add("stack", summary ? `Stack: ${summary}.` : null);
  add("package-manager", s.packageManager ? `Package manager: ${s.packageManager}.` : null);
  add("test-command", testCommand ? `Tests pass with: ${testCommand}` : null);
  add("run-command", s.runCommand ? `Run it with: ${s.runCommand}` : null);
  add("ports", s.ports.length ? `Ports: ${s.ports.map((p) => `${p.port} (${p.label})`).join(", ")}.` : null);
  add("layout", layout(root, files));
  return out;
}

/** The command of the last passing test run in a task, from its test_result events. */
export function lastPassingTest(db: AppDb, taskId: string): string | null {
  const row = db
    .select()
    .from(events)
    .where(and(eq(events.taskId, taskId), eq(events.type, "test_result"), eq(events.status, "succeeded")))
    .orderBy(desc(events.ts), desc(events.seq))
    .limit(1)
    .get();
  if (!row?.details) return null;
  try {
    const d = JSON.parse(row.details) as { command?: unknown };
    return typeof d.command === "string" && d.command.length <= 300 ? d.command : null;
  } catch {
    return null;
  }
}

export function memoryPrompt(o: TaskOutcome, known: string[]): { system: string; user: string } {
  const clip = (s: string, n: number) => {
    const t = redactString(s).trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const system = [
    "You keep Depo's durable memory for one software project.",
    "From the finished task below, propose at most 5 items worth remembering for future tasks on this project:",
    "- fact: how the project is built, structured, run or tested;",
    "- decision: a choice that was made and why;",
    "- preference: what the owner wants or dislikes;",
    "- convention: naming, style or patterns the code follows.",
    "Skip anything temporary, obvious from file names, already known, or secret (passwords, keys, tokens, personal data).",
    "Each item is one plain sentence under 200 characters.",
    'Reply with JSON only: {"items":[{"kind":"fact|decision|preference|convention","text":"..."}]}. Use an empty list when nothing is worth keeping.',
  ].join("\n");
  const user = [
    `Request: ${clip(o.request, 1200)}`,
    `Final answer: ${clip(o.finalText, 1500)}`,
    o.notes ? `Team notes:\n${clip(o.notes, 1500)}` : "",
    o.files.length
      ? `Changed files:\n${o.files
          .slice(0, 40)
          .map((f) => `- ${f.kind} ${f.path}`)
          .join("\n")}`
      : "No files changed.",
    known.length ? `Already remembered:\n${known.map((k) => `- ${k}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, user };
}

export class AutoMemory {
  private readonly ctl = new AbortController();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly h: AutoMemoryHost) {}

  enabled(): boolean {
    return this.h.enabled();
  }

  /** Start remembering what a finished task taught. Returns at once; the work runs in the background. */
  afterTask(o: TaskOutcome): void {
    if (!this.h.enabled() || this.ctl.signal.aborted) return;
    const p: Promise<void> = this.run(o)
      .catch((err: unknown) => {
        if (!this.ctl.signal.aborted) this.h.logger.warn("auto memory failed", { err, taskId: o.taskId });
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Resolves when no memory work is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Stop: model calls are cancelled and nothing more is written. */
  async stop(): Promise<void> {
    this.ctl.abort();
    await this.idle();
  }

  private async run(o: TaskOutcome): Promise<void> {
    // 1. Deterministic facts.
    const det = deterministicFacts(o.root, lastPassingTest(this.h.db, o.taskId), o.files);
    const first = this.saveAll(
      o.projectId,
      det.map((f) => ({ kind: f.kind, text: f.text, key: f.key })),
    );
    if (first.length) this.announce(o.projectId, first, o.taskId);

    // 2. The model's summary, in the background queue.
    if (o.finalText.trim().length < 40 && o.files.length === 0) return;
    const items = await this.summarise(o);
    if (this.ctl.signal.aborted || !items.length) return;
    const second = this.saveAll(o.projectId, items);
    if (second.length) this.announce(o.projectId, second, o.taskId);
  }

  private async summarise(o: TaskOutcome): Promise<{ kind: Exclude<MemoryKind, "lesson">; text: string }[]> {
    const r = this.h.models.resolve("fast") ?? this.h.models.resolve("coder");
    if (!r) return [];
    const known = this.h.memory
      .list(o.projectId, ["fact", "decision", "preference"])
      .slice(0, 15)
      .map((f) => f.text);
    const { system, user } = memoryPrompt(o, known);
    const signal = this.ctl.signal;
    const call = () =>
      generateObject(r.provider, {
        model: r.model,
        contextLength: r.contextLength ?? DEFAULT_CONTEXT,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        schema: MemorySummarySchema,
        maxRepairs: 1,
        temperature: 0.1,
        signal,
      });
    try {
      const res = await (this.h.scheduler
        ? this.h.scheduler.run(
            {
              projectId: o.projectId,
              taskId: null,
              model: r.model,
              priority: "background",
              label: "Memory: what this task taught",
            },
            call,
            signal,
          )
        : call());
      return res.value.items.slice(0, 5).map((it) => ({
        kind: it.kind === "convention" ? "fact" : it.kind,
        text:
          it.kind === "convention" && !/^convention\b/i.test(it.text) ? `Convention: ${it.text}` : it.text,
      }));
    } catch (err) {
      if (!signal.aborted) this.h.logger.info("memory summary skipped", { err: String(err) });
      return [];
    }
  }

  /** Save cleaned, deduplicated items; returns the texts that were added or changed. */
  private saveAll(
    projectId: string,
    items: { kind: Exclude<MemoryKind, "lesson">; text: string; key?: string }[],
  ): string[] {
    if (this.ctl.signal.aborted) return [];
    const saved: string[] = [];
    for (const it of items) {
      const text = cleanItem(it.text);
      if (!text) continue;
      const r = this.h.memory.upsertAuto(projectId, it.kind, text, it.key ?? null);
      if (r.change !== "unchanged") saved.push(r.fact.text);
    }
    if (saved.length) this.h.memory.pruneAuto(projectId, AUTO_MAX);
    return saved;
  }

  private announce(projectId: string, items: string[], taskId?: string) {
    const details: Record<string, JsonValue> = { auto: true, count: items.length, items };
    if (taskId) details.taskId = taskId;
    this.h.memory.announce(
      projectId,
      `Depo remembered ${items.length} ${items.length === 1 ? "thing" : "things"} about this project`,
      details,
    );
  }

  // ---- learning from the owner's actions -----------------------------------------------------

  /**
   * The owner declined a plan, a command or an apply and said why: keep the reason as a
   * preference. Without a reason nothing is stored (a bare "no" says too little).
   */
  learnFromDecline(
    req: {
      projectId: string | null;
      kind: "command" | "apply" | "other";
      title: string;
      details?: Record<string, JsonValue> | undefined;
    },
    reason: string | undefined,
  ): string | null {
    if (!req.projectId || !this.h.enabled()) return null;
    const why = cleanItem(reason ?? "", 240);
    if (!why) return null;
    const command = typeof req.details?.command === "string" ? req.details.command.slice(0, 120) : null;
    const plan = /plan/i.test(req.title) || typeof req.details?.plan === "string";
    const text =
      req.kind === "command" && command
        ? `The owner declined running "${command}": ${why}`
        : plan
          ? `The owner declined a plan: ${why}`
          : `The owner declined "${req.title.slice(0, 100)}": ${why}`;
    return this.preference(req.projectId, text);
  }

  /** The owner rejected a change set: keep the reason, and re-read the facts from the real project. */
  learnFromDiscard(
    cs: { projectId: string; title: string },
    reason: string | undefined,
    projectRoot: string | null,
  ): string | null {
    if (!this.h.enabled()) return null;
    if (projectRoot) this.refreshFacts(cs.projectId, projectRoot);
    const why = cleanItem(reason ?? "", 240);
    if (!why) return null;
    return this.preference(
      cs.projectId,
      `The owner rejected the changes for "${cs.title.slice(0, 100)}": ${why}`,
    );
  }

  /**
   * Re-derive the file-based facts from a folder (the real project after a discard): facts that
   * no longer hold are removed, so memory does not describe work that never landed.
   */
  refreshFacts(projectId: string, root: string): void {
    const facts = deterministicFacts(root, null);
    const keys = new Set(facts.map((f) => f.key));
    for (const key of ["auto:stack", "auto:package-manager", "auto:run-command", "auto:ports", "auto:layout"])
      if (!keys.has(key)) this.h.memory.removeAutoKey(projectId, key);
    const tests = detectStack(root).testCommand;
    const current = this.h.memory.list(projectId).find((f) => f.signature === "auto:test-command");
    if (current && (!tests || !current.text.includes(tests)))
      this.h.memory.removeAutoKey(projectId, "auto:test-command");
    this.saveAll(
      projectId,
      facts.map((f) => ({ kind: f.kind, text: f.text, key: f.key })),
    );
  }

  private preference(projectId: string, text: string): string | null {
    const saved = this.saveAll(projectId, [{ kind: "preference", text }]);
    if (!saved.length) return null;
    this.h.memory.announce(projectId, "Depo remembered a preference about this project", {
      auto: true,
      count: 1,
      items: saved,
    });
    return saved[0] ?? null;
  }
}

/** The project folder exists and can be read (a discarded workspace's project may be gone). */
export function readableDir(dir: string | null | undefined): string | null {
  if (!dir) return null;
  try {
    return fs.statSync(path.resolve(dir)).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}
