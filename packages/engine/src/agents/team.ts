import fs from "node:fs";
import path from "node:path";
import {
  type ChatMessage,
  collectChat,
  extractJson,
  generateObject,
  type ModelProvider,
} from "@depo/model-gateway";
import {
  AGENT_IDS,
  type AgentId,
  type AgentManifest,
  type AgentStatus,
  type Plan,
  type PlanNode,
  PlanSchema,
  type ProjectSettings,
  type Review,
  ReviewSchema,
  type WorkMode,
} from "@depo/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type Emit, runAgentLoop } from "../agent/loop";
import { detectProject, topLevelListing, venvEnv } from "../agent/prompt";
import type { ApprovalCenter } from "../approvals";
import type { AppDb } from "../db";
import { tasks } from "../db/schema";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import type { ModelManager } from "../models/manager";
import type { ModelScheduler } from "../scheduler/scheduler";
import type { ProjectKnowledge, TeamHooks, ToolContext } from "../tools/index";
import { ToolError } from "../tools/paths";
import type { Workspace } from "../workspace/service";
import { type Blackboard, cleanSection, mayWrite } from "./blackboard";
import { MANIFESTS, MODE_AGENTS, manifestOf, READ_ONLY_MODES } from "./manifests";

const DEFAULT_CONTEXT = 16_384;
const DIGEST_BUDGET = 4500;

/** What the team needs from the task manager (kept narrow so both can be tested apart). */
export interface TeamHost {
  db: AppDb;
  bus: EventBus;
  logger: Logger;
  models: Pick<ModelManager, "resolve">;
  approvals: ApprovalCenter;
  scheduler?: ModelScheduler | undefined;
  blackboard: Blackboard;
  /** Resolves the active manifest of an agent (Agent Lab); the built-in manifests when absent. */
  manifest?: ((id: AgentId) => AgentManifest) | undefined;
  retryDelayMs?: number | undefined;
  maxSteps?: number | undefined;
  /** Global team settings (read at run time). */
  options(): {
    approvePlan: boolean;
    reviews: "all" | "key" | "off";
    fixLoops: number;
    parallel: number;
    exportDocs: boolean;
  };
  projectSettings(projectId: string): ProjectSettings | undefined;
  addMessage(taskId: string, msg: ChatMessage & { isError?: boolean }, agent: string): void;
  knowledge(projectId: string): ProjectKnowledge | undefined;
  lessons(projectId: string): NonNullable<Parameters<typeof runAgentLoop>[0]["lessons"]>;
  memoryContext(projectId: string): string;
  repoMap(projectId: string): string;
  /** Extra prompt text and tools for an agent (skills, MCP servers, knowledge packs). */
  extras?(agentId: string, projectId: string, run: { taskId: string; signal: AbortSignal }): AgentExtras;
}

export interface AgentExtras {
  prompt: string;
  tools: NonNullable<ToolContext["extraTools"]>;
  /** Names of the tools above (and any others) the agent may call. */
  allow: string[];
}

export interface TeamInput {
  taskId: string;
  projectId: string;
  projectName: string;
  text: string;
  mode: Exclude<WorkMode, "single">;
  ws: Workspace;
  signal: AbortSignal;
}

export interface TeamResult {
  finalText: string;
  /** Nodes that did not finish (failed or blocked). */
  unfinished: number;
  declined: boolean;
}

// ---- plan templates ----------------------------------------------------------------------

type Draft = Pick<PlanNode, "id" | "title" | "owner"> & { deps?: string[]; criteria?: string[] };

/** Which builder owns a change, from the words of the request. */
export function builderFor(text: string): AgentId {
  const t = text.toLowerCase();
  const word = (words: string) => new RegExp(String.raw`\b(?:${words})\b`).test(t);
  if (
    word(
      "css|style|styling|ui|ux|button|page|screen|component|layout|form|react|html|frontend|front-end|responsive|dark mode|menu|modal",
    )
  )
    return "frontend";
  if (word("sql|schema|migrations?|tables?|quer(?:y|ies)|index|database|db|postgres|sqlite"))
    return "database";
  return "backend";
}

