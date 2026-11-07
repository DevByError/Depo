import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  ApiSchema,
  fuzzyMatch,
  positionsToMarks,
  type RpcResponse,
  type SearchGroup,
  type SearchScope,
  snippetAround,
  textMarks,
} from "@depo/shared";
import { tasks as tasksTable } from "../src/db/schema";
import { createEngine, type Engine } from "../src/engine";
import { contentSearch } from "../src/search/content";
import { SearchService } from "../src/search/service";
import { TEST_TOKEN, tempDir } from "./helpers";

const FIXTURE = path.resolve(import.meta.dir, "../../../scripts/fixtures/fastapi-demo");

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

async function setup() {
  const t = tempDir("depo search");
  cleanup = t.cleanup;
  const e = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
  engine = e;
  const root = path.join(t.dir, "fastapi demo");
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.mkdirSync(path.join(root, "app", "routes"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "app", "routes", "billing service.py"),
    "def charge_credit_card(amount):\n    # Send the payment to the card processor\n    return amount\n",
  );
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "// card processor copy\n");
  const project = await e.projects.open(root);
  e.indexer.ensure(project.id);
  await e.indexer.idle(project.id);
  return { e, root, project };
}

const group = (groups: SearchGroup[], scope: SearchScope) =>
  groups.find((g) => g.scope === scope) as SearchGroup;

describe("matching helpers", () => {
  test("fuzzy paths: contiguous, last segment and word starts win", () => {
    const main = fuzzyMatch("main", "app/main.py");
    const test = fuzzyMatch("main", "tests/test_main.py");
    expect(main && test && main.score > test.score).toBe(true);
    expect(fuzzyMatch("tmain", "tests/test_main.py")).not.toBeNull();
    expect(fuzzyMatch("app main", "src/app/main.py")).not.toBeNull();
    expect(fuzzyMatch("zzz", "app/main.py")).toBeNull();
    expect(positionsToMarks([0, 1, 2, 5, 6])).toEqual([
      [0, 3],
      [5, 7],
    ]);
  });

  test("text marks find the whole query, else each word, and snippets keep marks aligned", () => {
    expect(textMarks("Send the payment to the card processor", "card processor")).toEqual([[24, 38]]);
    expect(textMarks("card, then the processor", "processor card")).toEqual([
      [0, 4],
      [15, 24],
    ]);
    const long = `${"x ".repeat(200)}the needle is here ${"y ".repeat(200)}`;
    const s = snippetAround(long, "needle");
    expect(s?.text.startsWith("…")).toBe(true);
    const [a, b] = s?.marks[0] ?? [0, 0];
    expect(s?.text.slice(a, b)).toBe("needle");
    expect(snippetAround("nothing here", "needle")).toBeNull();
  });
});

