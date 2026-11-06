import type { McpServerDto, SkillDto, VetReportDto } from "@depo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, PlugZap, Puzzle, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

type Sub = "skills" | "mcp";

export function SkillsPanel() {
  const [sub, setSub] = useState<Sub>("skills");
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-6 py-6">
        <header className="flex items-center gap-3">
          <Puzzle className="size-5 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold text-fg">Skills and tools</h1>
          <div role="tablist" aria-label="Skills section" className="ml-auto flex gap-1">
            {(["skills", "mcp"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={sub === s}
                onClick={() => setSub(s)}
                className={cn(
                  "h-8 rounded-md px-3 text-xs",
                  sub === s ? "bg-hover text-fg" : "text-muted hover:text-fg",
                )}
              >
                {s === "skills" ? "Skills" : "MCP servers"}
              </button>
            ))}
          </div>
        </header>
        {sub === "skills" ? <SkillsSection /> : <McpSection />}
      </div>
    </div>
  );
}

function Verdict({ report }: { report: VetReportDto | null }) {
  if (!report) return <span className="text-xs text-subtle">Not tested</span>;
  const tone =
    report.verdict === "clean"
      ? "text-success"
      : report.verdict === "warnings"
        ? "text-warning"
        : "text-danger";
  const Icon =
    report.verdict === "clean" ? ShieldCheck : report.verdict === "warnings" ? AlertTriangle : ShieldAlert;
  const text =
    report.verdict === "clean"
      ? "Scan clean"
      : report.verdict === "warnings"
        ? "Warnings"
        : "Blocked by scan";
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", tone)} data-testid="verdict">
      <Icon className="size-3.5" aria-hidden /> {text}
    </span>
  );
}

