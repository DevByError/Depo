import type { DecisionKind, PlanNode, TeamDecision } from "@depo/shared";
import {
  ArrowDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CornerUpLeft,
  FileCheck2,
  Lightbulb,
  type LucideIcon,
  OctagonAlert,
  Rocket,
  Route,
  Scale,
  Signpost,
  UserRoundCheck,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AGENT_TEXT, agentTone } from "@/lib/agent-color";
import { cn } from "@/lib/cn";
import { TONE_TEXT, type Tone } from "@/lib/event-style";
import { formatClock } from "@/lib/format";
import { agentName, atBottom, decisionLabel, decisionTone } from "@/lib/team-view";
import { AgentAvatar } from "./AgentAvatar";

const KIND_ICON: Record<DecisionKind, LucideIcon> = {
  plan: Route,
  plan_approval: UserRoundCheck,
  send_back: CornerUpLeft,
  escalate: OctagonAlert,
  release: Rocket,
  review: CircleCheck,
  result: FileCheck2,
  adr: Scale,
  recommendation: Lightbulb,
};

const TONE_CHIP: Record<Tone, string> = {
  neutral: "bg-raised",
  accent: "bg-accent-soft",
  success: "bg-success/12",
  warning: "bg-warning/12",
  danger: "bg-danger/12",
  info: "bg-info/12",
};

const NONE: TeamDecision[] = [];

export function decisionIcon(d: Pick<TeamDecision, "kind" | "outcome">): LucideIcon {
  if (d.kind === "review" && d.outcome === "changes") return CircleAlert;
  return KIND_ICON[d.kind];
}

/**
 * Every decision of the run, oldest first. It follows new decisions only while the reader is at
 * the bottom; scrolled up, it stays put and offers "Jump to latest".
 */
export function DecisionTimeline({
  decisions,
  nodes,
  filter,
  onClearFilter,
  onNode,
  reducedMotion,
  upcoming = NONE,
}: {
  decisions: TeamDecision[];
  nodes: Map<string, PlanNode>;
  filter: string | null;
  onClearFilter(): void;
  onNode(id: string): void;
  reducedMotion: boolean;
  /** Replay: decisions made after the moment shown (they stay hidden until then). */
  upcoming?: TeamDecision[];
}) {
  const items = filter ? decisions.filter((d) => d.agent === filter) : decisions;
  const later = filter ? upcoming.filter((d) => d.agent === filter).length : upcoming.length;
  const box = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const count = useRef(items.length);
  const [unseen, setUnseen] = useState(0);
  const [away, setAway] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    const added = items.length - count.current;
    count.current = items.length;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (added > 0) setUnseen((u) => u + added);
  }, [items.length]);

  // Resizing the window or a panel keeps the newest entry in view while following.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const follow = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    follow.observe(el);
    return () => follow.disconnect();
  }, []);

  // A new filter starts at the newest entry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the filter changes.
  useEffect(() => {
    const el = box.current;
    stick.current = true;
    setUnseen(0);
    setAway(false);
    if (el) el.scrollTop = el.scrollHeight;
  }, [filter]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const bottom = atBottom(el);
    stick.current = bottom;
    setAway(!bottom);
    if (bottom) setUnseen(0);
  };

  const jump = () => {
    const el = box.current;
    if (!el) return;
    stick.current = true;
    setUnseen(0);
    setAway(false);
    if (typeof el.scrollTo === "function")
      el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
    else el.scrollTop = el.scrollHeight;
  };

  return (
    <section aria-labelledby="team-decisions-title" className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <Signpost className="size-3.5 text-accent" aria-hidden />
        <h3 id="team-decisions-title" className="text-xs font-semibold text-fg">
          Decisions
        </h3>
        <span className="rounded-full bg-raised px-1.5 text-[11px] tabular-nums text-muted">
          {items.length}
        </span>
        {filter && (
          <button
            type="button"
            onClick={onClearFilter}
            className="ml-auto inline-flex h-6 max-w-[60%] items-center gap-1 rounded-full border border-border bg-raised pr-1.5 pl-1 text-[11px] text-fg hover:bg-hover"
          >
            <AgentAvatar id={filter} name={agentName(filter)} size="xs" />
            <span className="truncate">Only {agentName(filter)}</span>
            <X className="size-3 shrink-0 text-muted" aria-hidden />
            <span className="sr-only">, show every agent</span>
          </button>
        )}
      </header>
      <div className="relative min-h-0 flex-1">
        <section
          ref={box}
          onScroll={onScroll}
          tabIndex={0}
          aria-label={filter ? `Decisions by ${agentName(filter)}, oldest first` : "Decisions, oldest first"}
          className="h-full max-h-[32rem] overflow-y-auto px-4 py-3 @3xl:max-h-none"
        >
          {items.length === 0 ? (
            <p className="py-8 text-center text-xs leading-relaxed text-muted">
              {filter
                ? `${agentName(filter)} has not decided anything yet.`
                : later > 0
                  ? "No decisions yet at this point of the run."
                  : "Decisions appear here as the agents make them: the plan, reviews, handoffs and the final verdict."}
            </p>
          ) : (
            <ol className="flex flex-col">
              {items.map((d, i) => (
                <DecisionItem
                  key={d.id}
                  d={d}
                  last={i === items.length - 1}
                  node={d.nodeId ? (nodes.get(d.nodeId) ?? null) : null}
                  onNode={onNode}
                />
              ))}
            </ol>
          )}
          {later > 0 && (
            <p className="mt-1 border-t border-dashed border-border pt-2 text-center text-[11px] text-subtle">
              {later} more decision{later === 1 ? "" : "s"} later in the run
            </p>
          )}
        </section>
        {away && (
          <button
            type="button"
            onClick={jump}
            className="absolute bottom-3 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full bg-accent px-3 text-xs font-medium text-accent-fg shadow-pop hover:opacity-90"
          >
            <ArrowDown className="size-3.5" aria-hidden />
            {unseen > 0 ? `Jump to latest (${unseen} new)` : "Jump to latest"}
          </button>
        )}
      </div>
    </section>
  );
}

