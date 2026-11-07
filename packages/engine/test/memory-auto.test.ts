import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { DepoEvent } from "@depo/shared";
import { FAKE_MEMORY_ITEMS, startFakeOllama } from "../../../scripts/fake-ollama-lib";
import { type HandlerContext, handlers } from "../src/api/handlers";
import { createEngine, type Engine } from "../src/engine";
import { AUTO_MAX, cleanItem, deterministicFacts, looksSecret } from "../src/memory/auto";
import { isDuplicate, normalizeMemoryText, tokenJaccard } from "../src/memory/store";
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
  cleanup = () => {};
});

async function setup() {
  const t = tempDir("depo memory");
  cleanup = t.cleanup;
  const fake = startFakeOllama();
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
  const proj = path.join(t.dir, "fastapi demo");
  fs.cpSync(FIXTURE, proj, { recursive: true });
  const project = await e.projects.open(proj);
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  // Only what these handlers use.
  const ctx = {
    bus: e.bus,
    settings: e.settings,
    models: e.models,
    approvals: e.approvals,
    projects: e.projects,
    tasks: e.tasks,
    registry: e.registry,
    memory: e.memory,
  } as unknown as HandlerContext;
  return { e, proj, project, events, ctx };
}

const autoFacts = (e: Engine, projectId: string) =>
  e.memory.list(projectId).filter((f) => f.source === "auto");
const remembered = (events: DepoEvent[]) =>
  events.filter((ev) => ev.type === "memory_updated" && ev.details?.auto === true);

describe("deterministic facts", () => {
  test("the FastAPI fixture: stack, package manager, passing tests, run command, port, layout", () => {
    const facts = deterministicFacts(FIXTURE, "python -m pytest -q", [
      { path: "app/routes/health.py", kind: "added" },
      { path: "app/routes/users.py", kind: "added" },
    ]);
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f.text]));
    expect(byKey["auto:stack"]).toBe("Stack: Python with FastAPI; pytest.");
    expect(byKey["auto:package-manager"]).toBe("Package manager: pip.");
    expect(byKey["auto:test-command"]).toBe("Tests pass with: python -m pytest -q");
    expect(byKey["auto:run-command"]).toBe("Run it with: uvicorn app.main:app --reload");
    expect(byKey["auto:ports"]).toContain("8000");
    expect(byKey["auto:layout"]).toContain("app/");
    expect(byKey["auto:layout"]).toContain("tests/");
    expect(byKey["auto:layout"]).toContain("code in app/routes/");
    expect(byKey["auto:layout"]).toContain("README.md");
    for (const f of facts) expect(f.kind).toBe("fact");
  });

  test("without a passing run, no test command is claimed", () => {
    const facts = deterministicFacts(FIXTURE, null);
    expect(facts.some((f) => f.key === "auto:test-command")).toBe(false);
    expect(deterministicFacts(path.join(FIXTURE, "does-not-exist"), null)).toEqual([]);
  });
});

