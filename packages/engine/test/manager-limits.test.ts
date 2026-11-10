import { afterEach, describe, expect, test } from "bun:test";

process.env.DEPO_NO_BROWSER = "1";

import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ChatRequest, ModelProvider } from "@depo/model-gateway";
import type { DepoEvent } from "@depo/shared";
import { planProgressText } from "../src/agents/team";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir } from "./helpers";

// The owner's first team run: qwen3:4b planned for 11 minutes with "Manager is planning the work"
// and nothing else on screen; Stop then marked the task as crashed.

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

/** A Manager that only thinks about the plan, until it is stopped; every other call ends at once. */
function thinker(requests: ChatRequest[]): ModelProvider {
  return {
    id: "fake",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    health: async () => ({ ok: true, version: "fake", message: null }),
    listModels: async () => [],
    embed: async () => [],
    async *chat(req): AsyncGenerator<ChatChunk> {
      requests.push(req);
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      if (req.jsonSchema && sys.includes("Plan the work as a task graph")) {
        while (!req.signal?.aborted) {
          yield { type: "thinking", delta: "Hmm, maybe the login page first. " };
          await Bun.sleep(25);
        }
        throw Object.assign(new Error("Cancelled"), { name: "ModelGatewayError", kind: "cancelled" });
      }
      yield { type: "text", delta: "Done." };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
}

async function setup(model: ModelProvider, planLimits: { thinkMs: number; totalMs: number }) {
  const t = tempDir("depo manager limits");
  cleanup = t.cleanup;
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    tasks: { retryDelayMs: 10, planLimits },
    models: { providerFactory: () => model },
  });
  engine = e;
  await e.start();
  e.models.setProviders([{ id: "fake", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }]);
  e.models.assign("coder", { providerId: "fake", model: "fake-coder" });
  e.models.assign("reasoning", { providerId: "fake", model: "qwen3:4b" });
  e.settings.set("team.approve_plan", false);
  const proj = path.join(t.dir, "app");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "app" }));
  const project = await e.projects.open(proj);
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  return { e, project, events };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

describe("the Manager's plan never hangs", () => {
  test("a Manager that only thinks is stopped and the standard steps start, with progress shown meanwhile", async () => {
    const requests: ChatRequest[] = [];
    const { e, project, events } = await setup(thinker(requests), { thinkMs: 2500, totalMs: 20_000 });
    const task = e.tasks.send(project.id, "add a register and login API", undefined, "backend");
    await until(() => events.some((ev) => ev.type === "warning" && /standard steps/.test(ev.text)));

    const plan = requests.find((r) => r.jsonSchema);
    expect(plan?.think).toBe(false);
    expect(plan?.maxTokens).toBe(4096);
    // The chat line moved while the Manager thought.
    const progress = events.filter((ev) => ev.ephemeral && ev.details?.jobId === `manager-plan-${task.id}`);
    expect(
      progress.some((ev) => /^Manager is thinking about the plan \(about \d+ words, \d+ s\)$/.test(ev.text)),
    ).toBe(true);
    expect(progress.at(-1)?.details?.clear).toBe(true);
    const warning = events.find((ev) => ev.type === "warning" && /standard steps/.test(ev.text));
    expect(warning?.text).toBe(
      "qwen3:4b thought for 3 seconds without starting its answer, so Depo uses the standard steps and starts the work",
    );
    await until(() => !!e.tasks.teamState(task.id).plan);
    expect(e.tasks.teamState(task.id).plan?.nodes.length).toBeGreaterThan(1);
    e.tasks.cancel(task.id);
    await e.tasks.settled(task.id);
  }, 30_000);

  test("Stop while the Manager plans marks the task stopped, not failed", async () => {
    const requests: ChatRequest[] = [];
    const { e, project, events } = await setup(thinker(requests), { thinkMs: 60_000, totalMs: 120_000 });
    const task = e.tasks.send(project.id, "add a register and login API", undefined, "backend");
    await until(() => events.some((ev) => ev.ephemeral && /^Manager is thinking/.test(ev.text)));
    e.tasks.cancel(task.id);
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("cancelled");
    expect(events.some((ev) => ev.type === "info" && ev.text === "Stopped by the user")).toBe(true);
    expect(events.some((ev) => ev.type === "error")).toBe(false);
  }, 30_000);

  test("an agent's thinking is not its reply, and the waiting line counts it", async () => {
    const thinkingCoder: ModelProvider = {
      ...thinker([]),
      async *chat(): AsyncGenerator<ChatChunk> {
        for (let i = 0; i < 30; i++) {
          yield { type: "thinking", delta: "Let me look at the files first. " };
          await Bun.sleep(50);
        }
        yield { type: "text", delta: "Done: nothing to change." };
        yield { type: "done", finishReason: "stop", usage: null };
      },
    };
    const { e, project, events } = await setup(thinkingCoder, { thinkMs: 60_000, totalMs: 120_000 });
    const task = e.tasks.send(project.id, "check the readme");
    await e.tasks.settled(task.id);
    const answer = e.tasks
      .get(task.id)
      .messages.filter((m) => m.role === "assistant")
      .at(-1);
    expect(answer?.text).toBe("Done: nothing to change.");
    const waits = events.filter(
      (ev) => ev.ephemeral && /^Waiting for .+: thinking, about \d+ words$/.test(ev.text),
    );
    expect(waits.length).toBeGreaterThan(0);
    expect(typeof waits.at(-1)?.details?.thinkingChars).toBe("number");
  }, 30_000);

  test("the progress line", () => {
    expect(planProgressText({ thinkingChars: 0, textChars: 0, attempt: 1 }, 4000)).toBe(
      "Manager is reading the request (4 s)",
    );
    expect(planProgressText({ thinkingChars: 2520, textChars: 0, attempt: 1 }, 80_000)).toBe(
      "Manager is thinking about the plan (about 420 words, 1 min 20 s)",
    );
    expect(planProgressText({ thinkingChars: 2520, textChars: 1234, attempt: 2 }, 95_000)).toBe(
      "Manager is writing the plan (1,234 characters, 1 min 35 s, fixing its JSON)",
    );
  });
});
