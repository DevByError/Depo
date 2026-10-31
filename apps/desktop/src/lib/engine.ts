import { type ApiMethod, type ApiParams, type ApiResult, DEPO_VERSION } from "@depo/shared";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { isTauri, resolveEngineUrl } from "./connection";
import { EngineClient } from "./engine-client";

/** The single engine connection for this window. */
export const engine = new EngineClient({ resolveUrl: resolveEngineUrl });

export function call<M extends ApiMethod>(method: M, params: ApiParams<M>): Promise<ApiResult<M>> {
  return engine.call(method, params);
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
  engine.onEvent((e) => store.receive(e));
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

async function onConnected() {
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
  const theme = settings.settings["ui.theme"];
  if (theme === "light" || theme === "dark") useUi.getState().setTheme(theme);
  if (info.engineVersion !== DEPO_VERSION) {
    void call("events.emit", {
      type: "warning",
      text: `UI ${DEPO_VERSION} is talking to engine ${info.engineVersion}. Restart Depo to update both.`,
    });
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
