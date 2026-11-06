import type { AgentMessage, Plan, PlanNode, PlanNodeStatus } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const COLUMNS: { id: string; label: string; statuses: PlanNodeStatus[] }[] = [
  { id: "todo", label: "To do", statuses: ["todo"] },
  { id: "doing", label: "In progress", statuses: ["doing"] },
  { id: "review", label: "In review", statuses: ["review"] },
  { id: "done", label: "Done", statuses: ["done"] },
  { id: "stuck", label: "Blocked", statuses: ["blocked", "failed"] },
];

const OWNER_NAMES: Record<string, string> = {
  manager: "Manager",
  thinking: "Thinking",
  reasoning: "Reasoning",
  "project-management": "Project Management",
  "ui-ux-design": "UI/UX Design",
  diagram: "Diagram",
  backend: "Backend",
  frontend: "Frontend",
  database: "Database",
  integration: "Integration",
  "ai-integration": "AI Integration",
  testing: "Testing",
  security: "Security",
  enhancement: "Enhancement",
  "devops-docs": "DevOps & Docs",
};

export function PlanBoard() {
  const status = useEngine((s) => s.status);
  const taskId = useUi((s) => s.taskId);
  const team = useQuery({
    queryKey: ["team", taskId],
    queryFn: () => call("team.get", { taskId: taskId ?? "" }),
    enabled: status === "open" && !!taskId,
  });
  const plan = team.data?.plan ?? null;

  if (!taskId || !plan) {
    return (
      <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-2 px-6 text-center">
        <ListChecks className="size-8 text-subtle" aria-hidden />
        <h2 className="text-sm font-semibold text-fg">No plan yet</h2>
        <p className="text-[13px] leading-relaxed text-muted">
          Start a task in the Chat tab with a work mode such as Full system or Backend only. The Manager turns
          your request into a task graph, and it appears here as a board you can follow while the team works.
        </p>
      </div>
    );
  }
  return <Board plan={plan} messages={team.data?.messages ?? []} />;
}

function Board({ plan, messages }: { plan: Plan; messages: AgentMessage[] }) {
  const done = plan.nodes.filter((n) => n.status === "done").length;
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-fg">Plan</h2>
        <span className="text-xs text-muted tabular-nums" data-testid="plan-progress">
          {done} of {plan.nodes.length} tasks done
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-subtle">{plan.summary}</span>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto p-4 md:grid-cols-5">
        {COLUMNS.map((col) => {
          const nodes = plan.nodes.filter((n) => col.statuses.includes(n.status));
          return (
            <section key={col.id} aria-label={col.label} className="min-w-0">
              <h3 className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-subtle">
                {col.label}
                <span className="tabular-nums">{nodes.length}</span>
              </h3>
              <ul className="flex flex-col gap-2">
                {nodes.map((n) => (
                  <Card key={n.id} node={n} deps={n.deps.map((d) => byId.get(d)?.title ?? d)} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <Messages messages={messages} />
    </div>
  );
}

function Card({ node, deps }: { node: PlanNode; deps: string[] }) {
  return (
    <li
      className={cn(
        "rounded-lg border bg-panel p-2.5 text-xs",
        node.status === "failed" || node.status === "blocked" ? "border-danger/40" : "border-border",
        node.status === "doing" && "border-accent/60",
      )}
    >
      <div className="font-medium text-fg">{node.title}</div>
      <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted">
        <span>{OWNER_NAMES[node.owner] ?? node.owner}</span>
        {node.attempts > 1 && <span>attempt {node.attempts}</span>}
        {node.review && <span>reviewed</span>}
      </div>
      {deps.length > 0 && <div className="mt-1 text-[11px] text-subtle">after: {deps.join(", ")}</div>}
      {node.criteria.length > 0 && (
        <ul className="mt-1.5 list-disc pl-4 text-[11px] text-muted">
          {node.criteria.slice(0, 3).map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      {(node.status === "failed" || node.status === "blocked") && node.note && (
        <p className="mt-1.5 text-[11px] text-danger">{node.note.slice(0, 240)}</p>
      )}
    </li>
  );
}

function Messages({ messages }: { messages: AgentMessage[] }) {
  if (messages.length === 0) return null;
  const recent = messages.slice(-30).reverse();
  return (
    <details className="border-t border-border px-4 py-2 text-xs">
      <summary className="cursor-pointer text-muted hover:text-fg">
        Messages between agents ({messages.length})
      </summary>
      <ol className="mt-2 max-h-48 overflow-y-auto">
        {recent.map((m) => (
          <li key={m.id} className="border-b border-border/50 py-1 last:border-0">
            <span className="text-fg">{m.from.split("@")[0]}</span>
            <span className="text-subtle"> → </span>
            <span className="text-fg">{m.to.split("@")[0]}</span>
            <span className="ml-2 rounded bg-hover px-1 text-[10px] uppercase text-muted">{m.type}</span>
            <span className="ml-2 text-muted">{m.summary.slice(0, 160)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
