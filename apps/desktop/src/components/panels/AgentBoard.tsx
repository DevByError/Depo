import { Cpu } from "lucide-react";
import { AGENT_TEAM, type AgentInfo } from "@/lib/agents";
import { useEngine } from "@/store/engine";
import { connectionLabel } from "./ConnectionBadge";
import { HeartbeatPulse } from "./HeartbeatPulse";

const GROUPS: AgentInfo["group"][] = ["Leadership", "Design", "Builders", "Quality", "Delivery"];

export function AgentBoard() {
  const status = useEngine((s) => s.status);
  const info = useEngine((s) => s.info);
  return (
    <section className="h-full overflow-y-auto p-3" tabIndex={0} aria-label="Agent board">
      <section
        aria-labelledby="board-engine"
        className="mb-4 rounded-lg border border-border bg-raised/40 p-3"
      >
        <div className="flex items-center justify-between">
          <h3 id="board-engine" className="flex items-center gap-2 text-xs font-semibold text-fg">
            <Cpu className="size-3.5 text-accent" aria-hidden />
            Engine
          </h3>
          <span className="text-xs text-muted">{connectionLabel(status)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-muted">
          <HeartbeatPulse />
          {info && <span className="text-subtle">v{info.engineVersion}</span>}
        </div>
      </section>

      <p className="mb-3 text-xs leading-relaxed text-subtle">
        The agent team is installed in Phase 3. Each agent will show live status here: idle, thinking,
        working, waiting or blocked.
      </p>

      {GROUPS.map((group) => (
        <section key={group} className="mb-3" aria-label={group}>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">{group}</h4>
          <ul className="divide-y divide-border/60 rounded-lg border border-border">
            {AGENT_TEAM.filter((a) => a.group === group).map((a) => (
              <li key={a.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                <span aria-hidden className="size-1.5 rounded-full bg-border" />
                <span className="min-w-0 flex-1">
                  <span className="text-fg">{a.name}</span>
                  <span className="block truncate text-subtle">{a.role}</span>
                </span>
                <span className="shrink-0 text-[11px] text-subtle">Not installed</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
