import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  newId,
  type TerminalLine,
  type TerminalRun,
  type TerminalRunState,
  type TestRun,
} from "@depo/shared";
import { venvEnv } from "../agent/prompt";
import type { EventBus } from "../events/bus";
import { firstLine, type Logger } from "../logger";
import { matchesRule } from "../tools/index";
import { classifyCommand, type PolicyVerdict } from "../tools/shell/policy";
import { type ShellProcess, startShell } from "../tools/shell/run";
import { linkNestedDependencies } from "../workspace/snapshot";
import { QUIET_ENV } from "./env";
import { LineRing, linesFromText } from "./ring";
import { TerminalStore } from "./store";
import { testRunFromEvent, testRunFromTerminal } from "./test-runs";

/**
 * The owner's Terminal: one command per run, in the project folder or a task's private copy.
 * Every command is judged by the command policy (a deny rule refuses it; "ask" counts as
 * approved because the owner typed it) and runs contained like agent commands: cmd.exe in a Job
 * Object on Windows, a process group elsewhere, with a timeout, a memory cap and no keyboard input.
 * Output streams to the UI as ephemeral `terminal_output` events and stays in a per-run buffer
 * (the last 2000 lines) for a UI that reconnects.
 */

export interface TerminalServiceOptions {
  bus: EventBus;
  logger: Logger;
  sqlite: Database;
  projectRoot(projectId: string): string | null;
  workspaceRoot(taskId: string): string | null;
  taskProject(taskId: string): string | null;
  taskTitle(taskId: string): string | null;
  commandRules(projectId: string): { allow: string[]; deny: string[] } | null;
  /** Default 10 minutes. */
  defaultTimeoutMs?: number;
  /** How often new output is sent to the UI (default 100 ms). */
  flushMs?: number;
  /** Memory cap for the whole process tree (Windows Job Object; default 8 GB). */
  memoryLimitBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_LIVE = 4;
const MAX_LINES_PER_EVENT = 500;
const KEPT_TEXT = 32_000;
const KEEP_FINISHED = 30;

interface LiveRun {
  info: TerminalRun;
  ring: LineRing;
  root: string;
  proc: ShellProcess | null;
  stopped: boolean;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
}

export class TerminalService {
  private readonly live = new Map<string, LiveRun>();
  private readonly store: TerminalStore;
  private readonly log: Logger;

  constructor(private readonly o: TerminalServiceOptions) {
    this.log = o.logger.child({ component: "terminal" });
    this.store = new TerminalStore(o.sqlite);
    const recovered = this.store.recover();
    if (recovered) this.log.info("marked terminal runs left from the last run as stopped", { recovered });
  }

  /** Where a command runs: the project folder, or the task's private copy. */
  private target(projectId: string, taskId: string | null): { root: string; label: string } {
    const realRoot = this.o.projectRoot(projectId);
    if (!realRoot || !fs.existsSync(realRoot)) throw new Error("This project's folder could not be found.");
    if (!taskId) return { root: realRoot, label: "Your project" };
    if (this.o.taskProject(taskId) !== projectId) throw new Error("That task belongs to another project.");
    const ws = this.o.workspaceRoot(taskId);
    if (!ws) throw new Error("This task's private copy no longer exists. Run the command in your project.");
    // Sub-projects of a monorepo copy need their installed packages too.
    linkNestedDependencies(realRoot, ws);
    return { root: ws, label: this.o.taskTitle(taskId) ?? "Task copy" };
  }

  private verdict(command: string, root: string, projectId: string): PolicyVerdict {
    let v = classifyCommand(command, root);
    const rules = this.o.commandRules(projectId);
    if (rules?.deny.some((r) => matchesRule(command, r)))
      v = { ...v, decision: "deny", reason: "blocked by this project's command rules" };
    else if (v.decision === "ask" && rules?.allow.some((r) => matchesRule(command, r)))
      v = { ...v, decision: "allow", reason: "allowed by this project's command rules" };
    return v;
  }

