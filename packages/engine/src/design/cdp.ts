import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConsoleIssue, FailedRequest } from "@depo/shared";
import { loopbackUrl } from "../preview/http-check";
import { commandEnv } from "../tools/shell/run";
import { attachJob, type JobHandle } from "../tools/shell/winjob";
import { findBrowser } from "./browser";

/**
 * A small Chrome DevTools Protocol client: Depo drives the browser that is already on the PC
 * (Edge, Chrome or Chromium) in headless mode to open the app it builds, like a human tester would.
 * Nothing is downloaded and no browser is bundled. Pages may only reach this computer: requests to
 * any other address are blocked, and only loopback addresses can be opened.
 *
 * One WebSocket per browser; pages are targets attached in "flat" mode (commands carry a sessionId).
 */

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

type Json = Record<string, unknown>;
type Listener = (params: Json, sessionId: string | null) => void;

interface Pending {
  resolve(v: Json): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

const DEFAULT_COMMAND_TIMEOUT = 15_000;

/** The browser's WebSocket: numbered commands with answers, and events. */
export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly closeHooks = new Set<(reason: string) => void>();
  private closedReason: string | null = null;

  private constructor(
    private readonly ws: WebSocket,
    private readonly commandTimeoutMs: number,
  ) {
    ws.onmessage = (m) => this.onMessage(m.data);
    ws.onclose = () => this.markClosed("The browser closed the connection.");
    ws.onerror = () => this.markClosed("The connection to the browser failed.");
  }

  /** Connect to a DevTools WebSocket URL (`ws://127.0.0.1:<port>/devtools/browser/<id>`). */
  static connect(
    url: string,
    opts: { timeoutMs?: number; commandTimeoutMs?: number } = {},
  ): Promise<CdpConnection> {
    const u = loopbackUrl(url.replace(/^ws/, "http"));
    if (!u) return Promise.reject(new CdpError("The DevTools address must be on this computer."));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new CdpError("The browser did not accept the DevTools connection in time."));
      }, opts.timeoutMs ?? 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws, opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new CdpError("Could not connect to the browser's DevTools port."));
      };
    });
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  /** Send one command; resolves with its result, rejects with the browser's error or a timeout. */
  send<T extends Json = Json>(
    method: string,
    params: Json = {},
    opts: { sessionId?: string | undefined; timeoutMs?: number | undefined } = {},
  ): Promise<T> {
    if (this.closedReason) return Promise.reject(new CdpError(this.closedReason));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.commandTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`The browser did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: Json) => void, reject, timer, method });
      try {
        this.ws.send(
          JSON.stringify({ id, method, params, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) }),
        );
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new CdpError(`Could not talk to the browser: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    });
  }

  /** Listen to an event (from every session; the listener gets the sessionId). Returns an unsubscribe. */
  on(method: string, fn: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  onClose(fn: (reason: string) => void): () => void {
    this.closeHooks.add(fn);
    return () => this.closeHooks.delete(fn);
  }

  close(): void {
    this.markClosed("The connection was closed.");
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  private onMessage(data: unknown): void {
    let msg: {
      id?: unknown;
      result?: unknown;
      error?: { message?: unknown };
      method?: unknown;
      params?: unknown;
      sessionId?: unknown;
    };
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return; // not JSON: ignore
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(`${p.method}: ${String(msg.error.message ?? "failed")}`));
      else p.resolve((msg.result as Json | undefined) ?? {});
      return;
    }
    if (typeof msg.method !== "string") return;
    const set = this.listeners.get(msg.method);
    if (!set) return;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Json;
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : null;
    for (const fn of [...set]) {
      try {
        fn(params, sessionId);
      } catch {
        // a listener must never break the connection
      }
    }
  }

  private markClosed(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CdpError(reason));
      this.pending.delete(id);
    }
    for (const fn of [...this.closeHooks]) {
      try {
        fn(reason);
      } catch {
        // ignore
      }
    }
  }
}

// ---- pages ------------------------------------------------------------------------------------

