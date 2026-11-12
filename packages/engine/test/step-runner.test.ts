import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ChatMessage, ChatRequest, ModelProvider } from "@depo/model-gateway";
import type { StepPlan } from "@depo/shared";
import type { FinishResult } from "../src/agent/finish";
import { buildPlan } from "../src/agent/plan";
import { newStepPlan, runStepPlan } from "../src/agent/step-runner";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { tempDir } from "./helpers";

// The owner's ask: work like Claude. Show the plan first, do one step at a time, check each step,
// and never stop at an error: fix it, bring in the bigger model, start the step again, park it and
// come back, and turn every problem the final check finds into a new step (ADR-0086).

const USERS = `CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL
);
`;
const APP = 'export const routes = {\n  "GET /api/health": () => 1,\n};\n';

const REQUEST = `Build the skill store.

Keep its structure: routes in be/src/app.ts, new tables at the end of be/src/db/schema.sql.

## Database
- favorites: user_id, skill_id, created_at
- scans: id, kind, user_id

## API
- GET /api/skill?id= : the skill with its files
`;

const SMALL = "qwen2.5-coder:3b";
const BIG = "qwen2.5-coder:7b";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

type Reply = string | { name: string; arguments: Record<string, unknown> };

function setup(script: (req: ChatRequest, ctx: { step: string; tryNo: number; root: string }) => Reply) {
  const t = tempDir("depo steps");
  const root = path.join(t.dir, "copy");
  fs.mkdirSync(path.join(root, "be/src/db"), { recursive: true });
  fs.writeFileSync(path.join(root, "be/src/db/schema.sql"), USERS);
  fs.writeFileSync(path.join(root, "be/src/app.ts"), APP);
  const logger = createLogger({ dir: path.join(t.dir, "logs"), level: "error", stderr: false });
  const db = openDatabase({
    file: path.join(t.dir, "db", "t.db"),
    backupsDir: path.join(t.dir, "bk"),
    logger,
  });
  cleanup = () => {
    db.close();
    t.cleanup();
  };
  const bus = new EventBus(db.db, logger);
  const tries = new Map<string, number>();
  const models: { step: string; model: string }[] = [];
  let n = 0;
  const provider: ModelProvider = {
    id: "fake",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:1",
    health: async () => ({ ok: true, version: "fake", message: null }),
    listModels: async () => [],
    embed: async () => [],
    chat: (req) => {
      const prompt = String(req.messages[1]?.content ?? "");
      const step = /Step \d+ of \d+: (.+)/.exec(prompt)?.[1] ?? "?";
      // A fresh conversation (system + step prompt) is a new try of the step.
      if (req.messages.length === 2) tries.set(step, (tries.get(step) ?? 0) + 1);
      models.push({ step, model: req.model });
      const r = script(req, { step, tryNo: tries.get(step) ?? 1, root });
      const id = `c${++n}`;
      return (async function* (): AsyncIterable<ChatChunk> {
        if (typeof r === "string") yield { type: "text", delta: r };
        else
          yield {
            type: "tool_call",
            call: { id, name: r.name, arguments: r.arguments, rawArguments: JSON.stringify(r.arguments) },
          } as ChatChunk;
        yield { type: "done", finishReason: "stop", usage: null };
      })();
    },
  };
  const events: string[] = [];
  const persisted: (ChatMessage & { fromDepo?: boolean })[] = [];
  const saved: StepPlan[] = [];
  const plan = buildPlan(REQUEST);
  const state = newStepPlan(plan, "msg_1");
  const base = {
    provider,
    model: SMALL,
    contextLength: 16_384,
    toolNames: ["write_file", "read_file", "append_file", "edit_file"],
    ctx: {
      root,
      bus,
      approvals: new ApprovalCenter(bus),
      projectId: null,
      taskId: null,
      agent: "coder",
      readPaths: new Set<string>(),
    },
    signal: new AbortController().signal,
    job: { projectId: "prj_1", taskId: "tsk_1", label: "t" },
    emit: (e: { text: string }) => events.push(e.text),
    persist: (m: ChatMessage) => persisted.push(m),
  };
  return { root, plan, state, base, events, persisted, saved, models };
}

