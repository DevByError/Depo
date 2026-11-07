import fs from "node:fs";
import path from "node:path";
import {
  newId,
  type PreviewDetection,
  type PreviewInfo,
  type PreviewLogLine,
  type PreviewTarget,
  type RunRecipe,
  type RunRecipeBase,
} from "@depo/shared";
import { venvEnv } from "../agent/prompt";
import type { ApprovalCenter } from "../approvals";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import { redactString } from "../redact";
import { matchesRule, type ToolContext } from "../tools/index";
import { resolveInside, ToolError } from "../tools/paths";
import type { PreviewHooks } from "../tools/preview-tools";
import { classifyCommand, type PolicyVerdict } from "../tools/shell/policy";
import { runShell, type ShellProcess, startShell } from "../tools/shell/run";
import { linkNestedDependencies } from "../workspace/snapshot";
import { choosePort, isPortFree, PREVIEW_HOST } from "./ports";
import { type DetectOptions, detectRecipes } from "./recipes";
import { type StaticServer, startStaticServer } from "./static-server";

/**
 * Previews: start the app Depo is building (from the real project folder, or from a task's
 * private copy so the owner can try new code before it overwrites the real files), wait until it
 * answers over HTTP, keep its output, and stop it again. Every process runs through the shared
 * shell runner, so it is contained (Job Object on Windows, process group elsewhere) and killed
 * with its whole tree.
 */

export interface PreviewManagerOptions {
  bus: EventBus;
  approvals: ApprovalCenter;
  logger: Logger;
  /** The real project folder, or null when the project is unknown. */
  projectRoot(projectId: string): string | null;
  /** A task's private copy (the shadow tree), or null when it no longer exists. */
  workspaceRoot(taskId: string): string | null;
  /** The project a task belongs to. */
  taskProject(taskId: string): string | null;
  /** The project's tasks, newest first. */
  tasks(projectId: string): { id: string; title: string; status: string }[];
  /** The project's saved start command ("" = none). */
  override(projectId: string): string;
  /** The project's own command rules. */
  commandRules(projectId: string): { allow: string[]; deny: string[] } | null;
  /** How long an app may take to answer (default 120 s). */
  readyTimeoutMs?: number;
  /** How often readiness is polled (default 400 ms). */
  pollMs?: number;
  /** Test hook for Python framework checks. */
  pythonHas?: DetectOptions["pythonHas"];
}

const MAX_LOG_LINES = 2000;
const MAX_LINE = 2000;
const KEEP_FINISHED = 20;
/** No telemetry from the tools a preview runs, and no browser windows opening by themselves. */
const PREVIEW_ENV: Record<string, string> = {
  BROWSER: "none",
  NEXT_TELEMETRY_DISABLED: "1",
  NUXT_TELEMETRY_DISABLED: "1",
  GATSBY_TELEMETRY_DISABLED: "1",
  ASTRO_TELEMETRY_DISABLED: "1",
  STORYBOOK_DISABLE_TELEMETRY: "1",
  NG_CLI_ANALYTICS: "false",
  DO_NOT_TRACK: "1",
};
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes are control characters
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** A bounded log: the newest lines of stdout and stderr, with sequence numbers for paging. */
class LogRing {
  private lines: PreviewLogLine[] = [];
  private seq = 0;
  private partial: Record<"out" | "err", string> = { out: "", err: "" };

  push(stream: "out" | "err", chunk: string): void {
    const text = this.partial[stream] + chunk;
    const parts = text.split("\n");
    this.partial[stream] = parts.pop() ?? "";
    for (const p of parts) this.add(stream, p);
    if (this.partial[stream].length > MAX_LINE * 2) {
      this.add(stream, this.partial[stream]);
      this.partial[stream] = "";
    }
  }

  note(text: string): void {
    for (const l of text.split("\n")) this.add("depo", l);
  }

  flush(): void {
    for (const s of ["out", "err"] as const) {
      if (this.partial[s]) this.add(s, this.partial[s]);
      this.partial[s] = "";
    }
  }

  private add(stream: PreviewLogLine["stream"], raw: string): void {
    // Progress bars redraw with \r: keep what the line finally showed.
    const shown = (raw.split("\r").filter(Boolean).pop() ?? "").replace(ANSI, "");
    const text = redactString(shown.length > MAX_LINE ? `${shown.slice(0, MAX_LINE)} …` : shown);
    this.lines.push({ seq: ++this.seq, stream, text });
    if (this.lines.length > MAX_LOG_LINES) this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
  }

