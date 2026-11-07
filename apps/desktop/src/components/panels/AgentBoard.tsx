import { ArrowUpRight, Cpu, Signpost } from "lucide-react";
import { AgentAvatar, AgentStateBadge, MiniProgress } from "@/components/team/AgentAvatar";
import { AGENT_TEAM, type AgentInfo } from "@/lib/agents";
import { cn } from "@/lib/cn";
import { engineAgentId, isBusy, type LiveAgent } from "@/lib/team-view";
import { useTeamView } from "@/lib/use-team";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { connectionLabel } from "./ConnectionBadge";
import { HeartbeatPulse } from "./HeartbeatPulse";

const GROUPS: AgentInfo["group"][] = ["Leadership", "Design", "Builders", "Quality", "Delivery"];

/**
 * The right-hand Agent board: for a team task, each agent taking part with its live state, what
 * it is doing and its last decision (the compact form of the Team screen); the rest of the team below.
 */
export function AgentBoard() {
  const status = useEngine((s) => s.status);
  const info = useEngine((s) => s.info);
  const taskId = useUi((s) => s.taskId);
  const setCenterTab = useUi((s) => s.setCenterTab);
  const { view } = useTeamView(taskId);
  const team = view && view.mode !== "single" ? view : null;
  const taking = new Set(team?.agents.map((a) => a.id as string) ?? []);
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

      {team ? (
        <>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-subtle">In this task</h4>
            <button
              type="button"
              onClick={() => setCenterTab("team")}
              className="inline-flex items-center gap-0.5 rounded text-[11px] font-medium text-accent hover:underline"
            >
              Open Team view
              <ArrowUpRight className="size-3" aria-hidden />
            </button>
          </div>
          <ul className="mb-4 flex flex-col gap-2" aria-label="Agents in this task">
            {team.agents.map((a) => (
              <BoardAgent key={a.id} agent={a} />
            ))}
          </ul>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">
            Rest of the team
          </h4>
          <ul className="flex flex-wrap gap-1.5" aria-label="Agents not in this task">
            {AGENT_TEAM.filter((a) => !taking.has(engineAgentId(a.id))).map((a) => (
              <li
                key={a.id}
                title={a.role}
                className="inline-flex items-center gap-1.5 rounded-md border border-border py-0.5 pr-2 pl-0.5 text-[11px] text-muted"
              >
                <AgentAvatar id={engineAgentId(a.id)} name={a.name} size="xs" />
                {a.name}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="mb-3 text-xs leading-relaxed text-subtle">
            Pick a work mode other than Single agent in a new task to put the team to work. Each agent then
            shows what it is doing and what it decided.
          </p>
          {GROUPS.map((group) => (
            <section key={group} className="mb-3" aria-label={group}>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">{group}</h4>
              <ul className="divide-y divide-border/60 rounded-lg border border-border">
                {AGENT_TEAM.filter((a) => a.group === group).map((a) => (
                  <li key={a.id} className="flex items-center gap-2.5 px-2.5 py-1.5 text-xs">
                    <AgentAvatar id={engineAgentId(a.id)} name={a.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-fg">{a.name}</span>
                      <span className="block truncate text-subtle">{a.role}</span>
                    </span>
                    <AgentStateBadge state="idle" compact />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </section>
  );
}

function BoardAgent({ agent: a }: { agent: LiveAgent }) {
  const busy = isBusy(a.state);
  return (
    <li
      data-agent={a.id}
      className={cn(
        "rounded-lg border bg-panel px-2.5 py-2",
        busy ? "border-border-strong" : "border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <AgentAvatar id={a.id} name={a.name} size="sm" busy={busy} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">{a.name}</span>
        <AgentStateBadge state={a.state} compact />
      </div>
      {a.action && (
        <p className="mt-1.5 truncate text-xs text-muted" title={a.action}>
          {a.action}
        </p>
      )}
      {a.lastDecision && (
        <p className="mt-1 flex gap-1.5 text-[11px] leading-4 text-subtle">
          <Signpost className="mt-px size-3 shrink-0" aria-hidden />
          <span className="line-clamp-2 min-w-0">{a.lastDecision.text}</span>
        </p>
      )}
      {a.total > 0 && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] tabular-nums text-subtle">
          <MiniProgress id={a.id} done={a.done} total={a.total} className="flex-1" />
          {a.done}/{a.total}
        </div>
      )}
    </li>
  );
}
