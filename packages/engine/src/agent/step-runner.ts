import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "@depo/model-gateway";
import type { PlanStep, StepPlan } from "@depo/shared";
import { getLogger } from "../logger";
import { appendFileTool } from "../tools/fs-tools";
import type { FinishResult } from "./finish";
import { FixRounds, finishSummary, withCodeFrames } from "./finish";
import { type LoopParams, type LoopResult, runAgentLoop } from "./loop";
import type { PlannedStep, RequestPlan } from "./plan";
import { changedSince, restoreFiles, restoreSavePoint, type SavePoint, takeSavePoint } from "./savepoint";
import { checkableBefore, checkStep, compileProblems, schemaFileFor } from "./step-check";
import { filesForStep, stepPrompt } from "./step-prompt";
import { generateTable } from "./tablegen";

/**
 * Runs Depo's step plan (ADR-0086). Each step is a short run of its own: a fresh conversation
 * with only that step, its part of the request and its files already read; Depo checks the step
 * in code when the model says it is done. A step that does not pass climbs a ladder (the problem
 * back to the model, the larger model, a clean restart from the step's save point); a step that
 * fails every rung is parked while the others go on, and tried again once they are done. Then
 * Depo runs the app; each problem it finds becomes a new fix step on the plan. Nothing ends the
 * run but success, the owner stopping it, or every approach failing on the same problem.
 */

const log = getLogger({ component: "steps" });

/** Model steps for one try of a step (the loop adds more for each round of Depo's feedback). */
export const STEP_MAX_STEPS = 24;
/** Rounds of feedback in one try; the same problem twice brings in the larger model. */
const STEP_ROUNDS = { maxRounds: 6, sameLimit: 2 };
/** Fix steps made from one round of the final check (the rest wait for the next round). */
const FIXES_PER_ROUND = 4;
/** Sampling for a careful retry. */
const CAREFUL = 0.2;

export type BaseLoopParams = Omit<
  LoopParams,
  "history" | "maxSteps" | "beforeFinish" | "checkDone" | "fixing" | "stepUp" | "temperature"
> & { temperature?: number };

export interface StepRunOptions {
  plan: RequestPlan;
  /** The plan as shown to the owner; updated in place and saved on every change. */
  state: StepPlan;
  root: string;
  /** System prompt for every step. */
  system: string;
  base: BaseLoopParams;
  /** A larger installed model for the steps the owner's model gets stuck on. */
  stepUp: string | null;
  /** Saves the plan and tells the app (called on every change). */
  save: (plan: StepPlan) => void;
  /** Depo runs the app (the finish line); null when that is off. */
  checkApp: (() => Promise<FinishResult>) | null;
  /** Characters of file content a step prompt may hold. */
  budget: number;
  /** The owner's design references brief, for the steps that build what the owner sees. */
  design?: string;
  /** Runs one try (tests pass their own). */
  run?: (p: LoopParams) => Promise<LoopResult>;
  /**
   * How many independent steps (pages: each its own files) may run at the same time, one agent
   * each. 1 (the default) runs them one after the other. The caller sets it from what the model
   * runtime can really serve at once.
   */
  parallel?: number;
  /**
   * Depo writes a table step itself, with no model call, when the schema is MySQL style and the
   * check passes (see tablegen.ts). Off by default; a step that fails the check goes to the model.
   */
  generateTables?: boolean;
}

export interface StepRunResult {
  /** The answer for the owner. */
  finalText: string;
  /** Depo's run report (what it ran and found), or "". */
  report: string;
  aborted: boolean;
  /** Steps that never passed. */
  blocked: PlanStep[];
}

interface Rung {
  model: string;
  restore: boolean;
  careful: boolean;
  /** Why this try, for the plan card and the activity feed. */
  why: string;
}

const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? s).trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The tools one step needs. Every tool's description travels with every model call, and a small
 * model does better with fewer to choose from: a step that builds a table, route, page or test
 * does not need the preview, the database console, memory or file deletion unless its title says so.
 */
