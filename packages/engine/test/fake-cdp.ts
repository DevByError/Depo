/**
 * A fake Chrome DevTools Protocol endpoint for tests: answers the commands Depo's CDP client sends
 * and, on Page.navigate, plays the events a real page would produce (a document, a console error,
 * an uncaught exception, a 500 from an API, a request to the internet that must be blocked).
 */

export interface Received {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId: string | null;
}

export interface FakeCdpOptions {
  /** Answer for Runtime.evaluate, by expression. Return undefined for the default answers. */
  evaluate?(expression: string): { value?: unknown; exception?: string } | undefined;
  /** Methods that never get an answer (to test timeouts). */
  hang?: string[];
  /** Ignore Browser.close (the process must then be killed). */
  ignoreClose?: boolean;
  /** Called after Browser.close is answered. */
  onClose?(): void;
  /** The page's violations (axe). */
  violations?: unknown[];
  /** The page title. */
  title?: string;
  /** Whether the expected text is on the page. */
  textFound?: boolean;
}

/** A 1×1 transparent PNG. */
export const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const DEFAULT_VIOLATIONS = [
  {
    id: "image-alt",
    impact: "critical",
    help: "Images must have alternative text",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.14/image-alt",
    count: 2,
    targets: ["img.hero", "img.logo"],
  },
  {
    id: "color-contrast",
    impact: "serious",
    help: "Elements must meet minimum color contrast ratio thresholds",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.14/color-contrast",
    count: 3,
    targets: [".muted"],
  },
  {
    id: "region",
    impact: "moderate",
    help: "All page content should be contained by landmarks",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.14/region",
    count: 1,
    targets: ["footer"],
  },
];

