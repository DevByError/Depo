import type { Plan, PlanNode, PlanNodeStatus } from "@depo/shared";
import {
  Circle,
  CircleCheck,
  CirclePause,
  CircleX,
  Crosshair,
  Eye,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { DAG_DEFAULTS, layoutDag } from "@/lib/dag-layout";
import { type NodeEtaView, nodeEtaText } from "@/lib/team-eta";
import { agentName, reviewState } from "@/lib/team-view";
import { AgentAvatar } from "./AgentAvatar";

const STATUS: Record<
  PlanNodeStatus,
  { label: string; icon: LucideIcon; text: string; card: string; spin?: boolean }
> = {
  todo: { label: "To do", icon: Circle, text: "text-subtle", card: "border-dashed border-border-strong" },
  doing: {
    label: "In progress",
    icon: LoaderCircle,
    text: "text-accent",
    card: "border-accent shadow-pop ring-1 ring-accent/25",
    spin: true,
  },
  review: { label: "In review", icon: Eye, text: "text-info", card: "border-info/70 shadow-pop" },
  done: { label: "Done", icon: CircleCheck, text: "text-success", card: "border-border" },
  blocked: {
    label: "Blocked",
    icon: CirclePause,
    text: "text-warning",
    card: "border-dashed border-warning/70",
  },
  failed: { label: "Not finished", icon: CircleX, text: "text-danger", card: "border-danger/70" },
};

export const STATUS_ORDER: PlanNodeStatus[] = ["todo", "doing", "review", "done", "blocked", "failed"];

const W = DAG_DEFAULTS.nodeWidth;
const H = DAG_DEFAULTS.nodeHeight;

/**
 * The task graph as a left-to-right DAG: one card per task (owner, title, status, attempts,
 * review state), edges from each dependency. Wide plans scroll sideways; "Follow" keeps the
 * work in progress in view.
 */
export const PlanGraph = memo(function PlanGraph({
  plan,
  highlight,
  reducedMotion,
  etas = null,
}: {
  plan: Plan;
  highlight: string | null;
  reducedMotion: boolean;
  /** Time left per task on this PC (shown on cards that still have work to do). */
  etas?: Map<string, NodeEtaView> | null;
}) {
  const layout = useMemo(() => layoutDag(plan.nodes.map((n) => ({ id: n.id, deps: n.deps }))), [plan.nodes]);
  const byId = useMemo(() => new Map(plan.nodes.map((n) => [n.id, n])), [plan.nodes]);
  const box = useMemo(() => new Map(layout.nodes.map((b) => [b.id, b])), [layout]);
  const scroller = useRef<HTMLElement>(null);
  const programmatic = useRef(0);
  const [follow, setFollow] = useState(true);

  const scrollToNode = (id: string, force: boolean) => {
    const el = scroller.current;
    const b = box.get(id);
    if (!el || !b) return;
    const visible = b.x >= el.scrollLeft && b.x + W <= el.scrollLeft + el.clientWidth;
    if (visible && !force) return;
    programmatic.current = Date.now();
    const left = Math.max(0, b.x - 48);
    if (typeof el.scrollTo === "function") el.scrollTo({ left, behavior: reducedMotion ? "auto" : "smooth" });
    else el.scrollLeft = left;
  };

  // Follow the work: bring the first task in progress (or in review) into view when it changes.
  const focusId =
    plan.nodes.find((n) => n.status === "doing")?.id ?? plan.nodes.find((n) => n.status === "review")?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls only when the followed task changes.
  useEffect(() => {
    if (follow && focusId) scrollToNode(focusId, false);
  }, [focusId, follow]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls only when the highlighted task changes.
  useEffect(() => {
    if (highlight) scrollToNode(highlight, false);
  }, [highlight]);

  const onScroll = () => {
    // A scroll the person made (not ours) stops following.
    if (Date.now() - programmatic.current > 800) setFollow(false);
  };

  const done = plan.nodes.filter((n) => n.status === "done").length;
  return (
    <section
      aria-labelledby="team-graph-title"
      className="@container shrink-0 overflow-hidden rounded-xl border border-border bg-panel"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3.5 py-2.5">
        <h3 id="team-graph-title" className="text-xs font-semibold text-fg">
          Task graph
        </h3>
        <span className="text-xs tabular-nums text-subtle">
          {done} of {plan.nodes.length} done · {layout.layers} step{layout.layers === 1 ? "" : "s"}
        </span>
        <ul className="ml-auto hidden items-center gap-3 @xl:flex" aria-label="Legend">
          {(["todo", "doing", "review", "done", "failed"] as const).map((s) => {
            const Icon = STATUS[s].icon;
            return (
              <li key={s} className="flex items-center gap-1 text-[11px] text-muted">
                <Icon className={cn("size-3", STATUS[s].text)} aria-hidden />
                {STATUS[s].label}
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          aria-pressed={follow}
          onClick={() => {
            setFollow(true);
            if (focusId) scrollToNode(focusId, true);
          }}
          className={cn(
            "ml-auto inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors @xl:ml-0",
            follow
              ? "border-accent/40 bg-accent-soft text-accent"
              : "border-border text-muted hover:bg-hover hover:text-fg",
          )}
        >
          <Crosshair className="size-3" aria-hidden />
          Follow live
        </button>
      </header>
      <section
        ref={scroller}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Task graph. Scroll sideways to see every step."
        className="overflow-x-auto overflow-y-hidden bg-bg"
        style={{
          backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      >
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0"
            width={layout.width}
            height={layout.height}
          >
            {layout.edges.map((e) => {
              const tone = edgeTone(byId.get(e.from), byId.get(e.to));
              return (
                <g key={`${e.from}>${e.to}`} className={EDGE[tone].g}>
                  <path
                    d={e.path}
                    fill="none"
                    strokeWidth={tone === "active" ? 1.75 : 1.25}
                    strokeDasharray={tone === "active" ? "5 4" : tone === "waiting" ? "3 4" : undefined}
                    strokeLinecap="round"
                  >
                    {tone === "active" && !reducedMotion && (
                      <animate
                        attributeName="stroke-dashoffset"
                        from="18"
                        to="0"
                        dur="0.9s"
                        repeatCount="indefinite"
                      />
                    )}
                  </path>
                  <path
                    d={`M${e.x2 - 6} ${e.y2 - 3.5} L${e.x2} ${e.y2} L${e.x2 - 6} ${e.y2 + 3.5} Z`}
                    stroke="none"
                  />
                </g>
              );
            })}
          </svg>
          <ol aria-label="Tasks in plan order">
            {plan.nodes.map((n) => {
              const b = box.get(n.id);
              if (!b) return null;
              return (
                <NodeCard
                  key={n.id}
                  node={n}
                  x={b.x}
                  y={b.y}
                  highlighted={highlight === n.id}
                  after={n.deps.map((d) => byId.get(d)?.title ?? d)}
                  eta={etas?.get(n.id) ?? null}
                />
              );
            })}
          </ol>
        </div>
      </section>
    </section>
  );
});

type EdgeTone = "done" | "active" | "waiting" | "broken";

const EDGE: Record<EdgeTone, { g: string }> = {
  done: { g: "stroke-success/45 fill-success/60" },
  active: { g: "stroke-accent fill-accent" },
  waiting: { g: "stroke-border-strong fill-border-strong" },
  broken: { g: "stroke-danger/50 fill-danger/60" },
};

function edgeTone(from: PlanNode | undefined, to: PlanNode | undefined): EdgeTone {
  if (!from || !to) return "waiting";
  if (from.status === "failed" || from.status === "blocked") return "broken";
  if (from.status === "done" && (to.status === "doing" || to.status === "review")) return "active";
  if (from.status === "done") return "done";
  return "waiting";
}

function NodeCard({
  node,
  x,
  y,
  highlighted,
  after,
  eta,
}: {
  node: PlanNode;
  x: number;
  y: number;
  highlighted: boolean;
  after: string[];
  eta: NodeEtaView | null;
}) {
  const s = STATUS[node.status];
  const showEta = eta && (node.status === "todo" || node.status === "doing" || node.status === "review");
  const Icon = s.icon;
  const owner = agentName(node.owner);
  const review = reviewState(node, agentName);
  return (
    <li
      data-node={node.id}
      data-status={node.status}
      className={cn(
        "absolute flex flex-col rounded-lg border bg-panel px-2.5 pt-2 pb-1.5 transition-[border-color,box-shadow] duration-300",
        s.card,
        highlighted && "ring-2 ring-accent ring-offset-2 ring-offset-bg",
      )}
      style={{ left: x, top: y, width: W, height: H }}
      title={after.length ? `${node.title}\nAfter: ${after.join(", ")}` : node.title}
    >
      <div className="flex items-center gap-1.5">
        <AgentAvatar id={node.owner} name={owner} size="xs" busy={node.status === "doing"} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{owner}</span>
        {showEta && eta && (
          <span
            className={cn("shrink-0 text-[10px] tabular-nums", eta.over ? "text-warning" : "text-subtle")}
            data-testid="node-eta"
          >
            {nodeEtaText(eta)}
          </span>
        )}
        <Icon className={cn("size-3.5 shrink-0", s.text, s.spin && "motion-safe:animate-spin")} aria-hidden />
      </div>
      <p className="mt-1 line-clamp-2 text-xs font-medium leading-snug text-fg">{node.title}</p>
      <p className="mt-auto flex items-center gap-1.5 truncate text-[11px] leading-4">
        <span className={cn("font-medium", s.text)}>{s.label}</span>
        {node.attempts > 1 && (
          <span className="text-subtle tabular-nums" title={`Attempt ${node.attempts}`}>
            · try {node.attempts}
          </span>
        )}
        {review && <span className="truncate text-subtle">· {review}</span>}
      </p>
    </li>
  );
}
