import fs from "node:fs";
import path from "node:path";
import { generateObject } from "@depo/model-gateway";
import type {
  ApiResult,
  ChangeSet,
  GitCommitRef,
  GitDraft,
  GitDraftFile,
  GitIdentity,
  GitStatus,
} from "@depo/shared";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import type { ModelManager } from "../models/manager";
import { redact } from "../redact";
import type { ModelScheduler } from "../scheduler/scheduler";
import { git } from "../tools/git";
import { matchesRule } from "../tools/index";
import { classifyCommand } from "../tools/shell/policy";
import { type RunResult, runShell } from "../tools/shell/run";
import type { ProjectService } from "../workspace/service";
import { hashFile } from "../workspace/snapshot";
import {
  branchSlug,
  CommitDraftSchema,
  cleanMessage,
  commitPrompt,
  type DraftInput,
  diffExcerpt,
  messageFromDraft,
  templateMessage,
} from "./message";
import {
  commitLog,
  commitShow,
  gitAvailable,
  gitWithInput,
  type PorcelainEntry,
  parseUnifiedDiff,
  porcelain,
  readIdentity,
  repoInfo,
  repoStatus,
} from "./repo";

export interface TaskInfo {
  title: string;
  prompt: string;
  summary: string | null;
  mode: string | null;
}

export interface GitServiceOptions {
  projects: ProjectService;
  bus: EventBus;
  logger: Logger;
  models: Pick<ModelManager, "resolve">;
  scheduler: ModelScheduler | null;
  /** The task a change set came from (title, request, final answer, mode). */
  task: (taskId: string) => TaskInfo | null;
  /** Per-project command rules: a blocked command stays blocked even when the owner clicks. */
  commandRules: (projectId: string) => { allow: string[]; deny: string[] } | null;
  /** Time a model draft may take, queue included (default 90 s). */
  draftTimeoutMs?: number;
}

/** Thrown when git needs a name and email first; the UI shows a small form for it. */
export class MissingIdentityError extends Error {
  constructor() {
    super("Git does not know who you are yet. Add your name and email for this project, then commit.");
  }
}

