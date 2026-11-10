import { afterEach, describe, expect, test } from "bun:test";

process.env.DEPO_NO_BROWSER = "1";

import fs from "node:fs";
import path from "node:path";
import {
  type ChatChunk,
  type ChatRequest,
  ModelGatewayError,
  type ModelProvider,
  type ToolCall,
} from "@depo/model-gateway";
import type { DepoEvent, RunRecipeBase } from "@depo/shared";
import { createFromBlueprint } from "../src/blueprints/service";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir } from "./helpers";

// The owner: "it should build from 0 and should delete what in the shade when we close or stop
// it". Stop ends the task's running app, and what the stopped run wrote leaves the private copy.

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

let n = 0;
const write = (file: string, content: string): ToolCall => {
  const args = { path: file, content };
  return { id: `w${++n}`, name: "write_file", arguments: args, rawArguments: JSON.stringify(args) };
};

/** Writes the file the request names, then answers; a request with "slow" writes, then works until stopped. */
function model(started: () => void): ModelProvider {
  return {
    id: "fake",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:1",
    health: async () => ({ ok: true, version: "fake", message: null }),
    listModels: async () => [],
    embed: async (_m, inputs) => inputs.map(() => [0]),
    async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
      const users = req.messages.filter((m) => m.role === "user");
      const asked = users.at(-1)?.content ?? "";
      // A follow-up's message also sums up the earlier request: the newest "write" is this one.
      const file = [...asked.matchAll(/write (\S+)/g)].at(-1)?.[1] ?? "notes.txt";
      if (req.messages.at(-1)?.role === "user") {
        yield { type: "tool_call", call: write(file, `${file}\n`) };
        yield { type: "done", finishReason: "tool_calls", usage: null };
        return;
      }
      if (/slow/.test(asked)) {
        started();
        await new Promise<void>((r) => req.signal?.addEventListener("abort", () => r(), { once: true }));
        throw new ModelGatewayError("cancelled", "Cancelled");
      }
      yield { type: "text", delta: `Wrote ${file}.` };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
}

async function setup(settings: Record<string, unknown> = {}) {
  let started = () => {};
  const t = tempDir("depo stop clears");
  cleanup = t.cleanup;
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    tasks: { retryDelayMs: 10 },
    models: {
      providerFactory: () =>
        model(() => {
          started();
        }),
    },
  });
  engine = e;
  await e.start();
  e.models.setProviders([{ id: "fake", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }]);
  e.models.assign("coder", { providerId: "fake", model: "fake-model" });
  for (const [k, v] of Object.entries({ "memory.auto": false, "preview.auto_start": false, ...settings }))
    e.settings.set(k, v as never);
  const proj = path.join(t.dir, "site");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "index.html"), "<h1>site</h1>\n");
  const project = await e.projects.open(proj);
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  const working = () =>
    new Promise<void>((r) => {
      started = r;
    });
  return { e, project, events, working, proj };
}

const STATIC: RunRecipeBase = {
  id: "static:.",
  kind: "static",
  label: "Static site",
  command: "",
  cwd: "",
  env: {},
  port: 5500,
  readyPath: "/",
  role: "app",
  missing: null,
};