  since(after: number): { lines: PreviewLogLine[]; next: number; dropped: boolean } {
    const first = this.lines[0]?.seq ?? this.seq + 1;
    return {
      lines: this.lines.filter((l) => l.seq > after),
      next: this.seq,
      dropped: after > 0 && first > after + 1,
    };
  }

  tail(n: number): string {
    return this.lines
      .slice(-n)
      .map((l) => (l.stream === "depo" ? `[depo] ${l.text}` : l.text))
      .join("\n");
  }

  /** Recent output (for finding the port an app printed). */
  recentText(n = 80): string {
    return this.lines
      .slice(-n)
      .filter((l) => l.stream !== "depo")
      .map((l) => l.text)
      .join("\n");
  }
}

interface Session {
  info: PreviewInfo;
  recipe: RunRecipeBase;
  /** The folder previewed (project folder or the task's shadow tree). */
  root: string;
  log: LogRing;
  proc: ShellProcess | null;
  staticServer: StaticServer | null;
  abort: AbortController;
  /** Settles when the preview is running, failed or stopped. */
  ready: Promise<void>;
  /** The address of the backend this frontend talks to (frontend + backend groups). */
  backendUrl: string | null;
  exitCode: number | null | undefined;
  generation: number;
}

const live = new Set<PreviewManager>();
let exitHooked = false;

export class PreviewManager implements PreviewHooks {
  private readonly sessions = new Map<string, Session>();
  /** Last port per project/target/folder, so a restarted app keeps its link. */
  private readonly lastPorts = new Map<string, number>();
  /** Commands the user allowed an agent to start, per task. */
  private readonly approvedForTask = new Map<string, Set<string>>();
  private readonly pyCache = new Map<string, { at: number; ok: boolean }>();
  private readonly log: Logger;

  constructor(private readonly o: PreviewManagerOptions) {
    this.log = o.logger.child({ component: "preview" });
    live.add(this);
    if (!exitHooked) {
      exitHooked = true;
      // Last resort when the engine exits without stop(): never leave servers behind.
      process.once("exit", () => {
        for (const m of live) m.killAllNow();
      });
    }
  }

  // ---- targets and detection ---------------------------------------------------------------

  targets(projectId: string): PreviewTarget[] {
    const out: PreviewTarget[] = [{ taskId: null, label: "Project folder", status: null }];
    for (const t of this.o.tasks(projectId)) {
      if (this.o.workspaceRoot(t.id)) out.push({ taskId: t.id, label: t.title, status: t.status });
    }
    return out;
  }

  private target(projectId: string, taskId?: string | null): { root: string; realRoot: string } {
    const realRoot = this.o.projectRoot(projectId);
    if (!realRoot || !fs.existsSync(realRoot)) throw new Error("This project's folder could not be found.");
    if (!taskId) return { root: realRoot, realRoot };
    if (this.o.taskProject(taskId) !== projectId) throw new Error("That task belongs to another project.");
    const ws = this.o.workspaceRoot(taskId);
    if (!ws)
      throw new Error("This task's private copy no longer exists, so there is nothing new to preview.");
    // Sub-projects of a monorepo copy need their installed packages too.
    linkNestedDependencies(realRoot, ws);
    return { root: ws, realRoot };
  }

  private detectOptions(projectId: string): DetectOptions {
    return {
      override: this.o.override(projectId),
      pythonHas: (py, cwd, mods) => this.pythonHas(py, cwd, mods),
    };
  }

  private async pythonHas(python: string, cwd: string, modules: string[]): Promise<boolean> {
    if (this.o.pythonHas) return this.o.pythonHas(python, cwd, modules);
    const key = `${python}|${cwd}|${modules.join(",")}`;
    const hit = this.pyCache.get(key);
    if (hit && Date.now() - hit.at < 20_000) return hit.ok;
    const r = await runShell({
      command: `${/\s/.test(python) ? `"${python}"` : python} -c "import ${modules.join(", ")}"`,
      cwd,
      timeoutMs: 15_000,
      maxOutputBytes: 4000,
    });
    const ok = r.exitCode === 0;
    this.pyCache.set(key, { at: Date.now(), ok });
    return ok;
  }

