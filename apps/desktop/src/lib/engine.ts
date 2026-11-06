import { API_FINGERPRINT, type ApiMethod, type ApiParams, type ApiResult, DEPO_VERSION } from "@depo/shared";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { isTauri, resolveEngineUrl } from "./connection";
import { EngineClient } from "./engine-client";
import { queryClient } from "./query";

/** The single engine connection for this window. */
export const engine = new EngineClient({ resolveUrl: resolveEngineUrl });

export function call<M extends ApiMethod>(
  method: M,
  params: ApiParams<M>,
  opts?: { timeoutMs?: number },
): Promise<ApiResult<M>> {
  return engine.call(method, params, opts);
}

let wired = false;
/** Set when the desktop shell reports an engine crash; reported once the UI reconnects. */
let pendingCrashNotice: string | null = null;

async function listenForEngineExits(): Promise<void> {
  if (!isTauri()) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ code: number | null; willRestart: boolean; message: string }>("engine://exited", (e) => {
    pendingCrashNotice = e.payload.message;
    useEngine.getState().setStatus("reconnecting", e.payload.message);
  });
}

/** Connect the client to the stores. Safe to call more than once (React StrictMode). */
export function startEngineConnection(): void {
  if (wired) return;
  wired = true;
  const store = useEngine.getState();
  engine.onEvent((e) => {
    store.receive(e);
    invalidateFor(e.type, e.status);
    // Task transcripts and approvals change with every finished agent step.
    if (e.taskId && !e.ephemeral) {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      void queryClient.invalidateQueries({ queryKey: ["team"] });
    } else if (e.taskId && e.details?.planUpdate === true) {
      void queryClient.invalidateQueries({ queryKey: ["team"] });
    }
  });
  engine.onStatus((status, error) => {
    useEngine.getState().setStatus(status, error);
    if (status === "open") {
      onConnected().catch((err: unknown) => {
        console.error("Failed to load engine state", err);
      });
    }
  });
  void listenForEngineExits();
  engine.start();
}

/** Keep cached queries fresh when the engine reports a change. */
function invalidateFor(type: string, status: string): void {
  if (
    type === "model_download" &&
    (status === "succeeded" || status === "failed" || status === "cancelled")
  ) {
    void queryClient.invalidateQueries({ queryKey: ["models"] });
  } else if (type === "hardware_profiled" || type === "model_benchmark") {
    void queryClient.invalidateQueries({ queryKey: ["hardware"] });
    void queryClient.invalidateQueries({ queryKey: ["models", "plan"] });
  } else if (
    type === "applied_changes" ||
    type === "checkpoint_created" ||
    type === "info" ||
    type === "handoff"
  ) {
    void queryClient.invalidateQueries({ queryKey: ["changes"] });
    void queryClient.invalidateQueries({ queryKey: ["checkpoints"] });
  } else if (type === "settings_changed") {
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    void queryClient.invalidateQueries({ queryKey: ["projectSettings"] });
    void queryClient.invalidateQueries({ queryKey: ["scheduler"] });
  } else if (type === "queued") {
    void queryClient.invalidateQueries({ queryKey: ["scheduler"] });
  } else if (type === "project_changed") {
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  } else if (type === "memory_updated") {
    void queryClient.invalidateQueries({ queryKey: ["memory"] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  } else if (type === "indexing" && status !== "running") {
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  }
  if (type === "handoff" || type === "test_result") {
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  }
}

async function onConnected() {
  void queryClient.invalidateQueries();
  const [info, recent, settings] = await Promise.all([
    call("system.info", {}),
    call("events.recent", { limit: 500 }),
    call("settings.all", {}),
  ]);
  const s = useEngine.getState();
  s.setInfo(info);
  if (pendingCrashNotice) {
    const text = `The engine stopped unexpectedly and was restarted. ${pendingCrashNotice}`;
    pendingCrashNotice = null;
    void call("events.emit", { type: "warning", text });
  }
  s.loadBacklog(recent.events);
  const projectId = settings.settings["ui.project_id"];
  if (typeof projectId === "string" && !useUi.getState().projectId) useUi.getState().setProjectId(projectId);
  const theme = settings.settings["ui.theme"];
  if (theme === "light" || theme === "dark") useUi.getState().setTheme(theme);
  if (info.engineVersion !== DEPO_VERSION) {
    void call("events.emit", {
      type: "warning",
      text: `UI ${DEPO_VERSION} is talking to engine ${info.engineVersion}. Restart Depo to update both.`,
    });
  } else if (info.apiFingerprint !== API_FINGERPRINT) {
    const text =
      "The engine is older than this window. Quit Depo, end any depo-engine.exe left in Task Manager, and reinstall or restart.";
    void call("events.emit", { type: "warning", text }).catch(() => {});
  }
}

export async function setTheme(theme: "light" | "dark"): Promise<void> {
  useUi.getState().setTheme(theme);
  try {
    await call("settings.set", { key: "ui.theme", value: theme });
  } catch {
    // Offline: the local copy still applies; it syncs next time the user changes it.
  }
}
