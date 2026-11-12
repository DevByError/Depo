import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Printer, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-panel px-3 py-2">
      <div className="text-xl font-semibold tabular-nums text-fg">{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
      {hint && <div className="text-[10px] text-subtle">{hint}</div>}
    </div>
  );
}

/** One page for showing someone what Depo is and what it has done on this PC (real data). */
export function ShowcasePanel() {
  const status = useEngine((s) => s.status);
  const qc = useQueryClient();
  const data = useQuery({
    queryKey: ["showcase"],
    queryFn: () => call("showcase.get", {}),
    enabled: status === "open",
    refetchInterval: 15_000,
  });
  const projectId = useUi((s) => s.projectId);
  const depo = useQuery({
    queryKey: ["depomd", projectId],
    queryFn: () => call("depomd.get", { projectId: projectId ?? "" }),
    enabled: status === "open" && !!projectId,
    refetchInterval: 15_000,
  });
  const upgrade = useMutation({
    mutationFn: () => call("lab.installUpgrades", {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["showcase"] });
      void qc.invalidateQueries({ queryKey: ["lab"] });
    },
  });
  const d = data.data;
  if (!d)
    return (
      <div className="p-6 text-sm text-muted">
        {data.isError ? (data.error as Error).message : "Loading the showcase..."}
      </div>
    );
  const t = d.totals;
  const failRate = t.toolCalls ? Math.round((t.toolFailures / t.toolCalls) * 100) : 0;
  const withUpgrade = d.agents.filter((a) => a.versions.length > 1).length;
  const areas = [...new Set(d.features.map((f) => f.area))];
  return (
    <div className="h-full overflow-y-auto p-5 print:overflow-visible">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-fg">
              <Sparkles className="size-5 text-accent" aria-hidden /> Depo showcase
            </h1>
            <p className="text-xs text-muted">
              A local team of {t.agents} AI agents that plans, builds, tests and secures software on this PC.
              The numbers below are real, from this installation ({new Date(d.generatedAt).toLocaleString()}).
            </p>
          </div>
          <Button variant="ghost" onClick={() => window.print()} className="print:hidden">
            <Printer className="size-4" aria-hidden /> Print
          </Button>
        </header>

        <section aria-label="Totals" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Agents" value={t.agents} hint={`${withUpgrade} with a newer version`} />
          <Stat label="Agent versions" value={t.agentVersions} />
          <Stat label="Evaluation runs" value={t.evalRuns} />
          <Stat label="Projects" value={t.projects} />
          <Stat label="Tasks" value={t.tasks} hint={`${t.tasksReviewed} reached review`} />
          <Stat label="Steps recorded" value={t.events.toLocaleString()} />
          <Stat
            label="Tool calls"
            value={t.toolCalls.toLocaleString()}
            hint={`${failRate}% failed and were retried`}
          />
          <Stat label="Errors kept with details" value={t.errors} />
          <Stat label="Questions asked" value={t.approvalsAsked} />
          <Stat label="Allowed automatically" value={t.approvalsAutomatic} hint="after you said yes once" />
          <Stat label="Facts remembered" value={t.memoryFacts} />
          <Stat
            label="Tools / blocks / playbooks"
            value={`${d.library.tools} / ${d.library.blocks} / ${d.library.playbooks}`}
          />
        </section>

        <section aria-label="Agent versions">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg">Agents and their versions</h2>
            <Button
              onClick={() => upgrade.mutate()}
              disabled={upgrade.isPending}
              className="print:hidden"
              title="Saves the newer versions (1.1 for every agent, 1.2 and 1.3 for the manager, back end, front end, tester and designer). Nothing changes until you promote one in Agent Lab."
            >
              {upgrade.isPending ? "Installing..." : "Install the newer agent versions"}
            </Button>
          </div>
          {upgrade.data && (
            <p className="mb-2 text-xs text-success" role="status">
              {upgrade.data.created.length
                ? `Saved ${upgrade.data.created.length} new agent versions. Compare and promote them in Agent Lab.`
                : "Every newer agent version was already installed."}
            </p>
          )}
          {upgrade.isError && <p className="mb-2 text-xs text-danger">{(upgrade.error as Error).message}</p>}
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-panel text-muted">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Agent</th>
                  <th className="px-3 py-1.5 font-medium">Team</th>
                  <th className="px-3 py-1.5 font-medium">Running</th>
                  <th className="px-3 py-1.5 font-medium">Versions (check score)</th>
                </tr>
              </thead>
              <tbody>
                {d.agents.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="px-3 py-1.5 text-fg">{a.name}</td>
                    <td className="px-3 py-1.5 text-muted">{a.group}</td>
                    <td className="px-3 py-1.5 tabular-nums text-fg">{a.activeVersion}</td>
                    <td className="px-3 py-1.5 text-muted">
                      {a.versions.map((v) => (
                        <span
                          key={v.version}
                          title={v.note}
                          className={`mr-2 inline-block rounded border px-1.5 ${v.active ? "border-accent text-fg" : "border-border"}`}
                        >
                          {v.version}
                          {v.score !== null ? ` · ${Math.round(v.score * 100)}%` : ""}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-label="Features" className="grid gap-4 sm:grid-cols-2">
          {areas.map((area) => (
            <div key={area}>
              <h2 className="mb-1 text-sm font-semibold text-fg">{area}</h2>
              <ul className="flex flex-col gap-1.5">
                {d.features
                  .filter((f) => f.area === area)
                  .map((f) => (
                    <li key={f.title} className="rounded-lg border border-border bg-panel px-3 py-2">
                      <div className="text-xs font-medium text-fg">{f.title}</div>
                      <div className="text-[11px] leading-relaxed text-muted">{f.detail}</div>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </section>

        <section aria-label="Project memory">
          <h2 className="mb-1 text-sm font-semibold text-fg">DEPO.md: the project's own memory</h2>
          <p className="mb-1 text-xs text-muted">
            Depo reads this file first in every task and updates the status log, what is next and the known
            issues when a task ends, like CLAUDE.md does for Claude Code. It reaches the project when you
            approve the changes.
          </p>
          {depo.data?.exists ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-panel p-3 font-mono text-[11px] text-muted">
              {depo.data.text}
            </pre>
          ) : (
            <p className="text-xs text-subtle">
              {projectId
                ? "This project has no DEPO.md yet. Depo creates it in the first task that changes something."
                : "Open a project to see its DEPO.md."}
            </p>
          )}
        </section>

        <section aria-label="Starting points">
          <h2 className="mb-1 text-sm font-semibold text-fg">Ready-made starting points</h2>
          <p className="text-xs text-muted">{d.library.blueprints.join(" · ")}</p>
        </section>

        {d.recentErrors.length > 0 && (
          <section aria-label="Recent errors">
            <h2 className="mb-1 text-sm font-semibold text-fg">
              Latest errors, shown exactly as they happened
            </h2>
            <ul className="flex flex-col gap-1">
              {d.recentErrors.map((e) => (
                <li
                  key={`${e.at}${e.text}`}
                  className="rounded border border-border px-2 py-1 font-mono text-[11px] text-muted"
                >
                  <span className="text-subtle">
                    {new Date(e.at).toLocaleString()} · {e.agent} ·{" "}
                  </span>
                  {e.text}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
