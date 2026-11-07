import type { DepoEvent, Task } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { AGENT_SOFT, agentTone } from "@/lib/agent-color";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { formatClock, formatDuration } from "@/lib/format";
import { useEngine } from "@/store/engine";

/**
 * The Team view of a single-agent task: the one model agent (the Coder) and Depo's own helpers,
 * which work without a model: the starter (starting project and the picture's colours), the tester
 * (installs, tests, starts the app and checks the page) and the reviewer (the readiness check).
 */

export type LaneId = "starter" | "coder" | "tester" | "reviewer";
export type LaneState = "waiting" | "working" | "done" | "problem" | "skipped";

export interface Lane {
  id: LaneId;
  name: string;
  role: string;
  /** For the colour and initials. */
  tone: string;
  initials: string;
  events: DepoEvent[];
  state: LaneState;
  last: DepoEvent | null;
  ms: number;
}

const ACTIVE: Task["status"][] = ["queued", "running", "waiting"];

const isReadiness = (e: DepoEvent) =>
  e.type === "decision" &&
  !!e.details &&
  typeof e.details === "object" &&
  (e.details as Record<string, unknown>).kind === "readiness";

export function laneOf(e: DepoEvent): LaneId | null {
  if (e.agent.startsWith("starter@")) return "starter";
  if (e.agent.startsWith("tester@")) return "tester";
  if (isReadiness(e)) return "reviewer";
  if (e.agent.startsWith("coder@")) return "coder";
  return null;
}

/** The four lanes of a single-agent task from its events (oldest first). */
export function buildLanes(events: DepoEvent[], status: Task["status"], model: string | null): Lane[] {
  const active = ACTIVE.includes(status);
  const mine = events.filter((e) => !e.ephemeral);
  const latest = [...mine].reverse().find((e) => laneOf(e) !== null);
  const latestLane = latest ? laneOf(latest) : null;
  const base: Omit<Lane, "events" | "state" | "last" | "ms">[] = [
    {
      id: "starter",
      name: "Depo starter",
      role: "Writes the starting project and your picture's colours, before the model starts",
      tone: "starter",
      initials: "ST",
    },
    {
      id: "coder",
      name: "Coder",
      role: `The model${model ? ` (${model})` : ""}: reads, edits and runs commands`,
      tone: "coder",
      initials: "CO",
    },
    {
      id: "tester",
      name: "Depo tester",
      role: "Installs the packages, runs the tests, starts the app and checks the page",
      tone: "tester",
      initials: "TE",
    },
    {
      id: "reviewer",
      name: "Depo reviewer",
      role: "Checks if the change is ready before you review it",
      tone: "testing",
      initials: "RV",
    },
  ];
  return base.map((b) => {
    const list = mine.filter((e) => laneOf(e) === b.id);
    const last = list.at(-1) ?? null;
    const first = list[0];
    const ms = first && last ? Math.max(0, Date.parse(last.ts) - Date.parse(first.ts)) : 0;
    let state: LaneState;
    if (!last) state = active ? "waiting" : "skipped";
    else if (active && latestLane === b.id) state = "working";
    else if (last.status === "failed") state = "problem";
    else state = "done";
    return { ...b, events: list, state, last, ms };
  });
}

const STATE_TEXT: Record<LaneState, string> = {
  waiting: "Waiting",
  working: "Working",
  done: "Done",
  problem: "Problem",
  skipped: "Not needed",
};

const STATE_STYLE: Record<LaneState, string> = {
  waiting: "bg-raised text-muted",
  working: "bg-accent-soft text-accent",
  done: "bg-success/12 text-success",
  problem: "bg-danger/12 text-danger",
  skipped: "bg-raised text-muted",
};

export function SingleCrew({ task, projectId }: { task: Task; projectId: string | null }) {
  const live = useEngine((s) => s.events);
  // Older tasks' events may no longer be in the live list.
  const backlog = useQuery({
    queryKey: ["events", "task", task.id],
    queryFn: () => call("events.recent", { projectId, limit: 1000 }),
    enabled: !!projectId,
  });
  const events = useMemo(() => {
    const byId = new Map<string, DepoEvent>();
    for (const e of backlog.data?.events ?? []) if (e.taskId === task.id) byId.set(e.id, e);
    for (const e of live) if (e.taskId === task.id) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.seq - b.seq || a.ts.localeCompare(b.ts));
  }, [backlog.data, live, task.id]);
  const lanes = useMemo(() => buildLanes(events, task.status, task.model), [events, task.status, task.model]);
  const recent = events
    .filter((e) => !e.ephemeral && laneOf(e) !== null)
    .slice(-40)
    .reverse();

  return (
    <div className="flex h-full flex-col overflow-auto p-5">
      <header className="mb-4">
        <h2 className="text-[15px] font-semibold text-fg">{task.title}</h2>
        <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-muted">
          One model agent does the coding. Depo's starter, tester and reviewer are Depo's own steps and need
          no model. For a whole team (Manager, Frontend, Backend, Database and reviewers), pick Full system
          when you start a new task.
        </p>
      </header>
      <ul aria-label="Who works on this task" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {lanes.map((l) => (
          <li
            key={l.id}
            data-lane={l.id}
            data-state={l.state}
            className={cn(
              "flex flex-col gap-2 rounded-lg border bg-surface p-3",
              l.state === "working" ? "border-accent/50" : "border-border",
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn("rounded px-1 py-px text-[9px] font-semibold", AGENT_SOFT[agentTone(l.tone)])}
                aria-hidden
              >
                {l.initials}
              </span>
              <span className="text-[13px] font-medium text-fg">{l.name}</span>
              <span
                className={cn("ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium", STATE_STYLE[l.state])}
              >
                {STATE_TEXT[l.state]}
              </span>
            </div>
            <p className="text-[11.5px] leading-snug text-muted">{l.role}</p>
            <p className="line-clamp-2 min-h-[2.4em] text-[12px] text-fg">{l.last?.text ?? "Nothing yet."}</p>
            <p className="text-[11px] text-subtle">
              {l.events.length} step{l.events.length === 1 ? "" : "s"}
              {l.ms > 0 ? ` · ${formatDuration(l.ms)}` : ""}
            </p>
          </li>
        ))}
      </ul>
      <h3 className="mt-6 mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">
        What happened
      </h3>
      {recent.length === 0 ? (
        <p className="text-[12.5px] text-muted">No steps yet.</p>
      ) : (
        <ol aria-label="Steps, newest first" className="flex flex-col divide-y divide-border">
          {recent.map((e) => {
            const lane = lanes.find((l) => l.id === laneOf(e));
            return (
              <li key={e.id} className="flex items-baseline gap-2 py-1.5 text-[12.5px]">
                <span className="w-14 shrink-0 font-mono text-[11px] text-subtle">{formatClock(e.ts)}</span>
                <span className="w-24 shrink-0 truncate font-medium text-fg">{lane?.name ?? ""}</span>
                <span
                  className={cn("min-w-0 flex-1 truncate", e.status === "failed" ? "text-danger" : "text-fg")}
                >
                  {e.text}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
