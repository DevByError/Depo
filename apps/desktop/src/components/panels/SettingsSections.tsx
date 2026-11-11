import { DEFAULT_KEEP_ALIVE, KEEP_ALIVE_CHOICES, SPEED_SETTINGS } from "@depo/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { call } from "@/lib/engine";
import { queryClient } from "@/lib/query";
import { useEngine } from "@/store/engine";
import { useNotifications } from "@/store/notifications";

function useSetting<T extends string | number | boolean>(key: string, fallback: T) {
  const connected = useEngine((s) => s.status === "open");
  const q = useQuery({
    queryKey: ["setting", key],
    queryFn: () => call("settings.get", { key }),
    enabled: connected,
  });
  const set = useMutation({
    mutationFn: (value: T) => call("settings.set", { key, value }),
    onSuccess: (r) => queryClient.setQueryData(["setting", key], r),
  });
  const raw = q.data?.value;
  const value = (raw === null || raw === undefined ? fallback : (raw as T)) as T;
  return { value, set: (v: T) => set.mutate(v), disabled: !connected || set.isPending };
}

const numberInput = "h-8 w-16 rounded-md border border-border bg-bg px-2 text-[13px] text-fg";

/** Speed on a small GPU: how long models stay loaded, and loading the next one early. */
export function ModelSpeedSettings() {
  const keep = useSetting<string>(SPEED_SETTINGS.keepAlive, DEFAULT_KEEP_ALIVE);
  const preload = useSetting<boolean>(SPEED_SETTINGS.preload, true);
  const oneModel = useSetting<string>("scheduler.one_model", "auto");
  const known = KEEP_ALIVE_CHOICES.some((c) => c.value === keep.value);
  return (
    <fieldset className="mt-5">
      <legend className="mb-1 text-xs font-medium text-fg">Model speed</legend>
      <div className="flex flex-col gap-3 text-[13px] text-muted">
        <label className="flex items-center gap-2">
          Keep models loaded for
          <select
            value={keep.value}
            disabled={keep.disabled}
            onChange={(e) => keep.set(e.target.value)}
            className="h-8 rounded-md border border-border bg-bg px-2 text-[13px] text-fg"
          >
            {KEEP_ALIVE_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
            {!known && <option value={keep.value}>Custom ({keep.value})</option>}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={preload.value}
            disabled={preload.disabled}
            onChange={(e) => preload.set(e.target.checked)}
          />
          Load the next model early
        </label>
        <label className="flex items-center gap-2">
          One model at a time on the graphics card
          <select
            value={typeof oneModel.value === "string" ? oneModel.value : "auto"}
            disabled={oneModel.disabled}
            onChange={(e) => oneModel.set(e.target.value)}
            className="h-8 rounded-md border border-border bg-bg px-2 text-[13px] text-fg"
          >
            <option value="auto">Auto (cards under 8 GB)</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-subtle">
        Loading a model can take a minute on a small graphics card. Keeping it loaded saves that time but
        holds memory. Loading early starts while a task gets ready. Two models at once do not fit a small
        card: the second spills to the processor and the whole PC slows down, so other work waits its turn.
      </p>
    </fieldset>
  );
}

/** How the agent team works: plan approval, who reviews, how often work is sent back. */
export function TeamSettings() {
  const approve = useSetting<boolean>("team.approve_plan", true);
  const reviews = useSetting<string>("team.reviews", "all");
  const loops = useSetting<number>("team.fix_loops", 5);
  const parallel = useSetting<number>("team.parallel", 2);
  const exportDocs = useSetting<boolean>("team.export_docs", true);
  return (
    <fieldset className="mt-5">
      <legend className="mb-1 text-xs font-medium text-fg">Agent team</legend>
      <div className="flex flex-col gap-3 text-[13px] text-muted">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={approve.value}
            disabled={approve.disabled}
            onChange={(e) => approve.set(e.target.checked)}
          />
          Show me the plan and ask before the team starts
        </label>
        <label className="flex items-center gap-2">
          Reviews
          <select
            value={reviews.value}
            disabled={reviews.disabled}
            onChange={(e) => reviews.set(e.target.value)}
            className="h-8 rounded-md border border-border bg-bg px-2 text-[13px] text-fg"
          >
            <option value="all">Another agent reviews every task (best quality)</option>
            <option value="key">Only architecture and API work (faster)</option>
            <option value="off">No reviews (fastest)</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Times a task can be sent back
          <input
            type="number"
            min={1}
            max={10}
            value={loops.value}
            disabled={loops.disabled}
            onChange={(e) => loops.set(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
            className={numberInput}
          />
        </label>
        <label className="flex items-center gap-2">
          Tasks worked on at once
          <input
            type="number"
            min={1}
            max={4}
            value={parallel.value}
            disabled={parallel.disabled}
            onChange={(e) => parallel.set(Math.min(4, Math.max(1, Number(e.target.value) || 1)))}
            className={numberInput}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={exportDocs.value}
            disabled={exportDocs.disabled}
            onChange={(e) => exportDocs.set(e.target.checked)}
          />
          Save the team's notes in the project as docs/depo
        </label>
      </div>
    </fieldset>
  );
}

/** Whether Depo saves what it learns after each task (memory.auto). */
export function MemorySetting() {
  const s = useSetting<boolean>("memory.auto", true);
  return (
    <fieldset className="mt-5">
      <legend className="mb-1 text-xs font-medium text-fg">Memory</legend>
      <label className="flex items-center gap-2 text-[13px] text-muted">
        <input
          type="checkbox"
          checked={s.value}
          disabled={s.disabled}
          onChange={(e) => s.set(e.target.checked)}
        />
        Remember what each task teaches about the project (stack, test command, decisions)
      </label>
      <p className="mt-1 text-[11px] leading-relaxed text-subtle">
        Saved items are marked auto in the Memory panel, where you can edit or delete them. Secrets are never
        saved.
      </p>
    </fieldset>
  );
}

/** Whether a larger installed model takes a step a small model keeps failing (agent.step_up). */
export function StepUpSetting() {
  const s = useSetting<boolean>("agent.step_up", true);
  return (
    <fieldset className="mt-5">
      <legend className="mb-1 text-xs font-medium text-fg">Small models</legend>
      <label className="flex items-center gap-2 text-[13px] text-muted">
        <input
          type="checkbox"
          checked={s.value}
          disabled={s.disabled}
          onChange={(e) => s.set(e.target.checked)}
        />
        Let a larger model take a step a small model is stuck on
      </label>
      <p className="mt-1 text-[11px] leading-relaxed text-subtle">
        For coders of 4B or less (such as qwen2.5-coder:3b): when it keeps writing tool calls Depo cannot
        read, the next larger installed model of the same kind (such as qwen2.5-coder:7b) does that one step,
        then the small model goes on. Small models also get a shorter tool list and write code as file blocks.
      </p>
    </fieldset>
  );
}

/** Whether Depo starts a task's private copy when its changes are ready (preview.auto_start). */
export function PreviewSetting() {
  const s = useSetting<boolean>("preview.auto_start", true);
  return (
    <fieldset className="mt-5">
      <legend className="mb-1 text-xs font-medium text-fg">Preview</legend>
      <label className="flex items-center gap-2 text-[13px] text-muted">
        <input
          type="checkbox"
          checked={s.value}
          disabled={s.disabled}
          onChange={(e) => s.set(e.target.checked)}
        />
        Start the app when changes are ready, so I can try them before I apply them
      </label>
      <p className="mt-1 text-[11px] leading-relaxed text-subtle">
        Only for apps that need nothing installed first. It stops when you apply or discard the changes, or
        when you stop the task.
      </p>
    </fieldset>
  );
}

/** What Stop does with the stopped run's work (tasks.keep_stopped_work). */
export function StopSetting() {
  const s = useSetting<boolean>("tasks.keep_stopped_work", false);
  return (
    <fieldset className="mt-5">
      <legend className="mb-1 text-xs font-medium text-fg">Stop</legend>
      <label className="flex items-center gap-2 text-[13px] text-muted">
        <input
          type="checkbox"
          checked={s.value}
          disabled={s.disabled}
          onChange={(e) => s.set(e.target.checked)}
        />
        Keep a stopped task's work so I can review it
      </label>
      <p className="mt-1 text-[11px] leading-relaxed text-subtle">
        Off: Stop also stops the task's app and takes what that run wrote out of its private copy, so the next
        run starts clean. Your project folder is never touched either way.
      </p>
    </fieldset>
  );
}

export function NotificationSetting() {
  const s = useSetting<boolean>("notify.enabled", true);
  const setEnabled = useNotifications((n) => n.setEnabled);
  const change = (v: boolean) => {
    s.set(v);
    setEnabled(v);
    if (v && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Promise.resolve(Notification.requestPermission()).catch(() => {});
    }
  };
  return (
    <fieldset className="mt-5">
      <legend className="mb-1 text-xs font-medium text-fg">Notifications</legend>
      <label className="flex items-center gap-2 text-[13px] text-muted">
        <input
          type="checkbox"
          checked={s.value}
          disabled={s.disabled}
          onChange={(e) => change(e.target.checked)}
        />
        Tell me when a task needs me or is finished (also when Depo is in the background)
      </label>
    </fieldset>
  );
}

/** Looks for a newer release on GitHub when asked. It never downloads or installs anything. */
export function UpdateSetting() {
  const repo = useSetting<string>("update.repo", "");
  const [draft, setDraft] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: async () => {
      const next = (draft ?? repo.value).trim();
      if (next !== repo.value) {
        await call("settings.set", { key: "update.repo", value: next });
        queryClient.setQueryData(["setting", "update.repo"], { key: "update.repo", value: next });
      }
      setDraft(null);
      return call("app.checkUpdate", {});
    },
  });
  return (
    <fieldset className="mt-5">
      <legend className="mb-1 text-xs font-medium text-fg">Updates</legend>
      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        Depo never checks by itself. Enter the GitHub repository your installers are published in, then press
        the button. You download and install the new version yourself.
      </p>
      <div className="flex gap-2">
        <input
          aria-label="Release repository"
          placeholder="owner/name"
          value={draft ?? repo.value}
          onChange={(e) => setDraft(e.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 font-mono text-[12px] text-fg"
        />
        <button
          type="button"
          disabled={check.isPending}
          onClick={() => check.mutate()}
          className="h-8 rounded-md border border-border px-3 text-[13px] text-fg hover:bg-hover"
        >
          {check.isPending ? "Checking…" : "Check for updates"}
        </button>
      </div>
      {check.data && (
        <p role="status" className="mt-2 text-[12px] text-muted">
          {check.data.message}
          {check.data.status === "available" && check.data.url && (
            <>
              {" "}
              <a
                href={check.data.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent underline"
              >
                Open the download page
              </a>
            </>
          )}
        </p>
      )}
      {check.isError && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {(check.error as Error).message}
        </p>
      )}
    </fieldset>
  );
}