const lastRole = (req: ChatRequest) => req.messages.at(-1)?.role;
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("the step runner", () => {
  test("checks every step, feeds back problems, steps up, parks a stuck step and comes back to it", async () => {
    let checks = 0;
    const s = setup((req, { step, tryNo, root }) => {
      if (lastRole(req) === "tool") return "Done.";
      const schema = read(root, "be/src/db/schema.sql");
      if (step === "Add the favorites table") {
        if (!schema.includes("favorites"))
          return {
            name: "append_file",
            arguments: {
              path: "be/src/db/schema.sql",
              content:
                "CREATE TABLE IF NOT EXISTS favorites (\n  user_id BIGINT UNSIGNED NOT NULL,\n  skill_id BIGINT UNSIGNED NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS bookings (\n  id INT PRIMARY KEY\n);\n",
            },
          };
        if (!schema.includes("created_at"))
          return {
            name: "edit_file",
            arguments: {
              path: "be/src/db/schema.sql",
              edits: [
                {
                  search: "  skill_id BIGINT UNSIGNED NOT NULL\n);",
                  replace: "  skill_id BIGINT UNSIGNED NOT NULL,\n  created_at DATETIME NOT NULL\n);",
                },
              ],
            },
          };
        return "Added the favorites table.";
      }
      if (step === "Add the scans table") {
        // The small model says it is done without doing it; the larger one does it.
        if (req.model === BIG && !schema.includes("scans"))
          return {
            name: "append_file",
            arguments: {
              path: "be/src/db/schema.sql",
              content:
                "CREATE TABLE IF NOT EXISTS scans (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  kind VARCHAR(20) NOT NULL,\n  user_id BIGINT UNSIGNED NULL\n);\n",
            },
          };
        return "Done.";
      }
      if (step === "Build GET /api/skill") {
        // Three tries fail (small, big restart, small careful); the parked step's retry works.
        if (tryNo >= 4 && !read(root, "be/src/app.ts").includes("/api/skill"))
          return {
            name: "write_file",
            arguments: {
              path: "be/src/app.ts",
              content:
                'export const routes = {\n  "GET /api/health": () => 1,\n  "GET /api/skill": () => 2,\n};\n',
            },
          };
        return "Done.";
      }
      if (step.startsWith("Fix:"))
        return {
          name: "write_file",
          arguments: { path: "be/src/skill.ts", content: "export const skill = 1;\n" },
        };
      return "Done.";
    });
    const checkApp = async (): Promise<FinishResult> => {
      checks++;
      return checks === 1
        ? {
            problems: ["Bun app in be did not start:\nerror: Cannot find module './skill'"],
            running: [],
            notes: [],
            blocked: [],
          }
        : {
            problems: [],
            running: [{ label: "API", url: "http://127.0.0.1:4000/", role: "backend" }],
            notes: [],
            blocked: [],
          };
    };
    const r = await runStepPlan({
      plan: s.plan,
      state: s.state,
      root: s.root,
      system: "You are Depo's coding agent.",
      base: s.base,
      stepUp: BIG,
      save: (p) => s.saved.push(structuredClone(p)),
      checkApp,
      budget: 8000,
    });
    const steps = s.state.steps.map((x) => [x.title, x.status, x.tries, x.added]);
    expect(steps).toEqual([
      ["Add the favorites table", "done", 1, false],
      ["Add the scans table", "done", 1, false],
      ["Build GET /api/skill", "done", 4, false],
      ["Fix: Bun app in be did not start:", "done", 1, true],
      ["Run the app and check it", "done", 2, false],
    ]);
    expect(r.blocked).toEqual([]);
    expect(r.finalText).toBe("Done: all 5 steps of the plan passed Depo's checks.");
    expect(s.state.steps[2]?.note).toBe(`Done by ${BIG}`);
    expect(s.state.steps[4]?.note).toBe("Running: http://127.0.0.1:4000/");
    // The table step kept only its own table.
    const schema = read(s.root, "be/src/db/schema.sql");
    expect(schema).toContain("created_at DATETIME NOT NULL");
    expect(schema).not.toContain("bookings");
    // The small model's "Done." twice on the same problem brought in the larger model.
    expect(s.models.filter((m) => m.step === "Add the scans table").map((m) => m.model)).toEqual([
      SMALL,
      SMALL,
      BIG,
      BIG,
    ]);
    // The route step was parked, then came back after the other steps.
    expect(s.events).toContain(
      'Parked "Build GET /api/skill" for now: The route GET /api/skill is not in the code yet. Add it where the other routes are, with its handler. Depo goes on with the other steps and comes back to it.',
    );
    // Depo's feedback is saved as Depo's, not as the owner.
    const feedback = s.persisted.filter((m) => m.role === "user");
    expect(feedback.length).toBeGreaterThan(0);
    expect(feedback.every((m) => m.fromDepo === true)).toBe(true);
    expect(feedback[0]?.content).toContain('Depo checked "Add the favorites table" and it is not done yet:');
    // The owner saw the plan before anything ran, then every change.
    expect(s.saved[0]?.steps.map((x) => x.status)).toEqual(["running", "pending", "pending", "pending"]);
    expect(s.saved.length).toBeGreaterThan(10);
  });

  test("a step that never passes is parked, the rest is done, and the owner is told to send go on", async () => {
    const s = setup((req, { step, root }) => {
      if (lastRole(req) === "tool") return "Done.";
      const schema = read(root, "be/src/db/schema.sql");
      if (step === "Add the favorites table" && !schema.includes("favorites"))
        return {
          name: "append_file",
          arguments: {
            path: "be/src/db/schema.sql",
            content:
              "CREATE TABLE IF NOT EXISTS favorites (\n  user_id BIGINT UNSIGNED NOT NULL,\n  skill_id BIGINT UNSIGNED NOT NULL,\n  created_at DATETIME NOT NULL\n);\n",
          },
        };
      if (step === "Build GET /api/skill" && !read(root, "be/src/app.ts").includes("/api/skill"))
        return {
          name: "write_file",
          arguments: {
            path: "be/src/app.ts",
            content:
              'export const routes = {\n  "GET /api/health": () => 1,\n  "GET /api/skill": () => 2,\n};\n',
          },
        };
      return "Done.";
    });
    const r = await runStepPlan({
      plan: s.plan,
      state: s.state,
      root: s.root,
      system: "You are Depo's coding agent.",
      base: s.base,
      stepUp: null,
      save: (p) => s.saved.push(structuredClone(p)),
      checkApp: null,
      budget: 8000,
    });
    expect(s.state.steps.map((x) => [x.title, x.status])).toEqual([
      ["Add the favorites table", "done"],
      ["Add the scans table", "blocked"],
      ["Build GET /api/skill", "done"],
      ["Run the app and check it", "skipped"],
    ]);
    expect(s.state.steps[1]?.note).toStartWith("There is no CREATE TABLE for scans");
    // Without a larger model: the try, a careful clean restart; then the parked retry.
    expect(s.state.steps[1]?.tries).toBe(3);
    expect(r.finalText).toContain("3 of 4 steps are done. One step is not done yet:");
    expect(r.finalText).toContain("- Add the scans table: There is no CREATE TABLE for scans");
    expect(r.finalText).toContain('Send "go on"');
  });

  test("a step already in the code is marked done without asking the model", async () => {
    const s = setup(() => "Done.");
    fs.appendFileSync(
      path.join(s.root, "be/src/db/schema.sql"),
      "CREATE TABLE IF NOT EXISTS favorites (\n  user_id BIGINT UNSIGNED NOT NULL,\n  skill_id BIGINT UNSIGNED NOT NULL,\n  created_at DATETIME NOT NULL\n);\n",
    );
    const ac = new AbortController();
    const base = { ...s.base, signal: ac.signal };
    // Stop as soon as the second step starts.
    const save = (p: StepPlan) => {
      if (p.steps[1]?.status === "running") ac.abort();
    };
    const r = await runStepPlan({
      plan: s.plan,
      state: s.state,
      root: s.root,
      system: "x",
      base,
      stepUp: null,
      save,
      checkApp: null,
      budget: 8000,
    });
    expect(s.state.steps[0]).toMatchObject({ status: "done", note: "Already in the code", tries: 0 });
    expect(s.models.filter((m) => m.step === "Add the favorites table")).toEqual([]);
    expect(r.aborted).toBe(true);
    expect(r.finalText).toBe("Stopped after 1 of 4 steps.");
  });
});