/** The standard pipeline of each mode (system description, Section 5.2). */
export function templateNodes(mode: Exclude<WorkMode, "single">, text: string): Draft[] {
  const ask = text.trim().slice(0, 140);
  switch (mode) {
    case "full":
      return [
        {
          id: "brief",
          title: "Business brief, personas, user stories and MVP scope",
          owner: "project-management",
          criteria: ["brief.md has problem, users, MVP scope and user stories with acceptance criteria"],
        },
        {
          id: "options",
          title: "Explore approaches and recommend one",
          owner: "thinking",
          deps: ["brief"],
          criteria: ["options.md compares 2-3 approaches and recommends one"],
        },
        {
          id: "critique",
          title: "Challenge the recommended approach",
          owner: "reasoning",
          deps: ["options"],
          criteria: ["reviews/options-critique.md lists risks and missing requirements"],
        },
        {
          id: "design",
          title: "Design system and page specifications",
          owner: "ui-ux-design",
          deps: ["critique"],
          criteria: ["design-system.json with tokens", "one ui-specs file per page"],
        },
        {
          id: "diagrams",
          title: "Architecture, ERD and user-flow diagrams",
          owner: "diagram",
          deps: ["critique"],
          criteria: ["Mermaid files in docs/diagrams"],
        },
        {
          id: "database",
          title: "Database schema, migrations and seed data",
          owner: "database",
          deps: ["critique"],
          criteria: ["migrations apply cleanly", "schema/ section describes tables"],
        },
        {
          id: "backend",
          title: `Backend API: ${ask}`,
          owner: "backend",
          deps: ["database"],
          criteria: ["openapi.yaml matches the routes", "route tests pass"],
        },
        {
          id: "integration",
          title: "Wire the layers: typed client, config and contract tests",
          owner: "integration",
          deps: ["backend"],
          criteria: ["contract tests pass", ".env.example lists every variable"],
        },
        {
          id: "frontend",
          title: `Frontend: ${ask}`,
          owner: "frontend",
          deps: ["design", "integration"],
          criteria: ["implements the design tokens", "every screen has its states"],
        },
        {
          id: "testing",
          title: "Run the full test suite and fix failures",
          owner: "testing",
          deps: ["frontend"],
          criteria: ["the whole suite passes"],
        },
        {
          id: "security",
          title: "Security audit",
          owner: "security",
          deps: ["testing"],
          criteria: ["reviews/security.md with findings and owners"],
        },
        {
          id: "enhancement",
          title: "Performance and caching pass",
          owner: "enhancement",
          deps: ["security"],
          criteria: ["before and after figures reported", "tests still pass"],
        },
        {
          id: "diagrams-final",
          title: "ERD and API map from the real schema and routes",
          owner: "diagram",
          deps: ["integration"],
          criteria: ["the erDiagram matches the schema", "every diagram passes render_diagram"],
        },
        {
          id: "ux-audit",
          title: "UX audit",
          owner: "project-management",
          deps: ["enhancement"],
          criteria: ["record_ux_audit scores all ten heuristics"],
        },
        {
          id: "deck",
          title: "Pitch deck with real screenshots",
          owner: "project-management",
          deps: ["ux-audit", "diagrams-final"],
          criteria: ["docs/deck has deck.pptx and deck.html", "uses real screenshots"],
        },
        {
          id: "final-review",
          title: "Final review of the whole change",
          owner: "reasoning",
          deps: ["deck"],
          criteria: ["no blocking findings"],
        },
        {
          id: "docs",
          title: "README, run script and guides",
          owner: "devops-docs",
          deps: ["final-review"],
          criteria: ["one-command run script", "README matches the project"],
        },
      ];
    case "backend":
      return [
        {
          id: "database",
          title: "Data model, migrations and seed data",
          owner: "database",
          criteria: ["migrations apply cleanly"],
        },
        {
          id: "backend",
          title: `Backend: ${ask}`,
          owner: "backend",
          deps: ["database"],
          criteria: ["routes match openapi.yaml", "route tests pass"],
        },
        {
          id: "testing",
          title: "Run the full test suite and fix failures",
          owner: "testing",
          deps: ["backend"],
          criteria: ["the whole suite passes"],
        },
        {
          id: "security",
          title: "Security audit",
          owner: "security",
          deps: ["testing"],
          criteria: ["no high-severity findings left"],
        },
        {
          id: "docs",
          title: "Document the endpoints and how to run the service",
          owner: "devops-docs",
          deps: ["security"],
          criteria: ["README or docs/api.md matches the real routes", "run instructions work"],
        },
      ];
    case "frontend":
      return [
        {
          id: "design",
          title: "Design system and page specifications",
          owner: "ui-ux-design",
          criteria: ["design-system.json and ui-specs written"],
        },
        {
          id: "frontend",
          title: `Frontend: ${ask}`,
          owner: "frontend",
          deps: ["design"],
          criteria: ["implements the design tokens", "every screen has its states"],
        },
        {
          id: "testing",
          title: "Run the full test suite and fix failures",
          owner: "testing",
          deps: ["frontend"],
          criteria: ["the whole suite passes"],
        },
        {
          id: "ux-audit",
          title: "UX audit",
          owner: "project-management",
          deps: ["testing"],
          criteria: ["reviews/ux-audit.md scores the ten heuristics"],
        },
      ];
    case "ai":
      return [
        {
          id: "ai",
          title: `AI feature: ${ask}`,
          owner: "ai-integration",
          criteria: ["works with a local model", "tests mock the model"],
        },
        {
          id: "backend",
          title: "Wire the routes and services into the backend",
          owner: "backend",
          deps: ["ai"],
          criteria: ["routes covered by tests"],
        },
        {
          id: "integration",
          title: "Contracts and configuration",
          owner: "integration",
          deps: ["backend"],
          criteria: ["contract tests pass"],
        },
        {
          id: "testing",
          title: "Run the full test suite and fix failures",
          owner: "testing",
          deps: ["integration"],
          criteria: ["the whole suite passes"],
        },
        {
          id: "security",
          title: "Security audit",
          owner: "security",
          deps: ["testing"],
          criteria: ["prompt-injection and secrets reviewed"],
        },
      ];
    case "import":
      return [
        {
          id: "analysis",
          title: "Study the project: stack, conventions, structure and risks",
          owner: "reasoning",
          criteria: ["decisions.md records the stack and conventions", "a list of improvements"],
        },
        {
          id: "diagrams",
          title: "Draw the current architecture",
          owner: "diagram",
          deps: ["analysis"],
          criteria: ["architecture diagram in docs/diagrams"],
        },
        {
          id: "baseline",
          title: "Run the existing tests and record what passes today (change nothing)",
          owner: "testing",
          deps: ["analysis"],
          criteria: [
            "reviews/baseline.md lists the command, the result and any failing tests",
            "no source file was changed",
          ],
        },
        {
          id: "security",
          title: "Baseline security scan of the existing code",
          owner: "security",
          deps: ["analysis"],
          criteria: ["security_scan run", "reviews/security.md lists the existing findings with owners"],
        },
        {
          id: "docs",
          title: "Write docs/PROJECT-OVERVIEW.md: how it is built, how to run it, known problems",
          owner: "devops-docs",
          deps: ["diagrams", "baseline", "security"],
          criteria: ["the overview matches what the other steps found"],
        },
      ];
    case "fix":
      return [
        {
          id: "reproduce",
          title: `Write a failing test that reproduces: ${ask}`,
          owner: "testing",
          criteria: [
            "a new test fails for the reported reason",
            "reviews/test-report.md says how to run it and what it shows",
          ],
        },
        {
          id: "fix",
          title: `Fix the cause: ${ask}`,
          owner: builderFor(text),
          deps: ["reproduce"],
          criteria: ["the new test passes", "no other test was changed or weakened"],
        },
        {
          id: "verify",
          title: "Run the whole suite and confirm nothing else broke",
          owner: "testing",
          deps: ["fix"],
          criteria: ["the whole suite passes"],
        },
      ];
    case "refactor":
      return [
        {
          id: "baseline",
          title: "Run the tests before the change and record the result",
          owner: "testing",
          criteria: ["reviews/baseline.md records the passing tests", "no source file was changed"],
        },
        {
          id: "analysis",
          title: `Plan the change: ${ask}`,
          owner: "reasoning",
          deps: ["baseline"],
          criteria: ["decisions.md lists the steps and the risks"],
        },
        {
          id: "change",
          title: `Carry out: ${ask}`,
          owner: builderFor(text),
          deps: ["analysis"],
          criteria: ["behaviour unchanged", "small steps, each leaving the code working"],
        },
        {
          id: "testing",
          title: "Run the full test suite and compare with the baseline",
          owner: "testing",
          deps: ["change"],
          criteria: ["every test that passed before still passes", "tests were not weakened to get there"],
        },
      ];
    case "ask":
      return [
        {
          id: "answer",
          title: `Answer: ${ask}`,
          owner: "reasoning",
          criteria: ["answers with file references"],
        },
      ];
    case "business":
      return [
        {
          id: "business",
          title: `Business analysis: ${ask}`,
          owner: "project-management",
          criteria: ["docs/business-brief.md with roadmap and risks"],
        },
      ];
  }
}

