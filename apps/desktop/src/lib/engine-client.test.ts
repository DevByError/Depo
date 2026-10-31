import { newId } from "@depo/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EngineCallError, EngineClient, type SocketLike } from "./engine-client";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(data: string) {
    this.sent.push(data);
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  lastRequest(): { id: number; method: string } {
    return JSON.parse(this.sent.at(-1) ?? "{}");
  }
}

const URL = "ws://127.0.0.1:1/rpc?token=x";

function makeClient() {
  return new EngineClient({
    resolveUrl: async () => URL,
    createSocket: (url) => new FakeSocket(url),
    minBackoffMs: 10,
    maxBackoffMs: 40,
    callTimeoutMs: 1000,
  });
}

async function opened(client: EngineClient): Promise<FakeSocket> {
  client.start();
  await vi.waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  const s = FakeSocket.all.at(-1) as FakeSocket;
  s.open();
  return s;
}

beforeEach(() => {
  FakeSocket.all = [];
});
afterEach(() => vi.useRealTimers());

describe("EngineClient", () => {
  test("resolves typed results", async () => {
    const c = makeClient();
    const s = await opened(c);
    const p = c.call("system.ping", {});
    const { id, method } = s.lastRequest();
    expect(method).toBe("system.ping");
    s.receive({ jsonrpc: "2.0", id, result: { pong: true, serverTime: "now" } });
    await expect(p).resolves.toEqual({ pong: true, serverTime: "now" });
  });

  test("rejects results with the wrong shape", async () => {
    const c = makeClient();
    const s = await opened(c);
    const p = c.call("system.ping", {});
    s.receive({ jsonrpc: "2.0", id: s.lastRequest().id, result: { pong: "yes" } });
    await expect(p).rejects.toMatchObject({ code: -4 });
  });

  test("turns rpc errors into EngineCallError", async () => {
    const c = makeClient();
    const s = await opened(c);
    const p = c.call("settings.get", { key: "ui.theme" });
    s.receive({ jsonrpc: "2.0", id: s.lastRequest().id, error: { code: -32602, message: "Invalid params" } });
    await expect(p).rejects.toBeInstanceOf(EngineCallError);
  });

  test("dispatches event notifications", async () => {
    const c = makeClient();
    const seen: string[] = [];
    c.onEvent((e) => seen.push(e.text));
    const s = await opened(c);
    s.receive({
      jsonrpc: "2.0",
      method: "event",
      params: {
        id: newId("evt"),
        ts: new Date().toISOString(),
        seq: 1,
        projectId: null,
        taskId: null,
        agent: "engine",
        type: "info",
        text: "hello",
        details: null,
        durationMs: null,
        status: "info",
        ephemeral: false,
      },
    });
    s.receive({ jsonrpc: "2.0", method: "event", params: { bogus: true } });
    expect(seen).toEqual(["hello"]);
  });

  test("fails fast when not connected", async () => {
    const c = makeClient();
    await expect(c.call("system.ping", {})).rejects.toMatchObject({ code: -1 });
  });

  test("rejects pending calls on disconnect and reconnects", async () => {
    const c = makeClient();
    const statuses: string[] = [];
    c.onStatus((st) => statuses.push(st));
    const s = await opened(c);
    const p = c.call("system.ping", {});
    s.close();
    await expect(p).rejects.toMatchObject({ code: -3 });
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(2));
    FakeSocket.all[1]?.open();
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "reconnecting", "open"]);
    c.stop();
  });

  test("times out calls the engine never answers", async () => {
    const c = makeClient();
    await opened(c);
    vi.useFakeTimers();
    const p = c.call("system.ping", {});
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toMatchObject({ code: -2 });
  });
});