describe("Stop clears the stopped run", () => {
  test("a new task: its app stops and its private copy is removed, so the next run starts clean", async () => {
    const { e, project, events, working } = await setup();
    const busy = working();
    const task = e.tasks.send(project.id, "slow: write page.html with a header");
    await busy;
    const copy = e.tasks.workspaceRoot(task.id) as string;
    expect(fs.existsSync(path.join(copy, "page.html"))).toBe(true);
    const { preview } = await e.previews.start({ projectId: project.id, taskId: task.id, recipe: STATIC });
    expect(["starting", "running"]).toContain(e.previews.get(preview.id)?.state ?? "");

    e.tasks.cancel(task.id);
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("cancelled");
    expect(e.previews.get(preview.id)?.state).toBe("stopped");
    expect(fs.existsSync(copy)).toBe(false);
    expect(e.tasks.workspaceRoot(task.id)).toBeNull();
    expect(e.projects.listChangeSets(project.id).filter((c) => c.taskId === task.id)).toEqual([]);
    expect(events.some((ev) => ev.text === "Stopped by the user")).toBe(true);
    expect(
      events.some(
        (ev) => ev.text === "Cleared the private copy: the next run starts from your project as it is",
      ),
    ).toBe(true);
  }, 30_000);

  test("a follow-up: only the stopped run's work leaves the copy; the earlier work stays for review", async () => {
    const { e, project, working } = await setup();
    const task = e.tasks.send(project.id, "write about.html");
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("review");
    const copy = e.tasks.workspaceRoot(task.id) as string;
    const busy = working();
    e.tasks.send(project.id, "slow: write contact.html", task.id);
    await busy;
    expect(fs.existsSync(path.join(copy, "contact.html"))).toBe(true);
    e.tasks.cancel(task.id);
    await e.tasks.settled(task.id);
    expect(fs.existsSync(path.join(copy, "about.html"))).toBe(true);
    expect(fs.existsSync(path.join(copy, "contact.html"))).toBe(false);
    const latest = e.projects.listChangeSets(project.id).find((c) => c.taskId === task.id);
    expect(latest?.files.map((f) => f.path)).toEqual(["about.html"]);
  }, 30_000);

  test("with tasks.keep_stopped_work on, the stopped work stays for review", async () => {
    const { e, project, working } = await setup({ "tasks.keep_stopped_work": true });
    const busy = working();
    const task = e.tasks.send(project.id, "slow: write page.html");
    await busy;
    e.tasks.cancel(task.id);
    await e.tasks.settled(task.id);
    const copy = e.tasks.workspaceRoot(task.id) as string;
    expect(fs.existsSync(path.join(copy, "page.html"))).toBe(true);
  }, 30_000);

  test("discarding the changes removes the private copy too", async () => {
    const { e, project, proj } = await setup();
    const task = e.tasks.send(project.id, "write about.html");
    await e.tasks.settled(task.id);
    const copy = e.tasks.workspaceRoot(task.id) as string;
    const cs = e.projects.listChangeSets(project.id).find((c) => c.taskId === task.id);
    if (!cs) throw new Error("no change set");
    e.projects.discardChangeSet(cs.id);
    expect(e.tasks.resetCopy(task.id)).toBe(true);
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(path.join(proj, "about.html"))).toBe(false);
    // The next message starts from the project as it is.
    e.tasks.send(project.id, "write team.html", task.id);
    await e.tasks.settled(task.id);
    const next = e.tasks.workspaceRoot(task.id) as string;
    expect(fs.existsSync(path.join(next, "about.html"))).toBe(false);
    expect(fs.existsSync(path.join(next, "team.html"))).toBe(true);
  }, 30_000);
});

describe("a starting project is built in the private copy", () => {
  test("created from a blueprint: the folder stays empty, the first task's copy gets the blueprint, a Stop leaves nothing", async () => {
    const { e, working, proj } = await setup();
    const parent = path.dirname(proj);
    const { project } = await createFromBlueprint(
      { id: "react-web-app", parentDir: parent, name: "Shop", initGit: false },
      { registry: e.registry, memory: e.memory },
    );
    expect(fs.readdirSync(project.rootPath)).toEqual(["README.md"]);
    // A request that names no stack still starts from the owner's chosen blueprint.
    const busy = working();
    const task = e.tasks.send(project.id, "slow: write notes.txt");
    await busy;
    const copy = e.tasks.workspaceRoot(task.id) as string;
    expect(fs.existsSync(path.join(copy, "src", "App.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(project.rootPath, "src"))).toBe(false);
    e.tasks.cancel(task.id);
    await e.tasks.settled(task.id);
    expect(fs.readdirSync(project.rootPath)).toEqual(["README.md"]);
    expect(fs.existsSync(copy)).toBe(false);

    // Run again: the blueprint and the work arrive as one change set.
    const again = e.tasks.send(project.id, "write notes.txt");
    await e.tasks.settled(again.id);
    const cs = e.projects.listChangeSets(project.id).find((c) => c.taskId === again.id);
    const files = cs?.files.map((f) => f.path) ?? [];
    expect(files).toContain("src/App.tsx");
    expect(files).toContain("notes.txt");
  }, 30_000);
});