const NO_REVIEW: AgentId[] = ["reasoning", "security", "manager"];
/** In "key" review mode only these owners are reviewed. */
const KEY_OWNERS: AgentId[] = ["thinking", "database", "backend", "integration", "ai-integration"];

const DraftSchema = z.object({
  summary: z.string().default(""),
  nodes: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        owner: z.string(),
        deps: z.array(z.string()).default([]),
        criteria: z.array(z.string()).default([]),
      }),
    )
    .min(1)
    .max(30),
  questions: z.array(z.string()).default([]),
});

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "step"
  );
}

/** Check the Manager's draft: known agents allowed by the mode, existing dependencies, no cycles. */
export function sanitizePlan(
  draft: z.infer<typeof DraftSchema>,
  mode: Exclude<WorkMode, "single">,
  fallback: Draft[],
): Draft[] {
  const allowed = new Set<string>(MODE_AGENTS[mode]);
  const seen = new Set<string>();
  const nodes: Draft[] = [];
  for (const n of draft.nodes) {
    const owner = n.owner.trim().toLowerCase().replace(/[ _]+/g, "-");
    if (!allowed.has(owner) || !(AGENT_IDS as readonly string[]).includes(owner)) continue;
    let id = slug(n.id || n.title);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    nodes.push({
      id,
      title: n.title.trim().slice(0, 200) || id,
      owner: owner as AgentId,
      deps: n.deps.map(slug),
      criteria: n.criteria
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 5),
    });
  }
  if (nodes.length === 0) return fallback;
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) n.deps = [...new Set((n.deps ?? []).filter((d) => ids.has(d) && d !== n.id))];
  if (hasCycle(nodes)) return fallback;
  // Anything that produces code needs the tests run at the end.
  const builds = nodes.some((n) => manifestOf(n.owner as AgentId).group === "builders");
  if (builds && !nodes.some((n) => n.owner === "testing") && allowed.has("testing")) {
    nodes.push({
      id: "testing",
      title: "Run the full test suite and fix failures",
      owner: "testing",
      deps: nodes.filter((n) => manifestOf(n.owner as AgentId).group === "builders").map((n) => n.id),
      criteria: ["the whole suite passes"],
    });
  }
  return nodes;
}

function hasCycle(nodes: Draft[]): boolean {
  const state = new Map<string, number>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const d of byId.get(id)?.deps ?? []) if (visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return nodes.some((n) => visit(n.id));
}

/** Per-agent board state, derived from the saved plan so it survives a restart. */
export function agentStatuses(plan: Plan | null, waitingAgents: Set<string> = new Set()): AgentStatus[] {
  return MANIFESTS.map((m) => {
    const mine = plan?.nodes.filter((n) => n.owner === m.id) ?? [];
    const reviewing = plan?.nodes.filter((n) => n.status === "review" && n.reviewer === m.id) ?? [];
    const doing = mine.find((n) => n.status === "doing");
    const stuck = mine.find((n) => n.status === "blocked" || n.status === "failed");
    let state: AgentStatus["state"] = "idle";
    let node: PlanNode | undefined;
    let text = "Idle";
    if (waitingAgents.has(m.id)) {
      state = "waiting";
      text = "Waiting for you";
    } else if (doing) {
      state = "working";
      node = doing;
      text = doing.title;
    } else if (reviewing[0]) {
      state = "thinking";
      node = reviewing[0];
      text = `Reviewing: ${reviewing[0].title}`;
    } else if (stuck) {
      state = "blocked";
      node = stuck;
      text = stuck.note ?? stuck.title;
    }
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      state,
      nodeId: node?.id ?? null,
      text,
      done: mine.filter((n) => n.status === "done").length,
      total: mine.length,
    };
  });
}

// ---- the runner --------------------------------------------------------------------------

export class TeamRunner {
  constructor(private readonly h: TeamHost) {}

  /** The manifest an agent works from now: the promoted Agent Lab version, or the built-in one. */
  private man(id: AgentId): AgentManifest {
    return this.h.manifest?.(id) ?? manifestOf(id);
  }

  private tag(id: AgentId): string {
    const m = this.man(id);
    return `${m.id}@${m.version}`;
  }

