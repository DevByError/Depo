import { afterEach, describe, expect, test } from "bun:test";

process.env.DEPO_NO_BROWSER = "1";

import fs from "node:fs";
import path from "node:path";
import {
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  collectChat,
  type HardwareProfile,
  type ModelProvider,
  type ToolCall,
} from "@depo/model-gateway";
import { ApiSchema } from "@depo/shared";
import { FAKE_COLD_LOAD_NS, type FakeRequest, startFakeOllama } from "../../../scripts/fake-ollama-lib";
import { firstStepRole } from "../src/agents/first-step";
import { manifestOf } from "../src/agents/manifests";
import { handlers } from "../src/api/handlers";
import { createEngine, type Engine } from "../src/engine";
import { checkSpeedSetting } from "../src/models/speed";
import { TEST_TOKEN, tempDir, waitFor } from "./helpers";

/** The owner's PC: GTX 1650 (4 GB), 25 GB RAM. */
const OWNER_PC: Omit<HardwareProfile, "benchmark"> = {
  os: { platform: "win32", release: "10.0.26100", arch: "x64" },
  cpu: { model: "Test CPU", threads: 12, avx: true, avx2: true, avx512: false },
  ramGB: 25,
  unifiedMemory: false,
  gpus: [{ name: "NVIDIA GeForce GTX 1650", vendor: "nvidia", vramGB: 4, source: "nvidia-smi" }],
  diskFreeGB: 400,
  profiledAt: "2026-11-07T00:00:00Z",
};

let engine: Engine | null = null;
let stopFake = () => {};
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  stopFake();
  stopFake = () => {};
  cleanup();
  cleanup = () => {};
});

async function setup(opts: { providerFactory?: () => ModelProvider } = {}) {
  const t = tempDir("depo speed");
  cleanup = t.cleanup;
  const fake = startFakeOllama();
  stopFake = fake.stop;
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    tasks: { retryDelayMs: 10 },
    models: {
      profile: async () => OWNER_PC,
      ...(opts.providerFactory ? { providerFactory: opts.providerFactory } : {}),
    },
  });
  engine = e;
  await e.start();
  e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: fake.url, enabled: true }]);
  // Only the calls under test reach the model.
  e.settings.set("memory.auto", false);
  e.settings.set("preview.auto_start", false);
  const proj = path.join(t.dir, "my site");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "README.md"), "# My site\n");
  return { e, fake, proj, dir: t.dir };
}

const chats = (requests: FakeRequest[]) => requests.filter((r) => r.path === "/api/chat");
const numCtx = (r: FakeRequest | undefined) => (r?.body.options as { num_ctx?: number } | undefined)?.num_ctx;

async function setSetting(e: Engine, key: string, value: unknown) {
  const ctx = { bus: e.bus, settings: e.settings } as unknown as Parameters<
    (typeof handlers)["settings.set"]
  >[1];
  const params = ApiSchema["settings.set"].params.parse({ key, value });
  return handlers["settings.set"](params, ctx);
}

describe("one context length per model", () => {
  test("two roles sharing a model send the same num_ctx, whatever each caller asks for", async () => {
    const { e, fake, dir } = await setup();
    await e.models.profileHardware(dir);
    const plan = e.models.plan();
    const fast = plan?.roles.fast;
    if (!fast) throw new Error("no quick-task model in the plan");
    // Auto-Fit gives the quick-task model a small context; the coder role, put on the same model by
    // hand, needs the default 16k. Before, the two sent different num_ctx and Ollama reloaded it.
    expect(fast.contextLength).toBeLessThan(16_384);
    e.models.assign("coder", { providerId: "ollama", model: fast.tag });
    const coder = e.models.resolve("coder");
    const quick = e.models.resolve("fast");
    expect(coder?.model).toBe(fast.tag);
    expect(quick?.model).toBe(fast.tag);
    expect(coder?.contextLength).toBe(16_384);
    expect(quick?.contextLength).toBe(coder?.contextLength);

    const ask = (r: typeof coder, contextLength?: number) =>
      collectChat(
        (r as NonNullable<typeof coder>).provider.chat({
          model: fast.tag,
          messages: [{ role: "user", content: "hi" }],
          ...(contextLength !== undefined ? { contextLength } : {}),
        }),
      );
    await ask(coder, coder?.contextLength);
    await ask(quick, 8192); // a caller that asks for its own context
    await ask(quick); // a caller that asks for none (a benchmark, a commit message)
    expect(chats(fake.requests).map(numCtx)).toEqual([16_384, 16_384, 16_384]);
    // Every call after the first found the model loaded.
    const calls = e.logs.stats.recent(10).reverse();
    expect(calls.map((c) => c.coldLoad)).toEqual([true, false, false]);
    expect(calls.map((c) => c.contextLength)).toEqual([16_384, 16_384, 16_384]);
  });

  test("the context is capped by what fits in VRAM and RAM", async () => {
    const { e, dir } = await setup();
    await e.models.profileHardware(dir);
    // A 32B coder fits 16k at most on 4 GB VRAM and 25 GB RAM, so a 32k need is cut to 16k.
    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:32b" });
    expect(e.models.resolve("coder")?.contextLength).toBe(16_384);
  });
});

