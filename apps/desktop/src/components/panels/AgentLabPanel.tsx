import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Play, RotateCcw, Upload } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";

type Section = "versions" | "edit" | "checks" | "compare" | "try";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "versions", label: "Versions" },
  { id: "edit", label: "Edit" },
  { id: "checks", label: "Checks" },
  { id: "compare", label: "Compare" },
  { id: "try", label: "Try it" },
];

type AgentId = Parameters<typeof call<"lab.versions">>[1]["agentId"];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AgentLabPanel() {
  const status = useEngine((s) => s.status);
  const enabled = status === "open";
  const agents = useQuery({ queryKey: ["lab", "agents"], queryFn: () => call("lab.agents", {}), enabled });
  const [agentId, setAgentId] = useState<AgentId>("backend");
  const [section, setSection] = useState<Section>("versions");
  const current = agents.data?.agents.find((a) => a.id === agentId);

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Agents" className="w-56 shrink-0 overflow-y-auto border-r border-border p-2">
        <h1 className="flex items-center gap-2 px-2 py-2 text-sm font-semibold text-fg">
          <FlaskConical className="size-4 text-accent" aria-hidden /> Agent Lab
        </h1>
        <ul className="flex flex-col gap-0.5">
          {(agents.data?.agents ?? []).map((a) => (
            <li key={a.id}>
              <button
                type="button"
                aria-current={a.id === agentId ? "true" : undefined}
                onClick={() => setAgentId(a.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover",
                  a.id === agentId ? "bg-hover text-fg" : "text-muted",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="text-[11px] text-subtle">
                  {a.activeVersion}
                  {a.lastScore !== null ? ` · ${Math.round(a.lastScore)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6">
          <header>
            <h2 className="text-lg font-semibold text-fg">{current?.name ?? agentId}</h2>
            <p className="text-xs text-muted">
              Change an agent, test it, compare versions, and use the better one. Nothing changes for your
              projects until you promote a version, and you can roll back at any time.
            </p>
          </header>
          <div role="tablist" aria-label="Lab sections" className="flex gap-1 border-b border-border">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                role="tab"
                type="button"
                aria-selected={section === s.id}
                onClick={() => setSection(s.id)}
                className={cn(
                  "-mb-px border-b-2 px-3 py-1.5 text-[13px]",
                  section === s.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          {section === "versions" && <Versions agentId={agentId} />}
          {section === "edit" && <Edit agentId={agentId} onSaved={() => setSection("versions")} />}
          {section === "checks" && <Checks agentId={agentId} />}
          {section === "compare" && <Compare agentId={agentId} />}
          {section === "try" && <TryIt agentId={agentId} />}
        </div>
      </div>
    </div>
  );
}

function useVersions(agentId: AgentId) {
  const status = useEngine((s) => s.status);
  return useQuery({
    queryKey: ["lab", "versions", agentId],
    queryFn: () => call("lab.versions", { agentId }),
    enabled: status === "open",
  });
}

function Versions({ agentId }: { agentId: AgentId }) {
  const qc = useQueryClient();
  const q = useVersions(agentId);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["lab"] });
  };
  const [error, setError] = useState("");
  const [shared, setShared] = useState("");
  const [importText, setImportText] = useState("");
  const wrap = <T,>(fn: () => Promise<T>) =>
    fn().then(
      () => {
        setError("");
        refresh();
      },
      (e: unknown) => setError(errText(e)),
    );

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="rounded-md border border-danger/40 p-2 text-xs text-danger">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {(q.data?.versions ?? []).map((v) => (
          <li key={v.id ?? "builtin"} className="rounded-lg border border-border bg-panel p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-fg">Version {v.version}</span>
              {v.active && (
                <span className="rounded-full border border-success/50 px-2 py-0.5 text-[11px] text-success">
                  in use
                </span>
              )}
              <span className="text-xs text-subtle">
                {v.source === "builtin" ? "ships with Depo" : v.source === "import" ? "imported" : "yours"}
              </span>
              <span className="ml-auto text-xs text-muted">
                {v.lastScore === null ? "not tested" : `last test ${Math.round(v.lastScore)}/100`}
              </span>
            </div>
            {v.note && <p className="mt-1 text-xs text-muted">{v.note}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {!v.active && (
                <Button
                  size="sm"
                  onClick={() => wrap(() => call("lab.promote", { agentId, versionId: v.id }))}
                >
                  Use this version
                </Button>
              )}
              {!v.active && v.id !== null && (
                <Button
                  size="sm"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Use version ${v.version} even though it was not tested or scores lower?`,
                      )
                    )
                      void wrap(() => call("lab.promote", { agentId, versionId: v.id, force: true }));
                  }}
                >
                  Use anyway
                </Button>
              )}
              <Button
                size="sm"
                onClick={() =>
                  void call("lab.export", { agentId, versionId: v.id }).then(
                    (r) => setShared(r.json),
                    (e: unknown) => setError(errText(e)),
                  )
                }
              >
                Share
              </Button>
              {v.id !== null && !v.active && (
                <Button
                  size="sm"
                  onClick={() => {
                    if (window.confirm(`Delete version ${v.version}?`))
                      void wrap(() => call("lab.deleteVersion", { agentId, versionId: v.id as string }));
                  }}
                >
                  Delete
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div>
        <Button size="sm" onClick={() => wrap(() => call("lab.rollback", { agentId }))}>
          <RotateCcw aria-hidden /> Go back to the previous version
        </Button>
      </div>
      {(q.data?.history ?? []).length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">History</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {q.data?.history.map((h) => (
              <li key={`${h.at}-${h.version}`}>
                {new Date(h.at).toLocaleString()} — {h.version} ({h.reason})
              </li>
            ))}
          </ul>
        </details>
      )}
      {shared && (
        <div>
          <label htmlFor="share-json" className="mb-1 block text-xs text-muted">
            Copy this and send it to someone. They paste it under "Import" below.
          </label>
          <textarea
            id="share-json"
            readOnly
            value={shared}
            rows={8}
            className="w-full rounded-md border border-border bg-bg p-2 font-mono text-xs text-fg"
          />
        </div>
      )}
      <section aria-labelledby="imp" className="rounded-lg border border-border bg-panel p-3">
        <h3 id="imp" className="text-sm font-semibold text-fg">
          Import an agent file
        </h3>
        <p className="mb-2 text-xs text-muted">
          It is scanned first and saved as a new version that is not used until you test and promote it.
        </p>
        <textarea
          aria-label="Agent file"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={4}
          className="w-full rounded-md border border-border bg-bg p-2 font-mono text-xs text-fg"
        />
        <Button
          size="sm"
          className="mt-2"
          disabled={importText.trim().length < 2}
          onClick={() =>
            void wrap(() => call("lab.import", { json: importText })).then(() => setImportText(""))
          }
        >
          <Upload aria-hidden /> Import
        </Button>
      </section>
    </div>
  );
}