describe("search.everything", () => {
  test("finds files, symbols, contents, tasks, decisions, memory and logs in one query each", async () => {
    const { e, root, project } = await setup();
    const now = new Date().toISOString();
    e.database.db
      .insert(tasksTable)
      .values({
        id: "tsk_search1",
        projectId: project.id,
        title: "Add card payments",
        prompt: "Add a way to charge a credit card",
        status: "done",
        summary: "Added charge_credit_card in app/routes. The processor is stubbed for now.",
        mode: "single",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const decision = e.bus.emit({
      projectId: project.id,
      taskId: "tsk_search1",
      agent: "manager@1.0.0",
      type: "decision",
      text: "Plan: Backend builds the payment endpoint, Testing checks it",
      details: { kind: "plan", reason: "Stripe is out of scope; use a stubbed processor" },
    });
    e.memory.add(project.id, "decision", "Payments use a stubbed card processor until launch", "user");
    const global = e.memory.add(null, "preference", "Prefer short commit messages about payments", "user");
    e.logger.info("payment webhook retried", { attempt: 2 });

    const s = e.search;
    const files = await s.everything({ projectId: project.id, query: "billing", limit: 5 });
    expect(group(files.groups, "files").results[0]?.target).toEqual({
      kind: "file",
      path: "app/routes/billing service.py",
      line: null,
    });
    expect(files.groups[0]?.scope).toBe("files");

    const fuzzy = await s.everything({ projectId: project.id, query: "tmain", scopes: ["files"], limit: 5 });
    expect(fuzzy.groups).toHaveLength(1);
    expect(group(fuzzy.groups, "files").results[0]?.title).toBe("tests/test_main.py");

    const sym = await s.everything({
      projectId: project.id,
      query: "read_item",
      scopes: ["symbols"],
      limit: 5,
    });
    const hit = group(sym.groups, "symbols").results[0];
    expect(hit?.target).toEqual({ kind: "file", path: "app/main.py", line: 12 });
    expect(hit?.title.slice(...(hit.titleMarks[0] ?? [0, 0]))).toBe("read_item");

    const content = await s.everything({
      projectId: project.id,
      query: "card processor",
      scopes: ["content"],
      limit: 5,
    });
    const lines = group(content.groups, "content").results;
    expect(lines.map((r) => r.target)).toEqual([
      { kind: "file", path: "app/routes/billing service.py", line: 2 },
    ]);
    const snip = lines[0]?.snippet;
    expect(snip?.text.slice(...(snip.marks[0] ?? [0, 0]))).toBe("card processor");

    const tasks = await s.everything({
      projectId: project.id,
      query: "stubbed",
      scopes: ["tasks"],
      limit: 5,
    });
    expect(group(tasks.groups, "tasks").results[0]).toMatchObject({
      title: "Add card payments",
      target: { kind: "task", taskId: "tsk_search1" },
    });
    expect(group(tasks.groups, "tasks").results[0]?.snippet?.text).toContain("stubbed");

    const dec = await s.everything({
      projectId: project.id,
      query: "stripe",
      scopes: ["decisions"],
      limit: 5,
    });
    expect(group(dec.groups, "decisions").results[0]?.target).toEqual({
      kind: "decision",
      taskId: "tsk_search1",
      eventId: decision.id,
    });

    const mem = await s.everything({
      projectId: project.id,
      query: "payments",
      scopes: ["memory"],
      limit: 5,
    });
    const memHits = group(mem.groups, "memory").results;
    expect(memHits).toHaveLength(2);
    expect(memHits.find((m) => m.target.kind === "memory" && m.target.global)?.target).toEqual({
      kind: "memory",
      factId: global.id,
      global: true,
    });

    const logs = await s.everything({ query: "webhook retried", scopes: ["logs"], limit: 5 });
    expect(group(logs.groups, "logs").results[0]).toMatchObject({
      title: "payment webhook retried",
      target: { kind: "log", text: "webhook retried", taskId: null },
    });

    // Every scope at once, ranked; node_modules never shows up.
    const all = await s.everything({ projectId: project.id, query: "processor", limit: 6 });
    expect(all.groups).toHaveLength(7);
    const paths = all.groups
      .flatMap((g) => g.results)
      .map((r) => (r.target.kind === "file" ? r.target.path : ""));
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(all.groups.at(-1)?.results).toHaveLength(0);
    expect(fs.existsSync(root)).toBe(true);
  });

  test("scopes that need a project say so, and an empty query returns empty groups", async () => {
    const { e } = await setup();
    const res = await e.search.everything({ query: "main", limit: 5 });
    expect(group(res.groups, "files").error).toBe("Open a project to search it.");
    expect(group(res.groups, "memory").error).toBeNull();
    const empty = await e.search.everything({ query: "   ", limit: 5 });
    expect(empty.groups.every((g) => g.results.length === 0 && g.error === null)).toBe(true);
  });

  test("a slow scope answers within its budget and never holds up the others", async () => {
    const { e, root, project } = await setup();
    const slow = new SearchService({
      db: e.database.db,
      indexer: e.indexer,
      memory: e.memory,
      logs: { query: () => new Promise(() => {}) },
      logger: e.logger,
      projectRoot: () => root,
      budgets: { logs: 80 },
    });
    const t0 = performance.now();
    const res = await slow.everything({
      projectId: project.id,
      query: "main",
      scopes: ["files", "logs"],
      limit: 5,
    });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(group(res.groups, "logs").timedOut).toBe(true);
    expect(group(res.groups, "files").timedOut).toBe(false);
    expect(group(res.groups, "files").results.length).toBeGreaterThan(0);
  });

  test("the built-in scanner finds the same lines when ripgrep is missing, and stops at the cap", async () => {
    const { root } = await setup();
    const hits: { path: string; line: number }[] = [];
    const ctl = new AbortController();
    const files = ["app/main.py", "app/routes/billing service.py", "tests/test_main.py"];
    const r = await contentSearch(root, "def ", {
      max: 2,
      signal: ctl.signal,
      onHit: (h) => hits.push(h),
      files: async () => files,
      noRipgrep: true,
    });
    expect(r).toEqual({ stoppedEarly: true, engine: "builtin" });
    expect(hits).toHaveLength(2);
    // Upper case makes it case-sensitive.
    const none: unknown[] = [];
    await contentSearch(root, "DEF ", {
      max: 5,
      signal: ctl.signal,
      onHit: (h) => none.push(h),
      files: async () => files,
      noRipgrep: true,
    });
    expect(none).toHaveLength(0);
  });

  test("over the WebSocket the answer matches the contract", async () => {
    const { e, project } = await setup();
    const { port } = await e.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${TEST_TOKEN}`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const call = (method: string, params: unknown) =>
      new Promise<RpcResponse>((resolve) => {
        const id = Math.floor(Math.random() * 1e9);
        const onMsg = (m: MessageEvent) => {
          const msg = JSON.parse(String(m.data));
          if (msg.id === id) {
            ws.removeEventListener("message", onMsg);
            resolve(msg);
          }
        };
        ws.addEventListener("message", onMsg);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    const res = await call("search.everything", { projectId: project.id, query: "item" });
    if ("error" in res) throw new Error(res.error.message);
    const parsed = ApiSchema["search.everything"].result.parse(res.result);
    expect(parsed.groups.length).toBe(7);
    expect(parsed.groups.flatMap((g) => g.results).length).toBeGreaterThan(0);
    const bad = await call("search.everything", { query: "x", scopes: ["everything"] });
    expect("error" in bad).toBe(true);
    ws.close();
  });
});
