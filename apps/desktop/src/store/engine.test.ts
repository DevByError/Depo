import { type DepoEvent, newId } from "@depo/shared";
import { beforeEach, expect, test } from "vitest";
import { capEvents, MAX_HEARTBEATS, useEngine } from "./engine";

function ev(partial: Partial<DepoEvent>): DepoEvent {
  return {
    id: newId("evt"),
    ts: new Date().toISOString(),
    seq: 1,
    projectId: null,
    taskId: null,
    agent: "engine",
    type: "info",
    text: "x",
    details: null,
    durationMs: null,
    status: "info",
    ephemeral: false,
    ...partial,
  };
}

const hbDetails = { uptimeMs: 1, rssBytes: 2, heapUsedBytes: 3, connectedClients: 1, eventsPersisted: 0 };

beforeEach(() => useEngine.setState({ events: [], heartbeats: [] }));

test("heartbeats go to their own ring buffer, not the feed", () => {
  const s = useEngine.getState();
  for (let i = 0; i < MAX_HEARTBEATS + 5; i++)
    s.receive(ev({ type: "heartbeat", details: hbDetails, ephemeral: true }));
  s.receive(ev({ text: "real" }));
  expect(useEngine.getState().heartbeats).toHaveLength(MAX_HEARTBEATS);
  expect(useEngine.getState().events.map((e) => e.text)).toEqual(["real"]);
});

test("malformed heartbeats are ignored", () => {
  useEngine.getState().receive(ev({ type: "heartbeat", details: { nope: 1 } }));
  expect(useEngine.getState().heartbeats).toHaveLength(0);
});

test("backlog merges without duplicates and keeps time order", () => {
  const early = ev({ ts: "2026-01-01T00:00:00.000Z", text: "early" });
  const live = ev({ ts: "2026-01-01T00:00:05.000Z", text: "live" });
  useEngine.getState().receive(live);
  useEngine.getState().loadBacklog([early, live]);
  expect(useEngine.getState().events.map((e) => e.text)).toEqual(["early", "live"]);
});

test("capEvents keeps the newest", () => {
  const list = Array.from({ length: 10 }, (_, i) => ev({ text: String(i) }));
  expect(capEvents(list, 3).map((e) => e.text)).toEqual(["7", "8", "9"]);
});

test("download progress replaces itself and clears when the job ends", () => {
  const s = useEngine.getState();
  const job = { jobId: "job_1" };
  s.receive(ev({ type: "model_download", status: "started", text: "start", details: job }));
  for (let i = 0; i < 5; i++) {
    s.receive(
      ev({ type: "model_download", status: "running", text: `p${i}`, details: job, ephemeral: true }),
    );
  }
  s.receive(
    ev({
      type: "model_download",
      status: "running",
      text: "other",
      details: { jobId: "job_2" },
      ephemeral: true,
    }),
  );
  expect(useEngine.getState().events.map((e) => e.text)).toEqual(["start", "p4", "other"]);
  s.receive(ev({ type: "model_download", status: "succeeded", text: "done", details: job }));
  expect(useEngine.getState().events.map((e) => e.text)).toEqual(["start", "other", "done"]);
});