function Edit({ agentId, onSaved }: { agentId: AgentId; onSaved: () => void }) {
  const qc = useQueryClient();
  const q = useVersions(agentId);
  const base = q.data?.versions.find((v) => v.active)?.manifest ?? q.data?.versions[0]?.manifest;
  const [draft, setDraft] = useState<{ prompt?: string; mission?: string; maxSteps?: number; note?: string }>(
    {},
  );
  const save = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = {};
      if (draft.prompt !== undefined && draft.prompt !== base?.prompt) patch.prompt = draft.prompt;
      if (draft.mission !== undefined && draft.mission !== base?.mission) patch.mission = draft.mission;
      if (draft.maxSteps !== undefined && draft.maxSteps !== base?.maxSteps) patch.maxSteps = draft.maxSteps;
      return call("lab.createVersion", { agentId, patch, note: draft.note ?? "" });
    },
    onSuccess: () => {
      setDraft({});
      void qc.invalidateQueries({ queryKey: ["lab"] });
      onSaved();
    },
  });
  if (!base) return null;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-xs text-muted">
        You are editing a copy of the version in use ({base.version}). Tools and file access stay as they are.
      </p>
      <label className="text-xs text-muted">
        Mission
        <input
          value={draft.mission ?? base.mission}
          onChange={(e) => setDraft({ ...draft, mission: e.target.value })}
          className="mt-1 h-9 w-full rounded-md border border-border bg-bg px-3 text-[13px] text-fg"
        />
      </label>
      <label className="text-xs text-muted">
        Instructions
        <textarea
          value={draft.prompt ?? base.prompt}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          rows={14}
          className="mt-1 w-full rounded-md border border-border bg-bg p-3 font-mono text-xs text-fg"
        />
      </label>
      <label className="text-xs text-muted">
        Most steps per task
        <input
          type="number"
          min={1}
          max={200}
          value={draft.maxSteps ?? base.maxSteps}
          onChange={(e) => setDraft({ ...draft, maxSteps: Number(e.target.value) })}
          className="mt-1 h-9 w-28 rounded-md border border-border bg-bg px-3 text-[13px] text-fg"
        />
      </label>
      <label className="text-xs text-muted">
        What did you change?
        <input
          value={draft.note ?? ""}
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          className="mt-1 h-9 w-full rounded-md border border-border bg-bg px-3 text-[13px] text-fg"
        />
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save as a new version
        </Button>
        {save.isError && (
          <span role="alert" className="text-xs text-danger">
            {errText(save.error)}
          </span>
        )}
      </div>
    </form>
  );
}