  async run(input: TeamInput): Promise<TeamResult> {
    const { taskId, projectId, signal } = input;
    const baseEmit =
      (agent: string): Emit =>
      (e) =>
        this.h.bus.emit({ ...e, agent, projectId, taskId });
    const mgrTag = this.tag("manager");
    const mgrEmit = baseEmit(mgrTag);
    const opts = this.h.options();

    const plan = await this.makePlan(input, mgrEmit);
    this.savePlan(taskId, projectId, plan);
    mgrEmit({
      type: "planning",
      text: `Plan ready: ${plan.nodes.length} task${plan.nodes.length === 1 ? "" : "s"} for ${plan.nodes
        .map((n) => this.man(n.owner).name)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(", ")}`,
      details: { plan: true, nodes: plan.nodes.length },
      status: "succeeded",
    });
    this.h.addMessage(taskId, { role: "assistant", content: planText(plan) }, mgrTag);

    if (opts.approvePlan && !READ_ONLY_MODES.includes(input.mode)) {
      const ok = await this.h.approvals.request(
        {
          projectId,
          taskId,
          agent: mgrTag,
          kind: "other",
          title: `Start this plan (${plan.nodes.length} tasks)?`,
          reason:
            [plan.summary, ...plan.questions.map((q) => `Question: ${q}`)].filter(Boolean).join("\n") ||
            "The Manager prepared a plan.",
          details: { plan: plan.nodes.map((n) => `${this.man(n.owner).name}: ${n.title}`).join("\n") },
        },
        signal,
      );
      if (signal.aborted) return { finalText: "", unfinished: 0, declined: false };
      if (!ok) {
        const finalText =
          "The plan was declined, so nothing was built. Tell me what to change and I will plan again.";
        return { finalText, unfinished: plan.nodes.length, declined: true };
      }
    }
    plan.approved = true;
    this.savePlan(taskId, projectId, plan);

    await this.execute(input, plan, baseEmit);
    if (signal.aborted) return { finalText: "", unfinished: 0, declined: false };

    if (opts.exportDocs && !READ_ONLY_MODES.includes(input.mode)) this.exportDocs(input);
    const finalText = this.summary(input, plan);
    this.h.blackboard.write(projectId, "plan.json", JSON.stringify(plan), mgrTag, taskId);
    const unfinished = plan.nodes.filter((n) => n.status !== "done").length;
    return { finalText, unfinished, declined: false };
  }

  // ---- planning ----------------------------------------------------------------------------

  private resolve(role: AgentManifest["role"]) {
    return this.h.models.resolve(role) ?? this.h.models.resolve("coder");
  }