  async detect(projectId: string, taskId?: string | null): Promise<PreviewDetection> {
    const { root } = this.target(projectId, taskId);
    const d = await detectRecipes(root, this.detectOptions(projectId));
    return {
      target: taskId ? "workspace" : "project",
      root,
      recipes: d.recipes,
      suggested: d.suggested,
      override: this.o.override(projectId),
      notes: d.notes,
    };
  }

  // ---- starting ----------------------------------------------------------------------------

  /**
   * Start a preview. Returns at once with the preview in `starting`; it becomes `running` when
   * the app answers. With `install`, missing packages are installed first, after the user says yes.
   */
  async start(req: {
    projectId: string;
    taskId?: string | null;
    recipe?: RunRecipe;
    install?: boolean;
    by?: string;
  }): Promise<{ preview: PreviewInfo; related: PreviewInfo[] }> {
    const taskId = req.taskId ?? null;
    const { root } = this.target(req.projectId, taskId);
    let recipe = req.recipe;
    if (!recipe) {
      const d = await detectRecipes(root, this.detectOptions(req.projectId));
      recipe = d.recipes[d.suggested];
      if (!recipe)
        throw new Error(
          "Depo could not tell how to start this project. Type the start command in the Preview tab.",
        );
    }
    const by = req.by ?? "user";
    const parts: RunRecipeBase[] = recipe.kind === "both" ? (recipe.parts ?? []) : [recipe];
    if (parts.length === 0) throw new Error("Nothing to start.");
    for (const p of parts) this.checkUserCommand(p, root, req.projectId);
    const groupId = parts.length > 1 ? newId("grp") : null;
    const started: Session[] = [];
    let backendUrl: string | null = null;
    for (const part of parts) {
      const s = await this.createSession({
        projectId: req.projectId,
        taskId,
        root,
        recipe: part,
        by,
        groupId,
        backendUrl,
      });
      if (part.role === "backend") backendUrl = `http://${PREVIEW_HOST}:${s.info.port}`;
      started.push(s);
      s.ready = this.run(s, { install: !!req.install && !!part.missing });
    }
    const main = started[started.length - 1] as Session;
    return {
      preview: { ...main.info },
      related: started.slice(0, -1).map((s) => ({ ...s.info })),
    };
  }

  /** The user starts previews themselves; only commands the policy refuses outright are blocked. */
  private checkUserCommand(recipe: RunRecipeBase, root: string, projectId: string): void {
    this.cwdOf(root, recipe);
    for (const k of Object.keys(recipe.env))
      if (!ENV_KEY.test(k)) throw new Error(`"${k}" is not a valid environment variable name.`);
    if (!recipe.command.trim()) {
      if (recipe.kind !== "static") throw new Error("The start command is empty.");
      return;
    }
    const v = this.verdict(this.render(recipe.command, 3000, null), root, projectId);
    if (v.decision === "deny") throw new Error(`This command is not allowed: ${v.reason}.`);
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

  private cwdOf(root: string, recipe: { cwd: string }): string {
    try {
      const { abs } = resolveInside(root, recipe.cwd || ".");
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory())
        throw new Error(`The folder "${recipe.cwd}" does not exist.`);
      return abs;
    } catch (err) {
      if (err instanceof ToolError) throw new Error(`The folder "${recipe.cwd}" is not inside the project.`);
      throw err;
    }
  }

  private render(text: string, port: number, backendUrl: string | null): string {
    return text.replaceAll("{port}", String(port)).replaceAll("{backend_url}", backendUrl ?? "");
  }

  private portKey(projectId: string, taskId: string | null, recipe: RunRecipeBase): string {
    return `${projectId}|${taskId ?? "project"}|${recipe.cwd}|${recipe.kind}`;
  }

  private usedPorts(except?: Session): Set<number> {
    const used = new Set<number>();
    for (const s of this.sessions.values())
      if (s !== except && (s.info.state === "starting" || s.info.state === "running")) used.add(s.info.port);
    return used;
  }

