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

interface Pending {
  method: ApiMethod;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

/**
 * Typed JSON-RPC client for the Depo engine.
 * - Reconnects with exponential backoff and re-resolves the URL each time.
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
  private readonly opts: Required<EngineClientOptions>;

  constructor(opts: EngineClientOptions) {
    this.opts = {
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      callTimeoutMs: 15_000,
      minBackoffMs: 250,
      maxBackoffMs: 5_000,
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
      this.attempt = 0;
      this.setStatus("open");
    };
    socket.onmessage = (ev) => this.handleMessage(ev.data);
    socket.onerror = () => {
      // onclose follows and handles reconnection.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
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
      p.reject(new EngineCallError(e.message, e.code, e.data));
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
