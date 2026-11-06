import type { AgentStatus } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { AGENT_TEAM, type AgentInfo } from "@/lib/agents";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { connectionLabel } from "./ConnectionBadge";
import { HeartbeatPulse } from "./HeartbeatPulse";

const GROUPS: AgentInfo["group"][] = ["Leadership", "Design", "Builders", "Quality", "Delivery"];

/** Board ids differ from the roster ids for three agents. */
const ROSTER_TO_ENGINE: Record<string, string> = {
  pm: "project-management",
  design: "ui-ux-design",
  devops: "devops-docs",
};

const STATE_TEXT: Record<AgentStatus["state"], string> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting",
  blocked: "Blocked",
};
const STATE_DOT: Record<AgentStatus["state"], string> = {
  idle: "bg-border",
  thinking: "bg-info animate-pulse",
  working: "bg-accent animate-pulse",
  waiting: "bg-warning",
  blocked: "bg-danger",
};

export function AgentBoard() {
  const status = useEngine((s) => s.status);
  const info = useEngine((s) => s.info);
  const taskId = useUi((s) => s.taskId);
  const team = useQuery({
    queryKey: ["team", taskId],
    queryFn: () => call("team.get", { taskId: taskId ?? "" }),
    enabled: status === "open" && !!taskId,
  });
  const byId = new Map((team.data?.agents ?? []).map((a) => [a.id as string, a]));
  const teamTask = team.data && team.data.mode !== "single";
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
        {teamTask
          ? "Live status of each agent in the current task."
          : "Pick a work mode other than Single agent in a new task to put the team to work. Each agent shows idle, thinking, working, waiting or blocked."}
      </p>

      {GROUPS.map((group) => (
        <section key={group} className="mb-3" aria-label={group}>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">{group}</h4>
          <ul className="divide-y divide-border/60 rounded-lg border border-border">
            {AGENT_TEAM.filter((a) => a.group === group).map((a) => {
              const s = byId.get(ROSTER_TO_ENGINE[a.id] ?? a.id);
              const state = s?.state ?? "idle";
              return (
                <li key={a.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                  <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[state])} />
                  <span className="min-w-0 flex-1">
                    <span className="text-fg">{a.name}</span>
                    <span className="block truncate text-subtle">
                      {s && state !== "idle" ? s.text : a.role}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-[11px] text-subtle">
                    {STATE_TEXT[state]}
                    {s && s.total > 0 && (
                      <span className="block tabular-nums">
                        {s.done}/{s.total}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}
