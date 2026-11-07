import { lookup } from "node:dns/promises";
import net from "node:net";
import { loopbackUrl } from "../preview/http-check";

/**
 * Which addresses a design reference may open. A link the owner pastes is the one time Depo goes
 * online, so: http and https only, no passwords in the URL, and an outside page may never reach
 * this computer or the local network (a page could otherwise call Ollama or a router from inside
 * the headless browser). A link to the owner's own running app (127.0.0.1) is fine and stays local.
 */

export type ReferenceUrl = { ok: true; url: URL; local: boolean } | { ok: false; reason: string };

export function checkReferenceUrl(raw: string): ReferenceUrl {
  let text = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: `"${raw.slice(0, 80)}" is not a web address.` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return { ok: false, reason: "Only http and https links can be used as a design reference." };
  if (u.username || u.password)
    return { ok: false, reason: "Links with a user name or password are not opened." };
  if (loopbackUrl(u.toString())) return { ok: true, url: u, local: true };
  const host = hostOf(u);
  if (isPrivateHost(host))
    return {
      ok: false,
      reason: `${host} is on your local network. Depo opens outside sites or your own app on 127.0.0.1 only.`,
    };
  return { ok: true, url: u, local: false };
}

/** The host without brackets, lower case. */
export function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

/** Names and literal addresses that belong to this computer or the local network. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal"))
    return true;
  if (h === "metadata.google.internal") return true;
  if (net.isIP(h)) return isPrivateAddress(h);
  // A single label ("router", "nas") resolves on the local network.
  return !h.includes(".");
}

/** Loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}

/**
 * Decides, per request of an outside reference page, whether it may load: public http(s) hosts
 * whose name does not resolve to a private address (cached per host). Everything else is blocked.
 */
export class OutsideRequestGate {
  private readonly cache = new Map<string, Promise<boolean>>();

  constructor(private readonly resolve: (host: string) => Promise<string[]> = defaultResolve) {}

  async allowed(raw: string): Promise<boolean> {
    if (/^(data|blob|about):/i.test(raw)) return true;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    const host = hostOf(u);
    if (isPrivateHost(host)) return false;
    if (net.isIP(host)) return true;
    let p = this.cache.get(host);
    if (!p) {
      p = this.resolve(host)
        .then((ips) => ips.length > 0 && ips.every((ip) => !isPrivateAddress(ip)))
        .catch(() => false);
      this.cache.set(host, p);
    }
    return p;
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  const r = await lookup(host, { all: true, verbatim: true });
  return r.map((x) => x.address);
}
