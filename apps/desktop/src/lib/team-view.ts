import {
  type AgentState,
  type ApiResult,
  DecisionDetailsSchema,
  type DepoEvent,
  type PlanNode,
  type TaskStatus,
  type TeamAgentStat,
  type TeamDecision,
} from "@depo/shared";
import type { Tone } from "./event-style";

/**
 * Pure helpers for the Team screen and the Agent board: they merge the `team.timeline` snapshot
 * with the live event stream, so the view updates the moment an agent acts or decides.
 */

export type TimelineResult = ApiResult<"team.timeline">;

export interface LiveAgent extends TeamAgentStat {
  /** Event type of the current action, for its icon. */
  actionType: string | null;
  /** The line the model is writing right now, while the agent thinks. */
  thought: string | null;
}

export interface LiveTeam extends Omit<TimelineResult, "agents"> {
  agents: LiveAgent[];
}

export const ACTIVE_TASK: TaskStatus[] = ["queued", "running", "waiting"];

/** `backend@1.0.0` -> `backend`. */
export function agentIdOf(tag: string): string {
  return tag.split("@")[0] ?? tag;
}

export function isBusy(state: AgentState): boolean {
  return state === "working" || state === "thinking";
}

/** A live `decision` event as a timeline entry. */
export function decisionFromEvent(e: DepoEvent): TeamDecision | null {
  if (e.type !== "decision") return null;
  const d = DecisionDetailsSchema.safeParse(e.details);
  if (!d.success) return null;
  return {
    id: e.id,
    ts: e.ts,
    agent: agentIdOf(e.agent),
    tag: e.agent,
    kind: d.data.kind,
    text: e.text,
    outcome: d.data.outcome ?? null,
    reason: d.data.reason ?? null,
    nodeId: d.data.nodeId ?? null,
    items: d.data.items ?? [],
  };
}

/** Snapshot plus live decisions, without duplicates, oldest first. */
export function mergeDecisions(base: TeamDecision[], live: TeamDecision[]): TeamDecision[] {
  const seen = new Set(base.map((d) => d.id));
  const extra = live.filter((d) => !seen.has(d.id));
  if (extra.length === 0) return base;
  // Event ids sort by time, so they break ties between decisions made in the same millisecond.
  return [...base, ...extra].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
}

/** The id of the newest event that changes the team picture (a refetch follows it). */
export function refreshKey(taskEvents: DepoEvent[]): string | null {
  for (let i = taskEvents.length - 1; i >= 0; i--) {
    const e = taskEvents[i];
    if (!e) continue;
    if (e.details?.planUpdate === true) return e.id;
    if (e.ephemeral) continue;
    if (["handoff", "decision", "reviewing", "retrying", "waiting_for_user", "error"].includes(e.type))
      return e.id;
  }
  return null;
}

/**
 * Merge the snapshot with what happened since: newer actions, newer decisions, "thinking" while
 * the model writes, and time spent counted up to `now` for agents at work.
 */
export function liveTeam(
  t: TimelineResult,
  taskEvents: DepoEvent[],
  fetchedAt: number,
  now: number,
): LiveTeam {
  const decisions = mergeDecisions(
    t.decisions,
    taskEvents.map(decisionFromEvent).filter((d): d is TeamDecision => d !== null),
  );
  const active = ACTIVE_TASK.includes(t.status);
  const lastAny = new Map<string, DepoEvent>();
  const lastAction = new Map<string, DepoEvent>();
  for (let i = taskEvents.length - 1; i >= 0; i--) {
    const e = taskEvents[i];
    if (!e) continue;
    const id = agentIdOf(e.agent);
    if (!lastAny.has(id)) lastAny.set(id, e);
    if (!lastAction.has(id) && !e.ephemeral && e.type !== "decision") lastAction.set(id, e);
  }
  const lastDecision = new Map<string, TeamDecision>();
  for (const d of decisions) lastDecision.set(d.agent, d);

  const agents = t.agents.map((a): LiveAgent => {
    const recent = lastAction.get(a.id);
    const newer = recent && (!a.actionAt || recent.ts >= a.actionAt);
    const any = lastAny.get(a.id);
    let state = a.state;
    const writing = any && (any.type === "thinking" || (any.ephemeral && any.type === "planning"));
    if (active && state === "working" && writing) state = "thinking";
    return {
      ...a,
      state,
      action: newer ? recent.text : a.action,
      actionAt: newer ? recent.ts : a.actionAt,
      actionType: newer ? recent.type : null,
      thought: active && isBusy(state) && any?.ephemeral && any.type === "thinking" ? any.text || null : null,
      lastDecision: lastDecision.get(a.id) ?? a.lastDecision,
      workMs: a.workMs + (active && isBusy(a.state) ? Math.max(0, now - fetchedAt) : 0),
    };
  });
  return { ...t, agents, decisions };
}