describe("pages built side by side", () => {
  const PAGES = `Build the pages.

## Pages
- /alpha : the alpha page
- /beta : the beta page
- /gamma : the gamma page
`;

  /** A scripted model that writes each step's page file; counts how many steps are in flight. */
  function pageRun(parallel: number) {
    const s = setup((req, { step }) => {
      if (lastRole(req) === "tool") return "Done.";
      const page = /Build the page \/(\w+)/.exec(step)?.[1];
      if (!page) return "Done.";
      return {
        name: "write_file",
        arguments: {
          path: `fe/app/${page}/page.tsx`,
          content: `export default function Page() {\n  return <main>${page}</main>;\n}\n`,
        },
      };
    });
    fs.mkdirSync(path.join(s.root, "fe/app"), { recursive: true });
    fs.writeFileSync(
      path.join(s.root, "fe/app/layout.tsx"),
      "export default function L({ children }: { children: unknown }) {\n  return <html>{children}</html>;\n}\n",
    );
    let inflight = 0;
    let most = 0;
    const real = s.base.provider.chat.bind(s.base.provider);
    s.base.provider.chat = (req) => {
      const it = real(req);
      inflight++;
      most = Math.max(most, inflight);
      return (async function* () {
        await Bun.sleep(30);
        try {
          yield* it;
        } finally {
          inflight--;
        }
      })();
    };
    const plan = buildPlan(PAGES);
    const state = newStepPlan(plan, "msg_p");
    return {
      s,
      state,
      most: () => most,
      run: () =>
        runStepPlan({
          plan,
          state,
          root: s.root,
          system: "You are Depo's coding agent.",
          base: s.base,
          stepUp: null,
          save: () => undefined,
          checkApp: null,
          budget: 8000,
          parallel,
        }),
    };
  }

  test("with room for two, two pages run at once and every page still passes its check", async () => {
    const p = pageRun(2);
    const r = await p.run();
    expect(r.blocked).toEqual([]);
    expect(p.state.steps.filter((x) => x.kind === "page").map((x) => x.status)).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(p.most()).toBe(2);
    for (const name of ["alpha", "beta", "gamma"])
      expect(fs.existsSync(path.join(p.s.root, `fe/app/${name}/page.tsx`))).toBe(true);
    expect(p.s.events.some((e) => e.includes("pages are built at the same time"))).toBe(true);
  });

  test("with room for one they run one after the other", async () => {
    const p = pageRun(1);
    await p.run();
    expect(p.most()).toBe(1);
    expect(p.s.events.some((e) => e.includes("at the same time"))).toBe(false);
  });
});

