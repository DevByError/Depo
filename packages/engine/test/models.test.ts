import { afterEach, describe, expect, test } from "bun:test";
import type { HardwareProfile } from "@depo/model-gateway";
import { type ApiMethod, type ApiParams, type ApiResult, ApiSchema, type DepoEvent } from "@depo/shared";
import { handlers } from "../src/api/handlers";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir, waitFor } from "./helpers";

const FAKE_HW: Omit<HardwareProfile, "benchmark"> = {
  os: { platform: "win32", release: "10.0.26100", arch: "x64" },
  cpu: { model: "Test CPU", threads: 16, avx: true, avx2: true, avx512: false },
  ramGB: 32,
  unifiedMemory: false,
  gpus: [{ name: "NVIDIA GeForce RTX 4070", vendor: "nvidia", vramGB: 12, source: "nvidia-smi" }],
  diskFreeGB: 400,
  profiledAt: "2026-10-31T00:00:00Z",
};

let engine: Engine | null = null;
let cleanup = () => {};
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

interface FakeOllama {
  url: string;
  deleted: string[];
  pullDelayMs: number;
}

/** A small stand-in for Ollama's HTTP API. */
function fakeOllama(): FakeOllama {
  const state: FakeOllama = { url: "", deleted: [], pullDelayMs: 0 };
  const enc = new TextEncoder();
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/api/version":
          return Response.json({ version: "0.12.6" });
        case "/api/tags":
          return Response.json({
            models: [
              {
                name: "qwen3-coder:30b",
                size: 18_556_700_000,
                details: { family: "qwen3moe", quantization_level: "Q4_K_M" },
              },
              { name: "my-custom:latest", size: 1000 },
            ],
          });
        case "/api/pull": {
          const body = (await req.json()) as { model: string };
          const delay = state.pullDelayMs;
          return new Response(
            new ReadableStream({
              async start(ctl) {
                for (let i = 0; i <= 4; i++) {
                  ctl.enqueue(
                    enc.encode(
                      `${JSON.stringify({ status: "downloading", total: 400, completed: i * 100 })}\n`,
                    ),
                  );
                  await Bun.sleep(delay || 5);
                }
                if (body.model === "broken:1b") {
                  ctl.enqueue(enc.encode(`${JSON.stringify({ error: "file does not exist" })}\n`));
                } else {
                  ctl.enqueue(enc.encode(`${JSON.stringify({ status: "success" })}\n`));
                }
                ctl.close();
              },
            }),
          );
        }
        case "/api/delete": {
          const body = (await req.json()) as { model: string };
          state.deleted.push(body.model);
          return new Response(null);
        }
        case "/api/chat": {
          const lines = [
            { message: { content: "def merge" } },
            { message: { content: "_intervals(): ..." } },
            { done: true, prompt_eval_count: 40, eval_count: 120, eval_duration: 2_000_000_000 },
          ];
          return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(s);
  state.url = `http://127.0.0.1:${s.port}`;
  return state;
}

async function boot() {
  const t = tempDir();
  cleanup = t.cleanup;
  engine = createEngine({
    dataRoot: t.dir,
    token: TEST_TOKEN,
    heartbeatMs: 10_000,
    models: {
      profile: async () => ({ ...FAKE_HW, profiledAt: new Date().toISOString() }),
      ollamaModelsDir: t.dir,
    },
  });
  await engine.start();
  return engine;
}

/** Call a handler the way the API server does: validate params, run, validate the result. */
async function call<M extends ApiMethod>(e: Engine, method: M, params: ApiParams<M>): Promise<ApiResult<M>> {
  const schema = ApiSchema[method];
  const p = schema.params.parse(params);
  const ctx = {
    bus: e.bus,
    settings: e.settings,
    models: e.models,
    info: { startedAt: new Date(), dataDir: e.dirs.root, dbPath: e.database.path, schemaVersion: 1 },
  };
  const fn = handlers[method] as (p: unknown, c: typeof ctx) => unknown;
  return schema.result.parse(await fn(p, ctx)) as ApiResult<M>;
}

function collect(e: Engine): DepoEvent[] {
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  return events;
}

describe("models API", () => {
  test("providers: default list, status of a running and a missing runtime, LAN-only", async () => {
    const e = await boot();
    const ollama = fakeOllama();
    const defaults = await call(e, "models.providers", {});
    expect(defaults.providers.map((p) => p.id)).toEqual(["ollama", "lmstudio", "llamacpp"]);

    await call(e, "models.providers.set", {
      providers: [
        { id: "ollama", kind: "ollama", baseUrl: ollama.url, enabled: true },
        { id: "lmstudio", kind: "lmstudio", baseUrl: "http://127.0.0.1:9", enabled: true },
        { id: "llamacpp", kind: "llamacpp", baseUrl: "http://127.0.0.1:8080", enabled: false },
      ],
    });
    const { providers } = await call(e, "models.providers", {});
    expect(providers[0]).toMatchObject({ id: "ollama", ok: true, version: "0.12.6" });
    expect(providers[1]).toMatchObject({
      ok: false,
      message: "LM Studio is not running or not reachable. Start it and try again.",
    });
    expect(providers[2]).toMatchObject({ ok: false, message: "Turned off" });

    await expect(
      call(e, "models.providers.set", {
        providers: [{ id: "cloud", kind: "lmstudio", baseUrl: "https://api.example.com", enabled: true }],
      }),
    ).rejects.toThrow(/not a local or LAN address/);
  });

  test("installed models are matched to the catalog", async () => {
    const e = await boot();
    const ollama = fakeOllama();
    await call(e, "models.providers.set", {
      providers: [{ id: "ollama", kind: "ollama", baseUrl: ollama.url, enabled: true }],
    });
    const { models } = await call(e, "models.installed", {});
    expect(models.map((m) => [m.name, m.catalogId])).toEqual([
      ["qwen3-coder:30b", "qwen3-coder-30b"],
      ["my-custom:latest", null],
    ]);
  });

  test("profile → plan → assignments, with manual override", async () => {
    const e = await boot();
    const events = collect(e);
    expect((await call(e, "models.plan", {})).plan).toBeNull();
    const { profile } = await call(e, "hardware.profile", {});
    expect(profile.gpus[0]?.vramGB).toBe(12);
    expect(events.some((ev) => ev.type === "hardware_profiled" && ev.text.includes("RTX 4070"))).toBe(true);
    expect((await call(e, "hardware.get", {})).profile?.ramGB).toBe(32);

    const { plan } = await call(e, "models.plan", {});
    expect(plan?.roles.coder?.modelId).toBe("qwen3-coder-30b");
    expect((await call(e, "models.plan", { mode: "balanced" })).plan?.mode).toBe("balanced");

    const auto = await call(e, "models.assignments", {});
    expect(auto.assignments).toEqual({});
    expect(auto.effective.coder).toEqual({ providerId: "ollama", model: plan?.roles.coder?.tag ?? "" });

    const manual = await call(e, "models.assign", {
      role: "coder",
      ref: { providerId: "ollama", model: "my-custom:latest" },
    });
    expect(manual.effective.coder?.model).toBe("my-custom:latest");
    expect(e.models.resolve("coder")?.model).toBe("my-custom:latest");
    expect(e.models.resolve("coder")?.contextLength).toBeUndefined();
    const back = await call(e, "models.assign", { role: "coder", ref: null });
    expect(back.effective.coder?.model).toBe(plan?.roles.coder?.tag ?? "");
    expect(e.models.resolve("reasoning")?.contextLength).toBe(plan?.roles.reasoning?.contextLength ?? -1);
  });

  test("pull reports progress events and finishes; failures and cancellation are reported", async () => {
    const e = await boot();
    const ollama = fakeOllama();
    const events = collect(e);
    await call(e, "models.providers.set", {
      providers: [{ id: "ollama", kind: "ollama", baseUrl: ollama.url, enabled: true }],
    });

    const job = await call(e, "models.pull", { providerId: "ollama", model: "qwen2.5-coder:7b" });
    expect(job.state).toBe("running");
    const again = await call(e, "models.pull", { providerId: "ollama", model: "qwen2.5-coder:7b" });
    expect(again.jobId).toBe(job.jobId);
    await waitFor(() => (e.models.pulls()[0]?.state === "succeeded" ? true : undefined));
    const done = events.filter((ev) => ev.type === "model_download");
    expect(done[0]?.status).toBe("started");
    expect(done.at(-1)).toMatchObject({ status: "succeeded", text: "Downloaded qwen2.5-coder:7b" });
    expect(e.models.pulls()[0]?.completedBytes).toBe(400);

    await call(e, "models.pull", { providerId: "ollama", model: "broken:1b" });
    await waitFor(() =>
      e.models.pulls().find((j) => j.model === "broken:1b")?.state === "failed" ? true : undefined,
    );
    expect(e.models.pulls().find((j) => j.model === "broken:1b")?.error).toContain("file does not exist");

    ollama.pullDelayMs = 200;
    const slow = await call(e, "models.pull", { providerId: "ollama", model: "qwen3:8b" });
    expect((await call(e, "models.pull.cancel", { jobId: slow.jobId })).cancelled).toBe(true);
    await waitFor(() =>
      e.models.pulls().find((j) => j.jobId === slow.jobId)?.state === "cancelled" ? true : undefined,
    );
    expect((await call(e, "models.pulls", {})).jobs).toHaveLength(3);
  });

  test("pull refuses runtimes that manage their own models", async () => {
    const e = await boot();
    await expect(call(e, "models.pull", { providerId: "lmstudio", model: "x" })).rejects.toThrow(
      /manages its own models/,
    );
  });

  test("delete removes the model and any manual assignment to it", async () => {
    const e = await boot();
    const ollama = fakeOllama();
    await call(e, "models.providers.set", {
      providers: [{ id: "ollama", kind: "ollama", baseUrl: ollama.url, enabled: true }],
    });
    await call(e, "models.assign", {
      role: "fast",
      ref: { providerId: "ollama", model: "my-custom:latest" },
    });
    await call(e, "models.delete", { providerId: "ollama", model: "my-custom:latest" });
    expect(ollama.deleted).toEqual(["my-custom:latest"]);
    expect((await call(e, "models.assignments", {})).assignments.fast).toBeUndefined();
  });

  test("benchmark measures tokens/sec and calibrates the plan", async () => {
    const e = await boot();
    const ollama = fakeOllama();
    await call(e, "models.providers.set", {
      providers: [{ id: "ollama", kind: "ollama", baseUrl: ollama.url, enabled: true }],
    });
    await call(e, "hardware.profile", {});
    const before = (await call(e, "models.plan", {})).plan;
    const { benchmark } = await call(e, "models.benchmark", {
      providerId: "ollama",
      model: "qwen2.5-coder:1.5b",
    });
    expect(benchmark).toMatchObject({ catalogId: "qwen2.5-coder-1.5b", tokensPerSec: 60 });
    expect((await call(e, "hardware.get", {})).profile?.benchmark?.tokensPerSec).toBe(60);
    const after = (await call(e, "models.plan", {})).plan;
    expect(after?.budget.calibration).not.toBe(before?.budget.calibration);
    // Re-profiling keeps the benchmark.
    await call(e, "hardware.profile", {});
    expect((await call(e, "hardware.get", {})).profile?.benchmark?.tokensPerSec).toBe(60);
  });

  test("catalog import validates, replaces, and resets", async () => {
    const e = await boot();
    const def = await call(e, "models.catalog", {});
    expect(def.custom).toBe(false);
    await expect(call(e, "models.catalog.import", { json: "{nope" })).rejects.toThrow("not valid JSON");
    await expect(
      call(e, "models.catalog.import", { json: JSON.stringify({ version: 1 }) }),
    ).rejects.toThrow();
    const only = def.catalog.models.filter((m) => m.id === "qwen2.5-coder-7b");
    const custom = await call(e, "models.catalog.import", {
      json: JSON.stringify({ version: 2, updated: "2026-11-01", models: only }),
    });
    expect(custom).toMatchObject({ custom: true, catalog: { version: 2 } });
    expect((await call(e, "models.catalog", {})).catalog.models).toHaveLength(1);
    expect((await call(e, "models.catalog.import", { json: null })).custom).toBe(false);
  });
});