const MAX_KEPT = 20;
const MAX_TEXT = 600;

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** URLs a page may load: this computer, and inline data. Everything else is blocked. */
export function isLocalResource(url: string): boolean {
  if (/^(data|blob|about):/i.test(url)) return true;
  if (/^(ws|wss):/i.test(url)) return loopbackUrl(url.replace(/^ws/i, "http")) !== null;
  return loopbackUrl(url) !== null;
}

/** Keys `press` understands, with the codes the browser expects. */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Space: { code: "Space", keyCode: 32, text: " " },
  " ": { code: "Space", keyCode: 32, text: " " },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
};

interface TrackedRequest {
  url: string;
  method: string;
  type: string;
}

/** What a page reported since the last reset. */
export interface PageReport {
  consoleErrors: ConsoleIssue[];
  consoleErrorCount: number;
  failedRequests: FailedRequest[];
  failedRequestCount: number;
}

/** One tab, attached in flat mode. Collects console errors and failed requests while it lives. */
export class CdpPage {
  private readonly off: (() => void)[] = [];
  private readonly inflight = new Set<string>();
  private readonly requests = new Map<string, TrackedRequest>();
  private readonly blocked = new Set<string>();
  private lastActivity = Date.now();
  private report: PageReport = {
    consoleErrors: [],
    consoleErrorCount: 0,
    failedRequests: [],
    failedRequestCount: 0,
  };
  /** HTTP status of each main-frame document, by loader id (the answer can come before Page.navigate's). */
  private readonly documents = new Map<string, number | null>();