describe("dedupe and redaction", () => {
  test("similar items are recognised: normalised text or 80% word overlap", () => {
    expect(normalizeMemoryText("  Uses Postgres!  ")).toBe("uses postgres");
    expect(isDuplicate("The API uses PostgreSQL 16.", "the api uses postgresql 16")).toBe(true);
    expect(
      tokenJaccard(
        "Each route in app/main.py has a matching pytest test",
        "Each route in app/main.py has a matching pytest test file",
      ),
    ).toBeGreaterThanOrEqual(0.8);
    expect(isDuplicate("The API uses PostgreSQL", "The worker uses Redis queues")).toBe(false);
  });

  test("upsertAuto updates instead of adding, keeps keyed facts in place, and never edits the owner's items", async () => {
    const { e, project } = await setup();
    const id = project.id;
    const a = e.memory.upsertAuto(id, "fact", "Each route in app/main.py has a matching pytest test");
    expect(a.change).toBe("added");
    expect(a.fact.source).toBe("auto");
    expect(
      e.memory.upsertAuto(id, "fact", "each route in app/main.py has a matching pytest test!").change,
    ).toBe("unchanged");
    const b = e.memory.upsertAuto(id, "fact", "Each route in app/main.py has a matching pytest test file");
    expect(b.change).toBe("updated");
    expect(b.fact.id).toBe(a.fact.id);

    const k1 = e.memory.upsertAuto(id, "fact", "Tests pass with: pytest -q", "auto:test-command");
    const k2 = e.memory.upsertAuto(id, "fact", "Tests pass with: python -m pytest -q", "auto:test-command");
    expect(k2.change).toBe("updated");
    expect(k2.fact.id).toBe(k1.fact.id);

    const mine = e.memory.add(id, "decision", "We use SQLite for storage in development");
    const dup = e.memory.upsertAuto(id, "decision", "We use SQLite for storage in development.");
    expect(dup.change).toBe("unchanged");
    expect(e.memory.getFact(mine.id).text).toBe("We use SQLite for storage in development");
    expect(e.memory.getFact(mine.id).source).toBe("user");
    expect(e.memory.list(id)).toHaveLength(3);

    expect(e.memory.removeAutoKey(id, "auto:test-command")).toBe(true);
    expect(e.memory.removeAutoKey(id, "auto:test-command")).toBe(false);
  });

  test("auto items are capped, oldest first, and the owner's items stay", async () => {
    const { e, project } = await setup();
    e.memory.add(project.id, "fact", "Hand written note that must stay");
    for (let i = 0; i < AUTO_MAX + 5; i++)
      e.memory.upsertAuto(
        project.id,
        "fact",
        `Module number ${i} lives in folder ${"abcdefghij"[i % 10]}${i}`,
      );
    expect(e.memory.pruneAuto(project.id, AUTO_MAX)).toBe(5);
    expect(autoFacts(e, project.id)).toHaveLength(AUTO_MAX);
    expect(e.memory.list(project.id).some((f) => f.text === "Hand written note that must stay")).toBe(true);
  });

  test("secrets are never stored", () => {
    for (const secret of [
      "The demo admin password is hunter2-very-secret",
      "Tests call the API with key sk-abcdefghijklmnopqrstuvwxyz123456 when needed.",
      "Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the registry",
      "The signing secret: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "API_KEY=abcd1234efgh",
    ])
      expect(cleanItem(secret)).toBeNull();
    for (const fine of [
      "Booking conflicts are covered by test_overlapping_booking_returns_409_conflict_status",
      "Passwords are hashed with scrypt before they are stored",
      "Tokens expire after 15 minutes and refresh tokens rotate on use",
      "Routes live in app/routers/bookings.py and app/routers/users.py",
    ]) {
      expect(looksSecret(fine)).toBe(false);
      expect(cleanItem(fine)).toBe(fine);
    }
    expect(cleanItem("  ok  ")).toBeNull();
    expect(cleanItem("  two   spaces   here ")).toBe("two spaces here");
    expect(cleanItem(`A long one ${"word ".repeat(200)}`)?.length).toBe(300);
  });
});

describe("after a task", () => {
  test("a finished task saves facts and the model's summary, without secrets, and says so", async () => {
    const { e, project, events } = await setup();
    // Watch the scheduler: the memory job must queue at background priority.
    const jobs: { label?: string | undefined; priority: string; taskId: string | null }[] = [];
    const run = e.scheduler.run.bind(e.scheduler);
    e.scheduler.run = (req, fn, signal) => {
      jobs.push({ label: req.label, priority: req.priority, taskId: req.taskId });
      return run(req, fn, signal);
    };
    const task = e.tasks.send(project.id, "add a /health endpoint to this FastAPI project");
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("review");
    await e.tasks.autoMemory?.idle();

    const facts = autoFacts(e, project.id);
    const texts = facts.map((f) => f.text);
    expect(texts).toContain("Stack: Python with FastAPI; pytest.");
    expect(texts).toContain("Run it with: uvicorn app.main:app --reload");
    if (hasPytest) expect(texts).toContain("Tests pass with: python -m pytest -q");
    // The model's items: the convention is kept as a fact, the decision as a decision.
    expect(texts).toContain(`Convention: ${FAKE_MEMORY_ITEMS[0]?.text}`);
    const decision = facts.find((f) => f.text === FAKE_MEMORY_ITEMS[1]?.text);
    expect(decision?.kind).toBe("decision");
    // The two items with secrets were dropped.
    const all = JSON.stringify(e.memory.list(project.id));
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");

    const notes = remembered(events);
    expect(notes.length).toBe(2);
    for (const n of notes) {
      expect(n.text).toMatch(/^Depo remembered \d+ things? about this project$/);
      expect(n.projectId).toBe(project.id);
      expect(n.details?.taskId).toBe(task.id);
    }
    expect(notes[1]?.details?.count).toBe(2);

    // The memory job went through the scheduler at background priority.
    const memJobs = jobs.filter((j) => j.label?.startsWith("Memory"));
    expect(memJobs).toEqual([
      { label: "Memory: what this task taught", priority: "background", taskId: null },
    ]);

    // A second identical run adds nothing new.
    const before = e.memory.list(project.id).length;
    const again = e.tasks.send(project.id, "add a /health endpoint to this FastAPI project");
    await e.tasks.settled(again.id);
    await e.tasks.autoMemory?.idle();
    expect(e.memory.list(project.id).length).toBe(before);
  }, 60_000);

  test("with memory.auto off nothing is remembered", async () => {
    const { e, project, events } = await setup();
    e.settings.set("memory.auto", false);
    const task = e.tasks.send(project.id, "add a /health endpoint to this FastAPI project");
    await e.tasks.settled(task.id);
    await e.tasks.autoMemory?.idle();
    expect(autoFacts(e, project.id)).toHaveLength(0);
    expect(remembered(events)).toHaveLength(0);
  }, 60_000);

  test("a short task with no changes still records the stack, but skips the model summary", async () => {
    const { e, project, events } = await setup();
    const task = e.tasks.send(project.id, "simulate a broken tool call");
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("done");
    await e.tasks.autoMemory?.idle();
    const texts = autoFacts(e, project.id).map((f) => f.text);
    expect(texts).toContain("Stack: Python with FastAPI; pytest.");
    expect(texts.some((t) => t.startsWith("Convention:"))).toBe(false);
    expect(remembered(events)).toHaveLength(1);
  });

  test("a cancelled task remembers nothing", async () => {
    const { e, project, events } = await setup();
    const task = e.tasks.send(project.id, "add a /health endpoint to this FastAPI project");
    e.tasks.cancel(task.id);
    await e.tasks.settled(task.id);
    await e.tasks.autoMemory?.idle();
    expect(e.tasks.get(task.id).task.status).toBe("cancelled");
    expect(autoFacts(e, project.id)).toHaveLength(0);
    expect(remembered(events)).toHaveLength(0);
  });
});

