import type { ApiResult } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileCode2, FlaskConical, Palette, ShieldCheck, XCircle } from "lucide-react";
import { AGENT_BG, type AgentTone } from "@/lib/agent-color";
import { cn } from "@/lib/cn";
import { compactNumber, languageShares, plural, testBars } from "@/lib/code-map";
import { call } from "@/lib/engine";
import { formatRelative } from "@/lib/format";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { Card, CardLink, Stat, TestSparkline } from "./parts";

type Overview = ApiResult<"projects.overview">;

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const LANGUAGE_TONES: AgentTone[] = ["build", "design", "data", "ops", "docs"];

/** Tests, security, UX and code size at a glance. */
export function HealthCards({ overview }: { overview: Overview }) {
  const projectId = overview.project.id;
  return (
    <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @4xl:grid-cols-4">
      <TestsCard projectId={projectId} last={overview.lastTestRun} />
      <SecurityCard projectId={projectId} />
      <UxCard projectId={projectId} />
      <CodeSizeCard projectId={projectId} overview={overview} />
    </div>
  );
}

function TestsCard({ projectId, last }: { projectId: string; last: Overview["lastTestRun"] }) {
  const enabled = useEngine((s) => s.status === "open");
  // Under "overview" so a new test result refreshes it with the rest of the home.
  const runs = useQuery({
    queryKey: ["overview", projectId, "tests"],
    queryFn: () => call("events.recent", { projectId, types: ["test_result"], limit: 20 }),
    enabled,
  });
  const bars = testBars(runs.data?.events ?? []);
  return (
    <Card title="Last test run" icon={FlaskConical}>
      {last ? (
        <div className="flex items-start gap-2 text-xs">
          {last.passed ? (
            <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Passed" />
          ) : (
            <XCircle className="size-4 shrink-0 text-danger" aria-label="Failed" />
          )}
          <div className="min-w-0">
            <p className="text-fg">{last.text}</p>
            <p className="mt-0.5 text-subtle">{formatRelative(last.at)}</p>
          </div>
        </div>
      ) : (
        <p className="text-xs text-subtle">
          Agents run the tests in their copy. The latest result shows here.
        </p>
      )}
      <TestSparkline bars={bars} />
    </Card>
  );
}

function SecurityCard({ projectId }: { projectId: string }) {
  const enabled = useEngine((s) => s.status === "open");
  const setCenterTab = useUi((s) => s.setCenterTab);
  const last = useQuery({
    queryKey: ["security", "last", projectId],
    queryFn: () => call("security.last", { projectId }),
    enabled,
  });
  const scores = useQuery({
    queryKey: ["scores", projectId],
    queryFn: () => call("scores.get", { projectId }),
    enabled,
  });
  const report = last.data?.report ?? null;
  const score = report?.score ?? scores.data?.security ?? null;
  const counts = SEVERITIES.map(
    (s) => [s, report?.findings.filter((f) => f.severity === s).length ?? 0] as const,
  );
  const open = report?.findings.filter((f) => f.severity !== "info").length ?? 0;
  return (
    <Card
      title="Security"
      icon={ShieldCheck}
      action={<CardLink onClick={() => setCenterTab("security")}>Open</CardLink>}
    >
      {score ? (
        <Stat
          value={score.overall}
          unit={`/100 · ${score.grade}${score.blocksRelease ? " · blocks release" : ""}`}
          tone={score.blocksRelease ? "text-danger" : undefined}
        />
      ) : (
        <p className="text-xs text-subtle">Not checked yet. Scan the project to get a score.</p>
      )}
      {report && (
        <p className="mt-2 text-[11px] text-muted">
          {open === 0
            ? "No open findings."
            : `${plural(open, "open finding")}: ${counts
                .filter(([, n]) => n > 0)
                .map(([s, n]) => `${n} ${s}`)
                .join(", ")}`}
          <span className="text-subtle"> · scanned {formatRelative(report.at)}</span>
        </p>
      )}
    </Card>
  );
}

function UxCard({ projectId }: { projectId: string }) {
  const enabled = useEngine((s) => s.status === "open");
  const setCenterTab = useUi((s) => s.setCenterTab);
  const scores = useQuery({
    queryKey: ["scores", projectId],
    queryFn: () => call("scores.get", { projectId }),
    enabled,
  });
  const ux = scores.data?.ux ?? null;
  return (
    <Card
      title="UX score"
      icon={Palette}
      action={<CardLink onClick={() => setCenterTab("design")}>Open</CardLink>}
    >
      {ux ? (
        <>
          <Stat
            value={ux.overall}
            unit={`/100 · ${ux.grade}`}
            tone={ux.blocksRelease ? "text-danger" : undefined}
          />
          <p className="mt-2 text-[11px] text-subtle">Scored {formatRelative(ux.at)}</p>
        </>
      ) : (
        <p className="text-xs text-subtle">
          No score yet. The UI/UX Design agent scores the screens when it reviews them.
        </p>
      )}
    </Card>
  );
}

function CodeSizeCard({ projectId, overview }: { projectId: string; overview: Overview }) {
  const enabled = useEngine((s) => s.status === "open") && overview.index.state !== "disabled";
  // Shares the code map's query, so the home asks for the map once.
  const map = useQuery({
    queryKey: ["codemap", projectId, "module"],
    queryFn: () => call("codemap.get", { projectId, level: "module" }),
    enabled,
  });
  const s = map.data?.summary;
  const shares = languageShares(s?.languages ?? []);
  return (
    <Card title="Code size" icon={FileCode2}>
      {s && s.files > 0 ? (
        <>
          <Stat value={compactNumber(s.lines)} unit={`lines in ${plural(s.files, "file")}`} />
          <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-hover" aria-hidden>
            {shares.map((l, i) => (
              <span
                key={l.name}
                className={cn("h-full", AGENT_BG[LANGUAGE_TONES[i % LANGUAGE_TONES.length] ?? "docs"])}
                style={{ width: `${Math.max(2, l.share * 100)}%` }}
              />
            ))}
          </div>
          <ul aria-label="Languages" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
            {shares.map((l, i) => (
              <li key={l.name} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "size-2 rounded-sm",
                    AGENT_BG[LANGUAGE_TONES[i % LANGUAGE_TONES.length] ?? "docs"],
                  )}
                  aria-hidden
                />
                {l.name} <span className="text-subtle tabular-nums">{Math.round(l.share * 100)}%</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-xs text-subtle">
          {overview.index.state === "disabled"
            ? "The code index is off for this project."
            : overview.index.state === "indexing"
              ? "Counting the code…"
              : "No source files yet."}
        </p>
      )}
    </Card>
  );
}
