import { afterEach, describe, expect, test } from "bun:test";

process.env.DEPO_NO_BROWSER = "1";

import fs from "node:fs";
import path from "node:path";
import {
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  ModelGatewayError,
  type ModelProvider,
  type ToolCall,
} from "@depo/model-gateway";
import type { DepoEvent, Plan } from "@depo/shared";
import { latestRequest } from "../src/agent/tasks";
import { applyNoteChange, NoteChangeSchema } from "../src/agents/steering";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir } from "./helpers";

/**
 * Steering: notes the owner sends while a task works reach the agents between steps, show in the
 * transcript as queued then read, and become a follow-up when the task is not working.
 */

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

let callId = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: `s${++callId}`,
  name,
  arguments: args,
  rawArguments: JSON.stringify(args),
});

interface Reply {
  text?: string;
  calls?: ToolCall[];
}

/** A promise the test resolves by hand, to hold the model while it sends a note. */
function gate() {
  let open = () => {};
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

/** A scripted model: `reply` sees every request (in order) and may wait before answering. */
function scripted(reply: (req: ChatRequest, n: number) => Reply | Promise<Reply>): {
  model: ModelProvider;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  const model: ModelProvider = {
    id: "fake",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:1",
    async health() {
      return { ok: true, version: "fake", message: null };
    },
    async listModels() {
      return [];
    },
    async embed(_m, inputs) {
      return inputs.map(() => [0]);
    },
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
      const r = await reply(req, requests.length);
      if (req.signal?.aborted) throw new ModelGatewayError("cancelled", "Cancelled");
      if (r.text) yield { type: "text", delta: r.text };
      for (const c of r.calls ?? []) yield { type: "tool_call", call: c };
      yield { type: "done", finishReason: r.calls?.length ? "tool_calls" : "stop", usage: null };
    },
  };
  return { model, requests };
}

async function setup(
  model: ModelProvider,
  opts: { maxSteps?: number; settings?: Record<string, unknown> } = {},
) {
  const t = tempDir("depo steer");
  cleanup = t.cleanup;
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    tasks: { retryDelayMs: 10, ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}) },
    models: { providerFactory: () => model },
  });
  engine = e;
  await e.start();
  e.models.setProviders([{ id: "fake", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }]);
  e.models.assign("coder", { providerId: "fake", model: "fake-model" });
  e.models.assign("reasoning", { providerId: "fake", model: "fake-model" });
  for (const [k, v] of Object.entries({
    "team.approve_plan": false,
    "team.reviews": "off",
    "memory.auto": false,
    ...opts.settings,
  }))
    e.settings.set(k, v as never);
  const proj = path.join(t.dir, "notes app");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "src", "app.ts"), "export const port = 3000;\n");
  const project = await e.projects.open(proj);
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  return { e, project, events };
}

const hasNote = (msgs: ChatMessage[], text: string) =>
  msgs.some(
    (m) =>
      m.role === "user" &&
      m.content.startsWith("Note from the owner while you work:") &&
      m.content.includes(text),
  );

