import type { EventType } from "@depo/shared";
import { Activity, Signpost, Timer } from "lucide-react";
import { AGENT_BG, agentTone } from "@/lib/agent-color";
import { AGENT_TEAM } from "@/lib/agents";
import { cn } from "@/lib/cn";
import { EVENT_STYLE } from "@/lib/event-style";
import { formatDuration, formatRelative } from "@/lib/format";
import { engineAgentId, isBusy, type LiveAgent } from "@/lib/team-view";
import { AgentAvatar, AgentStateBadge, MiniProgress } from "./AgentAvatar";

export function agentGroup(id: string): string | null {
  return AGENT_TEAM.find((a) => engineAgentId(a.id) === id)?.group ?? null;
}

function actionIcon(type: string | null) {
  return type && type in EVENT_STYLE ? EVENT_STYLE[type as EventType].icon : Activity;
}

/** What an agent shows when it has not done anything yet in this task. */
function idleLine(a: LiveAgent): string {
  if (a.id === "manager") return "Planning the work";
  if (a.total > 0) return "Waiting for its turn";
  return "Reviews work when it is handed over";
}

/** One agent of the team: who, live state, what it is doing, its last decision and progress. */
export function AgentCard({
  agent: a,
  selected,
  onSelect,
  now,
}: {
  agent: LiveAgent;
  selected: boolean;
  onSelect(): void;
  now: number;
}) {
  const busy = isBusy(a.state);
  const Icon = actionIcon(a.actionType);
  const group = agentGroup(a.id);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      data-agent={a.id}
      className={cn(
        "group relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-xl border bg-panel p-3 text-left transition-[border-color,box-shadow] duration-200",
        busy ? "border-border-strong shadow-pop" : "border-border hover:border-border-strong",
        selected && "ring-2 ring-accent ring-offset-1 ring-offset-bg",
      )}
    >
      <span
        aria-hidden
        className={cn("absolute inset-x-0 top-0 h-0.5", AGENT_BG[agentTone(a.id)], !busy && "opacity-35")}
      />
      <span className="flex items-start gap-2.5">
        <AgentAvatar id={a.id} name={a.name} busy={busy} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-fg">{a.name}</span>
          <span className="block truncate text-[11px] text-subtle">
            {[group, `v${a.version}`].filter(Boolean).join(" · ")}
          </span>
        </span>
        <AgentStateBadge state={a.state} />
      </span>

      <span className="block rounded-lg bg-raised px-2.5 py-2">
        <span className="flex items-center gap-1.5 text-[11px] text-subtle">
          <Icon className="size-3 shrink-0" aria-hidden />
          {busy ? "Now" : "Last action"}
          {a.actionAt && <span className="ml-auto tabular-nums">{formatRelative(a.actionAt, now)}</span>}
        </span>
        <span
          className="mt-0.5 line-clamp-2 block min-h-8 text-xs leading-4 text-fg"
          data-testid="agent-action"
        >
          {a.action ?? idleLine(a)}
        </span>
        {a.thought && (
          <span className="mt-1 block truncate font-mono text-[11px] text-muted" title={a.thought}>
            {a.thought}
          </span>
        )}
      </span>

      <span className="block">
        <span className="flex items-center gap-1.5 text-[11px] text-subtle">
          <Signpost className="size-3 shrink-0" aria-hidden />
          Last decision
        </span>
        <span className="mt-0.5 line-clamp-2 block min-h-8 text-xs leading-4 text-muted">
          {a.lastDecision?.text ?? "No decision yet"}
        </span>
      </span>

      <span className="mt-auto flex items-center gap-2.5 text-[11px] tabular-nums text-subtle">
        {a.total > 0 ? (
          <>
            <MiniProgress id={a.id} done={a.done} total={a.total} className="w-16" />
            <span>
              {a.done}/{a.total} task{a.total === 1 ? "" : "s"}
            </span>
          </>
        ) : a.reviews > 0 ? (
          <span>
            {a.reviews} review{a.reviews === 1 ? "" : "s"}
          </span>
        ) : (
          <span>{a.id === "manager" ? "Leads the team" : "On call"}</span>
        )}
        {a.total > 0 && a.reviews > 0 && <span>· {a.reviews} reviews</span>}
        <span className="ml-auto inline-flex items-center gap-1" title="Time working">
          <Timer className="size-3" aria-hidden />
          <span className="sr-only">Time working:</span>
          {formatDuration(a.workMs)}
        </span>
      </span>
    </button>
  );
}
