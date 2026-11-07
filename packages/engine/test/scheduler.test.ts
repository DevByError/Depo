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

describe("model affinity on a small GPU", () => {
  /** A scheduler with a clock the test moves forward. */
  function clocked(opts: { max?: number; cap?: number } = {}) {
    let t = 1_000_000;
    const bus = { emit: () => {} };
    const s = new ModelScheduler({
      bus: bus as unknown as EventBus,
      maxParallel: () => opts.max ?? 1,
      projectCap: () => opts.cap ?? 1,
      isProjectPaused: () => false,
      now: () => t,
    });
    return {
      s,
      advance: (ms: number) => {
        t += ms;
        s.refresh();
      },
    };
  }

  test("same priority: the loaded model goes first, until the other job has waited 20 s", async () => {
    const { s, advance } = clocked();
    const order: string[] = [];
    const g = gate();
    const first = s.run(req("A", { model: "big" }), () => g.p);
    const small = s.run(req("B", { model: "small" }), async () => {
      order.push("small");
    });
    advance(21_000);
    // "big" is loaded, but "small" has waited longer than the age limit: order wins.
    const big = s.run(req("C", { model: "big" }), async () => {
      order.push("big");
    });
    g.open();
    await Promise.all([first, small, big]);
    expect(order).toEqual(["small", "big"]);
  });

  test("background work does not swap the model while a task for another model waits or runs", async () => {
    const { s, advance } = clocked({ max: 2, cap: 1 });
    const started: string[] = [];
    const g1 = gate();
    const g2 = gate();
    const a1 = s.run(req("A", { model: "coder" }), async () => {
      started.push("A1");
      await g1.p;
    });
    // A may run one job at a time, so its second step waits for a slot of its own.
    const a2 = s.run(req("A", { model: "coder" }), async () => {
      started.push("A2");
      await g2.p;
    });
    const index = s.run(req("B", { model: "embed", priority: "background", taskId: null }), async () => {
      started.push("index");
    });
    await Bun.sleep(5);
    // A free slot, but starting the embedding model would push the coder out of VRAM.
    expect(started).toEqual(["A1"]);
    // Background work on the model that is loaded swaps nothing, so it may use the free slot.
    const sameModel = s.run(req("C", { model: "coder", priority: "background", taskId: null }), async () => {
      started.push("same-model");
    });
    await sameModel;
    expect(started).toEqual(["A1", "same-model"]);
    g1.open();
    await a1;
    await Bun.sleep(5);
    expect(started).toEqual(["A1", "same-model", "A2"]);
    g2.open();
    await a2;
    await Bun.sleep(5);
    // The task is between steps (its tools run): the background job gives it a moment first.
    expect(started).not.toContain("index");
    advance(3001);
    await index;
    expect(started.at(-1)).toBe("index");
  });

  test("a held background job is never starved: after 20 s it runs", async () => {
    const { s, advance } = clocked({ max: 2, cap: 1 });
    const started: string[] = [];
    const g = gate();
    const task = s.run(req("A", { model: "coder" }), async () => {
      started.push("task");
      await g.p;
    });
    const memory = s.run(req("B", { model: "fast", priority: "background", taskId: null }), async () => {
      started.push("memory");
    });
    await Bun.sleep(5);
    expect(started).toEqual(["task"]);
    advance(20_001);
    await memory;
    expect(started).toEqual(["task", "memory"]);
    g.open();
    await task;
  });

  test("the hold lifts by itself when the pause between steps is over", async () => {
    const s = new ModelScheduler({
      bus: { emit: () => {} } as unknown as EventBus,
      maxParallel: () => 1,
      projectCap: () => 1,
      isProjectPaused: () => false,
    });
    await s.run(req("A", { model: "coder" }), async () => {});
    const started = performance.now();
    await s.run(req("B", { model: "embed", priority: "background", taskId: null }), async () => {});
    // Real clock: it waited for the grace period (3 s) and was woken by a timer, not by new work.
    expect(performance.now() - started).toBeGreaterThanOrEqual(2900);
  }, 10_000);
});