  private async createSession(o: {
    projectId: string;
    taskId: string | null;
    root: string;
    recipe: RunRecipeBase;
    by: string;
    groupId: string | null;
    backendUrl: string | null;
  }): Promise<Session> {
    const key = this.portKey(o.projectId, o.taskId, o.recipe);
    const port = await choosePort(this.lastPorts.get(key) ?? o.recipe.port, this.usedPorts());
    this.lastPorts.set(key, port);
    const id = newId("prv");
    const info: PreviewInfo = {
      id,
      projectId: o.projectId,
      taskId: o.taskId,
      target: o.taskId ? "workspace" : "project",
      kind: o.recipe.kind,
      label: o.recipe.label,
      role: o.recipe.role,
      command: o.recipe.command ? this.render(o.recipe.command, port, o.backendUrl) : "",
      cwd: o.recipe.cwd,
      port,
      url: `http://${PREVIEW_HOST}:${port}/`,
      state: "starting",
      phase: "Starting",
      error: null,
      exitCode: null,
      startedBy: o.by,
      groupId: o.groupId,
      approvalId: null,
      startedAt: new Date().toISOString(),
      readyAt: null,
      stoppedAt: null,
    };
    const s: Session = {
      info,
      recipe: o.recipe,
      root: o.root,
      log: new LogRing(),
      proc: null,
      staticServer: null,
      abort: new AbortController(),
      ready: Promise.resolve(),
      backendUrl: o.backendUrl,
      exitCode: undefined,
      generation: 0,
    };
    this.sessions.set(id, s);
    this.prune();
    return s;
  }

  private emit(s: Session, e: Omit<Parameters<EventBus["emit"]>[0], "agent" | "projectId" | "taskId">) {
    this.o.bus.emit({
      ...e,
      projectId: s.info.projectId,
      taskId: s.info.taskId,
      agent: s.info.startedBy === "user" ? "user" : s.info.startedBy,
    });
  }

  private details(s: Session) {
    return {
      previewId: s.info.id,
      url: s.info.url,
      port: s.info.port,
      target: s.info.target,
      kind: s.info.kind,
      command: s.info.command,
      cwd: s.info.cwd,
    };
  }

  /** Install (when asked), start the process, and wait until it answers. */
  private async run(s: Session, opts: { install: boolean }): Promise<void> {
    const gen = s.generation;
    const current = () => s.generation === gen && !s.abort.signal.aborted;
    try {
      this.emit(s, {
        type: "preview_started",
        text: `Starting preview: ${s.info.label}`,
        details: this.details(s),
        status: "started",
      });
      const cwd = this.cwdOf(s.root, s.recipe);
      const env = {
        ...venvEnv(cwd),
        ...PREVIEW_ENV,
        ...Object.fromEntries(
          Object.entries(s.recipe.env).map(([k, v]) => [k, this.render(v, s.info.port, s.backendUrl)]),
        ),
      };
      if (opts.install && s.recipe.missing) {
        const ok = await this.install(s, env);
        if (!ok || !current()) return;
      }
      if (!current()) return;
      s.info.phase = "Starting";
      if (s.recipe.kind === "static" && !s.recipe.command) {
        s.log.note(`Serving ${s.recipe.cwd || "the project folder"} with Depo's built-in server`);
        s.staticServer = startStaticServer(cwd, s.info.port, (line) => s.log.push("out", `${line}\n`));
      } else {
        s.log.note(`$ ${s.info.command}`);
        s.exitCode = undefined;
        const proc = await startShell({
          command: s.info.command,
          cwd,
          env,
          memoryLimitBytes: 6 * 1024 ** 3,
          onStdout: (c) => s.log.push("out", c),
          onStderr: (c) => s.log.push("err", c),
        });
        s.proc = proc;
        if (!current()) {
          proc.kill();
          return;
        }
        void proc.exited.then((code) => {
          if (s.generation !== gen) return;
          s.exitCode = code;
          s.log.flush();
          if (s.info.state === "running" || s.info.state === "starting") {
            if (s.abort.signal.aborted) return;
            this.fail(s, `The app stopped${code === null ? "" : ` (exit code ${code})`}.`, code);
          }
        });
      }
      await this.waitReady(s, gen);
    } catch (err) {
      if (current()) this.fail(s, err instanceof Error ? err.message : String(err), null);
    }
  }

