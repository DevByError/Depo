import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { DepoEvent } from "@depo/shared";
import { startFakeOllama } from "../../../scripts/fake-ollama-lib";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir } from "./helpers";

const FIXTURE = path.resolve(import.meta.dir, "../../../scripts/fixtures/fastapi-demo");
const hasPytest =
  Bun.spawnSync(["python3", "-c", "import fastapi, httpx, pytest"]).exitCode === 0 ||
  Bun.spawnSync(["python", "-c", "import fastapi, httpx, pytest"]).exitCode === 0;

let engine: Engine | null = null;
let stopFake = () => {};
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  stopFake();
  cleanup();
});

async function setup(stepDelayMs: number) {
  const t = tempDir("depo multi");
  cleanup = t.cleanup;
  const fake = startFakeOllama(0, { stepDelayMs });
  stopFake = fake.stop;
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    tasks: { retryDelayMs: 10 },
  });
  engine = e;
  await e.start();
  e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: fake.url, enabled: true }]);
  e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
  const open = async (name: string) => {
    const dir = path.join(t.dir, name);
    fs.cpSync(FIXTURE, dir, { recursive: true });
    return e.projects.open(dir);
  };
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  return { e, open, events };
}

describe("multiple projects", () => {
  test.if(hasPytest)(
    "acceptance: two projects run tasks at the same time with separate feeds and changes",
    async () => {
      const { e, open, events } = await setup(40);
      const a = await open("shop api");
      const b = await open("blog api");

      const ta = e.tasks.send(a.id, "add a /health endpoint to this FastAPI project");
      const tb = e.tasks.send(b.id, "add a /version endpoint to this FastAPI project");
      expect(
        e.tasks
          .active()
          .map((t) => t.id)
          .sort(),
      ).toEqual([ta.id, tb.id].sort());
      await Promise.all([e.tasks.settled(ta.id), e.tasks.settled(tb.id)]);

      for (const [t, ep] of [
        [ta, "health"],
        [tb, "version"],
      ] as const) {
        const got = e.tasks.get(t.id);
        expect(got.task.error).toBeNull();
        expect(got.task.status).toBe("review");
        expect(got.messages.at(-1)?.text).toContain(`/${ep}`);
      }

      // The two tasks really overlapped: each started before the other finished.
      const firstOf = (taskId: string) => events.findIndex((ev) => ev.taskId === taskId);
      const handoff = (taskId: string) =>
        events.findIndex((ev) => ev.taskId === taskId && ev.type === "handoff");
      expect(handoff(ta.id)).toBeGreaterThan(0);
      expect(handoff(tb.id)).toBeGreaterThan(0);
      expect(firstOf(tb.id)).toBeLessThan(handoff(ta.id));
      expect(firstOf(ta.id)).toBeLessThan(handoff(tb.id));

      // One GPU: the scheduler queued model calls rather than running them together.
      expect(events.some((ev) => ev.type === "queued")).toBe(true);

      // Feeds are separate: every event of a task carries that task's project.
      for (const ev of events.filter((x) => x.taskId === ta.id)) expect(ev.projectId).toBe(a.id);
      for (const ev of events.filter((x) => x.taskId === tb.id)) expect(ev.projectId).toBe(b.id);
      const feedA = e.bus.recent({ limit: 500, projectId: a.id });
      const feedB = e.bus.recent({ limit: 500, projectId: b.id });
      expect(feedA.some((ev) => ev.taskId === tb.id)).toBe(false);
      expect(feedB.some((ev) => ev.taskId === ta.id)).toBe(false);
      expect(feedA.some((ev) => ev.text.includes("/version"))).toBe(false);
      expect(feedB.some((ev) => ev.text.includes("/health"))).toBe(false);

      // No cross-contamination of changes or files.
      const [csA] = e.projects.listChangeSets(a.id);
      const [csB] = e.projects.listChangeSets(b.id);
      const diff = (cs: typeof csA) =>
        cs?.files.flatMap((f) => f.hunks.flatMap((h) => h.lines)).join("\n") ?? "";
      expect(diff(csA)).toContain('"/health"');
      expect(diff(csA)).not.toContain('"/version"');
      expect(diff(csB)).toContain('"/version"');
      expect(diff(csB)).not.toContain('"/health"');
      expect(e.projects.listChangeSets(a.id)).toHaveLength(1);
      expect(e.projects.listChangeSets(b.id)).toHaveLength(1);
      expect(e.tasks.list(a.id).map((t) => t.id)).toEqual([ta.id]);
      expect(e.tasks.list(b.id).map((t) => t.id)).toEqual([tb.id]);
      expect(e.tasks.active()).toHaveLength(0);
    },
    90_000,
  );

  test("pausing a project holds its model calls until it is resumed", async () => {
    const { e, open, events } = await setup(0);
    const a = await open("paused api");
    e.registry.setSettings(a.id, { paused: true });
    const t = e.tasks.send(a.id, "say hello");
    await Bun.sleep(300);
    expect(e.tasks.get(t.id).task.status).toBe("running");
    expect(e.scheduler.status().queued.map((j) => j.taskId)).toEqual([t.id]);
    expect(events.some((ev) => ev.type === "queued" && ev.taskId === t.id)).toBe(true);
    e.registry.setSettings(a.id, { paused: false });
    e.scheduler.refresh();
    await e.tasks.settled(t.id);
    expect(e.tasks.get(t.id).task.status).toBe("done");
  });

  test.if(hasPytest)(
    "a fixed test failure becomes a lesson that later runs see",
    async () => {
      const { e, open } = await setup(0);
      const a = await open("lesson api");
      const t1 = e.tasks.send(a.id, "add a slugify helper");
      await e.tasks.settled(t1.id);
      expect(e.tasks.get(t1.id).task.summary).toBe("Added slugify with a test (2 passed).");
      const [lesson] = e.memory.list(a.id, ["lesson"]);
      expect(lesson?.text).toContain("no module named");
      expect(lesson?.text).toContain("app/slug.py");

      // The next task hits the same error and is shown the lesson with the test output.
      const t2 = e.tasks.send(a.id, "add a slugify helper");
      await e.tasks.settled(t2.id);
      const failedRun = e.tasks
        .get(t2.id)
        .messages.find((m) => m.toolName === "run_command" && !m.text.startsWith("Exit code 0."));
      expect(failedRun?.text).toContain("Lessons from earlier fixes");
      expect(e.memory.list(a.id, ["lesson"])).toHaveLength(1);
    },
    60_000,
  );

  test("project memory and the repo map reach the agent's system prompt", async () => {
    const { e, open } = await setup(0);
    const a = await open("mem api");
    e.memory.add(a.id, "decision", "All endpoints return JSON objects");
    e.indexer.ensure(a.id);
    await e.indexer.idle(a.id);
    const t = e.tasks.send(a.id, "say hello");
    await e.tasks.settled(t.id);
    const prompt = (
      e.tasks as unknown as { systemPrompt(id: string, n: string, r: string): string }
    ).systemPrompt(a.id, a.name, a.rootPath);
    expect(prompt).toContain("All endpoints return JSON objects");
    expect(prompt).toContain("app/main.py");
    expect(prompt).toContain("Repo map");
  });
});

describe("restart", () => {
  test("tasks left working by a stopped engine are marked stopped on the next start", async () => {
    const t = tempDir("depo restart");
    const dataRoot = path.join(t.dir, "data");
    const first = createEngine({ dataRoot, token: TEST_TOKEN, heartbeatMs: 60_000 });
    const dir = path.join(t.dir, "proj");
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const project = await first.projects.open(dir);
    const { tasks } = await import("../src/db/schema");
    const now = new Date().toISOString();
    first.database.db
      .insert(tasks)
      .values({
        id: "tsk_orphan",
        projectId: project.id,
        title: "old",
        prompt: "old",
        status: "running",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    first.database.close();
    const second = createEngine({ dataRoot, token: TEST_TOKEN, heartbeatMs: 60_000 });
    engine = second;
    cleanup = t.cleanup;
    await second.start();
    const got = second.tasks.get("tsk_orphan");
    expect(got.task.status).toBe("cancelled");
    expect(got.messages.at(-1)?.text).toContain("Depo was closed");
    expect(second.tasks.active()).toHaveLength(0);
  });
});
