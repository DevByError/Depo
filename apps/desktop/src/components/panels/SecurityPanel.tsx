import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleSlash, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const SEVERITY_STYLE: Record<string, string> = {
  critical: "border-danger/60 text-danger",
  high: "border-danger/40 text-danger",
  medium: "border-warning/50 text-warning",
  low: "border-border text-muted",
  info: "border-border text-subtle",
};

export function SecurityPanel() {
  const status = useEngine((s) => s.status);
  const projectId = useUi((s) => s.projectId);
  const qc = useQueryClient();
  const enabled = status === "open";
  const tools = useQuery({
    queryKey: ["security", "status"],
    queryFn: () => call("security.status", {}),
    enabled,
  });
  const last = useQuery({
    queryKey: ["security", "last", projectId],
    queryFn: () => call("security.last", { projectId: projectId ?? "" }),
    enabled: enabled && !!projectId,
  });
  const scores = useQuery({
    queryKey: ["scores", projectId],
    queryFn: () => call("scores.get", { projectId: projectId ?? "" }),
    enabled: enabled && !!projectId,
  });
  const scan = useMutation({
    mutationFn: () => call("security.scan", { projectId: projectId ?? "" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["security", "last"] });
    },
  });
  const report = scan.data ?? last.data?.report ?? null;
  const agentScore = scores.data?.security;

  return (
    <section className="h-full overflow-y-auto" tabIndex={0} aria-label="Security">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-6">
        <header className="flex items-center gap-3">
          <ShieldCheck className="size-5 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold text-fg">Security</h1>
          {report && (
            <span
              className={cn(
                "ml-auto rounded-full border px-2.5 py-0.5 text-xs",
                report.score.blocksRelease
                  ? "border-danger/50 text-danger"
                  : "border-success/50 text-success",
              )}
            >
              Security score {report.score.overall}/100 · {report.score.grade}
              {report.score.blocksRelease ? " · blocks release" : ""}
            </span>
          )}
        </header>
        <p className="-mt-3 text-[13px] leading-relaxed text-muted">
          Depo checks the project for secrets, insecure code and vulnerable dependencies with its own rules
          plus any scanner you have installed. Nothing is downloaded or installed for you.
        </p>

        <section className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={!projectId || scan.isPending} onClick={() => scan.mutate()}>
            {scan.isPending ? "Scanning…" : "Scan the project now"}
          </Button>
          {!projectId && <span className="text-xs text-muted">Open a project first.</span>}
          {agentScore && (
            <span className="text-xs text-muted">
              Latest scan by the Security agent: {agentScore.overall}/100 ({agentScore.grade})
            </span>
          )}
          {scan.isError && (
            <p role="alert" className="text-xs text-danger">
              {(scan.error as Error).message}
            </p>
          )}
        </section>

        {report && (
          <section aria-labelledby="findings">
            <h2 id="findings" className="mb-2 text-sm font-semibold text-fg">
              Findings ({report.findings.length})
            </h2>
            <p className="mb-2 text-xs text-muted">
              Checked with {report.ran.map((r) => r.tool).join(", ")}.
              {report.skipped.length > 0 &&
                ` Not available: ${report.skipped.map((s) => s.tool).join(", ")}.`}
            </p>
            {report.findings.length === 0 && (
              <p className="flex items-center gap-2 text-[13px] text-success">
                <CheckCircle2 className="size-4" aria-hidden /> No findings.
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {report.findings.slice(0, 200).map((f) => (
                <li
                  key={`${f.file}:${f.line}:${f.rule}`}
                  className="rounded-lg border border-border bg-panel p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px] uppercase",
                        SEVERITY_STYLE[f.severity] ?? "",
                      )}
                    >
                      {f.severity}
                    </span>
                    <span className="font-mono text-xs text-fg">
                      {f.file}:{f.line}
                    </span>
                    <span className="text-xs text-subtle">
                      {f.tool} · {f.rule}
                    </span>
                  </div>
                  <div className="mt-1 text-[13px] text-fg">{f.title}</div>
                  <div className="mt-0.5 text-xs text-muted">Fix: {f.fix}</div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="tools">
          <h2 id="tools" className="mb-2 text-sm font-semibold text-fg">
            Scanners and tools
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {(tools.data?.scanners ?? []).map((s) => (
              <li key={s.id} className="rounded-lg border border-border bg-panel p-3">
                <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
                  {s.installed ? (
                    <CheckCircle2 className="size-4 text-success" aria-hidden />
                  ) : (
                    <CircleSlash className="size-4 text-subtle" aria-hidden />
                  )}
                  {s.name}
                  <span className="ml-auto text-xs font-normal text-muted">
                    {s.installed ? "installed" : "not installed"}
                  </span>
                </div>
                <div className="text-xs text-muted">{s.purpose}</div>
                {!s.installed && <div className="mt-1 font-mono text-[11px] text-subtle">{s.install}</div>}
              </li>
            ))}
          </ul>
          <h3 className="mt-4 mb-2 text-xs font-semibold text-muted uppercase">Local runtimes</h3>
          <ul className="flex flex-wrap gap-2">
            {(tools.data?.runtimes ?? []).map((r) => (
              <li
                key={r.id}
                title={r.installed ? "installed" : r.install}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs",
                  r.installed ? "border-success/40 text-success" : "border-border text-muted",
                )}
              >
                {r.name}
                {r.installed ? "" : " (missing)"}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}