  private async makePlan(input: TeamInput, emit: Emit): Promise<Plan> {
    const template = templateNodes(input.mode, input.text);
    let drafts: Draft[] = template;
    let summary = "";
    let questions: string[] = [];
    // Single-step modes need no negotiation; the template is the plan.
    if (template.length > 1) {
      const r = this.resolve("reasoning");
      if (r) {
        emit({ type: "planning", text: "Manager is planning the work", status: "started" });
        const allowed = MODE_AGENTS[input.mode].map((id) => `- ${id}: ${this.man(id).mission}`).join("\n");
        const sys = [
          this.man("manager").prompt,
          "",
          'Plan the work as a task graph. Reply with JSON only: {"summary":"one or two sentences","nodes":[{"id":"kebab-id","title":"...","owner":"agent-id","deps":["ids that must finish first"],"criteria":["short, testable"]}],"questions":["only if you truly cannot proceed without an answer"]}.',
          `Owners must be one of:\n${allowed}`,
          "Keep the standard pipeline unless the request clearly does not need a step. Prefer 4 to 15 tasks. Every task must be small enough for one agent.",
          `Standard pipeline for this mode:\n${template.map((n) => `- ${n.id} (${n.owner})${n.deps?.length ? ` after ${n.deps.join(", ")}` : ""}: ${n.title}`).join("\n")}`,
          this.h.memoryContext(input.projectId)
            ? `What you know about this project:\n${this.h.memoryContext(input.projectId)}`
            : "",
          this.h.blackboard.digest(input.projectId, 2500)
            ? `Blackboard:\n${this.h.blackboard.digest(input.projectId, 2500)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        try {
          const res = await this.callStructured(
            r.provider,
            r.model,
            r.contextLength ?? DEFAULT_CONTEXT,
            sys,
            input.text,
            DraftSchema,
            input,
          );
          drafts = sanitizePlan(res, input.mode, template);
          summary = res.summary;
          questions = res.questions.slice(0, 5);
        } catch (err) {
          if (input.signal.aborted) throw err;
          emit({
            type: "warning",
            text: "The Manager's plan could not be read, so the standard pipeline is used.",
            details: { error: err instanceof Error ? err.message : String(err) },
            status: "info",
          });
          this.h.logger.warn("manager plan failed", { err });
        }
      }
    }
    const opts = this.h.options();
    const nodes: PlanNode[] = drafts.map((d) => {
      const owner = d.owner as AgentId;
      const reviewable =
        !NO_REVIEW.includes(owner) &&
        opts.reviews !== "off" &&
        !READ_ONLY_MODES.includes(input.mode) &&
        (opts.reviews === "all" || KEY_OWNERS.includes(owner));
      return {
        id: d.id,
        title: d.title,
        owner,
        deps: d.deps ?? [],
        criteria: d.criteria ?? [],
        review: reviewable,
        status: "todo" as const,
        attempts: 0,
      };
    });
    return PlanSchema.parse({
      mode: input.mode,
      summary: summary || defaultSummary(nodes),
      nodes,
      questions,
      version: 1,
      approved: false,
    });
  }

  private async callStructured<T>(
    provider: ModelProvider,
    model: string,
    contextLength: number,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    input: TeamInput,
  ): Promise<T> {
    const run = () =>
      generateObject(provider, {
        model,
        contextLength,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        schema,
        signal: input.signal,
      });
    const r = await (this.h.scheduler
      ? this.h.scheduler.run(
          {
            projectId: input.projectId,
            taskId: input.taskId,
            label: "Manager plan",
            model,
            priority: "task",
          },
          run,
          input.signal,
        )
      : run());
    return r.value;
  }

  private savePlan(taskId: string, projectId: string, plan: Plan) {
    this.h.db
      .update(tasks)
      .set({ plan: JSON.stringify(plan), updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
    this.h.blackboard.write(
      projectId,
      "plan.json",
      JSON.stringify(plan, null, 2),
      this.tag("manager"),
      taskId,
    );
  }

  // ---- execution ---------------------------------------------------------------------------

  private async execute(input: TeamInput, plan: Plan, baseEmit: (agent: string) => Emit): Promise<void> {
    const { taskId, projectId, signal } = input;
    const parallel = Math.max(1, this.h.options().parallel);
    const running = new Map<string, Promise<void>>();
    const byId = new Map(plan.nodes.map((n) => [n.id, n]));
    const save = () => this.savePlanQuiet(taskId, plan);

    while (!signal.aborted) {
      // Nodes whose dependencies failed can never run.
      for (const n of plan.nodes) {
        if (n.status !== "todo") continue;
        const bad = n.deps
          .map((d) => byId.get(d))
          .find((d) => d && (d.status === "failed" || d.status === "blocked"));
        if (bad) {
          n.status = "blocked";
          n.note = `Waiting on "${bad.title}", which did not finish.`;
          save();
        }
      }
      const ready = plan.nodes.filter(
        (n) => n.status === "todo" && n.deps.every((d) => byId.get(d)?.status === "done"),
      );
      for (const n of ready) {
        if (running.size >= parallel) break;
        const p = this.runNode(input, plan, n, baseEmit, save).finally(() => running.delete(n.id));
        running.set(n.id, p);
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    await Promise.allSettled(running.values());
    void projectId;
  }

  private savePlanQuiet(taskId: string, plan: Plan) {
    this.h.db
      .update(tasks)
      .set({ plan: JSON.stringify(plan), updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
    // Boards refresh on this event.
    this.h.bus.emit({
      agent: this.tag("manager"),
      taskId,
      projectId: null,
      type: "planning",
      text: "Plan updated",
      details: { planUpdate: true },
      ephemeral: true,
      status: "info",
    });
  }

  private async runNode(
    input: TeamInput,
    plan: Plan,
    node: PlanNode,
    baseEmit: (agent: string) => Emit,
    save: () => void,
  ): Promise<void> {
    const { taskId, projectId, signal } = input;
    const owner = this.man(node.owner);
    const ownerTag = this.tag(owner.id);
    const mgrTag = this.tag("manager");
    const emit = baseEmit(ownerTag);
    node.status = "doing";
    node.startedAt = new Date().toISOString();
    save();
    const nodeLog = {
      component: "team",
      taskId,
      projectId,
      agent: ownerTag,
      node: node.id,
      title: node.title,
    };
    this.h.logger.info("team node started", nodeLog);
    baseEmit(mgrTag)({
      type: "handoff",
      text: `Manager → ${owner.name}: ${node.title}`,
      details: { nodeId: node.id, to: owner.id },
      status: "started",
    });
    this.h.blackboard.addMessage({
      taskId,
      from: mgrTag,
      to: ownerTag,
      type: "handoff",
      summary: node.title,
      artifacts: this.h.blackboard
        .list(projectId)
        .filter((e) => e.section !== "plan.json")
        .map((e) => e.section)
        .slice(0, 30),
      criteria: node.criteria,
      confidence: 0.9,
    });
    this.h.addMessage(taskId, { role: "assistant", content: `**${owner.name}** — ${node.title}` }, ownerTag);

    const loopLimit = Math.max(1, this.h.options().fixLoops);
    const history: ChatMessage[] = [];
    let feedback: string | null = null;
    try {
      for (let attempt = 1; ; attempt++) {
        node.attempts = attempt;
        save();
        const run = await this.agentRun(input, plan, node, owner, history, feedback, emit);
        if (signal.aborted) return;
        if (run.error) {
          node.status = "failed";
          node.note = run.error;
          break;
        }
        node.note = run.text.slice(0, 600);
        const reviewer = node.review ? this.pickReviewer(node, owner) : null;
        if (!reviewer || run.hitLimit) {
          node.status = run.hitLimit ? "failed" : "done";
          if (run.hitLimit) node.note = `${owner.name} ran out of steps before finishing.`;
          break;
        }
        node.status = "review";
        node.reviewer = reviewer.id;
        save();
        const review = await this.reviewRun(
          input,
          node,
          owner,
          reviewer,
          run,
          baseEmit(this.tag(reviewer.id)),
        );
        if (signal.aborted) return;
        const blocking = review.findings.filter((f) => f.grade === "blocking");
        if (review.verdict === "approve" || blocking.length === 0) {
          node.status = "done";
          const nice = review.findings.filter((f) => f.grade !== "blocking");
          if (nice.length)
            node.note = `${node.note ?? ""}\nReview notes: ${nice.map((f) => f.text).join("; ")}`.trim();
          break;
        }
        if (attempt >= loopLimit) {
          node.status = "failed";
          node.note =
            `Still rejected after ${attempt} attempts. Open issues: ${blocking.map((f) => f.text).join("; ")}`.slice(
              0,
              800,
            );
          this.h.blackboard.write(
            projectId,
            "decisions.md",
            `### Unresolved after ${attempt} attempts: ${node.title}\nOwner ${owner.name}, reviewer ${reviewer.name}.\n${blocking.map((f) => `- ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.text}`).join("\n")}`,
            mgrTag,
            taskId,
            "append",
          );
          this.h.blackboard.addMessage({
            taskId,
            from: ownerTag,
            to: mgrTag,
            type: "blocker",
            summary: node.note,
            artifacts: [],
            criteria: [],
            confidence: 0.3,
          });
          break;
        }
        feedback = `${reviewer.name} reviewed your work and found blocking problems. Fix them, run the checks again, then summarise what you changed:\n${blocking.map((f, i) => `${i + 1}. ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.text}`).join("\n")}`;
        node.status = "doing";
        emit({
          type: "retrying",
          text: `${reviewer.name} asked for changes (attempt ${attempt} of ${loopLimit})`,
          status: "running",
        });
      }
    } catch (err) {
      if (signal.aborted) return;
      node.status = "failed";
      node.note = err instanceof Error ? err.message : String(err);
      this.h.logger.error("team node failed", { node: node.id, err });
      emit({ type: "error", text: `${owner.name} failed: ${node.note}`, status: "failed" });
    }
    node.finishedAt = new Date().toISOString();
    save();
    this.h.logger[node.status === "done" ? "info" : "warn"]("team node finished", {
      ...nodeLog,
      status: node.status,
      attempts: node.attempts,
      reviewer: node.reviewer ?? null,
      durationMs: Date.parse(node.finishedAt) - Date.parse(node.startedAt ?? node.finishedAt),
    });
    baseEmit(ownerTag)({
      type: "handoff",
      text:
        node.status === "done"
          ? `${owner.name} finished: ${node.title}`
          : `${owner.name} could not finish: ${node.title}`,
      details: { nodeId: node.id, status: node.status },
      status: node.status === "done" ? "succeeded" : "failed",
    });
    if (node.status === "done") {
      const dependents = plan.nodes.filter((n) => n.deps.includes(node.id)).map((n) => this.tag(n.owner));
      for (const to of new Set(dependents)) {
        this.h.blackboard.addMessage({
          taskId,
          from: ownerTag,
          to,
          type: "result",
          summary: (node.note ?? node.title).slice(0, 1500),
          artifacts: this.h.blackboard
            .list(projectId)
            .filter((e) => e.owner === ownerTag)
            .map((e) => e.section)
            .slice(0, 30),
          criteria: node.criteria,
          confidence: 0.8,
        });
      }
    }
  }

  private pickReviewer(node: PlanNode, owner: AgentManifest): AgentManifest | null {
    const sensitive = /\b(auth|login|password|payment|token|session|permission|role)/i.test(
      `${node.title} ${node.criteria.join(" ")}`,
    );
    const order: AgentId[] =
      sensitive && owner.id !== "security" ? ["security", ...owner.reviewers] : owner.reviewers;
    const id = order.find((r) => r !== owner.id);
    return id ? this.man(id) : null;
  }

  // ---- one agent working -------------------------------------------------------------------

  private toolContext(
    input: TeamInput,
    manifest: AgentManifest,
    emit: Emit,
    files: Set<string>,
  ): ToolContext {
    const { taskId, projectId, ws, signal } = input;
    const tag = this.tag(manifest.id);
    const settings = this.h.projectSettings(projectId);
    const team: TeamHooks = {
      read: (s) => {
        const e = this.h.blackboard.read(projectId, cleanSection(s));
        return e ? { content: e.content, version: e.version, owner: e.owner } : null;
      },
      list: () =>
        this.h.blackboard
          .list(projectId)
          .filter((e) => e.section !== "plan.json")
          .map((e) => ({ section: e.section, owner: e.owner, version: e.version, size: e.content.length })),
      write: (section, content, mode) => {
        const name = cleanSection(section);
        if (!mayWrite(manifest, name)) {
          throw new ToolError(
            `You may not write "${name}". Your sections: ${manifest.writes.join(", ")} (and decisions.md). Send a request to the owner instead.`,
          );
        }
        const e = this.h.blackboard.write(projectId, name, content, tag, taskId, mode);
        emit({
          type: "writing_file",
          text: `Blackboard: ${name} (v${e.version})`,
          details: { section: name, version: e.version },
          status: "succeeded",
        });
        return `Saved ${name} (v${e.version}).`;
      },
      send: (m) => {
        const to = m.to.trim().toLowerCase();
        if (!(AGENT_IDS as readonly string[]).includes(to))
          throw new ToolError(`Unknown recipient "${m.to}". Use one of: ${AGENT_IDS.join(", ")}.`);
        this.h.blackboard.addMessage({
          taskId,
          from: tag,
          to: this.tag(to as AgentId),
          type: m.type,
          summary: m.summary,
          artifacts: m.artifacts ?? [],
          criteria: m.criteria ?? [],
          confidence: m.confidence ?? 0.7,
        });
        emit({
          type: "handoff",
          text: `${manifest.name} → ${this.man(to as AgentId).name}: ${m.type}: ${m.summary.slice(0, 120)}`,
          status: "info",
        });
        return "Message sent.";
      },
    };
    const knowledge = this.h.knowledge(projectId);
    const extras = this.h.extras?.(manifest.id, projectId, { taskId, signal });
    return {
      root: ws.root,
      bus: this.h.bus,
      approvals: this.h.approvals,
      projectId,
      taskId,
      agent: tag,
      signal,
      env: venvEnv(ws.root),
      ...(settings ? { commandRules: { allow: settings.commandAllow, deny: settings.commandDeny } } : {}),
      ...(knowledge ? { knowledge } : {}),
      ...(extras?.tools ? { extraTools: extras.tools } : {}),
      readPaths: new Set<string>(),
      onFileChanged: (f) => files.add(f),
      team,
      vision: (prompt, images) => this.askVision(input, prompt, images),
    };
  }

  private async askVision(input: TeamInput, prompt: string, images: string[]): Promise<string | null> {
    const v = this.h.models.resolve("vision");
    if (!v) return null;
    const run = () =>
      collectChat(
        v.provider.chat({
          model: v.model,
          messages: [{ role: "user", content: prompt, images }],
          signal: input.signal,
          contextLength: v.contextLength ?? DEFAULT_CONTEXT,
        }),
      );
    const res = await (this.h.scheduler
      ? this.h.scheduler.run(
          {
            projectId: input.projectId,
            taskId: input.taskId,
            label: "Vision review",
            model: v.model,
            priority: "task",
          },
          run,
          input.signal,
        )
      : run());
    return res.text;
  }

  private systemPrompt(input: TeamInput, manifest: AgentManifest, extra: string): string {
    const info = detectProject(input.ws.root);
    const win = process.platform === "win32";
    return [
      manifest.prompt,
      "",
      `Project: ${input.projectName} (${info.kind}). Top level: ${topLevelListing(input.ws.root) || "(empty)"}`,
      `Shell: commands run with ${win ? "cmd.exe on Windows (use Windows syntax; `&&` works)" : "/bin/sh"} in the project root. There is no interactive input.`,
      ...(info.testCommand ? [`Run the tests with: ${info.testCommand}`] : []),
      ...info.notes,
      this.h.memoryContext(input.projectId)
        ? `# What you know about this project\n${this.h.memoryContext(input.projectId)}`
        : "",
      this.h.repoMap(input.projectId) ? `# Repo map\n${this.h.repoMap(input.projectId)}` : "",
      extra,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async agentRun(
    input: TeamInput,
    plan: Plan,
    node: PlanNode,
    manifest: AgentManifest,
    history: ChatMessage[],
    feedback: string | null,
    emit: Emit,
  ): Promise<{ text: string; error?: string; hitLimit: boolean; changed: string[] }> {
    const r = this.resolve(manifest.role);
    if (!r) {
      return {
        text: "",
        error: "No model is set up for this agent. Open the Models tab.",
        hitLimit: false,
        changed: [],
      };
    }
    const tag = this.tag(manifest.id);
    const files = new Set<string>();
    const ctx = this.toolContext(input, manifest, emit, files);
    const extras = this.h.extras?.(manifest.id, input.projectId, {
      taskId: input.taskId,
      signal: input.signal,
    });
    const toolNames = [...manifest.tools, ...(extras?.allow ?? [])];
    if (history.length === 0) {
      const deps = node.deps
        .map((d) => plan.nodes.find((n) => n.id === d))
        .filter((n): n is PlanNode => !!n)
        .map((n) => `- ${this.man(n.owner).name} finished "${n.title}": ${(n.note ?? "").slice(0, 400)}`);
      const inbox = this.h.blackboard
        .messages(input.taskId)
        .filter((m) => m.to === tag && m.type !== "handoff" && m.from !== this.tag("manager"))
        .slice(-6)
        .map((m) => `- ${m.from} (${m.type}): ${m.summary.slice(0, 300)}`);
      const digest = this.h.blackboard.digest(input.projectId, DIGEST_BUDGET);
      history.push({
        role: "system",
        content: this.systemPrompt(input, manifest, extras?.prompt ?? ""),
      });
      history.push({
        role: "user",
        content: [
          `The user's request: ${input.text}`,
          "",
          `Your task: ${node.title}`,
          node.criteria.length
            ? `Acceptance criteria:\n${node.criteria.map((c) => `- ${c}`).join("\n")}`
            : "",
          deps.length ? `Finished before you:\n${deps.join("\n")}` : "",
          inbox.length ? `Messages for you:\n${inbox.join("\n")}` : "",
          digest
            ? `Blackboard (shared notes; use bb_read for full text):\n${digest}`
            : "The blackboard is empty so far.",
          `Your blackboard sections: ${manifest.writes.join(", ")}.`,
        ]
          .filter(Boolean)
          .join("\n"),
      });
    } else if (feedback) {
      history.push({ role: "user", content: feedback });
    }
    const maxSteps = this.h.maxSteps ?? manifest.maxSteps;
    const result = await runAgentLoop({
      provider: r.provider,
      model: r.model,
      contextLength: r.contextLength ?? DEFAULT_CONTEXT,
      history,
      toolNames,
      ctx,
      maxSteps,
      signal: input.signal,
      scheduler: this.h.scheduler,
      job: { projectId: input.projectId, taskId: input.taskId, label: `${manifest.name}: ${node.title}` },
      retryDelayMs: this.h.retryDelayMs,
      emit,
      persist: (m) => this.h.addMessage(input.taskId, m, tag),
      lessons: this.h.lessons(input.projectId),
    });
    if (!result.finalText && !result.aborted && !result.hitLimit) {
      return {
        text: "",
        error: `${manifest.name} stopped without a result.`,
        hitLimit: false,
        changed: result.changed,
      };
    }
    return { text: result.finalText || "(no summary)", hitLimit: result.hitLimit, changed: result.changed };
  }

  // ---- the second key: review --------------------------------------------------------------

  private async reviewRun(
    input: TeamInput,
    node: PlanNode,
    owner: AgentManifest,
    reviewer: AgentManifest,
    run: { text: string; changed: string[] },
    emit: Emit,
  ): Promise<Review> {
    const tag = this.tag(reviewer.id);
    emit({
      type: "reviewing",
      text: `${reviewer.name} is reviewing ${owner.name}'s work: ${node.title}`,
      status: "started",
    });
    const r = this.resolve(reviewer.role);
    let review: Review = { verdict: "approve", findings: [], confidence: 0 };
    if (r) {
      const files = new Set<string>();
      const readOnly: AgentManifest = {
        ...reviewer,
        tools: reviewer.tools.filter((t) => !["write_file", "edit_file", "delete_file"].includes(t)),
      };
      const ctx = this.toolContext(input, readOnly, emit, files);
      const history: ChatMessage[] = [
        { role: "system", content: this.systemPrompt(input, readOnly, "") },
        {
          role: "user",
          content: [
            `Review the work of the ${owner.name} agent.`,
            `Task: ${node.title}`,
            node.criteria.length
              ? `Acceptance criteria:\n${node.criteria.map((c) => `- ${c}`).join("\n")}`
              : "",
            run.changed.length
              ? `Files they changed:\n${run.changed.map((c) => `- ${c}`).join("\n")}`
              : "They changed no project files.",
            `Their summary: ${run.text.slice(0, 1500)}`,
            "Read the changed files (and run the tests if that helps), then reply with the review JSON only.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ];
      try {
        const loop = await runAgentLoop({
          provider: r.provider,
          model: r.model,
          contextLength: r.contextLength ?? DEFAULT_CONTEXT,
          history,
          toolNames: readOnly.tools,
          ctx,
          maxSteps: Math.min(this.h.maxSteps ?? 12, 12),
          signal: input.signal,
          scheduler: this.h.scheduler,
          job: {
            projectId: input.projectId,
            taskId: input.taskId,
            label: `${reviewer.name} review: ${node.title}`,
          },
          retryDelayMs: this.h.retryDelayMs,
          emit,
          persist: (m) => this.h.addMessage(input.taskId, m, tag),
        });
        review = await this.parseReview(loop.finalText, r, input);
      } catch (err) {
        if (input.signal.aborted) return review;
        this.h.logger.warn("review failed", { err });
        review = {
          verdict: "approve",
          findings: [{ grade: "nice_to_have", text: "The review could not be completed." }],
          confidence: 0,
        };
      }
    }
    const body = [
      `# Review of "${node.title}" by ${reviewer.name}`,
      `Verdict: ${review.verdict} (confidence ${review.confidence})`,
      ...review.findings.map((f) => `- [${f.grade}] ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.text}`),
    ].join("\n");
    this.h.blackboard.write(input.projectId, `reviews/${node.id}.md`, body, tag, input.taskId, "append");
    this.h.blackboard.addMessage({
      taskId: input.taskId,
      from: tag,
      to: this.tag(owner.id),
      type: "review",
      summary: `${review.verdict}: ${review.findings.length} finding(s), ${review.findings.filter((f) => f.grade === "blocking").length} blocking`,
      artifacts: [`reviews/${node.id}.md`],
      criteria: [],
      confidence: review.confidence,
    });
    this.h.addMessage(
      input.taskId,
      {
        role: "assistant",
        content: `**${reviewer.name}** reviewed ${owner.name}: ${review.verdict === "approve" ? "approved" : "changes needed"}${review.findings.length ? ` (${review.findings.length} finding${review.findings.length === 1 ? "" : "s"})` : ""}`,
      },
      tag,
    );
    emit({
      type: "reviewing",
      text: `${reviewer.name}: ${review.verdict === "approve" ? "approved" : "changes needed"} (${review.findings.filter((f) => f.grade === "blocking").length} blocking)`,
      details: { nodeId: node.id, verdict: review.verdict },
      status: review.verdict === "approve" ? "succeeded" : "failed",
    });
    return review;
  }

  private async parseReview(
    text: string,
    r: NonNullable<ReturnType<TeamRunner["resolve"]>>,
    input: TeamInput,
  ): Promise<Review> {
    const tryParse = (t: string): Review | null => {
      try {
        const raw = JSON.parse(extractJson(t)) as {
          verdict?: unknown;
          findings?: unknown;
          confidence?: unknown;
        };
        const findings = Array.isArray(raw.findings)
          ? raw.findings.map((f: Record<string, unknown>) => ({
              grade: normalizeGrade(String(f.grade ?? f.severity ?? "")),
              ...(typeof f.file === "string" && f.file ? { file: f.file } : {}),
              ...(typeof f.line === "number" ? { line: Math.trunc(f.line) } : {}),
              text: String(f.text ?? f.message ?? f.issue ?? "").slice(0, 600) || "(no detail)",
            }))
          : [];
        const verdict =
          raw.verdict === "changes" || raw.verdict === "approve"
            ? raw.verdict
            : findings.some((f) => f.grade === "blocking")
              ? "changes"
              : "approve";
        const parsed = ReviewSchema.safeParse({
          verdict,
          findings,
          confidence: typeof raw.confidence === "number" ? Math.min(1, Math.max(0, raw.confidence)) : 0.6,
        });
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    };
    const direct = tryParse(text);
    if (direct) return direct;
    // Ask once more for just the JSON.
    try {
      const out = await this.callStructured(
        r.provider,
        r.model,
        r.contextLength ?? DEFAULT_CONTEXT,
        "Convert this review into the required JSON. If it contains no clear problems, use verdict approve with no findings.",
        text || "(empty review)",
        ReviewSchema,
        input,
      );
      return out;
    } catch {
      return {
        verdict: "approve",
        findings: [{ grade: "nice_to_have", text: "The reviewer's answer could not be read." }],
        confidence: 0,
      };
    }
  }

  // ---- hand-over ---------------------------------------------------------------------------

  /** Notes worth keeping go into the project as Markdown, so the user can review and keep them. */
  private exportDocs(input: TeamInput) {
    const keep = [
      "brief.md",
      "options.md",
      "decisions.md",
      "reviews/security.md",
      "reviews/ux-audit.md",
      "reviews/performance.md",
      "reviews/test-report.md",
    ];
    for (const s of keep) {
      const e = this.h.blackboard.read(input.projectId, s);
      if (!e) continue;
      const dest = path.join(input.ws.root, "docs", "depo", s);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, `${e.content.trimEnd()}\n`);
    }
  }

  private summary(input: TeamInput, plan: Plan): string {
    const done = plan.nodes.filter((n) => n.status === "done");
    const bad = plan.nodes.filter((n) => n.status === "failed" || n.status === "blocked");
    const open = this.h.blackboard
      .messages(input.taskId)
      .filter((m) => m.type === "blocker" || m.type === "question")
      .map((m) => `- ${m.from}: ${m.summary.slice(0, 200)}`);
    const lines = [
      bad.length === 0
        ? `The team finished all ${plan.nodes.length} task${plan.nodes.length === 1 ? "" : "s"}.`
        : `The team finished ${done.length} of ${plan.nodes.length} tasks. ${bad.length} did not finish, so check the changes carefully before you approve them.`,
      "",
      ...plan.nodes.map(
        (n) =>
          `- ${statusMark(n.status)} **${this.man(n.owner).name}**: ${n.title}${n.status === "done" ? "" : ` — ${n.note ?? n.status}`}`,
      ),
    ];
    if (bad.length) {
      lines.push(
        "",
        "What was tried is in the activity feed and in the blackboard (reviews/ and decisions.md). Options: send a follow-up message with more detail, change the request, or approve only the parts that look right.",
      );
    }
    const scores = this.scoreLines(input.projectId);
    if (scores.length) lines.push("", "Quality scores:", ...scores);
    if (open.length) lines.push("", "Open items:", ...open);
    return lines.join("\n");
  }

  /** The security and UX scores from the blackboard, with a clear line when one blocks the release. */
  private scoreLines(projectId: string): string[] {
    const out: string[] = [];
    for (const [section, label] of [
      ["scores/security.json", "Security"],
      ["scores/ux.json", "UX"],
    ] as const) {
      const e = this.h.blackboard.read(projectId, section);
      if (!e) continue;
      try {
        const j = JSON.parse(e.content) as { overall?: number; grade?: string; blocksRelease?: boolean };
        if (typeof j.overall !== "number") continue;
        out.push(
          `- ${label}: ${j.overall}/100 (${j.grade ?? "?"})${j.blocksRelease ? " **blocks the release**: fix it before you ship" : ""}`,
        );
      } catch {
        // A damaged score file is ignored; the blackboard note explains the audit.
      }
    }
    return out;
  }
}

function statusMark(s: PlanNode["status"]): string {
  return s === "done" ? "✓" : s === "failed" ? "✗" : s === "blocked" ? "⏸" : "…";
}

function normalizeGrade(g: string): "blocking" | "should_fix" | "nice_to_have" {
  const s = g.toLowerCase();
  if (/block|critical|high|severe|error|major/.test(s)) return "blocking";
  if (/should|medium|warn|moderate/.test(s)) return "should_fix";
  return "nice_to_have";
}

function defaultSummary(nodes: PlanNode[]): string {
  return `${nodes.length} task${nodes.length === 1 ? "" : "s"}: ${nodes
    .map((n) => manifestOf(n.owner).name)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ")}.`;
}

function planText(plan: Plan): string {
  return [
    `**Plan** — ${plan.summary}`,
    ...plan.nodes.map(
      (n, i) =>
        `${i + 1}. **${manifestOf(n.owner).name}**: ${n.title}${n.deps.length ? ` _(after ${n.deps.join(", ")})_` : ""}`,
    ),
  ].join("\n");
}
