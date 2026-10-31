import { z } from "zod";

const TauriConnectionSchema = z.object({ port: z.number().int(), token: z.string().min(32) });

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Where the engine is:
 * 1. Inside Tauri: ask the Rust shell, which started the sidecar and knows its port and token.
 * 2. Browser dev / tests: `?engine=ws://…` in the page URL, or VITE_DEPO_ENGINE_URL at build time.
 */
export async function resolveEngineUrl(): Promise<string> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const conn = TauriConnectionSchema.parse(await invoke("engine_connection"));
    return `ws://127.0.0.1:${conn.port}/rpc?token=${encodeURIComponent(conn.token)}`;
  }
  const fromQuery = new URLSearchParams(window.location.search).get("engine");
  const url = fromQuery ?? (import.meta.env.VITE_DEPO_ENGINE_URL as string | undefined);
  if (!url) throw new Error("No engine URL. Start the app with `bun run dev`.");
  if (!/^ws:\/\/(127\.0\.0\.1|localhost):\d+\/rpc\?token=/.test(url)) {
    throw new Error("Engine URL must point to the local engine (ws://127.0.0.1:<port>/rpc?token=…)");
  }
  return url;
}