  constructor(
    readonly conn: CdpConnection,
    readonly sessionId: string,
    readonly targetId: string,
  ) {
    const mine =
      (fn: (p: Json) => void): Listener =>
      (p, sid) => {
        if (sid === this.sessionId) fn(p);
      };
    const on = (method: string, fn: (p: Json) => void) => this.off.push(conn.on(method, mine(fn)));

    on("Network.requestWillBeSent", (p) => {
      const id = String(p.requestId ?? "");
      const req = (p.request ?? {}) as { url?: string; method?: string };
      this.inflight.add(id);
      this.lastActivity = Date.now();
      this.requests.set(id, {
        url: String(req.url ?? ""),
        method: String(req.method ?? "GET"),
        type: String(p.type ?? "Other"),
      });
    });
    on("Network.responseReceived", (p) => {
      const id = String(p.requestId ?? "");
      const res = (p.response ?? {}) as { status?: number; url?: string };
      const status = typeof res.status === "number" ? res.status : null;
      const type = String(p.type ?? this.requests.get(id)?.type ?? "Other");
      const loader = typeof p.loaderId === "string" ? p.loaderId : null;
      if (type === "Document" && loader && p.frameId === this.targetId && !this.documents.has(loader))
        this.documents.set(loader, status);
      if (status !== null && status >= 400) {
        const req = this.requests.get(id);
        const url = String(res.url ?? req?.url ?? "");
        if (!/\/favicon\.ico(\?|$)/i.test(url))
          this.addFailed({ url, method: req?.method ?? "GET", status, error: null, type, blocked: false });
      }
    });
    on("Network.loadingFinished", (p) => {
      this.inflight.delete(String(p.requestId ?? ""));
      this.lastActivity = Date.now();
    });
    on("Network.loadingFailed", (p) => {
      const id = String(p.requestId ?? "");
      this.inflight.delete(id);
      this.lastActivity = Date.now();
      if (p.canceled === true) return;
      const req = this.requests.get(id);
      const url = req?.url ?? "";
      if (/\/favicon\.ico(\?|$)/i.test(url)) return;
      this.addFailed({
        url,
        method: req?.method ?? "GET",
        status: null,
        error: clip(String(p.errorText ?? "failed"), 300),
        type: String(p.type ?? req?.type ?? "Other"),
        blocked: this.blocked.has(id),
      });
    });
    on("Fetch.requestPaused", (p) => {
      const requestId = String(p.requestId ?? "");
      const url = String(((p.request ?? {}) as { url?: string }).url ?? "");
      if (isLocalResource(url)) {
        void conn.send("Fetch.continueRequest", { requestId }, { sessionId }).catch(() => {});
      } else {
        if (typeof p.networkId === "string") this.blocked.add(p.networkId);
        void conn
          .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, { sessionId })
          .catch(() => {});
      }
    });
    on("Runtime.consoleAPICalled", (p) => {
      if (p.type !== "error" && p.type !== "assert") return;
      const args = (Array.isArray(p.args) ? p.args : []) as {
        value?: unknown;
        description?: string;
        type?: string;
      }[];
      const text = args
        .map((a) =>
          a.value !== undefined
            ? typeof a.value === "string"
              ? a.value
              : JSON.stringify(a.value)
            : (a.description ?? a.type ?? ""),
        )
        .join(" ");
      const frame = ((p.stackTrace as { callFrames?: { url?: string; lineNumber?: number }[] } | undefined)
        ?.callFrames ?? [])[0];
      this.addConsole({
        kind: "console",
        text: clip(text || "console.error"),
        source: frame?.url ? clip(`${frame.url}:${(frame.lineNumber ?? 0) + 1}`, 300) : null,
      });
    });
    on("Runtime.exceptionThrown", (p) => {
      const d = (p.exceptionDetails ?? {}) as {
        text?: string;
        url?: string;
        lineNumber?: number;
        exception?: { description?: string; value?: unknown };
      };
      const desc =
        d.exception?.description ?? (d.exception?.value !== undefined ? String(d.exception.value) : "");
      const text = desc ? desc.split("\n").slice(0, 3).join("\n") : (d.text ?? "Uncaught error");
      this.addConsole({
        kind: "exception",
        text: clip(text),
        source: d.url ? clip(`${d.url}:${(d.lineNumber ?? 0) + 1}`, 300) : null,
      });
    });
    on("Log.entryAdded", (p) => {
      const e = (p.entry ?? {}) as { source?: string; level?: string; text?: string; url?: string };
      // Network problems are reported as failed requests, script errors through Runtime.
      if (e.level !== "error" || e.source === "network" || e.source === "javascript") return;
      this.addConsole({
        kind: "log",
        text: clip(String(e.text ?? "")),
        source: e.url ? clip(e.url, 300) : null,
      });
    });
  }

  private addConsole(i: ConsoleIssue) {
    this.report.consoleErrorCount++;
    if (this.report.consoleErrors.length < MAX_KEPT) this.report.consoleErrors.push(i);
  }

  private addFailed(r: FailedRequest) {
    this.report.failedRequestCount++;
    if (this.report.failedRequests.length < MAX_KEPT)
      this.report.failedRequests.push({ ...r, url: clip(r.url) });
  }

  private send<T extends Json = Json>(method: string, params: Json = {}, timeoutMs?: number): Promise<T> {
    return this.conn.send<T>(method, params, { sessionId: this.sessionId, timeoutMs });
  }

  /** Turn on the domains a check needs, block requests that leave this computer, ignore the page's CSP. */
  async init(): Promise<void> {
    await Promise.all([
      this.send("Page.enable"),
      this.send("Runtime.enable"),
      this.send("Network.enable"),
      this.send("Log.enable"),
    ]);
    await this.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await this.send("Page.setBypassCSP", { enabled: true }).catch(() => {});
  }

  async setViewport(width: number, height: number, mobile: boolean): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  }

  /** Forget what was collected so far (before the next width). */
  resetReport(): void {
    this.report = { consoleErrors: [], consoleErrorCount: 0, failedRequests: [], failedRequestCount: 0 };
    this.documents.clear();
    this.inflight.clear();
    this.requests.clear();
    this.blocked.clear();
  }

  collected(): PageReport {
    return {
      consoleErrors: [...this.report.consoleErrors],
      consoleErrorCount: this.report.consoleErrorCount,
      failedRequests: [...this.report.failedRequests],
      failedRequestCount: this.report.failedRequestCount,
    };
  }

  /** Wait for one event of this page. The returned `cancel` stops waiting. */
  waitEvent(method: string, timeoutMs: number): { done: Promise<boolean>; cancel(): void } {
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: (v: boolean) => void = () => {};
    const done = new Promise<boolean>((resolve) => {
      settle = (v) => {
        off();
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      off = this.conn.on(method, (_p, sid) => {
        if (sid === this.sessionId) settle(true);
      });
      timer = setTimeout(() => settle(false), timeoutMs);
    });
    return { done, cancel: () => settle(false) };
  }

  /** Open a URL and wait for the load event. Only loopback addresses can be opened. */
  async goto(
    url: string,
    timeoutMs = 20_000,
  ): Promise<{ loaded: boolean; status: number | null; error: string | null }> {
    if (!loopbackUrl(url)) throw new CdpError(`Refused: ${url} is not a local address.`);
    const load = this.waitEvent("Page.loadEventFired", timeoutMs);
    let nav: { loaderId?: string; errorText?: string };
    try {
      nav = await this.send<{ loaderId?: string; errorText?: string }>("Page.navigate", { url }, timeoutMs);
    } catch (err) {
      load.cancel();
      throw err;
    }
    if (nav.errorText) {
      load.cancel();
      return { loaded: false, status: null, error: nav.errorText };
    }
    const loaded = await load.done;
    return {
      loaded,
      status: nav.loaderId ? (this.documents.get(nav.loaderId) ?? null) : null,
      error: loaded ? null : `The page did not finish loading within ${Math.round(timeoutMs / 1000)}s.`,
    };
  }

  /** True once no request has been open for `idleMs`; false when that did not happen in time. */
  async waitForNetworkIdle(idleMs = 500, timeoutMs = 5000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.inflight.size === 0 && Date.now() - this.lastActivity >= idleMs) return true;
      await Bun.sleep(50);
    }
    return false;
  }

  /** Run JavaScript in the page and return its (JSON) value. Page errors become CdpErrors. */
  async evaluate<T = unknown>(
    expression: string,
    opts: { awaitPromise?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const r = await this.send<{
      result?: { value?: unknown; type?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: opts.awaitPromise ?? false, userGesture: true },
      opts.timeoutMs,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new CdpError(
        clip((d.exception?.description ?? d.text ?? "Script error").split("\n")[0] ?? "Script error", 300),
      );
    }
    return r.result?.value as T;
  }

  /**
   * A PNG of the page from the top: the whole page up to `maxHeight` CSS pixels (or just the
   * viewport with `viewportOnly`), scaled by `scale`.
   */
  async screenshot(
    opts: { maxHeight?: number; scale?: number; viewportOnly?: boolean } = {},
  ): Promise<Buffer> {
    const m = await this.send<{
      cssContentSize?: { width?: number; height?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    }>("Page.getLayoutMetrics");
    const vw = Math.max(1, Math.round(m.cssLayoutViewport?.clientWidth ?? 1280));
    const vh = Math.max(1, Math.round(m.cssLayoutViewport?.clientHeight ?? 800));
    const full = Math.max(vh, Math.ceil(m.cssContentSize?.height ?? vh));
    const height = opts.viewportOnly ? vh : Math.min(full, opts.maxHeight ?? full);
    const r = await this.send<{ data?: string }>(
      "Page.captureScreenshot",
      {
        format: "png",
        clip: { x: 0, y: 0, width: vw, height, scale: opts.scale ?? 1 },
        captureBeyondViewport: height > vh,
      },
      30_000,
    );
    if (!r.data) throw new CdpError("The browser returned an empty screenshot.");
    return Buffer.from(r.data, "base64");
  }

  /** Where an element is, whether it can be seen, and what covers its centre (scrolls it into view). */
  private async locate(
    selector: string,
  ): Promise<{ x: number; y: number; visible: boolean; covered: string | null } | null> {
    const fn = `(sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      const name = (n) => n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
      const covered = top && top !== el && !el.contains(top) && !top.contains(el) ? name(top) : null;
      return { x, y, visible, covered };
    }`;
    return this.evaluate(`(${fn})(${JSON.stringify(selector)})`);
  }

  /** Wait until `selector` matches (or, with only `text`, until the text is on the page). */
  async waitFor(
    o: { selector?: string | undefined; text?: string | undefined },
    timeoutMs = 5000,
  ): Promise<void> {
    const end = Date.now() + timeoutMs;
    const expr = o.selector
      ? `!!document.querySelector(${JSON.stringify(o.selector)})`
      : `(document.body ? document.body.innerText : "").includes(${JSON.stringify(o.text ?? "")})`;
    for (;;) {
      if (await this.evaluate<boolean>(expr)) return;
      if (Date.now() > end)
        throw new CdpError(
          o.selector
            ? `Nothing matched ${o.selector} within ${Math.round(timeoutMs / 1000)}s.`
            : `The text "${clip(o.text ?? "", 80)}" did not appear within ${Math.round(timeoutMs / 1000)}s.`,
        );
      await Bun.sleep(100);
    }
  }

  /** Click the centre of an element with real mouse events. Returns a warning when something covers it. */
  async click(selector: string, timeoutMs = 5000): Promise<string | null> {
    await this.waitFor({ selector }, timeoutMs);
    const box = await this.locate(selector);
    if (!box) throw new CdpError(`Nothing matched ${selector}.`);
    if (!box.visible)
      throw new CdpError(`${selector} is on the page but cannot be seen, so it cannot be clicked.`);
    const base = { x: box.x, y: box.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    return box.covered ? `${box.covered} covers ${selector}, so the click landed on it instead.` : null;
  }

  /** Focus an element, select what it holds, and type text into it. */
  async type(selector: string, text: string, timeoutMs = 5000): Promise<void> {
    await this.waitFor({ selector }, timeoutMs);
    const focused = await this.evaluate<boolean>(
      `((sel) => { const el = document.querySelector(sel); if (!el) return false; el.scrollIntoView({ block: "center" }); el.focus(); if (typeof el.select === "function") el.select(); return document.activeElement === el; })(${JSON.stringify(selector)})`,
    );
    if (!focused) throw new CdpError(`${selector} could not be focused, so nothing was typed.`);
    await this.send("Input.insertText", { text });
  }

  /** Press one key (Enter, Tab, Escape, Space, Backspace, arrows, Home, End, or a single character). */
  async press(key: string): Promise<void> {
    const k =
      KEYS[key] ??
      (key.length === 1
        ? { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key }
        : null);
    if (!k)
      throw new CdpError(
        `Unknown key "${key}". Use Enter, Tab, Escape, Space, Backspace, an arrow key or one character.`,
      );
    const name = key === "Space" ? " " : key;
    await this.send("Input.dispatchKeyEvent", {
      type: k.text ? "keyDown" : "rawKeyDown",
      key: name,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: name,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
    });
  }

  dispose(): void {
    for (const off of this.off.splice(0)) off();
  }
}

// ---- launching the browser ------------------------------------------------------------------

export interface BrowserSession {
  readonly conn: CdpConnection;
  /** The temporary profile folder (deleted on close). Empty for a session without one. */
  readonly profileDir: string;
  newPage(): Promise<CdpPage>;
  /** Close the browser, kill what is left of it and delete the temporary profile. Never throws. */
  close(): Promise<void>;
}

/** Open a page on an existing connection (tests use this with a fake DevTools server). */
export async function openPage(conn: CdpConnection): Promise<CdpPage> {
  const t = await conn.send<{ targetId?: string }>("Target.createTarget", { url: "about:blank" });
  if (!t.targetId) throw new CdpError("The browser did not open a tab.");
  const a = await conn.send<{ sessionId?: string }>("Target.attachToTarget", {
    targetId: t.targetId,
    flatten: true,
  });
  if (!a.sessionId) throw new CdpError("Could not attach to the browser tab.");
  const page = new CdpPage(conn, a.sessionId, t.targetId);
  await page.init();
  return page;
}

/** A session over a connection made elsewhere (no process, no profile). */
export function sessionFor(conn: CdpConnection): BrowserSession {
  return {
    conn,
    profileDir: "",
    newPage: () => openPage(conn),
    async close() {
      try {
        await conn.send("Browser.close", {}, { timeoutMs: 2000 });
      } catch {
        // gone already
      }
      conn.close();
    },
  };
}

/** Flags that keep a throwaway headless browser quiet: no sync, updates, telemetry or first-run UI. */
export function browserArgs(profileDir: string): string[] {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-breakpad",
    "--no-pings",
    "--metrics-recording-only",
    "--safebrowsing-disable-auto-update",
    "--password-store=basic",
    "--use-mock-keychain",
    "--mute-audio",
    "--hide-scrollbars",
    "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions",
  ];
  // Chromium refuses to start as root on Linux without this (containers, CI).
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0)
    args.push("--no-sandbox");
  args.push("about:blank");
  return args;
}