describe("learning from the owner", () => {
  test("a declined command becomes a preference only when a reason is given", async () => {
    const { e, project, ctx } = await setup();
    const ask = (title: string) =>
      e.approvals.request({
        projectId: project.id,
        taskId: null,
        agent: "coder@1",
        kind: "command",
        title,
        reason: "network",
        details: { command: "pip install requests" },
      });
    const first = ask('Run "pip install requests"?');
    const req1 = e.approvals.list()[0];
    expect(await handlers["approvals.respond"]({ id: req1?.id ?? "", approve: false }, ctx)).toEqual({
      ok: true,
    });
    expect(await first).toBe(false);
    expect(autoFacts(e, project.id)).toHaveLength(0);

    const second = ask('Run "pip install requests"?');
    const req2 = e.approvals.list()[0];
    await handlers["approvals.respond"](
      { id: req2?.id ?? "", approve: false, reason: "Use httpx, it is already a dependency" },
      ctx,
    );
    expect(await second).toBe(false);
    const [pref] = autoFacts(e, project.id);
    expect(pref?.kind).toBe("preference");
    expect(pref?.text).toBe(
      'The owner declined running "pip install requests": Use httpx, it is already a dependency',
    );

    // A reason with a secret in it is not kept.
    const third = ask('Run "pip install requests"?');
    const req3 = e.approvals.list()[0];
    await handlers["approvals.respond"](
      { id: req3?.id ?? "", approve: false, reason: "the password is hunter2-very-secret" },
      ctx,
    );
    await third;
    expect(autoFacts(e, project.id)).toHaveLength(1);
  });

  test("rejected changes: the reason becomes a preference and facts are read again from the project", async () => {
    const { e, project, events, ctx } = await setup();
    const task = e.tasks.send(project.id, "add a /health endpoint to this FastAPI project");
    await e.tasks.settled(task.id);
    await e.tasks.autoMemory?.idle();
    const [cs] = e.projects.listChangeSets(project.id);
    expect(cs).toBeDefined();
    // A fact about work that never landed goes away on discard.
    e.memory.upsertAuto(project.id, "fact", "Ports: 9999 (gone).", "auto:ports");

    const res = await handlers["changes.discard"](
      { id: cs?.id ?? "", reason: "Keep health checks out of the API" },
      ctx,
    );
    expect(res.status).toBe("discarded");
    const facts = autoFacts(e, project.id);
    const pref = facts.find((f) => f.kind === "preference");
    expect(pref?.text).toContain("Keep health checks out of the API");
    expect(pref?.text).toContain("rejected the changes");
    expect(facts.find((f) => f.signature === "auto:ports")?.text).toContain("8000");
    expect(remembered(events).at(-1)?.text).toBe("Depo remembered a preference about this project");
  }, 60_000);

  test("a discard without a reason stores no preference", async () => {
    const { e, project, ctx } = await setup();
    const task = e.tasks.send(project.id, "add a /health endpoint to this FastAPI project");
    await e.tasks.settled(task.id);
    await e.tasks.autoMemory?.idle();
    const [cs] = e.projects.listChangeSets(project.id);
    await handlers["changes.discard"]({ id: cs?.id ?? "" }, ctx);
    expect(autoFacts(e, project.id).some((f) => f.kind === "preference")).toBe(false);
  }, 60_000);
});
