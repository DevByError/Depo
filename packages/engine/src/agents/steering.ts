import { AGENT_IDS, type AgentId, type Plan, type PlanNode, type WorkMode } from "@depo/shared";
import { z } from "zod";
import { MODE_AGENTS, manifestOf } from "./manifests";

/**
 * The Manager's side of steering: when the owner sends a note during a team run, the Manager may
 * add tasks for it or drop tasks it makes unnecessary. Only tasks that have not started can be
 * dropped, and new tasks can only depend on tasks that exist, so the graph stays acyclic.
 */

const MAX_ADD = 6;

export const NoteChangeSchema = z.object({
  change: z.enum(["none", "update"]).catch("none").default("none"),
  /** One plain sentence for the owner. */
  reason: z.string().default(""),
  add: z
    .array(
      z.object({
        id: z.string().default(""),
        title: z.string(),
        owner: z.string(),
        deps: z.array(z.string()).default([]),
        criteria: z.array(z.string()).default([]),
      }),
    )
    .max(MAX_ADD)
    .default([]),
  drop: z.array(z.string()).max(20).default([]),
});
export type NoteChange = z.infer<typeof NoteChangeSchema>;

/** The Manager's instructions for a note (kept short: it runs next to the agents at work). */
export function noteSystemPrompt(managerPrompt: string, mode: Exclude<WorkMode, "single">): string {
  const owners = MODE_AGENTS[mode].map((id) => `${id} (${manifestOf(id).name})`).join(", ");
  return [
    managerPrompt,
    "",
    "The owner sent a note while the team works. The agents at work read it at their next step. Decide if the plan must change because of it.",
    'Reply with JSON only: {"change":"none"|"update","reason":"one plain sentence for the owner","add":[{"id":"kebab-id","title":"...","owner":"agent-id","deps":["existing ids"],"criteria":["short, testable"]}],"drop":["ids of todo tasks the note makes unnecessary"]}.',
    'Use "none" when the agents at work can simply follow the note. Add a task only for new work the plan does not cover. Never drop a task that is doing, in review or done.',
    `Owners must be one of: ${owners}.`,
  ].join("\n");
}

/** The plan as one line per task, then the note. */
export function noteUserPrompt(plan: Plan, note: string): string {
  const lines = plan.nodes.map(
    (n) =>
      `- ${n.id} [${n.status}] ${n.owner}: ${n.title}${n.deps.length ? ` (after ${n.deps.join(", ")})` : ""}`,
  );
  return `Plan:\n${lines.join("\n")}\n\nThe owner's note: ${note}`;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "step"
  );
}

/**
 * Apply the Manager's change to the plan in place. Returns what was added and dropped (both empty
 * when the change is "none" or nothing in it was valid).
 */
export function applyNoteChange(
  plan: Plan,
  change: NoteChange,
  mode: Exclude<WorkMode, "single">,
  reviewable: (owner: AgentId) => boolean,
): { added: PlanNode[]; dropped: PlanNode[] } {
  const none = { added: [], dropped: [] };
  if (change.change !== "update") return none;
  const allowed = new Set<string>(MODE_AGENTS[mode]);

  // Drop: only tasks that have not started; whoever waited on them waits on their dependencies.
  const dropIds = new Set(
    change.drop.map(slug).filter((id) => plan.nodes.some((n) => n.id === id && n.status === "todo")),
  );
  if (dropIds.size >= plan.nodes.length) dropIds.clear();
  const dropped = plan.nodes.filter((n) => dropIds.has(n.id));
  if (dropped.length) {
    const byId = new Map(plan.nodes.map((n) => [n.id, n]));
    const resolveDeps = (ids: string[], seen = new Set<string>()): string[] =>
      ids.flatMap((d) => {
        if (seen.has(d)) return [];
        seen.add(d);
        return dropIds.has(d) ? resolveDeps(byId.get(d)?.deps ?? [], seen) : [d];
      });
    plan.nodes = plan.nodes.filter((n) => !dropIds.has(n.id));
    for (const n of plan.nodes) n.deps = [...new Set(resolveDeps(n.deps))];
  }

  // Add: known owners for this mode, fresh ids, dependencies on tasks that exist (or were just added).
  const added: PlanNode[] = [];
  for (const a of change.add) {
    if (plan.nodes.length >= 40) break;
    const owner = a.owner.trim().toLowerCase().replace(/[ _]+/g, "-");
    if (!allowed.has(owner) || !(AGENT_IDS as readonly string[]).includes(owner)) continue;
    const title = a.title.trim().slice(0, 200);
    if (!title) continue;
    let id = slug(a.id || title);
    while (plan.nodes.some((n) => n.id === id)) id = `${id.slice(0, 38)}-2`;
    const ids = new Set(plan.nodes.map((n) => n.id));
    const node: PlanNode = {
      id,
      title,
      owner: owner as AgentId,
      deps: [...new Set(a.deps.map(slug).filter((d) => ids.has(d)))],
      criteria: a.criteria
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 5),
      review: reviewable(owner as AgentId),
      status: "todo",
      attempts: 0,
    };
    plan.nodes.push(node);
    added.push(node);
    // New code is tested by the testing task that has not run yet (unless that would make a loop).
    if (manifestOf(node.owner).group === "builders") {
      for (const t of plan.nodes)
        if (
          t.owner === "testing" &&
          t.status === "todo" &&
          t.id !== node.id &&
          !t.deps.includes(node.id) &&
          !dependsOn(plan, node.id, t.id)
        )
          t.deps.push(node.id);
    }
  }
  if (added.length || dropped.length) plan.version += 1;
  return { added, dropped };
}

/** Does `from` wait on `target`, directly or through other tasks? */
function dependsOn(plan: Plan, from: string, target: string): boolean {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [...(byId.get(from)?.deps ?? [])];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.deps ?? []));
  }
  return false;
}
