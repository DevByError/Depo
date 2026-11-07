import type { Plan, PlanNode, PlanNodeStatus } from "@depo/shared";
import { Clock } from "lucide-react";
import { memo } from "react";
import { cn } from "@/lib/cn";
import { type NodeEtaView, nodeEtaText } from "@/lib/team-eta";
import { agentName, reviewState } from "@/lib/team-view";
import { AgentAvatar } from "./AgentAvatar";

export const BOARD_COLUMNS: { id: string; label: string; statuses: PlanNodeStatus[]; dot: string }[] = [
  { id: "todo", label: "To do", statuses: ["todo"], dot: "bg-border-strong" },
  { id: "doing", label: "In progress", statuses: ["doing"], dot: "bg-accent" },
  { id: "review", label: "In review", statuses: ["review"], dot: "bg-info" },
  { id: "done", label: "Done", statuses: ["done"], dot: "bg-success" },
  { id: "stuck", label: "Blocked", statuses: ["blocked", "failed"], dot: "bg-danger" },
];

/**
 * The plan as a board: one column per status, one card per task with its owner, attempts, review
 * state and time left. The Team tab (Board mode) and the Plan tab show the same board.
 */
export const BoardView = memo(function BoardView({
  plan,
  etas,
  highlight = null,
}: {
  plan: Plan;
  etas: Map<string, NodeEtaView> | null;
  highlight?: string | null;
}) {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  return (
    <section
      tabIndex={0}
      aria-label="Board. Scroll sideways to see every column."
      className="min-h-0 overflow-x-auto"
    >
      <div className="grid min-w-[52rem] grid-cols-5 gap-3">
        {BOARD_COLUMNS.map((col) => {
          const nodes = plan.nodes.filter((n) => col.statuses.includes(n.status));
          return (
            <section key={col.id} aria-label={col.label} className="flex min-w-0 flex-col">
              <h3 className="mb-2 flex items-center gap-1.5 px-0.5 text-[11px] font-semibold text-muted">
                <span aria-hidden className={cn("size-1.5 rounded-full", col.dot)} />
                {col.label}
                <span className="ml-auto rounded-full bg-raised px-1.5 tabular-nums text-subtle">
                  {nodes.length}
                </span>
              </h3>
              <ul className="flex min-h-16 flex-col gap-2 rounded-xl bg-raised/50 p-1.5">
                {nodes.length === 0 && (
                  <li className="px-1.5 py-3 text-center text-[11px] text-subtle">Nothing here</li>
                )}
                {nodes.map((n) => (
                  <BoardCard
                    key={n.id}
                    node={n}
                    eta={etas?.get(n.id) ?? null}
                    highlighted={highlight === n.id}
                    after={n.deps.map((d) => byId.get(d)?.title ?? d)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
});

function BoardCard({
  node,
  eta,
  highlighted,
  after,
}: {
  node: PlanNode;
  eta: NodeEtaView | null;
  highlighted: boolean;
  after: string[];
}) {
  const owner = agentName(node.owner);
  const review = reviewState(node, agentName);
  const stuck = node.status === "failed" || node.status === "blocked";
  const showEta = eta && (node.status === "todo" || node.status === "doing" || node.status === "review");
  return (
    <li
      data-node={node.id}
      data-status={node.status}
      className={cn(
        "rounded-lg border bg-panel p-2.5 text-xs transition-[border-color,box-shadow] duration-300",
        node.status === "doing" && "border-accent shadow-pop",
        node.status === "review" && "border-info/70",
        stuck ? "border-danger/50" : node.status !== "doing" && node.status !== "review" && "border-border",
        highlighted && "ring-2 ring-accent ring-offset-2 ring-offset-bg",
      )}
    >
      <div className="flex items-center gap-1.5">
        <AgentAvatar id={node.owner} name={owner} size="xs" busy={node.status === "doing"} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{owner}</span>
        {node.attempts > 1 && (
          <span className="shrink-0 rounded bg-warning/12 px-1 text-[10px] font-medium tabular-nums text-warning">
            Try {node.attempts}
          </span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-2 font-medium leading-snug text-fg">{node.title}</p>
      {(review || showEta) && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-subtle">
          {review && <span className="min-w-0">{review}</span>}
          {showEta && eta && (
            <span
              className={cn(
                "ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums",
                eta.over && "text-warning",
              )}
              title={eta.basis === "guess" ? "First guess on this PC" : "Estimated on this PC"}
            >
              <Clock className="size-3" aria-hidden />
              {nodeEtaText(eta)}
            </span>
          )}
        </p>
      )}
      {after.length > 0 && <p className="mt-1 truncate text-[11px] text-subtle">After {after.join(", ")}</p>}
      {stuck && node.note && <p className="mt-1.5 line-clamp-2 text-[11px] text-danger">{node.note}</p>}
    </li>
  );
}
