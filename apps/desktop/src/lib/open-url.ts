import { isTauri } from "./connection";

/** Previews run on this computer only: http(s) on 127.x.x.x, localhost or [::1]. */
export function isLocalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Open a preview link in the user's browser. In the desktop app this goes through the shell
 * plugin (its `open` scope only accepts local addresses); in a browser it opens a new tab.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isLocalUrl(url)) throw new Error("Only links to this computer can be opened.");
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("plugin:shell|open", { path: url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Copy text to the clipboard. False when the browser does not allow it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