  /** Start a command. Returns at once with the run in `running`. */
  async run(req: {
    projectId: string;
    taskId?: string | null;
    command: string;
    timeoutMs?: number;
  }): Promise<TerminalRun> {
    const command = req.command.trim();
    if (!command) throw new Error("Type a command first.");
    const taskId = req.taskId ?? null;
    const { root, label } = this.target(req.projectId, taskId);
    const v = this.verdict(command, root, req.projectId);
    if (v.decision === "deny") throw new Error(`This command is not allowed: ${v.reason}.`);
    if ([...this.live.values()].filter((r) => r.info.state === "running").length >= MAX_LIVE)
      throw new Error(`${MAX_LIVE} commands are already running. Stop one first.`);
    // An "ask" verdict counts as approved: the owner typed the command themselves.
    const info: TerminalRun = {
      id: newId("job"),
      projectId: req.projectId,
      taskId,
      target: label,
      command,
      category: v.category,
      state: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: null,
      lines: 0,
    };
    this.store.insert(info);
    this.store.remember(req.projectId, command);
    const live: LiveRun = {
      info,
      ring: new LineRing(),
      root,
      proc: null,
      stopped: false,
      timedOut: false,
      timer: null,
      done: Promise.resolve(),
    };
    this.live.set(info.id, live);
    this.prune();
    live.done = this.execute(live, req.timeoutMs ?? this.o.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.log.info("terminal command started", {
      projectId: req.projectId,
      taskId,
      runId: info.id,
      command,
      category: v.category,
      decision: v.decision,
    });
    return { ...info };
  }

  private async execute(live: LiveRun, timeoutMs: number): Promise<void> {
    const { info, ring } = live;
    const started = performance.now();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      this.send(live, ring.takeNew());
    };
    const schedule = () => {
      if (!flushTimer) flushTimer = setTimeout(flush, this.o.flushMs ?? 100);
    };
    let exitCode: number | null = null;
    try {
      live.proc = await startShell({
        command: info.command,
        cwd: live.root,
        env: { ...QUIET_ENV, ...venvEnv(live.root) },
        memoryLimitBytes: this.o.memoryLimitBytes ?? 8 * 1024 ** 3,
        onStdout: (s) => {
          ring.push("out", s);
          schedule();
        },
        onStderr: (s) => {
          ring.push("err", s);
          schedule();
        },
      });
      // Stop was pressed while the shell was starting.
      if (live.stopped) live.proc.kill();
      live.timer = setTimeout(() => {
        live.timedOut = true;
        live.proc?.kill();
      }, timeoutMs);
      exitCode = await live.proc.exited;
    } catch (err) {
      ring.note(`Could not start the command: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (live.timer) clearTimeout(live.timer);
    if (flushTimer) clearTimeout(flushTimer);
    ring.flush();
    const state: TerminalRunState = live.timedOut
      ? "timed_out"
      : live.stopped
        ? "stopped"
        : exitCode === 0
          ? "succeeded"
          : "failed";
    const secs = Math.round(timeoutMs / 1000);
    if (state === "timed_out")
      ring.note(
        `Stopped after ${secs >= 60 ? `${Math.round(secs / 60)} minutes` : `${secs} seconds`} (time limit).`,
      );
    else if (state === "stopped") ring.note("Stopped.");
    info.state = state;
    info.exitCode = state === "succeeded" || state === "failed" ? exitCode : null;
    info.endedAt = new Date().toISOString();
    info.durationMs = Math.round(performance.now() - started);
    info.lines = ring.count;
    this.store.finish(info, ring.tailText(KEPT_TEXT));
    this.send(live, ring.takeNew(), true);
    const verb =
      state === "succeeded"
        ? "finished"
        : state === "failed"
          ? `exited with ${exitCode ?? "an error"}`
          : state === "stopped"
            ? "was stopped"
            : "timed out";
    this.o.bus.emit({
      projectId: info.projectId,
      // The owner's command is not an agent step of the task: keep it out of the task's chat.
      taskId: null,
      agent: "user",
      type: "running_command",
      text: `Terminal: ${firstLine(info.command).slice(0, 160)} ${verb}`,
      details: {
        source: "terminal",
        runId: info.id,
        command: info.command,
        category: info.category,
        exitCode: info.exitCode,
        state,
        targetTaskId: info.taskId,
      },
      durationMs: info.durationMs,
      status: state === "succeeded" ? "succeeded" : state === "stopped" ? "cancelled" : "failed",
    });
    this.log[state === "failed" || state === "timed_out" ? "warn" : "info"]("terminal command finished", {
      projectId: info.projectId,
      taskId: info.taskId,
      runId: info.id,
      command: info.command,
      state,
      exitCode: info.exitCode,
      durationMs: info.durationMs,
      containment: live.proc?.containment ?? null,
    });
  }

  /** New lines (and the run when it changed) to the UI, in events of at most 500 lines. */
  private send(live: LiveRun, lines: TerminalLine[], final = false): void {
    live.info.lines = live.ring.count;
    const chunks: TerminalLine[][] = [];
    for (let i = 0; i < lines.length; i += MAX_LINES_PER_EVENT)
      chunks.push(lines.slice(i, i + MAX_LINES_PER_EVENT));
    if (chunks.length === 0 && !final) return;
    if (chunks.length === 0) chunks.push([]);
    chunks.forEach((chunk, i) => {
      const last = i === chunks.length - 1;
      this.o.bus.emit({
        projectId: live.info.projectId,
        taskId: null,
        agent: "user",
        type: "terminal_output",
        text: chunk.at(-1)?.text.slice(0, 200) || `Output of ${live.info.command.slice(0, 120)}`,
        details: {
          runId: live.info.id,
          lines: chunk,
          ...(last && (final || chunk.length > 0) ? { run: { ...live.info } } : {}),
        },
        ephemeral: true,
        status: final && last ? (live.info.state === "succeeded" ? "succeeded" : "failed") : "running",
      });
    });
  }

  /** Stop a running command and its whole process tree. */
  async kill(runId: string): Promise<boolean> {
    const live = this.live.get(runId);
    if (live?.info.state !== "running") return false;
    live.stopped = true;
    live.proc?.kill();
    await Promise.race([live.done, Bun.sleep(5000)]);
    return true;
  }

  read(
    runId: string,
    after = 0,
  ): { run: TerminalRun; lines: TerminalLine[]; next: number; dropped: boolean } {
    const live = this.live.get(runId);
    if (live) return { run: { ...live.info, lines: live.ring.count }, ...live.ring.since(after) };
    const kept = this.store.get(runId);
    if (!kept) throw new Error("That run no longer exists.");
    const all = linesFromText(kept.outputTail, kept.run.lines);
    const lines = all.filter((l) => l.seq > after);
    const first = all[0]?.seq ?? kept.run.lines + 1;
    return { run: kept.run, lines, next: kept.run.lines, dropped: first > after + 1 };
  }

  list(projectId: string, limit = 30): TerminalRun[] {
    return this.store.list(projectId, limit).map((r) => {
      const live = this.live.get(r.id);
      return live ? { ...live.info, lines: live.ring.count } : r;
    });
  }

  history(projectId: string): string[] {
    return this.store.history(projectId);
  }

  /**
   * Test runs of a project (or of one task's copy), newest first: agents' runs from the audit log
   * and the owner's Terminal runs of test commands, with failures parsed where the output allows.
   */
  tests(projectId: string, taskId: string | null, limit = 30): TestRun[] {
    const roots = new Map<string | null, string | undefined>();
    const rootOf = (id: string | null) => {
      if (!roots.has(id))
        roots.set(id, (id ? this.o.workspaceRoot(id) : this.o.projectRoot(projectId)) ?? undefined);
      return roots.get(id);
    };
    const titleOf = (id: string | null) => (id ? (this.o.taskTitle(id) ?? "Task copy") : "Your project");
    const fromAgents = this.o.bus
      .recent({ limit: Math.min(500, limit * 4), projectId, types: ["test_result"] })
      .reverse()
      .filter((e) => !taskId || e.taskId === taskId)
      .map((e) => testRunFromEvent(e, titleOf(e.taskId), rootOf(e.taskId)))
      .filter((r): r is TestRun => r !== null);
    const fromTerminal = this.store
      .finishedOf(projectId, "test", limit)
      .filter((r) => !taskId || r.run.taskId === taskId)
      .map((r) => testRunFromTerminal(r.run, r.outputTail, rootOf(r.run.taskId)));
    return [...fromAgents, ...fromTerminal].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  /** Wait until a run has finished (tests). */
  async settled(runId: string): Promise<TerminalRun | null> {
    const live = this.live.get(runId);
    if (!live) return this.store.get(runId)?.run ?? null;
    await live.done;
    return { ...live.info };
  }

  /** Stop commands running inside a folder that is about to be removed (a task's private copy). */
  stopRoot(dir: string): void {
    const base = path.resolve(dir);
    for (const live of this.live.values()) {
      const rel = path.relative(base, path.resolve(live.root));
      if (live.info.state === "running" && (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))) {
        live.stopped = true;
        live.proc?.kill();
      }
    }
  }

  async stopAll(): Promise<void> {
    const running = [...this.live.values()].filter((l) => l.info.state === "running");
    for (const l of running) {
      l.stopped = true;
      l.proc?.kill();
    }
    await Promise.race([Promise.all(running.map((l) => l.done)), Bun.sleep(5000)]);
  }

  /** Forget the output of old finished runs (their tail stays in the database). */
  private prune(): void {
    const finished = [...this.live.values()].filter((l) => l.info.state !== "running");
    for (const l of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)))
      this.live.delete(l.info.id);
  }
}