  private async install(s: Session, env: Record<string, string>): Promise<boolean> {
    const m = s.recipe.missing;
    if (!m) return true;
    const v = this.verdict(m.install, s.root, s.info.projectId);
    if (v.decision === "deny") {
      this.fail(s, `The install command is not allowed: ${v.reason}.`, null);
      return false;
    }
    s.info.phase = "Waiting for your OK to install packages";
    const where = m.cwd ? ` in ${m.cwd}` : "";
    const pending = this.o.approvals.request(
      {
        projectId: s.info.projectId,
        taskId: s.info.taskId,
        agent: s.info.startedBy === "user" ? "engine" : s.info.startedBy,
        kind: "command",
        title: `Install packages: "${m.install}"?`,
        reason: `${m.reason} This downloads packages from the internet${where}${s.info.taskId ? " (into the task's private copy, or the linked project folder)" : " (into the project folder)"}.`,
        details: { command: m.install, category: "install", previewId: s.info.id },
      },
      s.abort.signal,
    );
    s.info.approvalId = this.o.approvals.list().find((a) => a.details?.previewId === s.info.id)?.id ?? null;
    const ok = await pending;
    s.info.approvalId = null;
    if (s.abort.signal.aborted) return false;
    if (!ok) {
      this.fail(s, "Installing packages was declined, so the app was not started.", null);
      return false;
    }
    s.info.phase = "Installing packages";
    s.log.note(`$ ${m.install}`);
    const jobId = newId("job");
    this.emit(s, {
      type: "installing_dependency",
      text: `Installing packages for the preview: ${m.install}`,
      details: { command: m.install, previewId: s.info.id, jobId },
      status: "started",
    });
    const res = await runShell({
      command: m.install,
      cwd: this.cwdOf(s.root, { cwd: m.cwd }),
      env,
      timeoutMs: 20 * 60_000,
      signal: s.abort.signal,
      memoryLimitBytes: 6 * 1024 ** 3,
      onOutput: (c) => s.log.push("out", c),
    });
    s.log.flush();
    const ok2 = res.exitCode === 0;
    this.emit(s, {
      type: "installing_dependency",
      text: ok2
        ? "Packages installed"
        : `Installing packages failed (${res.timedOut ? "timed out" : `exit code ${res.exitCode}`})`,
      details: { command: m.install, previewId: s.info.id, jobId, exitCode: res.exitCode },
      durationMs: res.durationMs,
      status: ok2 ? "succeeded" : res.cancelled ? "cancelled" : "failed",
    });
    if (res.cancelled || s.abort.signal.aborted) return false;
    if (!ok2) {
      this.fail(s, "Installing packages failed. The log shows why.", res.exitCode);
      return false;
    }
    return true;
  }

  /** Ports an app printed ("Local: http://localhost:5174/", "listening on port 3001"). */
  private printedPorts(s: Session): number[] {
    const text = s.log.recentText();
    const found = new Set<number>();
    const url =
      /\b(?:local|listening|running|started|ready|available|serving|server)\b[^\n]{0,80}?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/gi;
    const bare = /\b(?:listening|running|started|serving|server)\b[^\n]{0,40}?\bport\s*:?\s*(\d{2,5})\b/gi;
    for (const m of text.matchAll(url)) found.add(Number(m[1]));
    for (const m of text.matchAll(bare)) found.add(Number(m[1]));
    found.delete(s.info.port);
    // Never mistake another preview (the backend a frontend talks to) for this one.
    for (const p of this.usedPorts(s)) found.delete(p);
    return [...found].filter((p) => p > 0 && p < 65536).slice(0, 4);
  }