async function until(fn: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("steering a single agent", () => {
  test("a note sent mid-run reaches the model's next request and shows as queued, then read", async () => {
    const hold = gate();
    let started = () => {};
    const first = new Promise<void>((r) => {
      started = r;
    });
    const { model, requests } = scripted(async (_req, n) => {
      if (n === 1) {
        started();
        await hold.promise;
        return { text: "Looking around.", calls: [call("list_dir", { path: "." })] };
      }
      return { text: "Changed the port to 8080." };
    });
    const { e, project, events } = await setup(model);
    const task = e.tasks.send(project.id, "set up the server");
    await first;

    const res = e.tasks.steer(task.id, "  Use port 8080, not 3000.  ");
    expect(res.delivery).toBe("queued");
    expect(res.noteId).toMatch(/^msg_/);
    // Shown at once as queued, before any agent has read it.
    const queued = e.tasks.get(task.id).messages.find((m) => m.id === res.noteId);
    expect(queued?.role).toBe("user");
    expect(queued?.text).toBe("Use port 8080, not 3000.");
    expect(queued?.steer?.state).toBe("queued");
    expect(queued?.steer?.readBy).toEqual([]);

    hold.open();
    await e.tasks.settled(task.id);

    // The first request had no note; the second has it, after the tool result (never mid tool call).
    expect(requests).toHaveLength(2);
    expect(hasNote(requests[0]?.messages ?? [], "8080")).toBe(false);
    const second = requests[1]?.messages ?? [];
    expect(hasNote(second, "Use port 8080, not 3000.")).toBe(true);
    const noteAt = second.findIndex((m) => m.role === "user" && m.content.includes("8080"));
    expect(second[noteAt - 1]?.role).toBe("tool");
    expect(second[noteAt - 2]?.role).toBe("assistant");

    // The transcript has it where it was read, marked read by the coding agent.
    const { task: done, messages } = e.tasks.get(task.id);
    expect(done.status).toBe("done");
    const read = messages.find((m) => m.id === res.noteId);
    expect(read?.steer?.state).toBe("delivered");
    expect(read?.steer?.readBy).toEqual(["coder@1.0.0"]);
    expect(read?.steer?.deliveredAt).toBeTruthy();
    const order = messages.map((m) => (m.id === res.noteId ? "note" : m.role));
    expect(order.indexOf("note")).toBeGreaterThan(order.indexOf("tool"));
    expect(messages.at(-1)?.text).toBe("Changed the port to 8080.");

    const notes = events.filter((ev) => ev.type === "owner_note" && ev.taskId === task.id);
    expect(notes.map((ev) => ev.details?.state)).toEqual(["queued", "delivered"]);
    expect(notes[1]?.agent).toBe("coder@1.0.0");
    expect(notes[1]?.text).toContain("The coding agent read your note");
  }, 30_000);

  test("a note sent while the model writes its final answer is read before the task finishes", async () => {
    const hold = gate();
    let started = () => {};
    const first = new Promise<void>((r) => {
      started = r;
    });
    const { model, requests } = scripted(async (_req, n) => {
      if (n === 1) {
        started();
        await hold.promise;
        return { text: "All done." };
      }
      return { text: "Added the README too." };
    });
    const { e, project } = await setup(model);
    const task = e.tasks.send(project.id, "tidy up");
    await first;
    e.tasks.steer(task.id, "Also add a README.");
    hold.open();
    await e.tasks.settled(task.id);
    expect(requests).toHaveLength(2);
    expect(hasNote(requests[1]?.messages ?? [], "Also add a README.")).toBe(true);
    expect(e.tasks.get(task.id).messages.at(-1)?.text).toBe("Added the README too.");
  }, 30_000);

  test("a note sent to a finished task becomes a normal follow-up", async () => {
    const { model, requests } = scripted((req) => {
      const last = req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      return { text: last.includes("dark mode") ? "Dark mode added." : "First pass done." };
    });
    const { e, project } = await setup(model);
    const task = e.tasks.send(project.id, "build the page");
    await e.tasks.settled(task.id);
    const res = e.tasks.steer(task.id, "Now add dark mode.");
    expect(res).toEqual({ delivery: "followup", taskId: task.id, noteId: null });
    await e.tasks.settled(task.id);
    // The new request after a summary of the earlier turn, not a framed note.
    const last = requests
      .at(-1)
      ?.messages.filter((m) => m.role === "user")
      .at(-1);
    expect(last?.content).toContain("New request, do this now: Now add dark mode.");
    expect(last?.content).toContain("- Request: build the page");
    expect(last?.content).not.toContain("Note from the owner");
    const { messages } = e.tasks.get(task.id);
    const followup = messages.filter((m) => m.role === "user").at(-1);
    expect(followup?.text).toBe("Now add dark mode.");
    expect(followup?.steer).toBeUndefined();
    expect(messages.at(-1)?.text).toBe("Dark mode added.");
  }, 30_000);

  test("a note nobody could read in time starts the next turn with it", async () => {
    const hold = gate();
    let started = () => {};
    const first = new Promise<void>((r) => {
      started = r;
    });
    const { model, requests } = scripted(async (req, n) => {
      if (n === 1) {
        started();
        await hold.promise;
        return { text: "Finished." };
      }
      const last = req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      return { text: `Handled: ${/New request, do this now: (.*)/.exec(last)?.[1] ?? last}` };
    });
    // One step only: the note arrives during the last step, so this run cannot read it.
    const { e, project } = await setup(model, { maxSteps: 1 });
    const task = e.tasks.send(project.id, "quick fix");
    await first;
    const res = e.tasks.steer(task.id, "Use tabs.");
    hold.open();
    await e.tasks.settled(task.id);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.filter((m) => m.role === "user").at(-1)?.content).toContain(
      "New request, do this now: Use tabs.",
    );
    const { messages } = e.tasks.get(task.id);
    const note = messages.find((m) => m.id === res.noteId);
    expect(note?.steer?.state).toBe("followup");
    expect(messages.at(-1)?.text).toBe("Handled: Use tabs.");
  }, 30_000);

  test("a note queued when the task is stopped is marked as not read", async () => {
    let started = () => {};
    const first = new Promise<void>((r) => {
      started = r;
    });
    const { model } = scripted(async (req) => {
      started();
      await new Promise<void>((r) => req.signal?.addEventListener("abort", () => r(), { once: true }));
      return { text: "never" };
    });
    const { e, project, events } = await setup(model);
    const task = e.tasks.send(project.id, "long job");
    await first;
    const res = e.tasks.steer(task.id, "Stop after the first file.");
    e.tasks.cancel(task.id);
    await e.tasks.settled(task.id);
    const note = e.tasks.get(task.id).messages.find((m) => m.id === res.noteId);
    expect(note?.steer?.state).toBe("dropped");
    expect(e.tasks.get(task.id).task.status).toBe("cancelled");
    expect(events.some((ev) => ev.type === "owner_note" && ev.details?.state === "dropped")).toBe(true);
  }, 30_000);
});