function Checks({ agentId }: { agentId: AgentId }) {
  const qc = useQueryClient();
  const status = useEngine((s) => s.status);
  const versions = useVersions(agentId);
  const suites = useQuery({
    queryKey: ["lab", "suites", agentId],
    queryFn: () => call("lab.suites", { agentId }),
    enabled: status === "open",
  });
  const runs = useQuery({
    queryKey: ["lab", "runs", agentId],
    queryFn: () => call("lab.runs", { agentId }),
    enabled: status === "open",
  });
  const [versionId, setVersionId] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (suiteId: string) => call("lab.runEval", { agentId, versionId, suiteId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["lab"] }),
  });
  const [form, setForm] = useState({ name: "", prompt: "", type: "contains" as const, value: "" });
  const [type, setType] = useState<"contains" | "not_contains" | "regex" | "json" | "max_chars" | "judge">(
    "contains",
  );
  const add = useMutation({
    mutationFn: () =>
      call("lab.saveSuite", {
        agentId,
        name: form.name.trim(),
        cases: [{ id: "case-1", prompt: form.prompt.trim(), checks: [{ type, value: form.value }] }],
      }),
    onSuccess: () => {
      setForm({ name: "", prompt: "", type: "contains", value: "" });
      void qc.invalidateQueries({ queryKey: ["lab"] });
    },
  });
  const latest = run.data ?? null;
  return (
    <div className="flex flex-col gap-4">
      <label className="text-xs text-muted">
        Test this version
        <select
          value={versionId ?? ""}
          onChange={(e) => setVersionId(e.target.value || null)}
          className="mt-1 block h-9 rounded-md border border-border bg-bg px-2 text-[13px] text-fg"
        >
          {(versions.data?.versions ?? []).map((v) => (
            <option key={v.id ?? "builtin"} value={v.id ?? ""}>
              {v.version}
              {v.active ? " (in use)" : ""}
            </option>
          ))}
        </select>
      </label>
      <ul className="flex flex-col gap-2">
        {(suites.data?.suites ?? []).map((s) => (
          <li key={s.id} className="rounded-lg border border-border bg-panel p-3">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-fg">{s.name}</span>
              <span className="text-xs text-subtle">{s.cases.length} checks</span>
              <Button size="sm" className="ml-auto" disabled={run.isPending} onClick={() => run.mutate(s.id)}>
                <Play aria-hidden /> {run.isPending && run.variables === s.id ? "Running…" : "Run"}
              </Button>
              {!s.builtin && (
                <Button
                  size="sm"
                  onClick={() =>
                    void call("lab.deleteSuite", { agentId, suiteId: s.id }).then(() =>
                      qc.invalidateQueries({ queryKey: ["lab"] }),
                    )
                  }
                >
                  Delete
                </Button>
              )}
            </div>
            <ul className="mt-1 list-disc pl-5 text-xs text-muted">
              {s.cases.map((c) => (
                <li key={c.id}>{c.prompt.slice(0, 110)}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {run.isError && (
        <p role="alert" className="text-xs text-danger">
          {errText(run.error)}
        </p>
      )}
      {latest && (
        <section aria-label="Result" className="rounded-lg border border-border bg-panel p-3">
          <h3 className="text-sm font-semibold text-fg">
            Result: {Math.round(latest.score)}/100{" "}
            <span className="font-normal text-muted">({latest.model})</span>
          </h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {latest.results.map((r) => (
              <li key={r.caseId} className="text-xs">
                <span className={r.passed ? "text-success" : "text-danger"}>
                  {r.passed ? "Passed" : "Failed"}
                </span>{" "}
                <span className="text-fg">{r.caseId}</span>
                <ul className="pl-4 text-muted">
                  {r.checks.map((c) => (
                    <li key={`${c.type}-${c.value}-${c.detail}`}>
                      {c.passed ? "✓" : "✗"} {c.detail}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="newsuite" className="rounded-lg border border-border bg-panel p-3">
        <h3 id="newsuite" className="mb-2 text-sm font-semibold text-fg">
          Write your own check
        </h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            aria-label="Name of the checks"
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="h-9 rounded-md border border-border bg-bg px-3 text-[13px] text-fg"
          />
          <select
            aria-label="What to look for"
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
            className="h-9 rounded-md border border-border bg-bg px-2 text-[13px] text-fg"
          >
            <option value="contains">Reply contains</option>
            <option value="not_contains">Reply does not contain</option>
            <option value="regex">Reply matches pattern</option>
            <option value="json">Reply has valid JSON</option>
            <option value="max_chars">Reply is at most N characters</option>
            <option value="judge">A model judges: criterion</option>
          </select>
          <textarea
            aria-label="What to ask the agent"
            placeholder="What to ask the agent"
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            rows={3}
            className="rounded-md border border-border bg-bg p-2 text-[13px] text-fg sm:col-span-2"
          />
          <input
            aria-label="Value"
            placeholder="Text, pattern, number or criterion"
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            className="h-9 rounded-md border border-border bg-bg px-3 text-[13px] text-fg sm:col-span-2"
          />
        </div>
        <div className="mt-2 flex items-center gap-3">
          <Button
            size="sm"
            disabled={!form.name.trim() || !form.prompt.trim() || add.isPending}
            onClick={() => add.mutate()}
          >
            Save checks
          </Button>
          {add.isError && (
            <span role="alert" className="text-xs text-danger">
              {errText(add.error)}
            </span>
          )}
        </div>
      </section>
      {(runs.data?.runs ?? []).length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Earlier runs</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {runs.data?.runs.slice(0, 20).map((r) => (
              <li key={r.id}>
                {new Date(r.createdAt).toLocaleString()} — version {r.version}: {Math.round(r.score)}/100
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Compare({ agentId }: { agentId: AgentId }) {
  const status = useEngine((s) => s.status);
  const versions = useVersions(agentId);
  const suites = useQuery({
    queryKey: ["lab", "suites", agentId],
    queryFn: () => call("lab.suites", { agentId }),
    enabled: status === "open",
  });
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null | undefined>(undefined);
  const [suiteId, setSuiteId] = useState("");
  const vs = versions.data?.versions ?? [];
  const bVal = b === undefined ? (vs[1]?.id ?? null) : b;
  const sid = suiteId || suites.data?.suites[0]?.id || "";
  const cmp = useMutation({ mutationFn: () => call("lab.compare", { agentId, a, b: bVal, suiteId: sid }) });
  const sel = (value: string | null, set: (v: string | null) => void, label: string) => (
    <label className="text-xs text-muted">
      {label}
      <select
        value={value ?? ""}
        onChange={(e) => set(e.target.value || null)}
        className="mt-1 block h-9 rounded-md border border-border bg-bg px-2 text-[13px] text-fg"
      >
        {vs.map((v) => (
          <option key={v.id ?? "builtin"} value={v.id ?? ""}>
            {v.version}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        {sel(a, setA, "Version A")}
        {sel(bVal, setB, "Version B")}
        <label className="text-xs text-muted">
          Checks
          <select
            value={sid}
            onChange={(e) => setSuiteId(e.target.value)}
            className="mt-1 block h-9 rounded-md border border-border bg-bg px-2 text-[13px] text-fg"
          >
            {(suites.data?.suites ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" disabled={cmp.isPending || a === bVal} onClick={() => cmp.mutate()}>
          {cmp.isPending ? "Comparing…" : "Compare"}
        </Button>
      </div>
      {cmp.isError && (
        <p role="alert" className="text-xs text-danger">
          {errText(cmp.error)}
        </p>
      )}
      {cmp.data && (
        <section aria-label="Comparison" className="rounded-lg border border-border bg-panel p-3">
          <h3 className="text-sm font-semibold text-fg">
            {cmp.data.winner === "tie"
              ? "It is a tie"
              : `Version ${cmp.data.winner === "a" ? cmp.data.a.version : cmp.data.b.version} did better`}
            : {Math.round(cmp.data.a.score)} against {Math.round(cmp.data.b.score)}
          </h3>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1">Check</th>
                <th>A ({cmp.data.a.version})</th>
                <th>B ({cmp.data.b.version})</th>
              </tr>
            </thead>
            <tbody>
              {cmp.data.cases.map((c) => (
                <tr key={c.caseId} className="border-t border-border">
                  <td className="py-1 text-fg">{c.caseId}</td>
                  <td className={c.a ? "text-success" : "text-danger"}>{c.a ? "Passed" : "Failed"}</td>
                  <td className={c.b ? "text-success" : "text-danger"}>{c.b ? "Passed" : "Failed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function TryIt({ agentId }: { agentId: AgentId }) {
  const versions = useVersions(agentId);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [log, setLog] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const send = useMutation({
    mutationFn: (messages: typeof log) => call("lab.playground", { agentId, versionId, messages }),
    onSuccess: (r) => setLog((l) => [...l, { role: "assistant", content: r.reply }]),
  });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        Talk to the agent directly. It answers with its instructions only: no tools, no project files.
      </p>
      <label className="text-xs text-muted">
        Version
        <select
          value={versionId ?? ""}
          onChange={(e) => {
            setVersionId(e.target.value || null);
            setLog([]);
          }}
          className="mt-1 block h-9 rounded-md border border-border bg-bg px-2 text-[13px] text-fg"
        >
          {(versions.data?.versions ?? []).map((v) => (
            <option key={v.id ?? "builtin"} value={v.id ?? ""}>
              {v.version}
            </option>
          ))}
        </select>
      </label>
      <ul aria-live="polite" className="flex flex-col gap-2">
        {log.map((m, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: an append-only transcript
            key={i}
            className={cn(
              "max-w-[85%] rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap",
              m.role === "user"
                ? "self-end bg-hover text-fg"
                : "self-start border border-border bg-panel text-fg",
            )}
          >
            {m.content}
          </li>
        ))}
        {send.isPending && <li className="text-xs text-muted">Thinking…</li>}
      </ul>
      {send.isError && (
        <p role="alert" className="text-xs text-danger">
          {errText(send.error)}
        </p>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim() || send.isPending) return;
          const next = [...log, { role: "user" as const, content: text.trim() }];
          setLog(next);
          setText("");
          send.mutate(next);
        }}
      >
        <input
          aria-label="Message to the agent"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 text-[13px] text-fg"
        />
        <Button type="submit" variant="primary" disabled={!text.trim() || send.isPending}>
          Send
        </Button>
      </form>
    </div>
  );
}