const liveBrowsers = new Set<{ kill(): void; profile: string }>();
let exitHooked = false;

function removeProfile(dir: string): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Windows may keep a file locked for a moment; the OS temp cleaner removes it later.
  }
}

/** Read the DevTools address from the profile's DevToolsActivePort file or the browser's stderr. */
async function devtoolsUrl(
  profile: string,
  stderrText: () => string,
  exited: () => boolean,
  timeoutMs: number,
): Promise<string> {
  const end = Date.now() + timeoutMs;
  const file = path.join(profile, "DevToolsActivePort");
  while (Date.now() < end) {
    try {
      const [port, wsPath] = fs.readFileSync(file, "utf8").split(/\r?\n/);
      if (port && /^\d+$/.test(port.trim()) && wsPath?.trim())
        return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    } catch {
      // not written yet
    }
    const m = stderrText().match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m?.[1]) return m[1];
    if (exited())
      throw new CdpError(
        `The browser stopped before it was ready. ${stderrText().trim().slice(-300)}`.trim(),
      );
    await Bun.sleep(50);
  }
  throw new CdpError(`The browser did not open its DevTools port within ${Math.round(timeoutMs / 1000)}s.`);
}

/**
 * Start the PC's browser headless with a fresh temporary profile and connect to it. The process tree
 * is contained (a Job Object on Windows, a process group elsewhere) and the profile is deleted on
 * close, on errors and when the engine exits.
 */