function Report({ report }: { report: VetReportDto }) {
  if (report.findings.length === 0)
    return <p className="mt-2 text-xs text-muted">No problems found in {report.files} file(s).</p>;
  return (
    <ul className="mt-2 flex flex-col gap-1 rounded-md border border-border bg-bg p-2 text-xs">
      {report.findings.map((f) => (
        <li key={`${f.rule}-${f.file}-${f.line}`} className="flex gap-2">
          <span
            className={cn(
              "w-14 shrink-0 font-medium uppercase",
              f.severity === "high" ? "text-danger" : f.severity === "medium" ? "text-warning" : "text-muted",
            )}
          >
            {f.severity}
          </span>
          <span className="min-w-0 text-muted">
            <span className="font-mono text-fg">
              {f.file}
              {f.line ? `:${f.line}` : ""}
            </span>{" "}
            {f.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SkillsSection() {
  const status = useEngine((s) => s.status);
  const qc = useQueryClient();
  const projectId = useUi((s) => s.projectId);
  const list = useQuery({
    queryKey: ["skills"],
    queryFn: () => call("skills.list", {}),
    enabled: status === "open",
  });
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => call("agents.list", {}),
    enabled: status === "open",
  });
  const updates = useQuery({
    queryKey: ["skills", "updates"],
    queryFn: () => call("skills.checkUpdates", {}),
    enabled: false,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["skills"] });

  const [source, setSource] = useState("");
  const preview = useMutation({ mutationFn: () => call("skills.preview", { source: source.trim() }) });
  const [picked, setPicked] = useState<string[]>([]);
  const install = useMutation({
    mutationFn: (stagingId: string) => call("skills.install", { stagingId, select: picked }),
    onSuccess: () => {
      preview.reset();
      setSource("");
      setPicked([]);
      refresh();
    },
  });
  const pv = preview.data;

  return (
    <>
      <section aria-labelledby="inst" className="rounded-lg border border-border bg-panel p-4">
        <h2 id="inst" className="text-sm font-semibold text-fg">
          Install a skill
        </h2>
        <p className="mt-1 text-xs text-muted">
          A skill is a folder with a SKILL.md. Paste a GitHub address (a repository or a folder in it), or the
          path of a .zip file or a folder on this PC. Nothing is enabled until you have read the security
          scan.
        </p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (source.trim()) preview.mutate();
          }}
        >
          <label htmlFor="skill-source" className="sr-only">
            Skill source
          </label>
          <input
            id="skill-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="https://github.com/owner/repo  ·  C:\skills\my-skill  ·  skills.zip"
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 text-[13px] text-fg outline-none focus:border-accent"
          />
          <Button type="submit" disabled={!source.trim() || preview.isPending}>
            {preview.isPending ? "Looking…" : "Look"}
          </Button>
        </form>
        {preview.isError && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {(preview.error as Error).message}
          </p>
        )}
        {pv && (
          <div className="mt-3">
            <p className="text-xs text-muted">
              Found {pv.candidates.length} skill{pv.candidates.length === 1 ? "" : "s"}
              {pv.commit ? ` at commit ${pv.commit.slice(0, 8)}` : ""}. Choose what to install:
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {pv.candidates.map((c) => (
                <li key={c.path}>
                  <label className="flex items-start gap-2 rounded-md border border-border bg-bg px-3 py-2 text-[13px]">
                    <input
                      type="checkbox"
                      disabled={!!c.error}
                      checked={picked.includes(c.path) || (pv.candidates.length === 1 && !c.error)}
                      onChange={(e) =>
                        setPicked((p) => (e.target.checked ? [...p, c.path] : p.filter((x) => x !== c.path)))
                      }
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="font-medium text-fg">{c.name}</span>
                      {c.installed && (
                        <span className="ml-2 text-xs text-subtle">(already installed: updates it)</span>
                      )}
                      <span className="block text-xs text-muted">{c.error ?? c.description}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                disabled={install.isPending || (pv.candidates.length > 1 && picked.length === 0)}
                onClick={() => install.mutate(pv.stagingId)}
              >
                Install
              </Button>
              <Button
                onClick={() => {
                  void call("skills.discard", { stagingId: pv.stagingId });
                  preview.reset();
                }}
              >
                Cancel
              </Button>
            </div>
            {install.isError && (
              <p role="alert" className="mt-2 text-xs text-danger">
                {(install.error as Error).message}
              </p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="have" className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 id="have" className="text-sm font-semibold text-fg">
            Installed skills
          </h2>
          <Button size="sm" className="ml-auto" onClick={() => void updates.refetch()}>
            Check for updates
          </Button>
        </div>
        {(list.data?.skills ?? []).length === 0 && (
          <p className="text-[13px] text-muted">No skills installed yet.</p>
        )}
        {(list.data?.skills ?? []).map((s) => (
          <SkillCard
            key={s.id}
            skill={s}
            projectId={projectId}
            agentIds={(agents.data?.agents ?? []).map((a) => a.id)}
            update={updates.data?.updates.find((u) => u.id === s.id)?.available ?? false}
            onChange={refresh}
          />
        ))}
      </section>

      <CreateSkill onDone={refresh} />
    </>
  );
}

function SkillCard({
  skill,
  projectId,
  agentIds,
  update,
  onChange,
}: {
  skill: SkillDto;
  projectId: string | null;
  agentIds: string[];
  update: boolean;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const run = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: onChange,
  });
  const blocked = skill.vetting.verdict === "blocked";
  const all = skill.assignments.some((a) => a.scope === "global" && a.agent === "*");
  const global = skill.assignments.filter((a) => a.scope === "global").map((a) => a.agent);
  return (
    <article className="rounded-lg border border-border bg-panel p-4" aria-label={`Skill ${skill.name}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-fg">{skill.name}</h3>
        <Verdict report={skill.vetting} />
        <span className="text-xs text-subtle">
          {skill.sourceKind} · version {skill.versionId}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant={skill.enabled ? "secondary" : "primary"}
            disabled={run.isPending}
            onClick={() => {
              if (
                !skill.enabled &&
                blocked &&
                !window.confirm(`The scan found serious problems in "${skill.name}". Enable it anyway?`)
              )
                return;
              run.mutate(() =>
                call("skills.setEnabled", { id: skill.id, enabled: !skill.enabled, force: blocked }),
              );
            }}
          >
            {skill.enabled ? (
              <>
                <Check aria-hidden /> Enabled
              </>
            ) : (
              "Enable"
            )}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-[13px] text-muted">{skill.description}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "Hide" : "Show"} security report ({skill.vetting.findings.length})
        </button>
        {update && (
          <Button size="sm" onClick={() => run.mutate(() => call("skills.update", { id: skill.id }))}>
            Update available: install
          </Button>
        )}
        {skill.versions.length > 1 && (
          <Button size="sm" onClick={() => run.mutate(() => call("skills.rollback", { id: skill.id }))}>
            Roll back
          </Button>
        )}
        <Button
          size="sm"
          onClick={() => {
            if (window.confirm(`Remove the skill "${skill.name}"?`))
              run.mutate(() => call("skills.remove", { id: skill.id }));
          }}
        >
          <Trash2 aria-hidden /> Remove
        </Button>
      </div>
      {open && <Report report={skill.vetting} />}
      {skill.enabled && (
        <fieldset className="mt-3 rounded-md border border-border p-2">
          <legend className="px-1 text-xs text-subtle">Which agents use it (everywhere)</legend>
          <label className="mr-3 inline-flex items-center gap-1.5 text-xs text-fg">
            <input
              type="checkbox"
              checked={all}
              onChange={(e) =>
                run.mutate(() =>
                  call("skills.assign", {
                    id: skill.id,
                    scope: "global",
                    agents: e.target.checked ? ["*"] : ["coder"],
                  }),
                )
              }
            />
            All agents
          </label>
          {!all &&
            ["coder", ...agentIds].map((a) => (
              <label key={a} className="mr-3 inline-flex items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={global.includes(a)}
                  onChange={(e) =>
                    run.mutate(() =>
                      call("skills.assign", {
                        id: skill.id,
                        scope: "global",
                        agents: e.target.checked ? [...global, a] : global.filter((x) => x !== a),
                      }),
                    )
                  }
                />
                {a}
              </label>
            ))}
          {projectId && (
            <p className="mt-2 text-[11px] text-subtle">
              Project-only assignments use the same list for the open project:
              <Button
                size="sm"
                className="ml-2"
                onClick={() =>
                  run.mutate(() =>
                    call("skills.assign", { id: skill.id, scope: "project", projectId, agents: ["*"] }),
                  )
                }
              >
                Also assign to all agents in this project
              </Button>
            </p>
          )}
        </fieldset>
      )}
      {run.isError && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {(run.error as Error).message}
        </p>
      )}
    </article>
  );
}

function CreateSkill({ onDone }: { onDone: () => void }) {
  const [workflow, setWorkflow] = useState("");
  const [draft, setDraft] = useState<{ name: string; description: string; instructions: string } | null>(
    null,
  );
  const make = useMutation({
    mutationFn: () => call("skills.draft", { workflow: workflow.trim() }),
    onSuccess: setDraft,
  });
  const save = useMutation({
    mutationFn: () => call("skills.create", draft ?? { name: "", description: "", instructions: "" }),
    onSuccess: () => {
      setDraft(null);
      setWorkflow("");
      onDone();
    },
  });
  return (
    <section aria-labelledby="create" className="rounded-lg border border-border bg-panel p-4">
      <h2 id="create" className="text-sm font-semibold text-fg">
        Create a skill
      </h2>
      <p className="mt-1 text-xs text-muted">
        Describe a workflow you repeat; Depo drafts a skill you can edit and save.
      </p>
      <textarea
        aria-label="Describe the workflow"
        rows={2}
        value={workflow}
        onChange={(e) => setWorkflow(e.target.value)}
        placeholder="e.g. Review a pull request: check tests, naming, security, then write a summary"
        className="mt-2 w-full resize-none rounded-md border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
      />
      <Button
        className="mt-2"
        disabled={workflow.trim().length < 3 || make.isPending}
        onClick={() => make.mutate()}
      >
        {make.isPending ? "Drafting…" : "Draft with the local model"}
      </Button>
      {make.isError && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {(make.error as Error).message}
        </p>
      )}
      {draft && (
        <div className="mt-3 flex flex-col gap-2">
          <input
            aria-label="Skill name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="h-9 rounded-md border border-border bg-bg px-3 font-mono text-[13px] text-fg"
          />
          <input
            aria-label="Skill description"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            className="h-9 rounded-md border border-border bg-bg px-3 text-[13px] text-fg"
          />
          <textarea
            aria-label="Skill instructions"
            rows={10}
            value={draft.instructions}
            onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            className="rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs text-fg"
          />
          <div className="flex gap-2">
            <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
              Save skill
            </Button>
            <Button onClick={() => setDraft(null)}>Discard</Button>
          </div>
          {save.isError && (
            <p role="alert" className="text-xs text-danger">
              {(save.error as Error).message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function McpSection() {
  const status = useEngine((s) => s.status);
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["mcp"],
    queryFn: () => call("mcp.list", {}),
    enabled: status === "open",
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["mcp"] });
  const [form, setForm] = useState({
    name: "",
    transport: "stdio" as "stdio" | "http",
    command: "",
    args: "",
    url: "",
  });
  const add = useMutation({
    mutationFn: () =>
      call("mcp.add", {
        name: form.name.trim(),
        transport: form.transport,
        ...(form.transport === "stdio"
          ? { command: form.command.trim(), args: form.args.trim() ? form.args.trim().split(/\s+/) : [] }
          : { url: form.url.trim() }),
      }),
    onSuccess: () => {
      setForm({ name: "", transport: "stdio", command: "", args: "", url: "" });
      refresh();
    },
  });
  return (
    <>
      <section aria-labelledby="mcp-add" className="rounded-lg border border-border bg-panel p-4">
        <h2 id="mcp-add" className="flex items-center gap-2 text-sm font-semibold text-fg">
          <PlugZap className="size-4 text-accent" aria-hidden /> Add an MCP server
        </h2>
        <p className="mt-1 text-xs text-muted">
          MCP servers give agents extra tools (files, git, databases, browsers). Only local programs and local
          addresses are allowed. Depo connects, lists the tools and scans them before you can enable the
          server.
        </p>
        <form
          className="mt-3 grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <input
            aria-label="Server name"
            placeholder="name (lowercase)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="h-9 rounded-md border border-border bg-bg px-3 text-[13px] text-fg"
          />
          <select
            aria-label="Transport"
            value={form.transport}
            onChange={(e) => setForm({ ...form, transport: e.target.value as "stdio" | "http" })}
            className="h-9 rounded-md border border-border bg-bg px-2 text-[13px] text-fg"
          >
            <option value="stdio">Local program (stdio)</option>
            <option value="http">Local address (HTTP)</option>
          </select>
          {form.transport === "stdio" ? (
            <>
              <input
                aria-label="Command"
                placeholder="command, e.g. npx"
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
                className="h-9 rounded-md border border-border bg-bg px-3 font-mono text-[13px] text-fg"
              />
              <input
                aria-label="Arguments"
                placeholder="arguments, e.g. -y @modelcontextprotocol/server-filesystem C:\work"
                value={form.args}
                onChange={(e) => setForm({ ...form, args: e.target.value })}
                className="h-9 rounded-md border border-border bg-bg px-3 font-mono text-[13px] text-fg"
              />
            </>
          ) : (
            <input
              aria-label="Server address"
              placeholder="http://127.0.0.1:8000/mcp"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              className="h-9 rounded-md border border-border bg-bg px-3 font-mono text-[13px] text-fg sm:col-span-2"
            />
          )}
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" disabled={!form.name.trim() || add.isPending}>
              Add server
            </Button>
          </div>
        </form>
        {add.isError && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {(add.error as Error).message}
          </p>
        )}
      </section>
      <section aria-label="MCP servers" className="flex flex-col gap-3">
        {(list.data?.servers ?? []).length === 0 && (
          <p className="text-[13px] text-muted">No MCP servers yet.</p>
        )}
        {(list.data?.servers ?? []).map((s) => (
          <ServerCard key={s.id} server={s} onChange={refresh} />
        ))}
      </section>
    </>
  );
}

function ServerCard({ server, onChange }: { server: McpServerDto; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const run = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn(), onSuccess: onChange });
  const blocked = server.vetting?.verdict === "blocked";
  return (
    <article
      className="rounded-lg border border-border bg-panel p-4"
      aria-label={`MCP server ${server.name}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-fg">{server.name}</h3>
        <Verdict report={server.vetting} />
        <span className="text-xs text-subtle">
          {server.transport === "stdio"
            ? `${server.command ?? ""} ${server.args.join(" ")}`.trim()
            : server.url}{" "}
          · {server.tools.length} tools · {server.status}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            disabled={run.isPending}
            onClick={() => run.mutate(() => call("mcp.test", { id: server.id }))}
          >
            {run.isPending ? "Working…" : "Test and scan"}
          </Button>
          <Button
            size="sm"
            variant={server.enabled ? "secondary" : "primary"}
            disabled={run.isPending || (!server.enabled && !server.vetting)}
            onClick={() => {
              if (
                !server.enabled &&
                blocked &&
                !window.confirm("The scan found serious problems with this server. Enable it anyway?")
              )
                return;
              run.mutate(() =>
                call("mcp.setEnabled", { id: server.id, enabled: !server.enabled, force: blocked }),
              );
            }}
          >
            {server.enabled ? "Enabled" : "Enable"}
          </Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        <label className="inline-flex items-center gap-1.5 text-muted">
          <input
            type="checkbox"
            checked={server.autoApprove}
            onChange={(e) =>
              run.mutate(() => call("mcp.setAutoApprove", { id: server.id, autoApprove: e.target.checked }))
            }
          />
          Trust this server (do not ask before each tool call)
        </label>
        {server.vetting && (
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? "Hide" : "Show"} report and tools
          </button>
        )}
        <Button
          size="sm"
          onClick={() => {
            if (window.confirm(`Remove the server "${server.name}"?`))
              run.mutate(() => call("mcp.remove", { id: server.id }));
          }}
        >
          <Trash2 aria-hidden /> Remove
        </Button>
      </div>
      {open && server.vetting && (
        <>
          <Report report={server.vetting} />
          <ul className="mt-2 text-xs text-muted">
            {server.tools.map((t) => (
              <li key={t.name}>
                <span className="font-mono text-fg">{t.name}</span> {t.readOnly ? "(read-only) " : ""}
                {t.description.split("\n")[0]}
              </li>
            ))}
          </ul>
        </>
      )}
      {run.isError && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {(run.error as Error).message}
        </p>
      )}
    </article>
  );
}
