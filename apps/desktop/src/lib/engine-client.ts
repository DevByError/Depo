import {
  type ApiMethod,
  type ApiParams,
  type ApiResult,
  ApiSchema,
  type DepoEvent,
  type RpcError,
  RpcNotificationSchema,
  RpcResponseSchema,
} from "@depo/shared";

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "stopped";

export class EngineCallError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "EngineCallError";
  }
}

/** Minimal WebSocket surface the client needs; lets tests inject a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface EngineClientOptions {
  /** Resolves the ws:// URL (with token). Called on every (re)connect, since the engine may restart on a new port. */
  resolveUrl: () => Promise<string>;
  createSocket?: (url: string) => SocketLike;
  callTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/** How a link to the engine ended, and how long the window waited for the next one. */
export interface LinkClose {
  code: number;
  reason: string;
  clean: boolean;
  /** When it ended (Date.now()). */
  at: number;
  /** Tries it took to connect again (filled in when the next link opens). */
  attempts: number;
  /** How long until the next link opened, in ms (filled in when it opens). */
  downMs: number;
}

interface Pending {
  method: ApiMethod;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

/**
 * Typed JSON-RPC client for the Depo engine.
 * - Reconnects with exponential backoff (at most 2 s apart) and re-resolves the URL each time;
 *   `kick()` tries at once (the window became visible, the network came back).
 * - Validates every result against the shared API schema (the engine is trusted, but versions can drift).
 * - Rejects in-flight calls when the socket drops, so the UI never waits forever.
 */
export class EngineClient {
  private socket: SocketLike | null = null;
  private status: ConnectionStatus = "idle";
  private nextId = 1;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(e: DepoEvent) => void>();
  private readonly statusListeners = new Set<(s: ConnectionStatus, error?: string) => void>();
  private readonly reconnectListeners = new Set<(close: LinkClose | null, connects: number) => void>();
  private readonly opts: Required<EngineClientOptions>;
  /** Links opened since the window loaded. */
  private connects = 0;
  /** How the last link ended (null until one ends). */
  private lastClose: LinkClose | null = null;
  /** When the last message from the engine arrived (Date.now()), 0 before any. */
  private lastMessageAt = 0;

  constructor(opts: EngineClientOptions) {
    this.opts = {
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      callTimeoutMs: 15_000,
      minBackoffMs: 250,
      // A local engine that dropped the link is usually back within a second or two: try often.
      maxBackoffMs: 2_000,
      ...opts,
    };
  }

  get currentStatus(): ConnectionStatus {
    return this.status;
  }

  onEvent(fn: (e: DepoEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onStatus(fn: (s: ConnectionStatus, error?: string) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Told each time a link opens: how the previous one ended (null for the first) and the count. */
  onConnected(fn: (close: LinkClose | null, connects: number) => void): () => void {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }

  /** Milliseconds since the engine last sent anything (heartbeats come every 2 s); null before any. */
  quietMs(now = Date.now()): number | null {
    return this.lastMessageAt ? now - this.lastMessageAt : null;
  }

  /** Waiting to reconnect: try now instead of after the backoff. */
  kick(): void {
    if (this.status !== "reconnecting" || !this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    void this.connect();
  }

  start(): void {
    if (this.status !== "idle" && this.status !== "stopped") return;
    void this.connect();
  }

  stop(): void {
    this.setStatus("stopped");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "client stopped");
    this.socket = null;
    this.rejectAll("Client stopped");
  }

  call<M extends ApiMethod>(
    method: M,
    params: ApiParams<M>,
    opts: { timeoutMs?: number } = {},
  ): Promise<ApiResult<M>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      return Promise.reject(new EngineCallError("Not connected to the Depo engine", -1));
    }
    const id = this.nextId++;
    return new Promise<ApiResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineCallError(`${method} timed out`, -2));
      }, opts.timeoutMs ?? this.opts.callTimeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private setStatus(s: ConnectionStatus, error?: string) {
    this.status = s;
    for (const fn of this.statusListeners) fn(s, error);
  }

  private async connect(): Promise<void> {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let url: string;
    try {
      url = await this.opts.resolveUrl();
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : "Could not locate the engine");
      return;
    }
    if (this.status === "stopped") return;

    const socket = this.opts.createSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      const tries = this.attempt;
      this.attempt = 0;
      this.connects++;
      this.lastMessageAt = Date.now();
      if (this.lastClose) {
        this.lastClose.attempts = tries;
        this.lastClose.downMs = Date.now() - this.lastClose.at;
      }
      this.setStatus("open");
      for (const fn of this.reconnectListeners) fn(this.lastClose, this.connects);
    };
    socket.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(ev.data);
    };
    socket.onerror = () => {
      // onclose follows and handles reconnection.
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      // Only a link that was open counts: a failed try keeps the first close's details.
      if (this.status === "open") {
        const e = (ev ?? {}) as { code?: unknown; reason?: unknown; wasClean?: unknown };
        this.lastClose = {
          code: typeof e.code === "number" ? e.code : 1006,
          reason: typeof e.reason === "string" ? e.reason.slice(0, 200) : "",
          clean: e.wasClean === true,
          at: Date.now(),
          attempts: 0,
          downMs: 0,
        };
      }
      this.rejectAll("Connection to the engine was lost");
      if (this.status !== "stopped") this.scheduleReconnect("Connection lost");
    };
  }

  private scheduleReconnect(reason: string) {
    if (this.status === "stopped") return;
    this.attempt++;
    const delay = Math.min(this.opts.maxBackoffMs, this.opts.minBackoffMs * 2 ** (this.attempt - 1));
    this.setStatus("reconnecting", reason);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private rejectAll(message: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new EngineCallError(message, -3));
      this.pending.delete(id);
    }
  }

  private handleMessage(data: unknown) {
    let json: unknown;
    try {
      json = JSON.parse(String(data));
    } catch {
      return;
    }
    const note = RpcNotificationSchema.safeParse(json);
    if (note.success) {
      for (const fn of this.eventListeners) fn(note.data.params);
      return;
    }
    const res = RpcResponseSchema.safeParse(json);
    if (!res.success || typeof res.data.id !== "number") return;
    const p = this.pending.get(res.data.id);
    if (!p) return;
    this.pending.delete(res.data.id);
    clearTimeout(p.timer);
    if ("error" in res.data) {
      const e: RpcError = res.data.error;
      // An unknown method almost always means an engine left over from an older install.
      const message =
        e.code === -32601
          ? `${e.message}. The engine is older than this window: quit Depo, end depo-engine.exe in Task Manager, and start Depo again.`
          : e.message;
      p.reject(new EngineCallError(message, e.code, e.data));
      return;
    }
    const parsed = ApiSchema[p.method].result.safeParse(res.data.result);
    if (!parsed.success) {
      p.reject(new EngineCallError(`Unexpected response shape from ${p.method}`, -4, parsed.error.issues));
      return;
    }
    p.resolve(parsed.data);
  }
}