/** Colour of a decision: good news, a warning, a stop, or neutral information. */
export function decisionTone(d: Pick<TeamDecision, "kind" | "outcome">): Tone {
  switch (d.kind) {
    case "review":
      return d.outcome === "changes" ? "warning" : "success";
    case "send_back":
      return "warning";
    case "escalate":
      return "danger";
    case "release":
      return d.outcome === "ready" ? "success" : d.outcome === "blocked" ? "danger" : "warning";
    case "plan_approval":
      return d.outcome === "declined" ? "neutral" : "success";
    case "result":
      return d.outcome === "incomplete" ? "warning" : "info";
    default:
      return "accent";
  }
}

/** A short label for the kind of decision. */
export function decisionLabel(d: Pick<TeamDecision, "kind" | "outcome">): string {
  switch (d.kind) {
    case "plan":
      return d.outcome === "standard" ? "Standard plan" : "Plan";
    case "plan_approval":
      return d.outcome === "declined" ? "Plan declined" : "Plan approved";
    case "send_back":
      return "Sent back";
    case "escalate":
      return "Needs you";
    case "release":
      return d.outcome === "ready" ? "Ready" : d.outcome === "blocked" ? "Release blocked" : "Unfinished";
    case "review":
      return d.outcome === "changes" ? "Changes asked" : "Approved";
    case "result":
      return "Handoff";
    case "adr":
      return "Architecture";
    case "recommendation":
      return "Recommends";
  }
}

/** What the plan says about a node's review, in a few words. */
export function reviewState(node: PlanNode, names: (id: string) => string): string | null {
  if (!node.review) return null;
  const who = node.reviewer ? names(node.reviewer) : null;
  if (node.status === "review") return who ? `${who} reviewing` : "In review";
  if (node.status === "done") return who ? `Approved by ${who}` : "Approved";
  if (node.attempts > 1 && node.status === "doing") return who ? `Changes asked by ${who}` : "Changes asked";
  if (node.status === "failed" && who) return `Rejected by ${who}`;
  return "Needs review";
}

/** Counts for the header: tasks done, agents at work, reviews approved and sent back. */
export function teamTotals(t: LiveTeam) {
  const nodes = t.plan?.nodes ?? [];
  const reviews = t.decisions.filter((d) => d.kind === "review");
  return {
    done: nodes.filter((n) => n.status === "done").length,
    total: nodes.length,
    stuck: nodes.filter((n) => n.status === "failed" || n.status === "blocked").length,
    busy: t.agents.filter((a) => isBusy(a.state)).length,
    agents: t.agents.length,
    approved: reviews.filter((d) => d.outcome !== "changes").length,
    changes: reviews.filter((d) => d.outcome === "changes").length,
    decisions: t.decisions.length,
  };
}

/** Is a scroll box at (or within `slack` pixels of) its bottom? */
export function atBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 24) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

export const MODE_LABEL: Record<string, string> = {
  single: "Single agent",
  full: "Full system",
  backend: "Backend only",
  frontend: "Frontend only",
  ai: "AI integration",
  import: "Study project",
  fix: "Fix / debug",
  refactor: "Refactor / upgrade",
  ask: "Ask / explain",
  business: "Business",
};

export const TASK_STATUS_TEXT: Record<TaskStatus, string> = {
  queued: "Starting",
  running: "Working",
  waiting: "Needs you",
  review: "Ready for review",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

/** Display names of the fifteen agents (the engine sends them too; this covers decisions alone). */
export const AGENT_NAMES: Record<string, string> = {
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
  "devops-docs": "DevOps and Docs",
  user: "You",
};

export function agentName(id: string): string {
  return AGENT_NAMES[id] ?? id;
}

/** The roster in lib/agents.ts uses short ids for three agents. */
const ROSTER_IDS: Record<string, string> = {
  pm: "project-management",
  design: "ui-ux-design",
  devops: "devops-docs",
};

export function engineAgentId(rosterId: string): string {
  return ROSTER_IDS[rosterId] ?? rosterId;
}
