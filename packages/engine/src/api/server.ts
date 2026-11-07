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
}

export interface ApiServer {
  port: number;
  clientCount(): number;
  stop(): Promise<void>;
}

interface SocketData {
  clientId: number;
  unsubscribe?: () => void;
}

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
    try {
      // The handler map is keyed by method; TypeScript cannot correlate the union here.
      const handler = opts.handlers[method] as (params: unknown, ctx: HandlerContext) => unknown;
      const result = await handler(p.data, opts.context);
      // The Logs view polls logs.tail; logging those calls would only feed the view itself.
      if (!method.startsWith("logs.") && method !== "system.ping") {
        log.debug("api call", { method, durationMs: Math.round(performance.now() - started) });
      }
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      log.error("handler failed", { method, durationMs: Math.round(performance.now() - started), err });
      return fail(id, {
        code: RpcErrorCode.InternalError,
        message: err instanceof Error ? err.message : "Internal error",
      });
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
      // Room for design reference pictures (up to 5 MB each, sent as base64 with the message).
      maxPayloadLength: opts.maxPayloadBytes ?? 16 * 1024 * 1024,
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        clients.add(ws);
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
      close(ws) {
        ws.data.unsubscribe?.();
        clients.delete(ws);
        opts.bus.emit({
          agent: "engine",
          type: "client_disconnected",
          text: `UI client #${ws.data.clientId} disconnected`,
          details: { clientId: ws.data.clientId, clients: clients.size },
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
    stop: async () => {
      for (const ws of clients) ws.close(1001, "Engine stopping");
      await server.stop(true);
    },
  };
}