export function stepTools(all: string[], step: { kind: PlanStep["kind"]; title: string }): string[] {
  const text = step.title.toLowerCase();
  const drop = new Set<string>(["delete_file", "remember", "stop_preview"]);
  if (!/database|migrat|seed|sql|table/.test(text) && step.kind !== "table") drop.add("dev_database");
  if (step.kind === "table" || step.kind === "route" || step.kind === "tests") {
    drop.add("start_preview");
    drop.add("check_page");
    drop.add("http_check");
  }
  if (step.kind === "table") drop.add("run_command");
  if (/delete|remove/.test(text)) drop.delete("delete_file");
  // The edit tools and the reading tools always stay.
  return all.filter((n) => !drop.has(n));
}

/** A new plan for the owner to see, all steps waiting. */
export function newStepPlan(
  plan: RequestPlan,
  messageId: string | null,
  now = new Date().toISOString(),
): StepPlan {
  return {
    messageId,
    createdAt: now,
    updatedAt: now,
    steps: plan.steps.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      status: "pending" as const,
      note: null,
      tries: 0,
      model: null,
      added: false,
    })),
  };
}

/** The message Depo sends when a step's check fails. */
export function stepProblemsText(step: PlannedStep, problems: string[], root: string): string {
  return [
    `Depo checked "${step.title}" and it is not done yet:`,
    ...problems.map((p) => `- ${withCodeFrames(p, root)}`),
    "Fix this now, then say in one line what you did.",
  ].join("\n");
}

