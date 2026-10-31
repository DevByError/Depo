import { OllamaProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { ModelProvider, ProviderKind } from "./types";

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  baseUrl: string;
  enabled: boolean;
}

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: "ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true },
  { id: "lmstudio", kind: "lmstudio", baseUrl: "http://127.0.0.1:1234", enabled: true },
  { id: "llamacpp", kind: "llamacpp", baseUrl: "http://127.0.0.1:8080", enabled: true },
];

/**
 * Only loopback and private-network addresses are accepted, so Depo can use a stronger PC
 * on the user's LAN but can never be pointed at a cloud service.
 */
export function isLocalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h.endsWith(".local") || h.endsWith(".lan")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith("fe80:")) return true;
  // Single-label hostnames (e.g. "gpu-box") resolve on the LAN only.
  return !h.includes(".");
}

export function createProvider(cfg: ProviderConfig): ModelProvider {
  if (!isLocalUrl(cfg.baseUrl)) {
    throw new Error(
      `${cfg.baseUrl} is not a local or LAN address. Depo only uses models running on your own machines.`,
    );
  }
  return cfg.kind === "ollama"
    ? new OllamaProvider(cfg.id, cfg.baseUrl)
    : new OpenAICompatibleProvider(cfg.id, cfg.kind, cfg.baseUrl);
}