describe("keeping models loaded", () => {
  test("every call sends the keep-alive setting; it is validated before it is saved", async () => {
    const { e, fake } = await setup();
    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
    const r = e.models.resolve("coder");
    if (!r) throw new Error("no coder");
    const ask = () =>
      collectChat(r.provider.chat({ model: r.model, messages: [{ role: "user", content: "hi" }] }));
    await ask();
    expect((await setSetting(e, "models.keep_alive", " 2H ")).value).toBe("2h");
    await ask();
    await setSetting(e, "models.keep_alive", "-1");
    await ask();
    expect(chats(fake.requests).map((q) => q.body.keep_alive)).toEqual(["30m", "2h", -1]);
    expect(() => checkSpeedSetting("models.keep_alive", "forever")).toThrow("Keep models loaded for");
    await expect(Promise.resolve().then(() => setSetting(e, "models.keep_alive", "5"))).rejects.toThrow();
    expect(() => checkSpeedSetting("models.preload", "yes")).toThrow();
    expect(checkSpeedSetting("models.preload", false)).toBe(false);
    expect(e.settings.get("models.keep_alive")).toBe("-1");
  });

  test('"until Depo closes" unloads the models this run used when the engine stops', async () => {
    const { e, fake } = await setup();
    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
    e.settings.set("models.keep_alive", "-1");
    const r = e.models.resolve("coder");
    if (!r) throw new Error("no coder");
    await collectChat(r.provider.chat({ model: r.model, messages: [{ role: "user", content: "hi" }] }));
    expect(fake.loaded.has("qwen2.5-coder:1.5b")).toBe(true);
    await e.stop("test");
    engine = null;
    expect(fake.requests.at(-1)).toMatchObject({
      path: "/api/generate",
      body: { model: "qwen2.5-coder:1.5b", keep_alive: 0 },
    });
    expect(fake.loaded.has("qwen2.5-coder:1.5b")).toBe(false);
  });
});

describe("prompts ordered for prefix reuse", () => {
  test("the coding agent's consecutive steps share the whole earlier prompt as their prefix", async () => {
    const { e, fake, proj } = await setup();
    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
    e.memory.add(null, "preference", "Use plain words in comments.", "user");
    const project = await e.projects.open(proj);
    const task = e.tasks.send(project.id, "check the landing page");
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.error).toBeNull();
    const steps = chats(fake.requests).filter((r) => Array.isArray(r.body.tools));
    expect(steps.length).toBeGreaterThanOrEqual(3);
    const sys = (r: FakeRequest) => (r.body.messages as ChatMessage[])[0]?.content ?? "";
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1] as FakeRequest;
      const next = steps[i] as FakeRequest;
      // At least the whole system prompt, and here the whole earlier conversation, is identical.
      expect(sys(next)).toBe(sys(prev));
      const before = prev.body.messages as unknown[];
      expect((next.body.messages as unknown[]).slice(0, before.length)).toEqual(before);
      expect(next.body.tools).toEqual(prev.body.tools);
      expect(next.body.options).toEqual(prev.body.options);
      expect(next.body.keep_alive).toBe(prev.body.keep_alive);
    }
    // Static parts first (role, rules, playbook), then project facts, then memory.
    const prompt = sys(steps[0] as FakeRequest);
    expect(prompt.startsWith("You are Depo's coding agent.")).toBe(true);
    const at = (s: string) => prompt.indexOf(s);
    expect(at("# Your playbook")).toBeGreaterThan(0);
    expect(at("# Your playbook")).toBeLessThan(at("Project: "));
    expect(at("Project: ")).toBeLessThan(at("# What you know about this project"));
    // No clock times or random ids in a system prompt.
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(prompt).not.toMatch(/\b(?:tsk|msg|prj|sch)_[A-Za-z0-9]{6,}/);
  }, 30_000);

  test("a team agent's consecutive steps share the whole earlier prompt as their prefix", async () => {
    const seen: ChatRequest[] = [];
    let id = 0;
    const call = (name: string, args: Record<string, unknown>): ToolCall => ({
      id: `c${++id}`,
      name,
      arguments: args,
      rawArguments: JSON.stringify(args),
    });
    const model: ModelProvider = {
      id: "ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      health: async () => ({ ok: true, version: "fake", message: null }),
      listModels: async () => [],
      embed: async (_m, inputs) => inputs.map(() => [0]),
      async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
        seen.push(structuredClone({ ...req, signal: undefined }));
        const tools = req.messages.filter((m) => m.role === "tool").length;
        const reply =
          tools === 0
            ? { calls: [call("list_dir", { path: "." })] }
            : tools === 1
              ? { calls: [call("read_file", { path: "README.md" })] }
              : { text: "The project is a one-page site with a README." };
        if (reply.text) yield { type: "text", delta: reply.text };
        for (const c of reply.calls ?? []) yield { type: "tool_call", call: c };
        yield { type: "done", finishReason: reply.calls ? "tool_calls" : "stop", usage: null };
      },
    };
    const { e, proj } = await setup({ providerFactory: () => model });
    e.models.assign("coder", { providerId: "ollama", model: "fake-model" });
    e.models.assign("reasoning", { providerId: "ollama", model: "fake-model" });
    e.settings.set("team.approve_plan", false);
    const project = await e.projects.open(proj);
    const task = e.tasks.send(project.id, "what does this project do?", undefined, "ask");
    await e.tasks.settled(task.id);
    const agentSteps = seen.filter((r) => r.tools?.length);
    expect(agentSteps.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < agentSteps.length; i++) {
      const prev = agentSteps[i - 1] as ChatRequest;
      const next = agentSteps[i] as ChatRequest;
      expect(next.messages[0]).toEqual(prev.messages[0] as ChatMessage);
      expect(next.messages.slice(0, prev.messages.length)).toEqual(prev.messages);
      expect(next.tools).toEqual(prev.tools);
      expect(next.contextLength).toBe(prev.contextLength);
    }
    const sys = agentSteps[0]?.messages[0]?.content ?? "";
    expect(sys.indexOf("You are the Reasoning agent")).toBeLessThan(sys.indexOf("Project: "));
    expect(sys.indexOf("Shell: ")).toBeLessThan(sys.indexOf("Project: "));
    expect(sys).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  }, 30_000);
});

