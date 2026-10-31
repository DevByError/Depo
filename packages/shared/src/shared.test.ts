import { describe, expect, test } from "bun:test";
import {
  ApiSchema,
  type DepoEvent,
  DepoEventSchema,
  isApiMethod,
  newId,
  RpcRequestSchema,
  SettingKeySchema,
} from "./index";

describe("newId", () => {
  test("has prefix and sorts by time", () => {
    const a = newId("evt", 1_000);
    const b = newId("evt", 2_000);
    expect(a).toMatch(/^evt_[0-9a-f]{28}$/);
    expect(a < b).toBe(true);
  });
  test("is unique", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("req")));
    expect(ids.size).toBe(1000);
  });
});

describe("schemas", () => {
  test("rejects malformed rpc requests", () => {
    expect(RpcRequestSchema.safeParse({ jsonrpc: "1.0", id: 1, method: "x" }).success).toBe(false);
    expect(RpcRequestSchema.safeParse({ jsonrpc: "2.0", id: 1, method: "system.ping" }).success).toBe(true);
  });
  test("event schema accepts a full event", () => {
    const ev: DepoEvent = {
      id: newId("evt"),
      ts: new Date().toISOString(),
      seq: 1,
      projectId: null,
      taskId: null,
      agent: "engine",
      type: "heartbeat",
      text: "alive",
      details: { uptimeMs: 1 },
      durationMs: null,
      status: "info",
      ephemeral: true,
    };
    expect(DepoEventSchema.parse(ev)).toEqual(ev);
  });
  test("setting keys are restricted", () => {
    expect(SettingKeySchema.safeParse("ui.theme").success).toBe(true);
    expect(SettingKeySchema.safeParse("../etc").success).toBe(false);
    expect(SettingKeySchema.safeParse("UI.Theme").success).toBe(false);
  });
  test("method lookup does not see prototype keys", () => {
    expect(isApiMethod("system.ping")).toBe(true);
    expect(isApiMethod("toString")).toBe(false);
    expect(isApiMethod("__proto__")).toBe(false);
  });
  test("events.recent applies default limit", () => {
    expect(ApiSchema["events.recent"].params.parse({}).limit).toBe(200);
  });
});