export async function runStepPlan(o: StepRunOptions): Promise<StepRunResult> {
  const { plan, state, root, base } = o;
  const signal = base.signal;
  const run = o.run ?? runAgentLoop;
  const steps = new Map(plan.steps.map((s) => [s.id, s]));
  const owner = base.model;
  const big = o.stepUp && o.stepUp !== owner ? o.stepUp : null;
  const schemaFile = schemaFileFor(root, plan.overview) ?? undefined;

  const view = (id: string) => state.steps.find((s) => s.id === id) as PlanStep;
  const update = (id: string, patch: Partial<PlanStep>) => {
    Object.assign(view(id), patch);
    state.updatedAt = new Date().toISOString();
    o.save(state);
  };
  const buildSteps = () => state.steps.filter((s) => s.kind !== "check");
  const position = (id: string) => {
    const i = state.steps.findIndex((s) => s.id === id);
    return { index: i + 1, total: state.steps.length };
  };

  base.emit({
    type: "planning",
    text: `Depo's plan: ${state.steps.length} steps (${state.steps
      .slice(0, 4)
      .map((s) => s.title)
      .join("; ")}${state.steps.length > 4 ? "; …" : ""})`,
    details: { steps: state.steps.map((s) => s.title) },
    status: "info",
  });

  /** One try of a step: a fresh conversation, checked by Depo when the model says it is done. */
  const tryStep = async (
    step: PlannedStep,
    rung: Rung,
    earlier: string[],
    sp: SavePoint | null,
    scope?: Set<string>,
  ): Promise<{ error: string | null; acceptUnchanged: boolean; changed: string[] }> => {
    const { index, total } = position(step.id);
    const done = state.steps.filter((s) => s.status === "done" && s.id !== step.id).map((s) => s.title);
    const later = state.steps
      .slice(index)
      .filter((s) => s.status === "pending")
      .map((s) => s.title);
    const prompt = stepPrompt({
      step,
      plan,
      root,
      done,
      later,
      index,
      total,
      earlier,
      blocks: !!base.fileBlocks,
      budget: o.budget,
      ...(o.design ? { design: o.design } : {}),
    });
    for (const f of prompt.shown) base.ctx.readPaths?.add(f);
    const mainFile = step.kind === "table" ? schemaFile : filesForStep(step, plan, root)[0];
    const history: ChatMessage[] = [
      { role: "system", content: o.system },
      { role: "user", content: prompt.text },
    ];
    const rounds = new FixRounds(STEP_ROUNDS);
    let unchangedAsked = false;
    let acceptUnchanged = false;
    const changedNow = () => (sp ? changedSince(root, sp, scope) : []);
    const params: LoopParams = {
      ...base,
      toolNames: stepTools(base.toolNames, step),
      model: rung.model,
      history,
      maxSteps: STEP_MAX_STEPS,
      ...(rung.careful
        ? { temperature: CAREFUL }
        : base.temperature !== undefined
          ? { temperature: base.temperature }
          : {}),
      ...(big && rung.model !== big ? { stepUp: { model: big } } : {}),
      ctx: {
        ...base.ctx,
        // Steps that run side by side each know which files are theirs.
        ...(scope
          ? {
              onFileChanged: (p: string) => {
                scope.add(p);
                const who = touchedBy.get(p) ?? new Set<string>();
                who.add(step.id);
                touchedBy.set(p, who);
                base.ctx.onFileChanged?.(p);
              },
            }
          : {}),
        step: {
          ...(step.table ? { tables: [step.table.name] } : {}),
          ...(mainFile ? { mainFile } : {}),
          ...(schemaFile ? { schemaFile } : {}),
        },
      },
      // Depo's feedback is saved as Depo's, so the chat shows it as a step, not as the owner.
      persist: (m) => base.persist(m.role === "user" ? ({ ...m, fromDepo: true } as typeof m) : m),
      beforeFinish: async () => {
        const changed = changedNow();
        if (step.kind === "build" && !changed.length) {
          if (!unchangedAsked) {
            unchangedAsked = true;
            return {
              retry: `You changed nothing in this step. If "${step.title}" is already in the code, say which file has it. Otherwise build it now.`,
            };
          }
          acceptUnchanged = true;
          return null;
        }
        const problems = checkStep(step, root, { changed, overview: plan.overview, acceptUnchanged });
        if (!problems.length) return null;
        const verdict = rounds.next(problems);
        if (verdict === "stop") return null;
        update(step.id, { note: clip(firstLine(problems[0] ?? ""), 200) });
        return {
          retry: stepProblemsText(step, problems, root),
          ...(verdict === "again" ? { stepUp: true } : {}),
        };
      },
    };
    try {
      const r = await run(params);
      return { error: null, acceptUnchanged, changed: r.changed };
    } catch (err) {
      // A try that crashed (replies that could not be read, a reply that kept repeating) ends
      // only this try: the ladder goes on.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("step try ended with an error", { step: step.title, model: rung.model, err: msg });
      return { error: `The try ended: ${msg}`, acceptUnchanged, changed: [] };
    }
  };

  const ladder = (second: boolean): Rung[] => {
    if (second)
      return [
        {
          model: big ?? owner,
          restore: false,
          careful: true,
          why: `${big ?? owner} tries the parked step again`,
        },
        ...(big ? [{ model: owner, restore: true, careful: true, why: "a clean restart" }] : []),
      ];
    return [
      { model: owner, restore: false, careful: false, why: "" },
      ...(big ? [{ model: big, restore: true, careful: false, why: `${big} starts the step again` }] : []),
      { model: owner, restore: true, careful: true, why: "a clean restart, carefully" },
    ];
  };

  /** Which steps changed each file, for steps that run side by side. */
  const touchedBy = new Map<string, Set<string>>();

  /** Runs one step up the ladder. True when it passed. `scope` is set when steps run side by side. */
  const doStep = async (step: PlannedStep, second: boolean, scope?: Set<string>): Promise<boolean> => {
    const { index, total } = position(step.id);
    if (!second && checkableBefore(step)) {
      const before = checkStep(step, root, { changed: [], overview: plan.overview });
      if (!before.length) {
        update(step.id, { status: "done", note: "Already in the code" });
        base.emit({
          type: "info",
          text: `Step ${index} of ${total} is already in the code: ${step.title}`,
          status: "succeeded",
        });
        return true;
      }
    }
    if (o.generateTables && !second && step.kind === "table" && step.table && schemaFile) {
      const abs = path.join(root, schemaFile);
      let existing = "";
      try {
        existing = fs.readFileSync(abs, "utf8");
      } catch {
        // no schema file yet: the model creates it
      }
      const gen = existing ? generateTable(existing, step.table.name, step.table.columns) : null;
      if (gen) {
        const point = takeSavePoint(root);
        appendFileTool(root, schemaFile, gen.sql);
        const problems = checkStep(step, root, { changed: [schemaFile], overview: plan.overview });
        if (!problems.length) {
          update(step.id, {
            status: "done",
            tries: view(step.id).tries + 1,
            note: "Written by Depo, no model call",
          });
          base.ctx.onFileChanged?.(schemaFile);
          base.emit({
            type: "writing_file",
            text: `Step ${index} of ${total}: Depo wrote the ${step.table.name} table itself (no model call)`,
            details: { step: step.id, path: schemaFile, generated: true, notes: gen.notes },
            status: "succeeded",
          });
          return true;
        }
        // Not good enough: put the file back and let the model do the step.
        if (point) restoreSavePoint(root, point);
      }
    }
    const sp = takeSavePoint(root);
    const earlier: string[] = [];
    let last: string[] = [];
    const rungs = ladder(second);
    for (const rung of rungs) {
      if (signal.aborted) return false;
      if (rung.restore && sp) {
        // Side by side: only this step's own files go back, never a file another step also changed.
        const r = scope
          ? restoreFiles(
              root,
              sp,
              [...scope].filter((f) => (touchedBy.get(f)?.size ?? 0) <= 1),
            )
          : restoreSavePoint(root, sp);
        if (r.restored.length || r.removed.length)
          base.emit({
            type: "retrying",
            text: `Depo put back the ${r.restored.length + r.removed.length} file${r.restored.length + r.removed.length === 1 ? "" : "s"} this step changed and starts it again`,
            details: { restored: r.restored, removed: r.removed },
            status: "running",
          });
      }
      const tries = view(step.id).tries + 1;
      update(step.id, {
        status: "running",
        tries,
        model: rung.model,
        ...(rung.why ? { note: `Try ${tries}: ${rung.why}` } : {}),
      });
      base.emit({
        type: "planning",
        text: `Step ${index} of ${total}: ${step.title}${rung.why ? ` (${rung.why})` : ""}`,
        details: { step: step.id, try: tries, model: rung.model },
        status: "started",
      });
      const res = await tryStep(step, rung, earlier, sp, scope);
      if (signal.aborted) return false;
      const changed = sp ? changedSince(root, sp, scope) : res.changed;
      last = res.error
        ? [res.error]
        : checkStep(step, root, { changed, overview: plan.overview, acceptUnchanged: res.acceptUnchanged });
      if (!last.length) {
        update(step.id, {
          status: "done",
          note: res.acceptUnchanged
            ? "Already in the code, the model says"
            : rung.model !== owner
              ? `Done by ${rung.model}`
              : null,
        });
        base.emit({
          type: "info",
          text: `Done: ${step.title}`,
          details: { step: step.id, tries, model: rung.model },
          status: "succeeded",
        });
        return true;
      }
      earlier.push(last[0] ?? "");
    }
    // Every rung failed: keep the work only if it compiles, so the next steps start from sound code.
    if (sp && compileProblems(root, changedSince(root, sp, scope)).length)
      if (scope)
        restoreFiles(
          root,
          sp,
          [...scope].filter((f) => (touchedBy.get(f)?.size ?? 0) <= 1),
        );
      else restoreSavePoint(root, sp);
    const why = clip(firstLine(last[0] ?? "it did not pass Depo's check"), 200);
    update(step.id, { status: "blocked", note: why });
    base.emit({
      type: "info",
      text: `Parked "${step.title}" for now: ${why.replace(/[.!]+$/, "")}. Depo goes on with the other steps and comes back to it.`,
      details: { step: step.id },
      status: "failed",
    });
    return false;
  };

  // 1. Every step in order; a step that fails every rung is parked.
  const width = Math.max(1, Math.floor(o.parallel ?? 1));
  const queue = buildSteps().filter((s) => s.status !== "done");
  while (queue.length && !signal.aborted) {
    const first = queue.shift() as PlanStep;
    const firstStep = steps.get(first.id);
    if (!firstStep) continue;
    // Pages are separate files and do not wait for one another: up to `width` run at once.
    const group: PlannedStep[] = [firstStep];
    if (width > 1 && firstStep.kind === "page")
      while (group.length < width && queue[0] && steps.get(queue[0].id)?.kind === "page") {
        const next = steps.get((queue.shift() as PlanStep).id);
        if (next) group.push(next);
      }
    if (group.length === 1) {
      await doStep(firstStep, false);
      continue;
    }
    base.emit({
      type: "planning",
      text: `${group.length} pages are built at the same time: ${group.map((g) => g.title).join("; ")}`,
      details: { parallel: group.map((g) => g.id) },
      status: "info",
    });
    await Promise.all(group.map((g) => doStep(g, false, new Set<string>())));
  }
  // 2. Parked steps again: later steps often made what they were missing.
  for (const s of buildSteps().filter((x) => x.status === "blocked")) {
    if (signal.aborted) break;
    const step = steps.get(s.id);
    if (step) await doStep(step, true);
  }

  // 3. Depo runs the app; each problem becomes a fix step on the plan.
  const check = state.steps.find((s) => s.kind === "check");
  let report = "";
  if (check && !signal.aborted) {
    if (!o.checkApp) update(check.id, { status: "skipped", note: "Running the app is off in Settings" });
    else {
      const rounds = new FixRounds();
      for (;;) {
        if (signal.aborted) break;
        update(check.id, { status: "running", tries: view(check.id).tries + 1, note: null });
        const r = await o.checkApp();
        if (signal.aborted) break;
        if (!r.problems.length) {
          update(check.id, {
            status: r.blocked.length ? "blocked" : "done",
            note: r.blocked.length
              ? clip(firstLine(r.blocked[0] ?? ""), 200)
              : r.running.length
                ? `Running: ${r.running.map((p) => p.url).join(", ")}`
                : null,
          });
          report = finishSummary(r);
          break;
        }
        const verdict = rounds.next(r.problems);
        if (verdict === "stop") {
          update(check.id, { status: "blocked", note: clip(firstLine(r.problems[0] ?? ""), 200) });
          report = finishSummary(r, rounds.stopped);
          break;
        }
        update(check.id, {
          status: "pending",
          note: `Found ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}; fixing`,
        });
        for (const problem of r.problems.slice(0, FIXES_PER_ROUND)) {
          if (signal.aborted) break;
          const id = `f${state.steps.length + 1}`;
          const fix: PlannedStep = {
            id,
            title: clip(`Fix: ${firstLine(problem)}`, 100),
            kind: "fix",
            spec: withCodeFrames(problem, root),
            notes: "",
            section: "",
          };
          steps.set(id, fix);
          // Fix steps go before the check, which runs again after them.
          state.steps.splice(state.steps.indexOf(view(check.id)), 0, {
            id,
            title: fix.title,
            kind: "fix",
            status: "pending",
            note: null,
            tries: 0,
            model: null,
            added: true,
          });
          o.save(state);
          await doStep(fix, verdict === "again");
        }
      }
    }
  }

  const blocked = state.steps.filter((s) => s.status === "blocked");
  const doneCount = state.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const lines: string[] = [];
  if (signal.aborted) lines.push(`Stopped after ${doneCount} of ${state.steps.length} steps.`);
  else if (!blocked.length)
    lines.push(`Done: all ${state.steps.length} steps of the plan passed Depo's checks.`);
  else
    lines.push(
      `${doneCount} of ${state.steps.length} steps are done. ${blocked.length === 1 ? "One step is" : `${blocked.length} steps are`} not done yet:`,
      ...blocked.map((s) => `- ${s.title}${s.note ? `: ${s.note}` : ""}`),
      'Send "go on" and Depo tries these again from here, or tell me what you know about them.',
    );
  return { finalText: lines.join("\n"), report, aborted: signal.aborted, blocked };
}