export function startFakeCdp(o: FakeCdpOptions = {}) {
  const received: Received[] = [];
  const sockets = new Set<Bun.ServerWebSocket<unknown>>();
  let loader = 0;
  let viewport = { width: 1280, height: 800 };
  let requestN = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("fake devtools", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
          sessionId?: string;
        };
        const sessionId = msg.sessionId ?? null;
        received.push({ id: msg.id, method: msg.method, params: msg.params ?? {}, sessionId });
        if (o.hang?.includes(msg.method)) return;
        const reply = (result: unknown) =>
          ws.send(JSON.stringify({ id: msg.id, result, ...(sessionId ? { sessionId } : {}) }));
        const event = (method: string, params: unknown) =>
          ws.send(JSON.stringify({ method, params, sessionId: "S1" }));
        const p = msg.params ?? {};
        switch (msg.method) {
          case "Target.createTarget":
            return reply({ targetId: "T1" });
          case "Target.attachToTarget":
            return reply({ sessionId: "S1" });
          case "Emulation.setDeviceMetricsOverride":
            viewport = { width: Number(p.width), height: Number(p.height) };
            return reply({});
          case "Page.navigate": {
            const url = String(p.url);
            if (url.includes(":9/"))
              return reply({ frameId: "T1", errorText: "net::ERR_CONNECTION_REFUSED" });
            const loaderId = `L${++loader}`;
            reply({ frameId: "T1", loaderId });
            const id = () => `R${++requestN}`;
            const doc = id();
            event("Network.requestWillBeSent", {
              requestId: doc,
              loaderId,
              frameId: "T1",
              type: "Document",
              request: { url, method: "GET" },
            });
            event("Network.responseReceived", {
              requestId: doc,
              loaderId,
              frameId: "T1",
              type: "Document",
              response: { url, status: 200 },
            });
            event("Network.loadingFinished", { requestId: doc });
            event("Runtime.consoleAPICalled", {
              type: "error",
              args: [{ type: "string", value: "Widget failed to load" }],
              stackTrace: { callFrames: [{ url: `${url}main.js`, lineNumber: 11 }] },
            });
            event("Runtime.consoleAPICalled", {
              type: "log",
              args: [{ type: "string", value: "just a log" }],
            });
            event("Runtime.exceptionThrown", {
              exceptionDetails: {
                text: "Uncaught",
                exception: {
                  description: "TypeError: items.map is not a function\n    at render (main.js:3)",
                },
                url: `${url}main.js`,
                lineNumber: 2,
              },
            });
            const api = id();
            event("Network.requestWillBeSent", {
              requestId: api,
              loaderId,
              type: "Fetch",
              request: { url: `${url}api/items`, method: "GET" },
            });
            event("Network.responseReceived", {
              requestId: api,
              loaderId,
              type: "Fetch",
              response: { url: `${url}api/items`, status: 500 },
            });
            event("Network.loadingFinished", { requestId: api });
            const font = id();
            event("Network.requestWillBeSent", {
              requestId: font,
              loaderId,
              type: "Stylesheet",
              request: { url: "https://fonts.example.com/inter.css", method: "GET" },
            });
            event("Fetch.requestPaused", {
              requestId: "F1",
              networkId: font,
              request: { url: "https://fonts.example.com/inter.css" },
              resourceType: "Stylesheet",
            });
            event("Fetch.requestPaused", {
              requestId: "F2",
              networkId: "R-local",
              request: { url: `${url}app.css` },
              resourceType: "Stylesheet",
            });
            event("Network.loadingFailed", {
              requestId: font,
              type: "Stylesheet",
              errorText: "net::ERR_BLOCKED_BY_CLIENT",
              canceled: false,
            });
            event("Log.entryAdded", {
              entry: { source: "network", level: "error", text: "Failed to load resource: 500" },
            });
            event("Log.entryAdded", {
              entry: { source: "security", level: "error", text: "Mixed content warning" },
            });
            event("Page.loadEventFired", { timestamp: 1 });
            return;
          }
          case "Page.getLayoutMetrics":
            return reply({
              cssContentSize: { width: viewport.width, height: viewport.height * 5 },
              cssLayoutViewport: { clientWidth: viewport.width, clientHeight: viewport.height },
            });
          case "Page.captureScreenshot":
            return reply({ data: TINY_PNG });
          case "Runtime.evaluate": {
            const expr = String(p.expression);
            const custom = o.evaluate?.(expr);
            const value = custom
              ? custom.value
              : expr.includes("return typeof window.axe")
                ? "object"
                : expr.includes("window.axe.run")
                  ? JSON.stringify(o.violations ?? DEFAULT_VIOLATIONS)
                  : expr === "document.title"
                    ? (o.title ?? "Fake page")
                    : expr.includes("document.body.innerText") && expr.includes("norm(")
                      ? (o.textFound ?? true)
                      : expr.includes("#missing")
                        ? expr.includes("getBoundingClientRect")
                          ? null
                          : false
                        : expr.includes("getBoundingClientRect")
                          ? {
                              x: 120,
                              y: 48,
                              visible: true,
                              covered: expr.includes("#covered") ? "div.overlay" : null,
                            }
                          : expr.includes("el.focus()")
                            ? !expr.includes("#readonly")
                            : true;
            if (custom?.exception)
              return reply({
                result: { type: "object" },
                exceptionDetails: { text: "Uncaught", exception: { description: custom.exception } },
              });
            return reply({ result: { type: typeof value, value } });
          }
          case "Browser.close":
            if (o.ignoreClose) return;
            reply({});
            o.onClose?.();
            return;
          default:
            if (/^(Page|Runtime|Network|Log|Fetch|Input|Emulation)\./.test(msg.method)) return reply({});
            return ws.send(
              JSON.stringify({
                id: msg.id,
                error: { code: -32601, message: `'${msg.method}' wasn't found` },
              }),
            );
        }
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/devtools/browser/fake`,
    port: server.port ?? 0,
    received,
    /** Send an event to every client. */
    emit(method: string, params: unknown, sessionId: string | null = "S1") {
      for (const ws of sockets)
        ws.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
    },
    /** Drop every connection (the browser crashed). */
    drop() {
      for (const ws of sockets) ws.close();
    },
    stop() {
      server.stop(true);
    },
  };
}
