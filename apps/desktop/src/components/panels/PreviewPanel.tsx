import type { PreviewInfo, PreviewLogLine, RunRecipe } from "@depo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Laptop,
  Loader2,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Pin,
  Play,
  RotateCw,
  Smartphone,
  Square,
  Tablet,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PageCheckSection } from "@/components/qa/PageCheckSection";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { copyText, openExternal } from "@/lib/open-url";
import { useEngine } from "@/store/engine";
import { DEVICE_SIZE, type DeviceWidth, usePreviewUi } from "@/store/preview";
import { useUi } from "@/store/ui";

const OWN = "__own";
const active = (p: PreviewInfo) => p.state === "starting" || p.state === "running";

const STATE_TEXT: Record<PreviewInfo["state"], string> = {
  starting: "Starting",
  running: "Running",
  failed: "Did not start",
  stopped: "Stopped",
};
const STATE_STYLE: Record<PreviewInfo["state"], string> = {
  starting: "border-info/50 text-info",
  running: "border-success/50 text-success",
  failed: "border-danger/50 text-danger",
  stopped: "border-border text-muted",
};

function ownRecipe(command: string): RunRecipe {
  return {
    id: "custom",
    kind: "custom",
    label: "Your start command",
    command,
    cwd: "",
    env: { PORT: "{port}", HOST: "127.0.0.1" },
    port: 3000,
    readyPath: "/",
    role: "app",
    missing: null,
  };
}

/**
 * Preview: run the project (or a task's private copy, to try new code before it reaches the real
 * files), get a link to open in the browser, see it embedded at phone, tablet or desktop width,
 * and follow its log.
 */
