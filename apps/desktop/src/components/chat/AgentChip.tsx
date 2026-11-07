import { AGENT_SOFT, agentTone } from "@/lib/agent-color";
import { cn } from "@/lib/cn";
import { agentName } from "@/lib/step-summary";

/**
 * A small coloured badge with an agent's name, in the agent's family colour (same on every screen).
 * The tint sits on a panel-coloured base, so the text keeps its contrast on any row, hovered or not.
 */
export function AgentChip({ agent, className }: { agent: string; className?: string }) {
  const name = agentName(agent) || agent;
  return (
    <span className={cn("inline-flex max-w-28 shrink-0 rounded bg-panel align-middle", className)}>
      <span
        className={cn(
          "block h-4 min-w-0 truncate rounded px-1.5 text-[10.5px] leading-4 font-medium",
          AGENT_SOFT[agentTone(agent.split("@")[0] ?? agent)],
        )}
      >
        {name}
      </span>
    </span>
  );
}
