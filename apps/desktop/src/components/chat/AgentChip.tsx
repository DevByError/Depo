import { AGENT_SOFT, agentTone } from "@/lib/agent-color";
import { cn } from "@/lib/cn";
import { agentName } from "@/lib/step-summary";

/** A small coloured badge with an agent's name, in the agent's family colour (same on every screen). */
export function AgentChip({ agent, className }: { agent: string; className?: string }) {
  const name = agentName(agent) || agent;
  return (
    <span
      className={cn(
        "inline-block h-4 max-w-28 shrink-0 truncate rounded px-1.5 align-middle text-[10.5px] leading-4 font-medium",
        AGENT_SOFT[agentTone(agent.split("@")[0] ?? agent)],
        className,
      )}
    >
      {name}
    </span>
  );
}
