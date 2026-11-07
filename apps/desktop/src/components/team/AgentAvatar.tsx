import type { AgentState } from "@depo/shared";
import { AGENT_BG, AGENT_BORDER, AGENT_SOFT, agentInitials, agentTone } from "@/lib/agent-color";
import { cn } from "@/lib/cn";

const SIZES = {
  xs: "size-5 rounded text-[9px]",
  sm: "size-6 rounded-md text-[10px]",
  md: "size-8 rounded-lg text-[11px]",
} as const;

/** An agent's initials on its family colour; a coloured frame while it is at work. */
export function AgentAvatar({
  id,
  name,
  size = "md",
  busy = false,
  className,
}: {
  id: string;
  name: string;
  size?: keyof typeof SIZES;
  busy?: boolean;
  className?: string;
}) {
  const tone = agentTone(id);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center border font-semibold tracking-wide",
        SIZES[size],
        AGENT_SOFT[tone],
        busy ? AGENT_BORDER[tone] : "border-transparent",
        className,
      )}
    >
      {id === "user" ? "You" : agentInitials(id || name)}
    </span>
  );
}

export const STATE_LABEL: Record<AgentState, string> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting for you",
  blocked: "Blocked",
};

const STATE_DOT: Record<AgentState, string> = {
  idle: "bg-border-strong",
  thinking: "bg-info",
  working: "bg-accent",
  waiting: "bg-warning",
  blocked: "bg-danger",
};

const STATE_TEXT: Record<AgentState, string> = {
  idle: "text-subtle",
  thinking: "text-info",
  working: "text-accent",
  waiting: "text-warning",
  blocked: "text-danger",
};

/** Live state with a dot that breathes while the agent is busy (still when motion is reduced). */
export function AgentStateBadge({ state, compact = false }: { state: AgentState; compact?: boolean }) {
  const busy = state === "working" || state === "thinking";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium",
        compact ? "text-[11px]" : "rounded-full bg-raised px-2 py-0.5 text-[11px]",
        STATE_TEXT[state],
      )}
      data-state={state}
    >
      <span className="relative flex size-1.5" aria-hidden>
        {busy && (
          <span
            className={cn(
              "absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping",
              STATE_DOT[state],
            )}
          />
        )}
        <span className={cn("relative inline-flex size-1.5 rounded-full", STATE_DOT[state])} />
      </span>
      {compact && state === "waiting" ? "Waiting" : STATE_LABEL[state]}
    </span>
  );
}

/** A thin progress bar in the agent's colour. */
export function MiniProgress({
  id,
  done,
  total,
  className,
}: {
  id: string;
  done: number;
  total: number;
  className?: string;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <span className={cn("relative block h-1 overflow-hidden rounded-full bg-hover", className)} aria-hidden>
      <span
        className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500", bgOf(id))}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

function bgOf(id: string): string {
  return AGENT_BG[agentTone(id)];
}