describe("save points for steps that run side by side", () => {
  test("restoring one step's files never touches another step's files", async () => {
    const { takeSavePoint, restoreFiles, changedSince } = await import("../src/agent/savepoint");
    const t = tempDir("depo scope");
    try {
      fs.writeFileSync(path.join(t.dir, "keep.txt"), "one\n");
      const sp = takeSavePoint(t.dir);
      if (!sp) throw new Error("no save point");
      fs.writeFileSync(path.join(t.dir, "mine.txt"), "mine\n");
      fs.writeFileSync(path.join(t.dir, "keep.txt"), "changed by me\n");
      fs.writeFileSync(path.join(t.dir, "theirs.txt"), "theirs\n");
      expect(changedSince(t.dir, sp, new Set(["mine.txt", "keep.txt"]))).toEqual(["keep.txt", "mine.txt"]);
      const r = restoreFiles(t.dir, sp, ["mine.txt", "keep.txt"]);
      expect(r.removed).toEqual(["mine.txt"]);
      expect(r.restored).toEqual(["keep.txt"]);
      expect(fs.readFileSync(path.join(t.dir, "keep.txt"), "utf8")).toBe("one\n");
      expect(fs.existsSync(path.join(t.dir, "theirs.txt"))).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});

describe("tables Depo writes itself", () => {
  const TABLES = `Build the store.

## Database
- favorites: user_id, skill_id, created_at
- scans: id, kind, user_id
`;

  test("table steps need no model call when Depo can write them, and keep to the existing types", async () => {
    let modelCalls = 0;
    const s = setup(() => {
      modelCalls++;
      return "Done.";
    });
    // A skills table to point at (users is already in the schema).
    fs.appendFileSync(
      path.join(s.root, "be/src/db/schema.sql"),
      "\nCREATE TABLE IF NOT EXISTS skills (\n  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY\n);\n",
    );
    const plan = buildPlan(TABLES);
    const state = newStepPlan(plan, "msg_t");
    const r = await runStepPlan({
      plan,
      state,
      root: s.root,
      system: "You are Depo's coding agent.",
      base: s.base,
      stepUp: null,
      save: () => undefined,
      checkApp: null,
      budget: 8000,
      generateTables: true,
    });
    expect(modelCalls).toBe(0);
    expect(r.blocked).toEqual([]);
    expect(state.steps.filter((x) => x.kind === "table").map((x) => [x.status, x.note])).toEqual([
      ["done", "Written by Depo, no model call"],
      ["done", "Written by Depo, no model call"],
    ]);
    const schema = read(s.root, "be/src/db/schema.sql");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS favorites");
    expect(schema).toContain("FOREIGN KEY (skill_id) REFERENCES skills (id)");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS scans");
    expect(schema).toContain("user_id BIGINT UNSIGNED NOT NULL");
  });

  test("off by default: the model writes the tables", async () => {
    let modelCalls = 0;
    const s = setup(() => {
      modelCalls++;
      return "Done.";
    });
    const plan = buildPlan(TABLES);
    const state = newStepPlan(plan, "msg_t2");
    await runStepPlan({
      plan,
      state,
      root: s.root,
      system: "You are Depo's coding agent.",
      base: s.base,
      stepUp: null,
      save: () => undefined,
      checkApp: null,
      budget: 8000,
    });
    expect(modelCalls).toBeGreaterThan(0);
  });
});