const NAME_RE = /^[\p{L}\p{M}\p{N} .,'_()-]{1,100}$/u;
const EMAIL_RE = /^[^\s"'%!^&|<>$`\\@;()]{1,100}@[^\s"'%!^&|<>$`\\@;()]{1,100}$/;
/** Characters that are safe inside a double-quoted argument in both cmd.exe and /bin/sh. */
const SAFE_ARG = /^[^"%!^&|<>$`\r\n]*$/;

/**
 * Git for applied change sets: draft a conventional commit message, commit exactly the files
 * Depo applied (never the owner's other changes), optionally on a new `depo/…` branch, and read
 * the history. Commits run as ordinary git commands through the command policy, contained like
 * every other command, on the owner's click. Depo never pushes.
 */
export class GitService {
  private readonly logger: Logger;

  constructor(private readonly o: GitServiceOptions) {
    this.logger = o.logger.child({ component: "git" });
  }

  private async root(projectId: string): Promise<string> {
    const project = await this.o.projects.get(projectId);
    if (!project.exists) throw new Error("The project folder is missing.");
    return project.rootPath;
  }

  async status(projectId: string): Promise<GitStatus> {
    return repoStatus(await this.root(projectId));
  }

  async log(projectId: string, limit: number): Promise<ApiResult<"git.log">> {
    const root = await this.root(projectId);
    if (!(await repoInfo(root))) return { commits: [] };
    return { commits: await commitLog(root, limit) };
  }

  async show(projectId: string, hash: string): Promise<ApiResult<"git.show">> {
    const root = await this.root(projectId);
    if (!(await repoInfo(root))) throw new Error("This project is not a git repository.");
    return commitShow(root, hash);
  }

  // ---- drafting ------------------------------------------------------------------------------

  private changeSet(projectId: string, changeSetId: string): ChangeSet {
    const cs = this.o.projects.getChangeSet(changeSetId);
    if (cs.projectId !== projectId) throw new Error("This change set belongs to another project.");
    return cs;
  }

  /** The change set's files that were applied, with the hash each had right after the apply. */
  private appliedFiles(
    cs: ChangeSet,
  ): { file: ChangeSet["files"][number]; appliedHash: string | null | undefined }[] {
    const hashes = new Map<string, string | null>();
    // Oldest first, so a later apply of the same file wins.
    const cps = this.o.projects
      .listCheckpoints(cs.projectId)
      .filter((c) => c.changeSetId === cs.id && c.status === "active")
      .reverse();
    for (const c of cps) for (const f of c.files) hashes.set(f.path, f.appliedHash);
    return cs.files
      .filter((f) => f.status === "applied" || f.status === "partially_applied")
      .map((file) => ({ file, appliedHash: hashes.has(file.path) ? hashes.get(file.path) : undefined }));
  }

  /** Each applied file: whether it is committed by default, and why not. */
  private async draftFiles(
    root: string,
    cs: ChangeSet,
  ): Promise<{ files: GitDraftFile[]; changed: Map<string, PorcelainEntry> }> {
    const info = await repoInfo(root);
    if (!info) throw new Error("This project is not a git repository.");
    const applied = this.appliedFiles(cs);
    const paths = applied.map((a) => a.file.path);
    // Porcelain paths are relative to the repository top; the change set's to the project folder.
    const st = await porcelain(root, {
      allUntracked: true,
      ...(paths.join("").length < 20_000 ? { paths } : {}),
    });
    const changed = new Map<string, PorcelainEntry>();
    for (const e of st.entries) {
      const rel = info.prefix && e.path.startsWith(info.prefix) ? e.path.slice(info.prefix.length) : e.path;
      if (!info.prefix || e.path.startsWith(info.prefix)) changed.set(rel, e);
    }
    const unchanged = paths.filter((p) => !changed.has(p));
    const ignored = new Set<string>();
    if (unchanged.length) {
      const r = await gitWithInput(root, ["check-ignore", "-z", "--stdin"], `${unchanged.join("\0")}\0`);
      for (const p of r.stdout.split("\0")) if (p) ignored.add(p.replace(/\\/g, "/"));
    }
    const files = applied.map(({ file, appliedHash }): GitDraftFile => {
      let note: string | null = null;
      let include = true;
      if (ignored.has(file.path)) {
        include = false;
        note = "Git ignores this file (.gitignore), so it is left out.";
      } else if (!changed.has(file.path)) {
        include = false;
        note = "No changes left to commit. It may be committed already or undone.";
      } else if (appliedHash !== undefined && hashFile(path.join(root, file.path)) !== appliedHash) {
        include = false;
        note = "You changed this file after applying it. Tick it to commit your edits too.";
      }
      return {
        path: file.path,
        kind: file.kind,
        additions: file.additions,
        deletions: file.deletions,
        include,
        note,
      };
    });
    return { files, changed };
  }

  private draftInput(cs: ChangeSet, files: GitDraftFile[]): DraftInput {
    const task = cs.taskId ? this.o.task(cs.taskId) : null;
    const included = files.filter((f) => f.include);
    return {
      title: task?.title || cs.title,
      request: task?.prompt || cs.title,
      finalAnswer: task?.summary ?? "",
      mode: task?.mode ?? null,
      files: (included.length ? included : files).map((f) => ({
        path: f.path,
        kind: f.kind,
        additions: f.additions,
        deletions: f.deletions,
      })),
    };
  }

  private committedRef(projectId: string, changeSetId: string): GitCommitRef | null {
    const ev = this.o.bus
      .recent({ projectId, types: ["committed"], limit: 500 })
      .find((e) => e.details?.changeSetId === changeSetId);
    const d = ev?.details;
    if (!d || typeof d.hash !== "string") return null;
    return {
      hash: d.hash,
      shortHash: typeof d.shortHash === "string" ? d.shortHash : d.hash.slice(0, 7),
      branch: typeof d.branch === "string" ? d.branch : null,
    };
  }

  private async freeBranch(root: string, base: string): Promise<string> {
    const r = await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/depo/"]);
    const taken = new Set(r.ok ? r.stdout.split("\n").map((l) => l.trim()) : []);
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    return `${base}-${Date.now().toString(36)}`;
  }

  async draft(projectId: string, changeSetId: string, useModel: boolean): Promise<GitDraft> {
    const root = await this.root(projectId);
    if (!(await gitAvailable()))
      throw new Error("Git is not installed. Install Git for Windows to commit from Depo.");
    const cs = this.changeSet(projectId, changeSetId);
    const [{ files }, identity, st] = await Promise.all([
      this.draftFiles(root, cs),
      readIdentity(root),
      porcelain(root).catch(() => null),
    ]);
    const input = this.draftInput(cs, files);
    const suggestedBranch = await this.freeBranch(root, `depo/${branchSlug(input.title)}`);
    let message = templateMessage(input);
    let source: GitDraft["source"] = "template";
    let note: string | null = null;
    if (useModel && files.some((f) => f.include)) {
      const drafted = await this.modelDraft(projectId, root, cs, input).catch((err: unknown) => {
        this.logger.info("commit draft from the model skipped", { err: String(err) });
        return null;
      });
      if (drafted) {
        message = drafted;
        source = "model";
      } else note = "No local model answered in time, so this is Depo's simple draft.";
    }
    return {
      message,
      source,
      note,
      files,
      branch: st?.branch ?? null,
      suggestedBranch,
      identity,
      committed: this.committedRef(projectId, changeSetId),
    };
  }

  private async modelDraft(
    projectId: string,
    root: string,
    cs: ChangeSet,
    input: DraftInput,
  ): Promise<string | null> {
    const r = this.o.models.resolve("fast") ?? this.o.models.resolve("coder");
    if (!r) return null;
    const diff = await git(
      root,
      [
        "diff",
        "HEAD",
        "--no-ext-diff",
        "--no-color",
        "-U1",
        "--",
        ...input.files.slice(0, 20).map((f) => `:(literal)${f.path}`),
      ],
      15_000,
    ).catch(() => null);
    const hunks = diff?.ok ? parseUnifiedDiff(diff.stdout, { perFile: 40, total: 400, files: 20 }) : [];
    const excerpt = hunks.length
      ? diffExcerpt(hunks)
      : diffExcerpt(cs.files.filter((f) => input.files.some((i) => i.path === f.path)));
    const { system, user } = commitPrompt(input, excerpt);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.draftTimeoutMs ?? 90_000);
    try {
      const call = () =>
        generateObject(r.provider, {
          model: r.model,
          contextLength: r.contextLength ?? 8192,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          schema: CommitDraftSchema,
          maxRepairs: 1,
          temperature: 0.2,
          signal: ctl.signal,
        });
      const res = await (this.o.scheduler
        ? this.o.scheduler.run(
            { projectId, taskId: null, model: r.model, priority: "background", label: "Git: commit message" },
            call,
            ctl.signal,
          )
        : call());
      return messageFromDraft(res.value, input);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- committing ----------------------------------------------------------------------------

  /** Run a git command the owner just asked for: policy first (a blocked command stays blocked), then contained. */
  private async run(
    projectId: string,
    root: string,
    command: string,
    timeoutMs = 60_000,
  ): Promise<RunResult> {
    let verdict = classifyCommand(command, root);
    const rules = this.o.commandRules(projectId);
    if (rules?.deny.some((r) => matchesRule(command, r)))
      verdict = { ...verdict, decision: "deny", reason: "blocked by this project's command rules" };
    if (verdict.decision === "deny") throw new Error(`Depo will not run "${command}": ${verdict.reason}.`);
    // "ask" is answered: the owner clicked Commit (or Save) for exactly this.
    const res = await runShell({
      command,
      cwd: root,
      timeoutMs,
      env: { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
      maxOutputBytes: 40_000,
    });
    this.logger.info("git command", {
      projectId,
      command,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      containment: res.containment,
    });
    return res;
  }

  private failure(what: string, res: RunResult): Error {
    const out = redact(res.output.trim()).split("\n").slice(-12).join("\n").slice(0, 1200);
    if (res.timedOut) return new Error(`${what} took too long and was stopped.${out ? `\n${out}` : ""}`);
    return new Error(`${what} failed.${out ? `\n${out}` : ""}`);
  }

  async commit(p: {
    projectId: string;
    changeSetId: string;
    message: string;
    branch?: string | undefined;
    files?: string[] | undefined;
  }): Promise<ApiResult<"git.commit">> {
    const root = await this.root(p.projectId);
    if (!(await gitAvailable()))
      throw new Error("Git is not installed. Install Git for Windows to commit from Depo.");
    const info = await repoInfo(root);
    if (!info) throw new Error("This project is not a git repository.");
    if (!(await readIdentity(root))) throw new MissingIdentityError();
    const message = cleanMessage(p.message);
    if (!message) throw new Error("Write a commit message first.");
    const cs = this.changeSet(p.projectId, p.changeSetId);
    if (cs.status !== "applied" && cs.status !== "partially_applied")
      throw new Error("Apply these changes first. Depo commits only changes you applied.");

    const { files, changed } = await this.draftFiles(root, cs);
    const byPath = new Map(files.map((f) => [f.path, f]));
    let wanted: string[];
    if (p.files) {
      const unknown = p.files.filter((f) => !byPath.has(f));
      if (unknown.length) throw new Error(`Not one of the applied files: ${unknown.slice(0, 3).join(", ")}`);
      wanted = [...new Set(p.files)];
    } else wanted = files.filter((f) => f.include).map((f) => f.path);
    const skipped: { path: string; reason: string }[] = [];
    const commitPaths: string[] = [];
    for (const f of files) {
      if (!wanted.includes(f.path)) {
        skipped.push({ path: f.path, reason: f.note ?? "Not selected." });
        continue;
      }
      if (!changed.has(f.path)) {
        skipped.push({ path: f.path, reason: f.note ?? "No changes left to commit." });
        continue;
      }
      commitPaths.push(f.path);
    }
    if (commitPaths.length === 0)
      throw new Error("Nothing to commit: none of the chosen files has changes since the last commit.");

    // Files go to git through files in the git folder, never on the command line: no quoting
    // problems with spaces or odd names, and no length limit on Windows.
    const rel = path.relative(root, info.gitDir) || ".git";
    const msgRel = path.join(rel, "DEPO_COMMIT_MSG");
    const pathsRel = path.join(rel, "DEPO_COMMIT_PATHS");
    if (!SAFE_ARG.test(msgRel))
      throw new Error("The repository folder name has characters Depo cannot pass to git safely.");
    const msgAbs = path.join(info.gitDir, "DEPO_COMMIT_MSG");
    const pathsAbs = path.join(info.gitDir, "DEPO_COMMIT_PATHS");
    const pathspec = `--pathspec-from-file="${pathsRel}" --pathspec-file-nul`;

    const start = await porcelain(root).catch(() => null);
    const originalBranch = start?.branch ?? null;
    let createdBranch = false;
    if (p.branch) {
      const check = await git(root, ["check-ref-format", "--branch", p.branch]);
      if (!check.ok) throw new Error(`"${p.branch}" is not a valid branch name.`);
      const exists = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`]);
      if (exists.ok) throw new Error(`A branch named ${p.branch} already exists. Choose another name.`);
      if (start?.unborn)
        throw new Error("This repository has no commits yet. Commit to the current branch first.");
    }

    // Paths already staged by the owner stay staged if the commit fails.
    const stagedBefore = new Set(
      commitPaths.filter((rp) => {
        const code = changed.get(rp)?.code ?? "  ";
        return code[0] !== " " && code[0] !== "?";
      }),
    );
    try {
      fs.writeFileSync(msgAbs, `${message}\n`, "utf8");
      fs.writeFileSync(pathsAbs, `${commitPaths.join("\0")}\0`, "utf8");
      if (p.branch) {
        const sw = await this.run(p.projectId, root, `git switch -c ${p.branch}`, 30_000);
        if (sw.exitCode !== 0) throw this.failure("Creating the branch", sw);
        createdBranch = true;
      }
      const add = await this.run(p.projectId, root, `git add -A ${pathspec}`, 60_000);
      if (add.exitCode !== 0) throw this.failure("Staging the files", add);
      const commit = await this.run(p.projectId, root, `git commit -F "${msgRel}" ${pathspec}`, 120_000);
      if (commit.exitCode !== 0) throw this.failure("The commit", commit);
    } catch (err) {
      await this.rollback(
        p.projectId,
        root,
        commitPaths,
        stagedBefore,
        pathsAbs,
        pathspec,
        createdBranch ? { created: p.branch as string, back: originalBranch } : null,
      );
      throw err;
    } finally {
      fs.rmSync(msgAbs, { force: true });
      fs.rmSync(pathsAbs, { force: true });
    }

    const head = await git(root, ["rev-parse", "HEAD"]);
    const hash = head.stdout.trim();
    const shortHash = (await git(root, ["rev-parse", "--short", "HEAD"])).stdout.trim() || hash.slice(0, 7);
    const branch = (await porcelain(root).catch(() => null))?.branch ?? null;
    const subject = message.split("\n")[0] ?? "";
    this.o.bus.emit({
      projectId: p.projectId,
      taskId: cs.taskId,
      agent: "user",
      type: "committed",
      text: `Committed ${commitPaths.length} file${commitPaths.length === 1 ? "" : "s"} to ${branch ?? "a detached HEAD"} (${shortHash}): ${subject}`,
      details: {
        changeSetId: cs.id,
        hash,
        shortHash,
        branch,
        createdBranch,
        files: commitPaths,
        skipped: skipped.map((s) => s.path),
      },
      status: "succeeded",
    });
    return { hash, shortHash, branch, createdBranch, files: commitPaths, skipped };
  }

  /** Undo the staging Depo did (and the branch it made) after a failed commit. Best effort. */
  private async rollback(
    projectId: string,
    root: string,
    paths: string[],
    stagedBefore: Set<string>,
    pathsAbs: string,
    pathspec: string,
    branch: { created: string; back: string | null } | null,
  ): Promise<void> {
    try {
      const unstage = paths.filter((p) => !stagedBefore.has(p));
      if (unstage.length) {
        fs.writeFileSync(pathsAbs, `${unstage.join("\0")}\0`, "utf8");
        const hasHead = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
        await this.run(
          projectId,
          root,
          hasHead ? `git reset -q ${pathspec}` : `git rm -r -q --cached ${pathspec}`,
          30_000,
        );
      }
      if (branch?.back && /^[A-Za-z0-9._/-]+$/.test(branch.back)) {
        const back = await this.run(projectId, root, `git switch ${branch.back}`, 30_000);
        if (back.exitCode === 0) await this.run(projectId, root, `git branch -D ${branch.created}`, 30_000);
      }
    } catch (err) {
      this.logger.warn("git rollback after a failed commit did not finish", { err: String(err) });
    }
  }

  async setIdentity(projectId: string, name: string, email: string): Promise<{ identity: GitIdentity }> {
    const root = await this.root(projectId);
    if (!(await repoInfo(root))) throw new Error("This project is not a git repository.");
    const n = name.trim();
    const e = email.trim();
    if (!NAME_RE.test(n) || !SAFE_ARG.test(n))
      throw new Error("Use letters, digits, spaces, dots and dashes in the name.");
    if (!EMAIL_RE.test(e)) throw new Error("That does not look like an email address.");
    for (const [key, value] of [
      ["user.name", n],
      ["user.email", e],
    ] as const) {
      const res = await this.run(projectId, root, `git config --local ${key} "${value}"`, 15_000);
      if (res.exitCode !== 0) throw this.failure("Saving your git identity", res);
    }
    const identity = await readIdentity(root);
    if (!identity) throw new Error("Git did not keep the name and email.");
    this.o.bus.emit({
      projectId,
      agent: "user",
      type: "info",
      text: `Set the git name and email for this project to ${identity.name} <${identity.email}>`,
      details: { gitIdentity: true },
      status: "succeeded",
    });
    return { identity };
  }
}