export function PreviewPanel() {
  const enabled = useEngine((s) => s.status === "open");
  const projectId = useUi((s) => s.projectId);
  const ui = usePreviewUi();
  const qc = useQueryClient();
  const taskId = ui.projectId === projectId ? ui.taskId : null;

  const targets = useQuery({
    queryKey: ["previews", "targets", projectId],
    queryFn: () => call("preview.targets", { projectId: projectId ?? "" }),
    enabled: enabled && !!projectId,
  });
  const detect = useQuery({
    queryKey: ["previews", "detect", projectId, taskId],
    queryFn: () =>
      call(
        "preview.detect",
        { projectId: projectId ?? "", ...(taskId ? { taskId } : {}) },
        { timeoutMs: 30_000 },
      ),
    enabled: enabled && !!projectId,
    retry: false,
  });
  const list = useQuery({
    queryKey: ["previews", "list", projectId],
    queryFn: () => call("preview.list", { projectId: projectId ?? "" }),
    enabled: enabled && !!projectId,
    refetchInterval: (q) => (q.state.data?.previews.some((p) => p.state === "starting") ? 1000 : 5000),
  });

  // Nothing picked for this project yet: follow what is already running (for example the private
  // copy Depo started when a task's changes became ready) instead of offering to start another.
  useEffect(() => {
    if (!projectId || ui.projectId === projectId) return;
    const all = list.data?.previews ?? [];
    if (all.some((p) => p.taskId === null && active(p))) return;
    const running = all.filter(active).sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role])[0];
    if (running) usePreviewUi.getState().show({ projectId, taskId: running.taskId, previewId: running.id });
  }, [projectId, ui.projectId, list.data]);

  const forTarget = (list.data?.previews ?? []).filter((p) => p.taskId === taskId);
  // The site before its API: a frontend, then an app, then a backend.
  const byRole = [...forTarget].sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role]);
  const current = forTarget.find((p) => p.id === ui.previewId) ?? byRole.find(active) ?? byRole[0] ?? null;
  const mates = current?.groupId
    ? forTarget.filter((p) => p.groupId === current.groupId && p.id !== current.id)
    : [];

  // The recipe to start, and its command as the owner edits it.
  const recipes = detect.data?.recipes ?? [];
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const chosen: RunRecipe | null =
    recipeId === OWN
      ? null
      : (recipes.find((r) => r.id === recipeId) ?? recipes[detect.data?.suggested ?? -1] ?? null);
  const [command, setCommand] = useState("");
  const chosenKey = `${projectId}:${taskId}:${recipeId === OWN ? OWN : (chosen?.id ?? "")}:${chosen?.command ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the field only when another recipe is shown
  useEffect(() => {
    setCommand(recipeId === OWN ? (detect.data?.override ?? "") : (chosen?.command ?? ""));
  }, [chosenKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new target starts with the suggested recipe
  useEffect(() => setRecipeId(null), [projectId, taskId]);

  const editable = recipeId === OWN || (!!chosen && chosen.kind !== "both" && chosen.kind !== "static");
  const edited = editable && command.trim() !== (chosen?.command ?? "").trim();
  const toStart = (): RunRecipe | undefined => {
    if (recipeId === OWN || (!chosen && command.trim())) return ownRecipe(command.trim());
    if (!chosen) return undefined;
    return edited ? { ...chosen, command: command.trim() } : chosen;
  };
  const missing = !edited ? (chosen?.missing ?? null) : null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["previews"] });
  };
  const start = useMutation({
    mutationFn: (o: { install: boolean; recipe?: RunRecipe | undefined }) =>
      call(
        "preview.start",
        {
          projectId: projectId ?? "",
          ...(taskId ? { taskId } : {}),
          ...(o.recipe ? { recipe: o.recipe } : {}),
          install: o.install,
        },
        // Without a recipe the engine detects one first, which may ask Python what is installed.
        { timeoutMs: 45_000 },
      ),
    onSuccess: (r) => {
      if (projectId) usePreviewUi.getState().show({ projectId, taskId, previewId: r.preview.id });
      refresh();
    },
  });
  const stop = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await call("preview.stop", { id }, { timeoutMs: 20_000 });
    },
    onSettled: refresh,
  });
  const restart = useMutation({
    mutationFn: (id: string) => call("preview.restart", { id }, { timeoutMs: 20_000 }),
    onSettled: refresh,
  });
  const saveCommand = useMutation({
    mutationFn: (previewCommand: string) =>
      call("projects.settings.set", { id: projectId ?? "", patch: { previewCommand } }),
    onSuccess: (_r, previewCommand) => {
      setRecipeId(previewCommand ? "custom" : null);
      void qc.invalidateQueries({ queryKey: ["previews", "detect"] });
      void qc.invalidateQueries({ queryKey: ["projectSettings"] });
    },
  });

  // "Preview these changes" in Diff Review opens this tab and starts the task's copy.
  const autoStart = ui.autoStart && ui.projectId === projectId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per request, when the list is known
  useEffect(() => {
    if (!autoStart || !list.isSuccess || start.isPending) return;
    usePreviewUi.getState().clearAutoStart();
    const running = forTarget.find(active);
    if (running) usePreviewUi.getState().setPreviewId(running.id);
    else start.mutate({ install: false });
  }, [autoStart, list.isSuccess]);

  if (!projectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <MonitorPlay className="size-8 text-subtle" aria-hidden />
        <h2 className="text-sm font-semibold text-fg">No project open</h2>
        <p className="max-w-sm text-xs text-muted">
          Open a project to run it here and get a link you can visit in your browser.
        </p>
      </div>
    );
  }

  const busy = start.isPending || stop.isPending || restart.isPending;
  const isActive = !!current && active(current);
  const groupIds = current ? [current.id, ...mates.filter(active).map((m) => m.id)] : [];
  const error = (start.error ?? stop.error ?? restart.error ?? saveCommand.error) as Error | null;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-y-auto" tabIndex={0} aria-label="Preview">
      <header className="flex shrink-0 flex-col gap-3 border-b border-border bg-panel px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <MonitorPlay className="size-5 text-accent" aria-hidden />
          <h1 className="text-[15px] font-semibold text-fg">Preview</h1>
          <label className="ml-auto flex items-center gap-2 text-xs text-muted">
            What to run
            <select
              value={taskId ?? ""}
              onChange={(e) => usePreviewUi.getState().show({ projectId, taskId: e.target.value || null })}
              className="max-w-72 truncate rounded-md border border-border bg-raised px-2 py-1 text-xs text-fg outline-none focus:border-accent"
            >
              {(targets.data?.targets ?? [{ taskId: null, label: "Project folder", status: null }]).map(
                (t) => (
                  <option key={t.taskId ?? "project"} value={t.taskId ?? ""}>
                    {t.taskId ? `Task: ${t.label} (changes not applied yet)` : "Your project folder"}
                  </option>
                ),
              )}
            </select>
          </label>
        </div>
        <p className="-mt-1 text-xs text-muted">
          {taskId
            ? "This runs the task's private copy, so you can try the new code before it reaches your files."
            : "Run the app and open it in your browser. It runs only on this computer."}
        </p>

        {detect.isError && (
          <p role="alert" className="text-xs text-danger">
            {(detect.error as Error).message}
          </p>
        )}
        {detect.data?.notes.map((n) => (
          <p key={n} className="text-xs text-muted">
            {n}
          </p>
        ))}

        <div className="flex flex-col gap-2">
          {(recipes.length > 0 || detect.data) && (
            <label className="flex flex-wrap items-center gap-2 text-xs text-muted">
              How to start
              <select
                value={recipeId === OWN ? OWN : (chosen?.id ?? OWN)}
                onChange={(e) => setRecipeId(e.target.value)}
                className="min-w-0 max-w-full flex-1 truncate rounded-md border border-border bg-raised px-2 py-1 text-xs text-fg outline-none focus:border-accent"
              >
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.kind === "custom" ? "Your saved command" : r.label}
                  </option>
                ))}
                {!recipes.some((r) => r.kind === "custom") && (
                  <option value={OWN}>Type my own command</option>
                )}
              </select>
            </label>
          )}
          {editable || !chosen ? (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="preview-command" className="text-xs text-muted">
                Start command
              </label>
              <input
                id="preview-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                spellCheck={false}
                placeholder="for example: npm run dev"
                aria-describedby="preview-command-hint"
                className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-fg outline-none placeholder:text-subtle focus:border-accent"
              />
              {(edited || recipeId === OWN) && command.trim() && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saveCommand.isPending}
                  onClick={() => saveCommand.mutate(command.trim())}
                >
                  Remember this command
                </Button>
              )}
              {chosen?.kind === "custom" && !edited && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saveCommand.isPending}
                  onClick={() => saveCommand.mutate("")}
                >
                  Use what Depo finds
                </Button>
              )}
              <span id="preview-command-hint" className="w-full text-[11px] text-subtle">
                Depo puts a free port where you write {"{port}"}, and sets PORT too.
              </span>
            </div>
          ) : chosen.kind === "both" ? (
            <ul className="flex flex-col gap-1 text-xs text-muted">
              {(chosen.parts ?? []).map((p) => (
                <li key={p.id}>
                  <span className="text-fg">{p.role === "backend" ? "Backend" : "Frontend"}:</span>{" "}
                  <code className="font-mono text-[11px]">{p.command || "built-in server"}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">
              Depo's built-in server shows the files in{" "}
              {chosen.cwd ? <code>{chosen.cwd}</code> : "the project folder"}.
            </p>
          )}
        </div>

        {missing && (
          <div className="flex flex-col gap-1 rounded-md border border-warning/40 bg-raised px-3 py-2">
            <p className="flex items-center gap-2 text-xs font-medium text-warning">
              <AlertTriangle className="size-3.5" aria-hidden /> Some packages are not installed yet
            </p>
            <p className="text-xs text-muted">{missing.reason}</p>
            <p className="text-xs text-muted">
              Install with <code className="font-mono text-[11px] text-fg">{missing.install}</code>
              {missing.cwd ? ` in ${missing.cwd}` : ""}. Depo asks you before it installs anything.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {missing && !isActive ? (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => start.mutate({ install: true, recipe: toStart() })}
              >
                <Play /> Install and start
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => start.mutate({ install: false, recipe: toStart() })}
              >
                Start anyway
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={busy || isActive || (!chosen && !command.trim())}
              onClick={() => start.mutate({ install: false, recipe: toStart() })}
            >
              {start.isPending ? <Loader2 className="animate-spin" /> : <Play />} Start
            </Button>
          )}
          <Button size="sm" disabled={busy || !isActive} onClick={() => stop.mutate(groupIds)}>
            <Square /> Stop
          </Button>
          <Button size="sm" disabled={busy || !current} onClick={() => current && restart.mutate(current.id)}>
            <RotateCw /> Restart
          </Button>
          {current && (
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", STATE_STYLE[current.state])}>
              {STATE_TEXT[current.state]}
              {current.state === "starting" && current.phase !== "Starting" ? `: ${current.phase}` : ""}
            </span>
          )}
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error.message}
          </p>
        )}
      </header>

      {current?.approvalId && <ApprovalInline id={current.approvalId} />}
      {current && <LinkBar preview={current} mates={mates} />}
      <PageCheckSection target={{ projectId, taskId }} preview={current} />
      <Viewer preview={current} device={ui.device} />
      <LogPane preview={current} />
    </section>
  );
}

function ApprovalInline({ id }: { id: string }) {
  const qc = useQueryClient();
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: () => call("approvals.list", {}) });
  const a = approvals.data?.approvals.find((x) => x.id === id);
  const respond = useMutation({
    mutationFn: (approve: boolean) => call("approvals.respond", { id, approve }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      void qc.invalidateQueries({ queryKey: ["previews"] });
    },
  });
  const command = typeof a?.details?.command === "string" ? a.details.command : null;
  return (
    <section
      aria-label="Needs your OK"
      className="flex shrink-0 flex-wrap items-center gap-3 border-b border-warning/40 bg-raised px-4 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-fg">Depo needs your OK to install packages</p>
        {command && <code className="block truncate font-mono text-[11px] text-muted">{command}</code>}
        {a?.reason && <p className="text-[11px] text-muted">{a.reason}</p>}
      </div>
      <Button size="sm" variant="primary" disabled={respond.isPending} onClick={() => respond.mutate(true)}>
        Install
      </Button>
      <Button size="sm" variant="ghost" disabled={respond.isPending} onClick={() => respond.mutate(false)}>
        Don't install
      </Button>
    </section>
  );
}

function LinkBar({ preview, mates }: { preview: PreviewInfo; mates: PreviewInfo[] }) {
  const [copied, setCopied] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const open = (url: string) => {
    setOpenError(null);
    openExternal(url).catch((e: unknown) => setOpenError(e instanceof Error ? e.message : String(e)));
  };
  const running = preview.state === "running";
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={preview.url}
          onClick={(e) => {
            e.preventDefault();
            open(preview.url);
          }}
          className={cn(
            "min-w-0 truncate font-mono text-base font-medium underline-offset-4 hover:underline",
            running ? "text-accent" : "text-muted",
          )}
          title="Open in your browser"
        >
          {preview.url}
        </a>
        <Button size="sm" variant="secondary" onClick={() => open(preview.url)} disabled={!running}>
          <ExternalLink /> Open in browser
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void copyText(preview.url).then((ok) => setCopied(ok))}
        >
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy link"}
        </Button>
        <span role="status" className="sr-only">
          {copied ? "Link copied" : ""}
        </span>
      </div>
      {preview.auto && preview.taskId && <PinToggle preview={preview} />}
      <p className="text-[11px] text-subtle">
        {preview.label}
        {preview.command ? (
          <>
            {" · "}
            <code className="font-mono">{preview.command}</code>
          </>
        ) : null}
      </p>
      {mates.map((m) => (
        <p key={m.id} className="text-[11px] text-muted">
          Also running ({m.role}):{" "}
          <a
            href={m.url}
            onClick={(e) => {
              e.preventDefault();
              open(m.url);
            }}
            className="font-mono text-accent underline-offset-2 hover:underline"
          >
            {m.url}
          </a>{" "}
          · {STATE_TEXT[m.state]}{" "}
          <button
            type="button"
            className="ml-1 rounded px-1 text-accent underline-offset-2 hover:underline"
            onClick={() => usePreviewUi.getState().setPreviewId(m.id)}
          >
            Show here
          </button>
        </p>
      ))}
      {preview.state === "failed" && preview.error && (
        <p role="alert" className="text-xs text-danger">
          {preview.error} The log below shows what happened.
        </p>
      )}
      {openError && (
        <p role="alert" className="text-xs text-danger">
          {openError}
        </p>
      )}
    </div>
  );
}

/** Depo stops the app it started at review once the changes are applied or discarded, unless pinned. */
function PinToggle({ preview }: { preview: PreviewInfo }) {
  const qc = useQueryClient();
  const pin = useMutation({
    mutationFn: (pinned: boolean) => call("preview.pin", { id: preview.id, pinned }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["previews"] }),
  });
  const pinned = !!preview.pinned;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-[11px] text-muted">
        Depo started this when the changes were ready.{" "}
        {pinned
          ? "It keeps running after you apply or discard them."
          : "It stops when you apply or discard them."}
      </p>
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={pinned}
        disabled={pin.isPending}
        onClick={() => pin.mutate(!pinned)}
        className={pinned ? "bg-hover text-fg" : undefined}
      >
        <Pin /> Keep running
      </Button>
    </div>
  );
}

const DEVICES: { id: DeviceWidth; label: string; icon: typeof Smartphone }[] = [
  { id: "phone", label: "Phone", icon: Smartphone },
  { id: "tablet", label: "Tablet", icon: Tablet },
  { id: "desktop", label: "Desktop", icon: Laptop },
];

const ROLE_RANK: Record<PreviewInfo["role"], number> = { frontend: 0, app: 1, backend: 2 };

/** Scale that fits a w×h screen into the box (never larger than 100%). */
export function fitScale(
  box: { width: number; height: number },
  screen: { width: number; height: number },
): number {
  if (box.width <= 0 || box.height <= 0) return 1;
  return Math.min(1, box.width / screen.width, box.height / screen.height);
}

function Viewer({ preview, device }: { preview: PreviewInfo | null; device: DeviceWidth }) {
  const [reloads, setReloads] = useState(0);
  const size = DEVICE_SIZE[device];
  const running = preview?.state === "running";
  // The page renders at the device's real size and is scaled down to fit the panel (or shown at
  // 100% with scrolling). The area only exists while the app runs, so it is measured once it appears.
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [actual, setActual] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!area || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(area);
    return () => ro.disconnect();
  }, [area]);
  const scale = actual ? 1 : fitScale(box, size);
  return (
    <div ref={root} className="flex min-h-[max(22rem,72vh)] flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <fieldset className="m-0 flex items-center gap-1 border-0 p-0">
          <legend className="sr-only">Screen width</legend>
          {DEVICES.map((d) => {
            const Icon = d.icon;
            return (
              <Button
                key={d.id}
                size="sm"
                variant="ghost"
                aria-pressed={device === d.id}
                onClick={() => {
                  usePreviewUi.getState().setDevice(d.id);
                  // Bring the whole screen into view (the panel scrolls when the page check is open).
                  root.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
                }}
                className={device === d.id ? "bg-hover text-fg" : undefined}
              >
                <Icon /> {d.label}
              </Button>
            );
          })}
        </fieldset>
        <span className="ml-auto font-mono text-[11px] text-subtle" data-testid="device-size">
          {size.width} × {size.height}
          {box.width > 0 ? ` · ${Math.round(scale * 100)}%` : ""}
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={actual}
          title={actual ? "Scale the page to fit the panel" : "Show the page at its real size and scroll"}
          onClick={() => setActual((v) => !v)}
        >
          {actual ? <Minimize2 /> : <Maximize2 />} {actual ? "Fit" : "100%"}
        </Button>
        <Button size="sm" variant="ghost" disabled={!running} onClick={() => setReloads((n) => n + 1)}>
          <RotateCw /> Reload
        </Button>
      </div>
      <section
        className={cn("min-h-0 flex-1 bg-bg p-3", actual ? "overflow-auto" : "overflow-hidden")}
        tabIndex={0}
        aria-label="Preview viewer"
      >
        {running && preview ? (
          <div ref={setArea} className="h-full min-h-80 w-full">
            {/* The frame takes the scaled size in the layout; the page inside keeps the real one. */}
            <div
              className="mx-auto overflow-hidden rounded-lg border border-border-strong bg-white shadow-pop"
              style={{ width: size.width * scale, height: size.height * scale }}
            >
              <iframe
                key={`${preview.id}:${preview.url}:${reloads}`}
                src={preview.url}
                title={`Preview of ${preview.label}`}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                className="block origin-top-left border-0 bg-white"
                style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center">
            {preview?.state === "starting" ? (
              <>
                <Loader2 className="size-6 animate-spin text-accent" aria-hidden />
                <p className="text-sm text-fg">{preview.phase}…</p>
                <p className="text-xs text-muted">The first start can take a little while.</p>
              </>
            ) : (
              <>
                <MonitorPlay className="size-7 text-subtle" aria-hidden />
                <p className="text-sm text-muted">
                  {preview?.state === "failed"
                    ? "The app did not start. Check the log, fix it, then press Start or Restart."
                    : "Press Start to run the app. You will see it here and get a link."}
                </p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/** Fetch new log lines while the preview is alive; one last fetch after it ends. */
function useLogs(id: string | null, live: boolean): PreviewLogLine[] {
  const enabled = useEngine((s) => s.status === "open");
  const [lines, setLines] = useState<PreviewLogLine[]>([]);
  const cursor = useRef(0);
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (shownFor.current !== id) {
      shownFor.current = id;
      cursor.current = 0;
      setLines([]);
    }
    if (!id || !enabled) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await call("preview.logs", { id, since: cursor.current });
        if (cancelled) return;
        cursor.current = r.next;
        if (r.lines.length > 0 || r.dropped)
          setLines((prev) => (r.dropped ? r.lines : [...prev, ...r.lines]).slice(-2000));
      } catch {
        // the preview was removed; keep what is shown
      }
    };
    void tick();
    if (!live)
      return () => {
        cancelled = true;
      };
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, live, enabled]);
  return lines;
}

function LogPane({ preview }: { preview: PreviewInfo | null }) {
  const lines = useLogs(preview?.id ?? null, !!preview && active(preview));
  const ref = useRef<HTMLElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [open, setOpen] = useState(true);
  const stick = useRef(true);
  // Follow new lines only while the reader is at the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when lines change
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, open]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stick.current = bottom;
    setAtBottom(bottom);
  };
  const jump = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAtBottom(true);
  };
  return (
    <div className={cn("flex shrink-0 flex-col border-t border-border bg-panel", open ? "h-44" : "")}>
      <div className="flex items-center gap-2 px-4 py-1">
        <h2 className="text-xs font-semibold text-fg">Log</h2>
        {open && !atBottom && (
          <Button size="sm" variant="ghost" onClick={jump}>
            <ArrowDownToLine /> Jump to the end
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-expanded={open}
          aria-controls="preview-log"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown /> : <ChevronUp />} {open ? "Hide log" : "Show log"}
        </Button>
      </div>
      <section
        id="preview-log"
        hidden={!open}
        ref={ref}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Preview log"
        className="min-h-0 flex-1 overflow-auto px-4 pb-2 font-mono text-[11px] leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="text-subtle">{preview ? "Nothing yet." : "The app's output appears here."}</p>
        ) : (
          lines.map((l) => (
            <div
              key={l.seq}
              className={cn(
                "whitespace-pre-wrap break-all",
                l.stream === "depo" ? "text-accent" : l.stream === "err" ? "text-muted" : "text-fg",
              )}
            >
              {l.text || " "}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