function DecisionItem({
  d,
  last,
  node,
  onNode,
}: {
  d: TeamDecision;
  last: boolean;
  node: PlanNode | null;
  onNode(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const tone = decisionTone(d);
  const Icon = decisionIcon(d);
  const name = agentName(d.agent);
  const reason = d.reason && d.reason !== d.items.join("\n") ? d.reason : null;
  const hasWhy = !!reason || d.items.length > 0;
  return (
    <li className="relative flex gap-3 pb-4 last:pb-1" data-kind={d.kind} data-decision-id={d.id}>
      {!last && <span aria-hidden className="absolute top-7 bottom-0 left-3 w-px bg-border" />}
      <AgentAvatar id={d.agent} name={name} size="sm" className="relative mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
          <span className={cn("truncate font-semibold", AGENT_TEXT[agentTone(d.agent)])}>{name}</span>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px font-medium",
              TONE_CHIP[tone],
              TONE_TEXT[tone],
            )}
          >
            <Icon className="size-3" aria-hidden />
            {decisionLabel(d)}
          </span>
          <time className="ml-auto shrink-0 tabular-nums text-subtle" dateTime={d.ts}>
            {formatClock(d.ts)}
          </time>
        </div>
        <p className="mt-1 text-[13px] leading-snug break-words text-fg">{d.text}</p>
        {(node || hasWhy) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {node && (
              <button
                type="button"
                onClick={() => onNode(node.id)}
                className="inline-flex max-w-full items-center gap-1 rounded text-[11px] text-muted hover:text-fg"
                title="Show this task in the graph"
              >
                <Workflow className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{node.title}</span>
              </button>
            )}
            {hasWhy && (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="inline-flex items-center gap-0.5 text-[11px] font-medium text-muted hover:text-fg"
              >
                <ChevronRight
                  className={cn("size-3 transition-transform", open && "rotate-90")}
                  aria-hidden
                />
                {open ? "Hide details" : "Why"}
              </button>
            )}
          </div>
        )}
        {open && hasWhy && (
          <div className="mt-1.5 rounded-lg border border-border bg-raised px-2.5 py-2 text-xs leading-relaxed text-muted">
            {reason && <p className="whitespace-pre-wrap break-words">{reason}</p>}
            {d.items.length > 0 && (
              <ul className={cn("flex flex-col gap-0.5", reason && "mt-1.5")}>
                {uniqueKeys(d.items).map(({ key, text }) => (
                  <li key={key} className="flex gap-1.5 break-words">
                    <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-border-strong" />
                    <span className="min-w-0">{text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** Stable keys for a list of strings that may repeat. */
function uniqueKeys(items: string[]): { key: string; text: string }[] {
  const seen = new Map<string, number>();
  return items.map((text) => {
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    return { key: n === 1 ? text : `${text}#${n}`, text };
  });
}