export async function launchBrowser(
  o: { browser?: string | null; timeoutMs?: number } = {},
): Promise<BrowserSession> {
  const browser = o.browser ?? findBrowser();
  if (!browser)
    throw new CdpError("No browser found (Edge or Chrome). Install one or set DEPO_BROWSER to its path.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "depo-cdp-"));
  const win = process.platform === "win32";
  let proc: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    proc = Bun.spawn([browser, ...browserArgs(profile)], {
      env: commandEnv(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
      detached: !win,
    });
  } catch (err) {
    removeProfile(profile);
    throw new CdpError(`Could not start the browser: ${err instanceof Error ? err.message : String(err)}`);
  }
  let job: JobHandle | null = null;
  if (win) job = await attachJob(proc.pid).catch(() => null);
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  const killTree = () => {
    if (job) job.terminate(1);
    else if (win) Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { windowsHide: true });
    else {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  };
  const handle = { kill: killTree, profile };
  liveBrowsers.add(handle);
  if (!exitHooked) {
    exitHooked = true;
    // Last resort when the engine exits in the middle of a check: never leave a browser behind.
    process.once("exit", () => {
      for (const b of liveBrowsers) {
        b.kill();
        removeProfile(b.profile);
      }
    });
  }

  let stderr = "";
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stderr) {
        if (stderr.length < 20_000) stderr += decoder.decode(chunk, { stream: true });
      }
    } catch {
      // the pipe broke when the browser was killed
    }
  })();

  let closed = false;
  let conn: CdpConnection | null = null;
  const close = async () => {
    if (closed) return;
    closed = true;
    let polite = false;
    if (conn && !conn.closed) {
      try {
        await conn.send("Browser.close", {}, { timeoutMs: 2000 });
        polite = true;
      } catch {
        // not answering: kill below
      }
    }
    conn?.close();
    // A browser that agreed to close gets a moment to save and exit; the tree is killed either way.
    if (polite) await Promise.race([proc.exited, Bun.sleep(2500)]);
    killTree();
    await Promise.race([proc.exited, Bun.sleep(2000)]);
    job?.close();
    liveBrowsers.delete(handle);
    removeProfile(profile);
  };

  try {
    const url = await devtoolsUrl(
      profile,
      () => stderr,
      () => exited,
      o.timeoutMs ?? 20_000,
    );
    conn = await CdpConnection.connect(url);
  } catch (err) {
    await close();
    throw err instanceof CdpError ? err : new CdpError(err instanceof Error ? err.message : String(err));
  }
  const c = conn;
  return {
    conn: c,
    profileDir: profile,
    newPage: () => openPage(c),
    close,
  };
}
