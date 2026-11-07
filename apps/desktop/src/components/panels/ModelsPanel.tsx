import type { Role, RolePlan } from "@depo/model-gateway/contracts";
import type { ApiResult, InstalledModel, ModelRef, ProviderStatus, PullJob } from "@depo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Cpu,
  Download,
  Gauge,
  HardDrive,
  Loader2,
  MemoryStick,
  MonitorCog,
  RefreshCw,
  Server,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";

const ROLE_ORDER: Role[] = ["coder", "reasoning", "vision", "fast", "embedding"];
const ROLE_TITLE: Record<Role, string> = {
  coder: "Coder",
  reasoning: "Reasoning",
  vision: "Vision",
  fast: "Quick tasks",
  embedding: "Embeddings",
};
const ROLE_HINT: Record<Role, string> = {
  coder: "Writes and edits code",
  reasoning: "Plans, reviews and decides",
  vision: "Reads screenshots and designs",
  fast: "Small edits and classification (Balanced mode)",
  embedding: "Searches the codebase",
};

const LONG = { timeoutMs: 15 * 60_000 };

function gb(bytes: number | null | undefined): string {
  if (!bytes) return "–";
  return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ModelsPanel() {
  const status = useEngine((s) => s.status);
  const enabled = status === "open";
  const qc = useQueryClient();

  const hardware = useQuery({ queryKey: ["hardware"], queryFn: () => call("hardware.get", {}), enabled });
  const plan = useQuery({ queryKey: ["models", "plan"], queryFn: () => call("models.plan", {}), enabled });
  const providers = useQuery({
    queryKey: ["models", "providers"],
    queryFn: () => call("models.providers", {}),
    enabled,
    refetchInterval: 15_000,
  });
  const installed = useQuery({
    queryKey: ["models", "installed"],
    queryFn: () => call("models.installed", {}),
    enabled,
  });
  const assignments = useQuery({
    queryKey: ["models", "assignments"],
    queryFn: () => call("models.assignments", {}),
    enabled,
  });
  const settings = useQuery({
    queryKey: ["models", "settings"],
    queryFn: () => call("settings.all", {}),
    enabled,
  });
  const pulls = useQuery({
    queryKey: ["models", "pulls"],
    queryFn: () => call("models.pulls", {}),
    enabled,
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.state === "running") ? 1000 : false),
  });

  const profile = useMutation({
    mutationFn: () => call("hardware.profile", {}, { timeoutMs: 60_000 }),
    onSuccess: () => qc.invalidateQueries(),
  });

  // First visit: profile automatically so the plan is ready.
  const autoProfiled = useRef(false);
  useEffect(() => {
    if (hardware.data && !hardware.data.profile && !autoProfiled.current) {
      autoProfiled.current = true;
      profile.mutate();
    }
  }, [hardware.data, profile]);

  const mode = settings.data?.settings["quality.mode"] === "balanced" ? "balanced" : "max_quality";
  const setMode = useMutation({
    mutationFn: (value: "max_quality" | "balanced") => call("settings.set", { key: "quality.mode", value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });

  const runningPulls = (pulls.data?.jobs ?? []).filter((j) => j.state === "running");
  const startPull = useMutation({
    mutationFn: (ref: ModelRef) => call("models.pull", ref),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models", "pulls"] }),
  });

  if (!enabled) {
    return <Centered>Waiting for the engine…</Centered>;
  }

  const hw = hardware.data?.profile ?? null;
  const p = plan.data?.plan ?? null;
  const ollama = providers.data?.providers.find((x) => x.kind === "ollama" && x.enabled);
  const models = installed.data?.models ?? [];

  return (
    <section className="h-full overflow-y-auto" tabIndex={0} aria-label="Models">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-5">
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-fg">Models</h2>
            <p className="mt-0.5 text-[13px] text-muted">
              {p ? p.headline : "Depo picks the strongest local models your PC can run, then adapts."}
            </p>
          </div>
          <ModeToggle mode={mode} onChange={(m) => setMode.mutate(m)} />
          <Button size="sm" onClick={() => profile.mutate()} disabled={profile.isPending}>
            {profile.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {hw ? "Re-check hardware" : "Check hardware"}
          </Button>
        </header>

        {profile.isError && <ErrorLine>{errorText(profile.error)}</ErrorLine>}
        <HardwareCard hw={hw} loading={profile.isPending || hardware.isLoading} />
        <ProvidersCard providers={providers.data?.providers ?? []} loading={providers.isLoading} />

        <Card
          title="Auto-Fit plan"
          subtitle={
            mode === "max_quality"
              ? "Max Quality: the strongest models that fit, even when slower."
              : "Balanced: a faster model for simple tasks, the strongest for planning and reviews."
          }
        >
          {!p ? (
            <p className="text-xs text-muted">Check hardware to see the plan.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {ROLE_ORDER.map((role) => (
                <RoleCard
                  key={role}
                  role={role}
                  plan={p.roles[role] ?? null}
                  unavailable={p.unavailable[role] ?? null}
                  installed={models}
                  ollamaId={ollama?.id ?? null}
                  assignments={assignments.data}
                  pull={pulls.data?.jobs.find((j) => j.model === p.roles[role]?.tag) ?? null}
                  onPull={(ref) => startPull.mutate(ref)}
                />
              ))}
            </div>
          )}
          {p?.qualityFirst.active && (
            <div className="mt-4 rounded-lg border border-border bg-raised/40 p-3">
              <div className="text-xs font-medium text-fg">Quality-First is on</div>
              <p className="mt-0.5 text-xs text-muted">
                Some choices were stepped down for this PC, so Depo works more carefully: slower, not worse.
              </p>
              <ul className="mt-2 grid gap-1 text-xs text-muted sm:grid-cols-2">
                {p.qualityFirst.measures.map((m) => (
                  <li key={m} className="flex gap-1.5">
                    <Check className="mt-0.5 size-3 shrink-0 text-success" aria-hidden />
                    {m}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {startPull.isError && <ErrorLine>{errorText(startPull.error)}</ErrorLine>}
        </Card>

        <InstalledCard
          models={models}
          loading={installed.isLoading}
          running={runningPulls}
          ollamaId={ollama?.id ?? null}
          onPull={(ref) => startPull.mutate(ref)}
        />
        <CatalogCard />
      </div>
    </section>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: "max_quality" | "balanced";
  onChange: (m: "max_quality" | "balanced") => void;
}) {
  const opts = [
    { v: "max_quality" as const, label: "Max Quality" },
    { v: "balanced" as const, label: "Balanced" },
  ];
  return (
    <div role="radiogroup" aria-label="Quality mode" className="flex rounded-md border border-border p-0.5">
      {opts.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: segmented control; role and aria-checked are set.
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={mode === o.v}
          onClick={() => onChange(o.v)}
          className={cn(
            "h-6 rounded px-2.5 text-xs transition-colors",
            mode === o.v ? "bg-accent-soft font-medium text-fg" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Card({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-xl border border-border bg-panel p-4">
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={id} className="text-[13px] font-semibold text-fg">
            {title}
          </h3>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center text-[13px] text-muted">{children}</div>;
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-danger">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex gap-2.5 rounded-lg border border-border bg-raised/40 px-3 py-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
      <div className="min-w-0">
        <div className="text-[11px] text-subtle">{label}</div>
        <div className="truncate text-[13px] font-medium text-fg" title={value}>
          {value}
        </div>
        {note && <div className="text-[11px] text-muted">{note}</div>}
      </div>
    </div>
  );
}

type Hw = NonNullable<ApiResult<"hardware.get">["profile"]>;

function HardwareCard({ hw, loading }: { hw: Hw | null; loading: boolean }) {
  if (!hw) {
    return (
      <Card title="This PC">
        <p className="flex items-center gap-2 text-xs text-muted">
          {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {loading ? "Checking graphics card, memory and processor…" : "Not checked yet."}
        </p>
      </Card>
    );
  }
  const gpu = hw.gpus.filter((g) => g.vramGB >= 1);
  const flags = [hw.cpu.avx2 ? "AVX2" : null, hw.cpu.avx512 ? "AVX-512" : null].filter(Boolean).join(", ");
  return (
    <Card title="This PC" subtitle={`Checked ${new Date(hw.profiledAt).toLocaleString()}`}>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={MonitorCog}
          label={hw.unifiedMemory ? "Graphics (shared memory)" : "Graphics card"}
          value={gpu.length ? gpu.map((g) => g.name).join(" + ") : "No dedicated GPU"}
          note={
            gpu.length
              ? `${gpu.reduce((s, g) => s + g.vramGB, 0).toFixed(1)} GB`
              : "Models run on the processor"
          }
        />
        <Stat icon={MemoryStick} label="Memory" value={`${hw.ramGB} GB`} />
        <Stat
          icon={Cpu}
          label="Processor"
          value={hw.cpu.model}
          note={`${hw.cpu.threads} threads${flags ? ` · ${flags}` : ""}`}
        />
        <Stat
          icon={hw.benchmark ? Gauge : HardDrive}
          label={hw.benchmark ? "Measured speed" : "Free disk"}
          value={
            hw.benchmark
              ? `${hw.benchmark.tokensPerSec} tokens/sec`
              : hw.diskFreeGB !== null
                ? `${hw.diskFreeGB} GB`
                : "–"
          }
          note={hw.benchmark ? hw.benchmark.model : "where models are stored"}
        />
      </div>
    </Card>
  );
}

function ProvidersCard({ providers, loading }: { providers: ProviderStatus[]; loading: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card
      title="Runtimes"
      subtitle="Local model servers. A stronger PC on your network works too."
      actions={
        <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)}>
          {editing ? "Done" : "Edit"}
        </Button>
      }
    >
      {loading && <p className="text-xs text-muted">Checking…</p>}
      {editing ? (
        <ProvidersEditor providers={providers} onDone={() => setEditing(false)} />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-3">
          {providers.map((p) => (
            <li key={p.id} className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5">
              <Server className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                  <span
                    className={cn("size-1.5 rounded-full", p.ok ? "bg-success" : "bg-subtle")}
                    aria-hidden
                  />
                  {providerName(p.kind)}
                  {p.version && <span className="font-normal text-subtle">{p.version}</span>}
                </div>
                <div className="truncate font-mono text-[11px] text-subtle">{p.baseUrl}</div>
                <div className={cn("text-[11px]", p.ok ? "text-success" : "text-muted")}>
                  {p.ok ? "Running" : p.message}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!loading && providers.length > 0 && !providers.some((p) => p.ok) && !editing && (
        <p className="mt-3 text-xs text-muted">
          No runtime is running. Install Ollama from ollama.com, start it, and this page updates by itself.
        </p>
      )}
    </Card>
  );
}

function providerName(kind: ProviderStatus["kind"]): string {
  return kind === "ollama" ? "Ollama" : kind === "lmstudio" ? "LM Studio" : "llama.cpp";
}

function ProvidersEditor({ providers, onDone }: { providers: ProviderStatus[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState(() =>
    providers.map(({ id, kind, baseUrl, enabled }) => ({ id, kind, baseUrl, enabled })),
  );
  const save = useMutation({
    mutationFn: () => call("models.providers.set", { providers: rows }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["models"] });
      onDone();
    },
  });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {rows.map((r, i) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2">
          <label className="flex w-28 items-center gap-1.5 text-xs text-fg">
            <input
              type="checkbox"
              checked={r.enabled}
              onChange={(e) =>
                setRows(rows.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))
              }
            />
            {providerName(r.kind)}
          </label>
          <input
            aria-label={`${providerName(r.kind)} address`}
            value={r.baseUrl}
            onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, baseUrl: e.target.value } : x)))}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 font-mono text-xs text-fg outline-none focus:border-accent"
          />
        </div>
      ))}
      <p className="text-[11px] text-subtle">Only this PC or machines on your local network are allowed.</p>
      {save.isError && <ErrorLine>{errorText(save.error)}</ErrorLine>}
      <div>
        <Button size="sm" variant="primary" type="submit" disabled={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

const QUALITY_TONE: Record<RolePlan["qualityLabel"], string> = {
  Excellent: "text-success",
  Great: "text-success",
  Good: "text-info",
  Basic: "text-warning",
};
const SPEED_TONE: Record<RolePlan["speedLabel"], string> = {
  Fast: "text-success",
  Good: "text-success",
  Slow: "text-warning",
  "Very slow": "text-danger",
};

function RoleCard({
  role,
  plan,
  unavailable,
  installed,
  ollamaId,
  assignments,
  pull,
  onPull,
}: {
  role: Role;
  plan: RolePlan | null;
  unavailable: string | null;
  installed: InstalledModel[];
  ollamaId: string | null;
  assignments: ApiResult<"models.assignments"> | undefined;
  pull: PullJob | null;
  onPull: (ref: ModelRef) => void;
}) {
  const qc = useQueryClient();
  const selectId = useId();
  const manual = assignments?.assignments[role] ?? null;
  const isInstalled = plan
    ? installed.some((m) => m.name === plan.tag || m.name === `${plan.tag}:latest`)
    : false;
  const assign = useMutation({
    mutationFn: (ref: ModelRef | null) => call("models.assign", { role, ref }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models", "assignments"] }),
  });

  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[13px] font-semibold text-fg">{ROLE_TITLE[role]}</h4>
        <span className="text-[11px] text-subtle">{ROLE_HINT[role]}</span>
      </div>
      {plan ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-medium text-fg">{plan.modelName}</span>
            <code className="font-mono text-[11px] text-subtle">{plan.tag}</code>
          </div>
          <p className="text-xs leading-relaxed text-muted">{plan.summary}</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            <span className={QUALITY_TONE[plan.qualityLabel]}>Quality: {plan.qualityLabel}</span>
            {role !== "embedding" && (
              <span className={SPEED_TONE[plan.speedLabel]}>Speed: {plan.speedLabel}</span>
            )}
            <span className="text-subtle">{plan.memoryGB} GB</span>
            <span className="text-subtle">{(plan.contextLength / 1024).toFixed(0)}k context</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {isInstalled ? (
              <span className="flex items-center gap-1 text-xs text-success">
                <Check className="size-3.5" aria-hidden /> Installed
              </span>
            ) : pull?.state === "running" ? (
              <PullProgress job={pull} />
            ) : (
              <Button
                size="sm"
                variant="primary"
                disabled={!ollamaId}
                title={ollamaId ? undefined : "Start Ollama to download models"}
                onClick={() => ollamaId && onPull({ providerId: ollamaId, model: plan.tag })}
              >
                <Download /> Download
              </Button>
            )}
            {pull?.state === "failed" && !isInstalled && <ErrorLine>{pull.error}</ErrorLine>}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted">{unavailable ?? "No plan for this role."}</p>
      )}
      <div className="mt-1 flex items-center gap-2 border-t border-border pt-2">
        <label htmlFor={selectId} className="text-[11px] text-subtle">
          Use
        </label>
        <select
          id={selectId}
          value={manual ? `${manual.providerId}\u0000${manual.model}` : ""}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return assign.mutate(null);
            const [providerId = "", model = ""] = v.split("\u0000");
            assign.mutate({ providerId, model });
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-1.5 text-xs text-fg outline-none focus:border-accent"
        >
          <option value="">Auto-Fit choice{plan ? ` (${plan.tag})` : ""}</option>
          {installed.map((m) => (
            <option key={`${m.providerId}/${m.name}`} value={`${m.providerId}\u0000${m.name}`}>
              {m.name} · {m.providerId}
            </option>
          ))}
        </select>
      </div>
    </article>
  );
}

function PullProgress({ job }: { job: PullJob }) {
  const qc = useQueryClient();
  const pct =
    job.totalBytes && job.completedBytes !== null
      ? Math.floor((job.completedBytes / job.totalBytes) * 100)
      : null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"
        role="progressbar"
        aria-label={`Downloading ${job.model}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct ?? 5}%` }} />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-muted">
        {pct !== null ? `${pct}% of ${gb(job.totalBytes)}` : job.status}
      </span>
      <button
        type="button"
        aria-label={`Cancel download of ${job.model}`}
        className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
        onClick={() =>
          void call("models.pull.cancel", { jobId: job.jobId }).then(() =>
            qc.invalidateQueries({ queryKey: ["models", "pulls"] }),
          )
        }
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function InstalledCard({
  models,
  loading,
  running,
  ollamaId,
  onPull,
}: {
  models: InstalledModel[];
  loading: boolean;
  running: PullJob[];
  ollamaId: string | null;
  onPull: (ref: ModelRef) => void;
}) {
  const [tag, setTag] = useState("");
  return (
    <Card title="Installed models" subtitle="Everything the running runtimes report.">
      {loading ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : models.length === 0 ? (
        <p className="text-xs text-muted">No models installed yet. Download one from the plan above.</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-[11px] text-subtle">
            <tr>
              <th className="py-1 font-medium">Model</th>
              <th className="py-1 font-medium">Runtime</th>
              <th className="py-1 font-medium">Size</th>
              <th className="py-1 font-medium">Precision</th>
              <th className="py-1 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <InstalledRow key={`${m.providerId}/${m.name}`} m={m} />
            ))}
          </tbody>
        </table>
      )}
      {running.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {running.map((j) => (
            <div key={j.jobId} className="flex items-center gap-2 text-xs text-muted">
              <span className="w-48 truncate font-mono text-[11px]">{j.model}</span>
              <PullProgress job={j} />
            </div>
          ))}
        </div>
      )}
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ollamaId && tag.trim()) {
            onPull({ providerId: ollamaId, model: tag.trim() });
            setTag("");
          }
        }}
      >
        <input
          aria-label="Ollama model tag"
          placeholder="Any Ollama tag, e.g. qwen2.5-coder:14b"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 font-mono text-xs text-fg outline-none placeholder:text-subtle focus:border-accent"
        />
        <Button size="sm" type="submit" disabled={!ollamaId || !tag.trim()}>
          <Download /> Download
        </Button>
      </form>
    </Card>
  );
}

function InstalledRow({ m }: { m: InstalledModel }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const bench = useMutation({
    mutationFn: () => call("models.benchmark", { providerId: m.providerId, model: m.name }, LONG),
    onSuccess: () => qc.invalidateQueries(),
  });
  const del = useMutation({
    mutationFn: () => call("models.delete", { providerId: m.providerId, model: m.name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });
  return (
    <tr className="border-t border-border align-middle">
      <td className="py-1.5 font-mono text-[11px] text-fg">{m.name}</td>
      <td className="py-1.5 text-muted">{m.providerId}</td>
      <td className="py-1.5 tabular-nums text-muted">{gb(m.sizeBytes)}</td>
      <td className="py-1.5 text-muted">{m.quantization ?? "–"}</td>
      <td className="py-1.5">
        <div className="flex items-center justify-end gap-1">
          {bench.data && (
            <span className="mr-1 text-[11px] text-success">{bench.data.benchmark.tokensPerSec} tok/s</span>
          )}
          {(bench.isError || del.isError) && (
            <span
              className="mr-1 max-w-56 truncate text-[11px] text-danger"
              title={errorText(bench.error ?? del.error)}
            >
              {errorText(bench.error ?? del.error)}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => bench.mutate()} disabled={bench.isPending}>
            {bench.isPending ? <Loader2 className="animate-spin" /> : <Gauge />}
            {bench.isPending ? "Measuring…" : "Benchmark"}
          </Button>
          {confirm ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Keep
              </Button>
              <Button size="sm" className="text-danger" onClick={() => del.mutate()} disabled={del.isPending}>
                Delete {gb(m.sizeBytes)}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete ${m.name}`}
              onClick={() => setConfirm(true)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function CatalogCard() {
  const qc = useQueryClient();
  const enabled = useEngine((s) => s.status === "open");
  const cat = useQuery({
    queryKey: ["models", "catalog"],
    queryFn: () => call("models.catalog", {}),
    enabled,
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const importer = useMutation({
    mutationFn: (json: string | null) => call("models.catalog.import", { json }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });
  const c = cat.data;
  return (
    <Card
      title="Model catalog"
      subtitle={
        c
          ? `${c.custom ? "Custom" : "Built-in"} catalog, version ${c.catalog.version} (${c.catalog.updated}), ${c.catalog.models.length} models.`
          : "Loading…"
      }
      actions={
        <div className="flex gap-1">
          {c?.custom && (
            <Button size="sm" variant="ghost" onClick={() => importer.mutate(null)}>
              Use built-in
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
            <Upload /> Import catalog
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Catalog file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) importer.mutate(await f.text());
            }}
          />
        </div>
      }
    >
      <p className="text-xs text-muted">
        New, stronger models are added through the catalog, so they do not need a new Depo release.
      </p>
      {importer.isError && <ErrorLine>{errorText(importer.error)}</ErrorLine>}
    </Card>
  );
}
