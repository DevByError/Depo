import { timingSafeEqual } from "node:crypto";
import {
  ApiSchema,
  type DepoEvent,
  isApiMethod,
  type RpcError,
  RpcErrorCode,
  type RpcNotification,
  RpcRequestSchema,
  type RpcResponse,
} from "@depo/shared";
import type { ServerWebSocket } from "bun";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import type { HandlerContext, Handlers } from "./handlers";

export interface ApiServerOptions {
  token: string;
  /** 0 = pick a free random port. */
  port: number;
  handlers: Handlers;
  context: HandlerContext;
  bus: EventBus;
  logger: Logger;
  maxPayloadBytes?: number;
  /** Told when a call starts (the freeze watchdog notes what the engine is doing). */
  onCall?: (method: string) => void;
}

export interface ApiServer {
  port: number;
  clientCount(): number;
  /** Calls being answered right now, oldest first. */
  inflight(): { method: string; ms: number }[];
  stop(): Promise<void>;
}

interface SocketData {
  clientId: number;
  openedAt?: number;
  unsubscribe?: () => void;
}

/**
 * Room for one message from the UI: a message may carry up to 4 design pictures of 5 MB each,
 * which are about 27 MB as base64. A bigger message makes Bun close the link (code 1009).
 */
export const MAX_MESSAGE_BYTES = 48 * 1024 * 1024;
/** A call slower than this is written to the log (what kept the engine busy). */
const SLOW_CALL_MS = 2000;

/** Origins the WebView2 shell and the dev server use. Non-browser clients send no Origin. */
export function isAllowedOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  if (
    origin === "tauri://localhost" ||
    origin === "http://tauri.localhost" ||
    origin === "https://tauri.localhost"
  ) {
    return true;
  }
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}

export function tokensMatch(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Local JSON-RPC 2.0 server over WebSocket, bound to 127.0.0.1 only.
 * Clients connect to ws://127.0.0.1:<port>/rpc?token=<per-launch token>.
 * Every connected client receives all bus events as `event` notifications.
 */
export function startApiServer(opts: ApiServerOptions): ApiServer {
  let nextClientId = 1;
  const clients = new Set<ServerWebSocket<SocketData>>();
  const log = opts.logger.child({ component: "api" });
  let nextCall = 1;
  const calls = new Map<number, { method: string; started: number }>();

  const send = (ws: ServerWebSocket<SocketData>, msg: RpcResponse | RpcNotification) => {
    ws.send(JSON.stringify(msg));
  };

  const fail = (id: string | number | null, error: RpcError): RpcResponse => ({ jsonrpc: "2.0", id, error });

  const dispatch = async (raw: string): Promise<RpcResponse> => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return fail(null, { code: RpcErrorCode.ParseError, message: "Invalid JSON" });
    }
    const parsed = RpcRequestSchema.safeParse(json);
    if (!parsed.success) {
      return fail(null, { code: RpcErrorCode.InvalidRequest, message: "Invalid JSON-RPC request" });
    }
    const { id, method, params } = parsed.data;
    if (!isApiMethod(method)) {
      return fail(id, { code: RpcErrorCode.MethodNotFound, message: `Unknown method: ${method}` });
    }
    const schema = ApiSchema[method];
    const p = schema.params.safeParse(params ?? {});
    if (!p.success) {
      log.warn("invalid params", { method, issues: p.error.issues.slice(0, 5).map((i) => i.message) });
      return fail(id, { code: RpcErrorCode.InvalidParams, message: "Invalid params", data: p.error.issues });
    }
    const started = performance.now();
    const callId = nextCall++;
    calls.set(callId, { method, started });
    opts.onCall?.(method);
    try {
      // The handler map is keyed by method; TypeScript cannot correlate the union here.
      const handler = opts.handlers[method] as (params: unknown, ctx: HandlerContext) => unknown;
      const result = await handler(p.data, opts.context);
      const durationMs = Math.round(performance.now() - started);
      // The Logs view polls logs.tail; logging those calls would only feed the view itself.
      if (durationMs >= SLOW_CALL_MS) log.info("slow api call", { method, durationMs });
      else if (!method.startsWith("logs.") && method !== "system.ping") {
        log.debug("api call", { method, durationMs });
      }
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      log.error("handler failed", { method, durationMs: Math.round(performance.now() - started), err });
      return fail(id, {
        code: RpcErrorCode.InternalError,
        message: err instanceof Error ? err.message : "Internal error",
      });
    } finally {
      calls.delete(callId);
    }
  };

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: opts.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== "/rpc") return new Response("Not found", { status: 404 });
      if (!isAllowedOrigin(req.headers.get("origin"))) {
        log.warn("rejected connection: origin", { origin: req.headers.get("origin") });
        return new Response("Forbidden", { status: 403 });
      }
      if (!tokensMatch(opts.token, url.searchParams.get("token"))) {
        log.warn("rejected connection: bad token");
        return new Response("Unauthorized", { status: 401 });
      }
      if (srv.upgrade(req, { data: { clientId: nextClientId++ } })) return undefined;
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      maxPayloadLength: opts.maxPayloadBytes ?? MAX_MESSAGE_BYTES,
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        clients.add(ws);
        ws.data.openedAt = Date.now();
        log.info("ui client connected", { clientId: ws.data.clientId, clients: clients.size });
        ws.data.unsubscribe = opts.bus.subscribe((event: DepoEvent) => {
          send(ws, { jsonrpc: "2.0", method: "event", params: event });
        });
        opts.bus.emit({
          agent: "engine",
          type: "client_connected",
          text: `UI client #${ws.data.clientId} connected`,
          details: { clientId: ws.data.clientId, clients: clients.size },
        });
      },
      async message(ws, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        send(ws, await dispatch(raw));
      },
      close(ws, code, reason) {
        ws.data.unsubscribe?.();
        clients.delete(ws);
        // Who closed the link and why: 1000/1001 = closed on purpose (window reload or quit),
        // 1006 = dropped without a goodbye, 1009 = a message was too big.
        log.info("ui client disconnected", {
          clientId: ws.data.clientId,
          code,
          reason: reason || null,
          connectedMs: ws.data.openedAt ? Date.now() - ws.data.openedAt : null,
          clients: clients.size,
        });
        opts.bus.emit({
          agent: "engine",
          type: "client_disconnected",
          text: `UI client #${ws.data.clientId} disconnected`,
          details: { clientId: ws.data.clientId, clients: clients.size, code, reason: reason || null },
        });
      },
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("API server did not bind a port");
  log.info("api server listening", { port });

  return {
    port,
    clientCount: () => clients.size,
    inflight: () => {
      const now = performance.now();
      return [...calls.values()].map((c) => ({ method: c.method, ms: Math.round(now - c.started) }));
    },
    stop: async () => {
      for (const ws of clients) ws.close(1001, "Engine stopping");
      await server.stop(true);
    },
  };
}