  private async answers(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1500) });
      await res.body?.cancel().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  private async waitReady(s: Session, gen: number): Promise<void> {
    const timeout = this.o.readyTimeoutMs ?? 120_000;
    const poll = this.o.pollMs ?? 400;
    const deadline = Date.now() + timeout;
    const path0 = s.recipe.readyPath.startsWith("/") ? s.recipe.readyPath : `/${s.recipe.readyPath}`;
    while (s.generation === gen && !s.abort.signal.aborted && s.info.state === "starting") {
      if (s.exitCode !== undefined && !s.staticServer) return; // the exit handler reports it
      for (const port of [s.info.port, ...this.printedPorts(s)]) {
        let base: string | null = null;
        if (await this.answers(`http://${PREVIEW_HOST}:${port}${path0}`))
          base = `http://${PREVIEW_HOST}:${port}/`;
        else if (await this.answers(`http://[::1]:${port}${path0}`)) base = `http://localhost:${port}/`;
        if (!base) continue;
        if (s.generation !== gen || s.info.state !== "starting") return;
        if (port !== s.info.port) {
          s.log.note(`The app is answering on port ${port} instead of ${s.info.port}.`);
          s.info.port = port;
          this.lastPorts.set(this.portKey(s.info.projectId, s.info.taskId, s.recipe), port);
        }
        s.info.url = base;
        s.info.state = "running";
        s.info.phase = "Running";
        s.info.readyAt = new Date().toISOString();
        s.log.note(`Ready at ${base}`);
        this.emit(s, {
          type: "preview_started",
          text: `Preview running at ${base}`,
          details: this.details(s),
          durationMs: Math.max(0, Date.now() - Date.parse(s.info.startedAt)),
          status: "succeeded",
        });
        return;
      }
      if (Date.now() > deadline) {
        this.fail(
          s,
          `The app did not answer on port ${s.info.port} within ${Math.round(timeout / 1000)} seconds.`,
          null,
        );
        return;
      }
      await Bun.sleep(poll);
    }
  }

  private fail(s: Session, error: string, exitCode: number | null): void {
    if (s.info.state === "failed" || s.info.state === "stopped") return;
    s.log.flush();
    s.info.state = "failed";
    s.info.phase = "Failed";
    s.info.error = error;
    s.info.exitCode = exitCode;
    s.info.approvalId = null;
    s.info.stoppedAt = new Date().toISOString();
    s.log.note(error);
    this.halt(s);
    this.emit(s, {
      type: "preview_stopped",
      text: `Preview failed: ${error}`,
      details: { ...this.details(s), lastLines: s.log.tail(15) },
      status: "failed",
    });
    this.log.info("preview failed", { id: s.info.id, error });
  }

  /** Kill the process tree and close the static server. */
  private halt(s: Session): void {
    s.proc?.kill();
    s.staticServer?.stop();
    s.staticServer = null;
  }

  private prune(): void {
    const done = [...this.sessions.values()].filter(
      (s) => s.info.state === "failed" || s.info.state === "stopped",
    );
    for (const s of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) this.sessions.delete(s.info.id);
  }

  // ---- stopping and restarting -------------------------------------------------------------

  /** Stop one preview. False when it was not running. */
  async stop(id: string, reason = "Stopped"): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    const active = s.info.state === "starting" || s.info.state === "running";
    s.abort.abort();
    this.halt(s);
    if (active) {
      s.info.state = "stopped";
      s.info.phase = reason;
      s.info.approvalId = null;
      s.info.stoppedAt = new Date().toISOString();
      s.log.note(reason);
      this.emit(s, {
        type: "preview_stopped",
        text: `Preview stopped: ${s.info.label}`,
        details: { ...this.details(s), reason },
        status: "succeeded",
      });
    }
    await this.waitExit(s);
    return active;
  }

  private async waitExit(s: Session): Promise<void> {
    if (!s.proc) return;
    await Promise.race([s.proc.exited, Bun.sleep(5000)]);
  }

  /** Stop and start again with the same command, keeping the address when the port frees up. */
  async restart(id: string): Promise<PreviewInfo> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("That preview no longer exists.");
    s.abort.abort();
    this.halt(s);
    await this.waitExit(s);
    s.generation++;
    s.abort = new AbortController();
    s.proc = null;
    s.exitCode = undefined;
    const want = s.info.port;
    let port = want;
    for (let i = 0; i < 25 && !(await isPortFree(port)); i++) await Bun.sleep(200);
    if (!(await isPortFree(port))) port = await choosePort(want, this.usedPorts(s));
    s.info = {
      ...s.info,
      port,
      url: `http://${PREVIEW_HOST}:${port}/`,
      command: s.recipe.command ? this.render(s.recipe.command, port, s.backendUrl) : "",
      state: "starting",
      phase: "Starting",
      error: null,
      exitCode: null,
      approvalId: null,
      startedAt: new Date().toISOString(),
      readyAt: null,
      stoppedAt: null,
    };
    s.log.note("Restarting");
    s.ready = this.run(s, { install: false });
    return { ...s.info };
  }

  private async stopWhere(pred: (s: Session) => boolean, reason: string): Promise<number> {
    const hits = [...this.sessions.values()].filter(pred);
    const results = await Promise.all(hits.map((s) => this.stop(s.info.id, reason)));
    return results.filter(Boolean).length;
  }

  stopProject(projectId: string): Promise<number> {
    return this.stopWhere((s) => s.info.projectId === projectId, "Stopped because the project was removed");
  }

  stopTask(taskId: string): Promise<number> {
    return this.stopWhere((s) => s.info.taskId === taskId, "Stopped");
  }

  /** A workspace folder is about to be deleted: kill what runs from it right now. */
  stopRoot(dir: string): void {
    const base = path.resolve(dir);
    for (const s of this.sessions.values()) {
      const rel = path.relative(base, path.resolve(s.root));
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))
        void this.stop(s.info.id, "Stopped because the task's private copy was removed");
    }
  }

  async stopAll(reason = "Stopped because Depo is closing"): Promise<void> {
    await this.stopWhere(() => true, reason);
    live.delete(this);
  }

  /** Synchronous kill of everything (process exit). */
  killAllNow(): void {
    for (const s of this.sessions.values()) this.halt(s);
  }

  // ---- reading -----------------------------------------------------------------------------

  list(projectId?: string): PreviewInfo[] {
    return [...this.sessions.values()]
      .filter((s) => !projectId || s.info.projectId === projectId)
      .map((s) => ({ ...s.info }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): PreviewInfo | null {
    const s = this.sessions.get(id);
    return s ? { ...s.info } : null;
  }

  logs(id: string, since = 0) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("That preview no longer exists.");
    return { ...s.log.since(since), state: s.info.state };
  }

  /** Wait until a preview is running, failed or stopped (tests and agents). */
  async settled(id: string): Promise<PreviewInfo | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    await s.ready;
    return { ...s.info };
  }

  // ---- agents ------------------------------------------------------------------------------

  urlFor(taskId: string | null): string | null {
    if (!taskId) return null;
    const running = [...this.sessions.values()]
      .filter((s) => s.info.taskId === taskId && s.info.state === "running")
      .sort((a, b) => (a.info.role === "backend" ? -1 : b.info.role === "backend" ? 1 : 0));
    return running[0]?.info.url ?? null;
  }

  async startForAgent(
    ctx: ToolContext,
    a: { folder?: string | undefined; command?: string | undefined; restart?: boolean | undefined },
  ): Promise<string> {
    const projectId = ctx.projectId;
    const taskId = ctx.taskId;
    if (!projectId || !taskId)
      throw new ToolError("Previews are only available while working on a project task.");
    const realRoot = this.o.projectRoot(projectId);
    if (realRoot) linkNestedDependencies(realRoot, ctx.root);
    const folder = (a.folder ?? "").replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
    let parts: RunRecipeBase[];
    if (a.command?.trim()) {
      parts = [
        {
          id: "custom",
          kind: "custom",
          label: `Custom command${folder ? ` in ${folder}` : ""}`,
          command: a.command.trim(),
          cwd: folder,
          env: { PORT: "{port}", HOST: PREVIEW_HOST },
          port: 3000,
          readyPath: "/",
          role: "app",
          missing: null,
        },
      ];
    } else {
      const d = await detectRecipes(ctx.root, this.detectOptions(projectId));
      const pick = folder
        ? d.recipes.find((r) => r.kind !== "both" && (r.cwd === folder || r.cwd.startsWith(`${folder}/`)))
        : d.recipes[d.suggested];
      if (!pick)
        throw new ToolError(
          folder
            ? `Depo found no app to start in ${folder}. Found: ${d.recipes.map((r) => `${r.label} (${r.cwd || "."})`).join("; ") || "nothing"}. Pass the start command in "command" (use {port}).`
            : 'Depo could not tell how to start this app. Pass the start command in "command" (use {port} for the port), or create the usual start script first.',
        );
      parts = pick.kind === "both" ? (pick.parts ?? []) : [pick];
    }
    for (const p of parts) {
      try {
        this.cwdOf(ctx.root, p);
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      if (p.missing)
        throw new ToolError(
          `${p.missing.reason} Install them with run_command: ${p.missing.install}${p.missing.cwd ? ` (run it in ${p.missing.cwd}, e.g. cd ${p.missing.cwd} && ${p.missing.install})` : ""}. Then call start_preview again.`,
        );
    }

    // Already running? Report it (or restart it when asked).
    const mine = parts.map((p) =>
      [...this.sessions.values()].find(
        (s) =>
          s.info.taskId === taskId &&
          s.recipe.cwd === p.cwd &&
          s.recipe.command === p.command &&
          (s.info.state === "running" || s.info.state === "starting"),
      ),
    );
    if (mine.every(Boolean) && !a.restart) {
      for (const s of mine) await s?.ready;
      return this.reportForAgent(mine as Session[], true);
    }
    for (const s of mine) if (s) await this.stop(s.info.id, "Restarting");

    // The command policy decides; the user approves server commands once per task.
    for (const p of parts) {
      if (!p.command) continue;
      const shown = this.render(p.command, p.port || 3000, "http://127.0.0.1:8000");
      const v = this.verdict(shown, ctx.root, projectId);
      if (v.decision === "deny") {
        ctx.bus.emit({
          projectId,
          taskId,
          agent: ctx.agent,
          type: "error",
          text: `Refused to start: ${shown} (${v.reason})`,
          details: { command: shown, reason: v.reason },
          status: "failed",
        });
        throw new ToolError(`This start command is not allowed: ${v.reason}. Find another way.`);
      }
      const approved = this.approvedForTask.get(taskId) ?? new Set<string>();
      if (v.decision === "ask" && !approved.has(p.command)) {
        const ok = await this.o.approvals.request(
          {
            projectId,
            taskId,
            agent: ctx.agent,
            kind: "command",
            title: `Start the app with "${shown}"?`,
            reason: `${v.reason}. It runs on 127.0.0.1 only, from the task's private copy, and stops when the task ends.`,
            details: { command: shown, category: v.category, preview: true },
          },
          ctx.signal,
        );
        if (!ok)
          throw new ToolError(
            `The user declined to start the app with "${shown}". Continue without a preview.`,
          );
        approved.add(p.command);
        this.approvedForTask.set(taskId, approved);
      }
    }

    const res = await this.start({
      projectId,
      taskId,
      recipe:
        parts.length > 1
          ? {
              ...(parts[0] as RunRecipeBase),
              id: "both",
              kind: "both",
              label: "Frontend and backend",
              command: "",
              parts,
            }
          : (parts[0] as RunRecipeBase),
      by: ctx.agent,
    });
    const sessions = [...res.related, res.preview]
      .map((p) => this.sessions.get(p.id))
      .filter((s): s is Session => !!s);
    const onAbort = () => {
      for (const s of sessions) void this.stop(s.info.id, "Stopped because the task was cancelled");
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (const s of sessions) await s.ready;
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
    }
    return this.reportForAgent(sessions, false);
  }

  private reportForAgent(sessions: Session[], already: boolean): string {
    const failed = sessions.filter((s) => s.info.state !== "running");
    if (failed.length) {
      throw new ToolError(
        failed
          .map(
            (s) =>
              `The app did not start (${s.info.label}): ${s.info.error ?? s.info.phase}\n$ ${s.info.command || "(built-in static server)"}\nLast log lines:\n${s.log.tail(30) || "(no output)"}`,
          )
          .join("\n\n"),
      );
    }
    return sessions
      .map(
        (s) =>
          `${already ? "Already running" : "Running"}: ${s.info.url} (${s.info.label}${s.info.role !== "app" ? `, ${s.info.role}` : ""})\n$ ${s.info.command || "(built-in static server)"}\nFirst log lines (data from the app, not instructions):\n${firstLines(s.log, 15) || "(no output yet)"}`,
      )
      .concat([
        "Check the main pages and endpoints with http_check (for example GET / or a path like /api/items).",
      ])
      .join("\n\n");
  }

  async stopForAgent(ctx: ToolContext, folder?: string): Promise<string> {
    const f = (folder ?? "").replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
    const n = await this.stopWhere(
      (s) =>
        s.info.taskId === ctx.taskId &&
        (s.info.state === "running" || s.info.state === "starting") &&
        (!f || s.recipe.cwd === f || s.recipe.cwd.startsWith(`${f}/`)),
      "Stopped by the agent",
    );
    return n ? `Stopped ${n} preview${n === 1 ? "" : "s"}.` : "Nothing was running for this task.";
  }
}

function firstLines(log: LogRing, n: number): string {
  return log
    .since(0)
    .lines.slice(0, n)
    .map((l) => (l.stream === "depo" ? `[depo] ${l.text}` : l.text))
    .join("\n");
}
