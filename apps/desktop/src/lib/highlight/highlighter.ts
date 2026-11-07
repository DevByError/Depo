import type { HighlightReply, HighlightRequest } from "./highlight.worker";
import type { LanguageId } from "./languages";
import type { Token } from "./tokens";

/**
 * The app's one way to highlight code. Work runs in a Web Worker (a module worker bundled with the
 * app, so nothing leaves the PC); where workers are unavailable it runs on the main thread in idle
 * time, one piece at a time. Results are cached by language and content, so a file or a diff hunk
 * is highlighted once however often it is shown.
 */

/** Above either limit code is shown without colours ("Large file: shown without colours"). */
export const MAX_HIGHLIGHT_CHARS = 300 * 1024;
export const MAX_HIGHLIGHT_LINES = 8000;

export type HighlightResult =
  | { status: "ready"; lines: Token[][] }
  | { status: "large" }
  | { status: "failed" };

export function isTooLarge(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return true;
  let lines = 1;
  for (let i = code.indexOf("\n"); i >= 0; i = code.indexOf("\n", i + 1)) {
    if (++lines > MAX_HIGHLIGHT_LINES) return true;
  }
  return false;
}

/** 53-bit string hash (cyrb53): cache keys stay short however large the file. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function highlightKey(code: string, lang: LanguageId): string {
  return `${lang}:${code.length}:${hash(code)}`;
}

// ---- cache (least recently used goes first) ----------------------------------------------------

const MAX_ENTRIES = 400;
const MAX_CACHED_CHARS = 8_000_000;
const cache = new Map<string, { lines: Token[][]; size: number }>();
let cachedChars = 0;
const inflight = new Map<string, Promise<HighlightResult>>();
const stats = { runs: 0, hits: 0 };

function remember(key: string, lines: Token[][], size: number): void {
  cache.set(key, { lines, size });
  cachedChars += size;
  for (const [k, v] of cache) {
    if (cache.size <= MAX_ENTRIES && cachedChars <= MAX_CACHED_CHARS) break;
    if (k === key) continue;
    cache.delete(k);
    cachedChars -= v.size;
  }
}

/** Cached lines for a key, without starting any work. */
export function peekHighlight(key: string): Token[][] | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit.lines;
}

/** How often code was actually highlighted, and how often the cache answered (tests, diagnostics). */
export function highlightStats(): { runs: number; hits: number; cached: number } {
  return { ...stats, cached: cache.size };
}

export function clearHighlightCache(): void {
  cache.clear();
  cachedChars = 0;
  stats.runs = 0;
  stats.hits = 0;
}

// ---- runners ------------------------------------------------------------------------------------

interface Pending {
  code: string;
  lang: LanguageId;
  resolve: (lines: Token[][]) => void;
  reject: (err: Error) => void;
}

/** undefined: not tried yet; null: no worker here (tests, a locked-down WebView), run locally. */
let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === "undefined") return null;
  try {
    const w = new Worker(new URL("./highlight.worker.ts", import.meta.url), {
      type: "module",
      name: "depo-highlight",
    });
    w.onmessage = (e: MessageEvent<HighlightReply>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if ("lines" in e.data) p.resolve(e.data.lines);
      else p.reject(new Error(e.data.error));
    };
    // The worker could not start (or crashed): finish its queue here and stop using it.
    w.onerror = (e) => {
      e.preventDefault();
      if (worker === w) worker = null;
      w.terminate();
      const left = [...pending.values()];
      pending.clear();
      for (const p of left) runLocal(p.code, p.lang).then(p.resolve, p.reject);
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** Wait for a quiet moment so highlighting never delays typing or scrolling. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (
      globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
    ).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 250 });
    else setTimeout(resolve, 0);
  });
}

let localQueue: Promise<unknown> = Promise.resolve();

function runLocal(code: string, lang: LanguageId): Promise<Token[][]> {
  const run = localQueue.then(async () => {
    const { tokenize } = await import("./tokenize");
    await idle();
    return tokenize(code, lang);
  });
  localQueue = run.catch(() => undefined);
  return run;
}

function runInWorker(w: Worker, code: string, lang: LanguageId): Promise<Token[][]> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { code, lang, resolve, reject });
    const req: HighlightRequest = { id, code, lang };
    w.postMessage(req);
  });
}

/** Highlight code (cached). Resolves "large" above the size limit and "failed" when a grammar cannot load. */
export function highlightCode(
  code: string,
  lang: LanguageId,
  key = highlightKey(code, lang),
): Promise<HighlightResult> {
  if (isTooLarge(code)) return Promise.resolve({ status: "large" });
  const hit = peekHighlight(key);
  if (hit) {
    stats.hits++;
    return Promise.resolve({ status: "ready", lines: hit });
  }
  const running = inflight.get(key);
  if (running) {
    stats.hits++;
    return running;
  }
  stats.runs++;
  const w = getWorker();
  const job = (w ? runInWorker(w, code, lang) : runLocal(code, lang))
    .then((lines): HighlightResult => {
      remember(key, lines, code.length);
      return { status: "ready", lines };
    })
    .catch((): HighlightResult => ({ status: "failed" }))
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