describe("steering a team", () => {
  test("the Manager and the agent at work read the note; the Manager adds a task and records a decision", async () => {
    const hold = gate();
    let backendStarted = () => {};
    const backendWorking = new Promise<void>((r) => {
      backendStarted = r;
    });
    const seen: { who: string; title: string; messages: ChatMessage[] }[] = [];
    const { model } = scripted(async (req) => {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      if (req.jsonSchema && sys.includes("Plan the work as a task graph")) {
        return {
          text: JSON.stringify({
            summary: "Build the API, then test it.",
            nodes: [
              { id: "api", title: "Tasks API", owner: "backend", deps: [], criteria: ["routes work"] },
              {
                id: "testing",
                title: "Run the suite",
                owner: "testing",
                deps: ["api"],
                criteria: ["passes"],
              },
            ],
            questions: [],
          }),
        };
      }
      if (req.jsonSchema && sys.includes("The owner sent a note while the team works")) {
        const user = req.messages.find((m) => m.role === "user")?.content ?? "";
        expect(user).toContain("Also add a /version route");
        expect(user).toContain("api [doing] backend");
        return {
          text: JSON.stringify({
            change: "update",
            reason: "A new route needs its own task.",
            add: [
              {
                id: "version-route",
                title: "Add a /version route",
                owner: "backend",
                deps: ["api"],
                criteria: ["GET /version answers"],
              },
            ],
            drop: [],
          }),
        };
      }
      const who = /You are the ([\w/ ]+?) agent\./.exec(sys)?.[1] ?? "";
      const title =
        /Your task: (.*)/.exec(req.messages.find((m) => m.role === "user")?.content ?? "")?.[1] ?? "";
      seen.push({ who, title, messages: req.messages.map((m) => ({ ...m })) });
      const tools = req.messages.filter((m) => m.role === "tool").length;
      if (who === "Backend" && title === "Tasks API" && tools === 0) {
        backendStarted();
        await hold.promise;
        return {
          calls: [call("write_file", { path: "src/api.ts", content: "export const routes = [];\n" })],
        };
      }
      return { text: `${who}: ${title} done.` };
    });
    const { e, project, events } = await setup(model);
    const task = e.tasks.send(project.id, "add a tasks API", undefined, "backend");
    await backendWorking;
    const res = e.tasks.steer(task.id, "Also add a /version route.");
    expect(res.delivery).toBe("queued");
    hold.open();
    await e.tasks.settled(task.id);

    // The agent at work read it at its next step.
    const apiSecond = seen.find(
      (s) => s.who === "Backend" && s.title === "Tasks API" && s.messages.some((m) => m.role === "tool"),
    );
    expect(apiSecond && hasNote(apiSecond.messages, "Also add a /version route.")).toBe(true);
    // The new task's agent got it in its first prompt.
    const added = seen.find((s) => s.title === "Add a /version route");
    expect(added?.messages.find((m) => m.role === "user")?.content).toContain(
      "Notes from the owner while the team works",
    );

    // The plan changed, and the Manager recorded why.
    const plan = e.tasks.teamState(task.id).plan as Plan;
    expect(plan.nodes.map((n) => [n.id, n.status])).toEqual([
      ["api", "done"],
      ["testing", "done"],
      ["version-route", "done"],
    ]);
    // The testing task waited for the new code.
    expect(plan.nodes.find((n) => n.id === "testing")?.deps).toEqual(["api", "version-route"]);
    const decision = events.find((ev) => ev.type === "decision" && ev.details?.outcome === "replanned");
    expect(decision?.agent).toStartWith("manager@");
    expect(decision?.details?.kind).toBe("plan");
    expect(decision?.details?.cause).toBe("owner_note");
    expect(decision?.text).toContain("Manager changed the plan after your note");
    expect(decision?.details?.reason).toBe("A new route needs its own task.");

    // Who read it, in the transcript; the Manager passed it on through the blackboard.
    const note = e.tasks.get(task.id).messages.find((m) => m.id === res.noteId);
    expect(note?.steer?.state).toBe("delivered");
    expect(note?.steer?.readBy).toContain("manager@1.0.0");
    expect(note?.steer?.readBy).toContain("backend@1.0.0");
    const msgs = e.tasks.teamState(task.id).messages;
    expect(
      msgs.some(
        (m) =>
          m.type === "request" &&
          m.from.startsWith("manager@") &&
          m.to.startsWith("backend@") &&
          m.summary.includes("/version"),
      ),
    ).toBe(true);
  }, 60_000);

  test("a reason given when declining the plan makes the Manager plan again with it", async () => {
    const plans: string[] = [];
    const { model } = scripted((req) => {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      if (req.jsonSchema && sys.includes("Plan the work as a task graph")) {
        plans.push(req.messages.find((m) => m.role === "user")?.content ?? "");
        return {
          text: JSON.stringify({
            summary: "Build it.",
            nodes: [{ id: "api", title: "Tasks API", owner: "backend", deps: [], criteria: [] }],
            questions: [],
          }),
        };
      }
      return { text: "done" };
    });
    const { e, project } = await setup(model, { settings: { "team.approve_plan": true } });
    const task = e.tasks.send(project.id, "add a tasks API", undefined, "backend");
    await until(() => e.approvals.list().length > 0);
    const [req] = e.approvals.list();
    expect(e.approvals.respond(req?.id ?? "", false)).toBe(true);
    e.tasks.noteDecline(req as NonNullable<typeof req>, "Keep it to one route.");
    // The second plan arrives with the reason and the original request.
    await until(() => e.approvals.list().length > 0 || plans.length > 1);
    expect(plans).toHaveLength(2);
    expect(plans[1]).toContain("add a tasks API");
    expect(plans[1]).toContain("Declined: Start this plan (2 tasks). Reason: Keep it to one route.");
    const [again] = e.approvals.list();
    e.approvals.respond(again?.id ?? "", false);
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("done");
  }, 60_000);
});

