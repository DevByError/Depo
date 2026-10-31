import { describe, expect, test } from "bun:test";
import type { EventBus } from "../src/events/bus";
import { ModelScheduler, type SchedulerRequest } from "../src/scheduler/scheduler";

function setup(opts: { max?: number; cap?: number; paused?: Set<string> } = {}) {
  const events: { taskId?: string | null; text: string; details?: unknown }[] = [];
  const bus = { emit: (e: { taskId?: string | null; text: string; details?: unknown }) => events.push(e) };
  const s = new ModelScheduler({
    bus: bus as unknown as EventBus,
    maxParallel: () => opts.max ?? 1,
    projectCap: () => opts.cap ?? 1,
    isProjectPaused: (id) => opts.paused?.has(id) ?? false,
  });
  return { s, events };
}

const req = (projectId: string, over: Partial<SchedulerRequest> = {}): SchedulerRequest => ({
  projectId,
  taskId: `t-${projectId}`,
  model: "coder",
  priority: "task",
  label: "step",
  ...over,
});

/** A job that records when it starts and finishes when told to. */
function gate() {
  let open = () => {};
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

describe("model scheduler", () => {
  test("runs one job at a time and alternates between projects", async () => {
    const { s } = setup();
    const order: string[] = [];
    const gates = [gate(), gate(), gate(), gate()];
    const jobs = [
      s.run(req("A"), async () => {
        order.push("A1");
        await gates[0]?.p;
      }),
      s.run(req("A"), async () => {
        order.push("A2");
        await gates[1]?.p;
      }),
      s.run(req("B"), async () => {
        order.push("B1");
        await gates[2]?.p;
      }),
    ];
    await Bun.sleep(5);
    expect(order).toEqual(["A1"]);
    expect(s.status().running).toHaveLength(1);
    expect(s.status().queued).toHaveLength(2);
    gates[0]?.open();
    await Bun.sleep(5);
    // B has not had a turn yet, so it goes before A's second job.
    expect(order).toEqual(["A1", "B1"]);
    gates[2]?.open();
    await Bun.sleep(5);
    expect(order).toEqual(["A1", "B1", "A2"]);
    gates[1]?.open();
    await Promise.all(jobs);
    expect(s.status().running).toHaveLength(0);
    gates[3]?.open();
  });

  test("chat beats tasks, tasks beat background indexing", async () => {
    const { s } = setup();
    const order: string[] = [];
    const g = gate();
    const first = s.run(req("A"), () => g.p);
    const bg = s.run(req("B", { priority: "background" }), async () => {
      order.push("bg");
    });
    const task = s.run(req("C"), async () => {
      order.push("task");
    });
    const chat = s.run(req("D", { priority: "chat" }), async () => {
      order.push("chat");
    });
    g.open();
    await Promise.all([first, bg, task, chat]);
    expect(order).toEqual(["chat", "task", "bg"]);
  });

  test("prefers the model that is already loaded", async () => {
    const { s } = setup();
    const order: string[] = [];
    const g = gate();
    const first = s.run(req("A", { model: "big" }), () => g.p);
    const other = s.run(req("B", { model: "small" }), async () => {
      order.push("small");
    });
    const same = s.run(req("C", { model: "big" }), async () => {
      order.push("big");
    });
    g.open();
    await Promise.all([first, other, same]);
    expect(order).toEqual(["big", "small"]);
  });

  test("parallel slots, per-project caps and pausing", async () => {
    const paused = new Set<string>();
    const { s } = setup({ max: 2, cap: 1, paused });
    const g = gate();
    const started: string[] = [];
    const a1 = s.run(req("A"), async () => {
      started.push("A1");
      await g.p;
    });
    const a2 = s.run(req("A"), async () => {
      started.push("A2");
    });
    const b1 = s.run(req("B"), async () => {
      started.push("B1");
      await g.p;
    });
    await Bun.sleep(5);
    // Two slots, but A may only use one of them.
    expect(started.sort()).toEqual(["A1", "B1"]);
    paused.add("A");
    g.open();
    await Promise.all([a1, b1]);
    await Bun.sleep(5);
    expect(started).not.toContain("A2");
    paused.delete("A");
    s.refresh();
    await a2;
    expect(started).toContain("A2");
  });

  test("pause all holds new work until resumed; cancel leaves the queue", async () => {
    const { s, events } = setup();
    s.pause();
    const ctl = new AbortController();
    let ran = false;
    const job = s.run(
      req("A"),
      async () => {
        ran = true;
      },
      ctl.signal,
    );
    await Bun.sleep(5);
    expect(ran).toBe(false);
    expect(s.status().pausedAll).toBe(true);
    expect(events.some((e) => e.text === "All model work is paused")).toBe(true);
    ctl.abort();
    await expect(job).rejects.toThrow("Cancelled");
    expect(s.status().queued).toHaveLength(0);
    s.resume();
    await s.run(req("A"), async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