describe("warm-up", () => {
  test("a task loads its first model early, with the same num_ctx and keep-alive, and only once", async () => {
    const { e, fake, proj } = await setup();
    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
    const project = await e.projects.open(proj);
    const first = e.tasks.send(project.id, "make a landing page");
    await e.tasks.settled(first.id);
    const preloads = fake.requests.filter((r) => r.path === "/api/generate");
    expect(preloads).toHaveLength(1);
    // The warm-up comes before the first step and loads the model exactly as the steps use it.
    expect(fake.requests[0]?.path).toBe("/api/generate");
    expect(preloads[0]?.body).toMatchObject({ model: "qwen2.5-coder:1.5b", prompt: "", keep_alive: "30m" });
    const firstChat = chats(fake.requests)[0];
    expect(numCtx(preloads[0])).toBe(numCtx(firstChat));
    // So every step found it loaded; the load shows up in the stats as an early load.
    const stats = e.logs.stats.summary().find((m) => m.model === "qwen2.5-coder:1.5b");
    expect(stats?.coldLoads).toBe(1);
    expect(stats?.medianLoadMs).toBe(FAKE_COLD_LOAD_NS / 1e6);
    expect(stats?.keptLoaded).toBe(true);
    expect(e.logs.stats.recent(20).every((c) => c.coldLoad === false)).toBe(true);

    // The model is still in memory: the next task does not load it again.
    const second = e.tasks.send(project.id, "make a landing page");
    await e.tasks.settled(second.id);
    expect(fake.requests.filter((r) => r.path === "/api/generate")).toHaveLength(1);
  }, 30_000);

  test("no warm-up when it is turned off, and the task does not wait for a slow one", async () => {
    const { e, fake, proj } = await setup();
    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
    e.settings.set("models.preload", false);
    const project = await e.projects.open(proj);
    const task = e.tasks.send(project.id, "make a landing page");
    await e.tasks.settled(task.id);
    expect(fake.requests.some((r) => r.path === "/api/generate")).toBe(false);
    expect(e.tasks.get(task.id).task.status).toBe("review");
  }, 30_000);

  test("the first step's role: coder alone, the Manager's reasoning model, or a one-step mode's agent", () => {
    expect(firstStepRole("single", "add a page")).toBe("coder");
    expect(firstStepRole("backend", "add a tasks API")).toBe("reasoning");
    expect(firstStepRole("ask", "what does this do?")).toBe("reasoning");
    expect(firstStepRole("business", "who would buy this?")).toBe("reasoning");
    expect(
      firstStepRole("business", "who would buy this?", (id) => ({
        ...manifestOf(id),
        role: "fast",
      })),
    ).toBe("fast");
  });

  test("a warm-up that fails or is cancelled never fails the task", async () => {
    const { e, proj } = await setup();
    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
    const project = await e.projects.open(proj);
    const task = e.tasks.send(project.id, "make a landing page");
    e.tasks.cancel(task.id);
    await e.tasks.settled(task.id);
    await waitFor(() => (e.scheduler.status().running.length === 0 ? true : undefined));
    expect(e.tasks.get(task.id).task.status).toBe("cancelled");
  });
});