describe("steering helpers", () => {
  const base = (): Plan => ({
    mode: "backend",
    summary: "",
    version: 1,
    approved: true,
    questions: [],
    nodes: [
      {
        id: "db",
        title: "Schema",
        owner: "database",
        deps: [],
        criteria: [],
        review: false,
        status: "done",
        attempts: 1,
      },
      {
        id: "api",
        title: "API",
        owner: "backend",
        deps: ["db"],
        criteria: [],
        review: false,
        status: "doing",
        attempts: 1,
      },
      {
        id: "docs",
        title: "Docs",
        owner: "devops-docs",
        deps: ["api"],
        criteria: [],
        review: false,
        status: "todo",
        attempts: 0,
      },
      {
        id: "testing",
        title: "Tests",
        owner: "testing",
        deps: ["docs"],
        criteria: [],
        review: false,
        status: "todo",
        attempts: 0,
      },
    ],
  });

  test("the Manager's change keeps the graph valid: unknown owners, started tasks and loops are refused", () => {
    const plan = base();
    const change = NoteChangeSchema.parse({
      change: "update",
      add: [
        { title: "Rate limits", owner: "Backend", deps: ["api", "nope"] },
        { title: "Make a logo", owner: "ui-ux-design" },
        { title: "", owner: "backend" },
      ],
      drop: ["api", "docs", "missing"],
    });
    const { added, dropped } = applyNoteChange(plan, change, "backend", () => true);
    expect(added.map((n) => [n.id, n.owner, n.deps, n.review])).toEqual([
      ["rate-limits", "backend", ["api"], true],
    ]);
    // Only the task that had not started is dropped; testing now waits on what docs waited on.
    expect(dropped.map((n) => n.id)).toEqual(["docs"]);
    expect(plan.nodes.find((n) => n.id === "testing")?.deps).toEqual(["api", "rate-limits"]);
    expect(plan.version).toBe(2);
  });

  test("'none' changes nothing, and a bad answer reads as none", () => {
    const plan = base();
    expect(applyNoteChange(plan, NoteChangeSchema.parse({ change: "none" }), "backend", () => true)).toEqual({
      added: [],
      dropped: [],
    });
    expect(NoteChangeSchema.parse({ change: "rewrite everything" }).change).toBe("none");
    expect(plan.version).toBe(1);
  });

  test("the newest request joins notes that became the turn; read notes are not requests", () => {
    const item = (
      id: string,
      role: "user" | "assistant",
      text: string,
      state?: "delivered" | "followup",
    ) => ({
      id,
      role,
      text,
      toolName: null,
      isError: false,
      agent: null,
      createdAt: id,
      ...(state ? { steer: { state, readBy: [], queuedAt: id, deliveredAt: null } } : {}),
    });
    expect(
      latestRequest([
        item("1", "user", "build"),
        item("2", "user", "read note", "delivered"),
        item("3", "assistant", "ok"),
      ]),
    ).toEqual({ text: "build", fromNotes: false });
    expect(
      latestRequest([
        item("1", "user", "build"),
        item("2", "assistant", "ok"),
        item("3", "user", "a", "followup"),
        item("4", "user", "b", "followup"),
      ]),
    ).toEqual({ text: "a\n\nb", fromNotes: true });
  });
});
