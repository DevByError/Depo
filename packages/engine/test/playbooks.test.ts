import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AGENT_IDS } from "@depo/shared";
import { codingSystemPrompt } from "../src/agent/prompt";
import { detectStack, stackSummary } from "../src/agent/stack";
import { promptBudgets } from "../src/agent/tasks";
import { MANIFESTS } from "../src/agents/manifests";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import {
  autoTopicsPrompt,
  coreFor,
  corePrompt,
  definitionOfDone,
  findTopic,
  playbookBudget,
  readPlaybook,
  selectTopics,
  TOPICS,
  trimSection,
} from "../src/playbooks";
import { needsFrom, planningGuide, raiseTheBar } from "../src/playbooks/plan";
import { executeTool, type ToolContext, toolDefinitions } from "../src/tools/index";
import { tempDir } from "./helpers";

const FIXTURE = path.resolve(import.meta.dir, "../../../scripts/fixtures/fastapi-demo");
const AGENTS = [...AGENT_IDS, "coder"] as const;

describe("playbook content", () => {
  test("every agent has a core with a definition of done, a checklist and what to avoid", () => {
    for (const id of AGENTS) {
      const core = coreFor(id);
      expect(core.length).toBeGreaterThan(1200);
      expect(core.length).toBeLessThan(2800);
      for (const h of ["## Definition of done", "## Checklist", "## Avoid"]) expect(core).toContain(h);
      expect(definitionOfDone(id).length).toBeGreaterThan(100);
      expect(definitionOfDone(id)).not.toContain("## Checklist");
    }
  });

  test("topics have valid headers, real depth and no em dashes", () => {
    expect(TOPICS.length).toBeGreaterThanOrEqual(25);
    const ids = new Set<string>();
    for (const t of TOPICS) {
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.summary.length).toBeGreaterThan(20);
      expect(t.triggers.length).toBeGreaterThan(0);
      expect(t.agents.length).toBeGreaterThan(0);
      for (const a of t.agents) expect(AGENTS as readonly string[]).toContain(a);
      const words = t.body.split(/\s+/).length;
      expect(words).toBeGreaterThan(400);
      expect(words).toBeLessThan(1000);
      expect(t.body).not.toContain("—");
      // Code fences are balanced, so trimming never leaves one open.
      expect((t.body.match(/```/g) ?? []).length % 2).toBe(0);
    }
    for (const want of ["fastapi", "nextjs", "postgres", "auth", "rbac", "owasp", "testing-strategy"])
      expect(ids.has(want)).toBe(true);
    expect(findTopic("production-baseline")?.when).toBe("new");
  });
});

describe("topic selection", () => {
  test("the stack and the request pick the right sections", () => {
    const hints = detectStack(FIXTURE).hints;
    expect(hints).toContain("fastapi");
    const coder = selectTopics({ agent: "coder", text: "add a /health endpoint", hints });
    expect(coder[0]?.id).toBe("fastapi");

    const backend = selectTopics({
      agent: "backend",
      text: "add login with refresh tokens to the Express API",
      hints: ["express"],
    }).map((t) => t.id);
    expect(backend).toContain("auth");

    // Specialists get their own field even when the request does not name it.
    expect(selectTopics({ agent: "testing", text: "build a clinic booking app", max: 1 })[0]?.id).toBe(
      "testing-strategy",
    );
    expect(selectTopics({ agent: "security", text: "build a clinic booking app", max: 1 })[0]?.id).toBe(
      "owasp",
    );
    // The production baseline is for new work, not for a small fix.
    const manager = (text: string) => selectTopics({ agent: "manager", text }).map((t) => t.id);
    expect(manager("build a clinic booking system with an admin area")).toContain("production-baseline");
    expect(manager("fix the typo in the footer")).not.toContain("production-baseline");
  });

  test("the budget grows with the context and small models get no sections", () => {
    expect(playbookBudget(4096)).toEqual({ topics: 0, chars: 0 });
    expect(playbookBudget(8192).topics).toBe(0);
    expect(playbookBudget(16_384).topics).toBe(1);
    expect(playbookBudget(32_768).topics).toBe(2);
    expect(playbookBudget(131_072).chars).toBeGreaterThan(playbookBudget(32_768).chars);

    const args = { agent: "coder", text: "add an endpoint", root: FIXTURE };
    expect(autoTopicsPrompt({ ...args, contextLength: 8192 })).toBe("");
    const mid = autoTopicsPrompt({ ...args, contextLength: 16_384 });
    expect(mid).toContain("## Playbook:");
    expect(mid.length).toBeLessThanOrEqual(3600 + 200);
    const big = autoTopicsPrompt({ ...args, contextLength: 65_536 });
    expect(big.length).toBeGreaterThanOrEqual(mid.length);
    expect(big.length).toBeLessThanOrEqual(11_000 + 300);
  });

  test("trimming cuts at a heading or paragraph and never inside a code block", () => {
    const body = [
      "# Topic",
      "Intro paragraph.",
      "## Part one",
      "Some text here.",
      "```ts",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "## Part two",
      "x".repeat(400),
    ].join("\n");
    expect(trimSection(body, 10_000, "t")).toBe(body);
    const cut = trimSection(body, 160, "t");
    expect(cut.length).toBeLessThanOrEqual(160);
    expect((cut.match(/```/g) ?? []).length % 2).toBe(0);
    expect(cut).toContain("read_playbook t");
    expect(trimSection("one long paragraph ".repeat(50), 100, "t")).toBe("");
  });
});

describe("read_playbook tool", () => {
  let ctx: ToolContext;
  let cleanup = () => {};
  let closeDb = () => {};
  beforeEach(() => {
    const t = tempDir("depo playbook");
    cleanup = t.cleanup;
    const logger = createLogger({ dir: path.join(t.dir, "logs"), level: "error", stderr: false });
    const db = openDatabase({
      file: path.join(t.dir, "db", "t.db"),
      backupsDir: path.join(t.dir, "bk"),
      logger,
    });
    closeDb = () => db.close();
    const bus = new EventBus(db.db, logger);
    fs.mkdirSync(path.join(t.dir, "proj"));
    ctx = {
      root: path.join(t.dir, "proj"),
      bus,
      approvals: new ApprovalCenter(bus),
      projectId: null,
      taskId: null,
      agent: "backend@1",
    };
  });
  afterEach(() => {
    closeDb();
    cleanup();
  });

  test("lists, reads, searches, and answers an unknown topic with the list", async () => {
    expect(toolDefinitions(["read_playbook"])).toHaveLength(1);
    const list = await executeTool("read_playbook", {}, ctx);
    expect(list.isError).toBe(false);
    for (const t of TOPICS) expect(list.content).toContain(`- ${t.id}:`);

    const fastapi = await executeTool("read_playbook", { topic: "fastapi" }, ctx);
    expect(fastapi.content).toBe(findTopic("fastapi")?.body ?? "missing");
    // Aliases from the triggers work too.
    expect((await executeTool("read_playbook", { topic: "postgresql" }, ctx)).content).toBe(
      findTopic("postgres")?.body ?? "missing",
    );

    const q = await executeTool("read_playbook", { query: "refresh token rotation" }, ctx);
    expect(q.content).toBe(readPlaybook({ query: "refresh token rotation" }).text);
    expect(readPlaybook({ query: "refresh token rotation" }).title).toBe(findTopic("auth")?.title ?? "");

    const none = readPlaybook({ query: "zzqx flurb" });
    expect(none.found).toBe(false);
    expect(none.text).toContain("- fastapi:");

    const core = await executeTool("read_playbook", { topic: "testing" }, ctx);
    expect(core.content).toContain(coreFor("testing"));

    const bad = await executeTool("read_playbook", { topic: "x".repeat(200) }, ctx);
    expect(bad.isError).toBe(true);
  });
});

describe("agents carry their playbook", () => {
  test("every manifest prompt holds its core and the topic list, and can call read_playbook", () => {
    for (const m of MANIFESTS) {
      expect(m.prompt).toContain(coreFor(m.id));
      expect(m.prompt).toContain(corePrompt(m.id));
      expect(m.prompt).toContain(`You are the ${m.name} agent.`);
      expect(m.tools).toContain("read_playbook");
    }
  });

  test("the system prompt fits a small 8k model with room to work", () => {
    // About 3.5 characters per token: the prompt plus the memory and repo map budgets must stay
    // under 30% of an 8k context, so the conversation and tool output have the rest.
    const limit = Math.floor(8192 * 0.3 * 3.5);
    const budgets = promptBudgets(8192);
    const reserve = budgets.memory + budgets.repoMap;

    const coding = codingSystemPrompt({
      projectName: "fastapi demo",
      root: FIXTURE,
      contextLength: 8192,
      request: "add a /health endpoint",
    });
    expect(coding).toContain("# Your playbook");
    expect(coding).not.toContain("# Playbook sections");
    expect(coding.length + reserve).toBeLessThan(limit);

    for (const m of MANIFESTS) {
      const topics = autoTopicsPrompt({
        agent: m.id,
        text: "build a clinic booking app with an admin area",
        root: FIXTURE,
        contextLength: 8192,
      });
      expect(topics).toBe("");
      expect(m.prompt.length + reserve).toBeLessThan(limit);
    }

    // A bigger model gets sections, and the project line names the stack.
    const big = codingSystemPrompt({
      projectName: "fastapi demo",
      root: FIXTURE,
      contextLength: 32_768,
      request: "add a /health endpoint",
    });
    expect(big).toContain("# Playbook sections for this task");
    expect(big).toContain(stackSummary(detectStack(FIXTURE)));
  });
});

describe("production bar", () => {
  test("a build plan with users and admins gets accounts and permissions", () => {
    const text = "Build a clinic booking app where patients book visits and an admin manages doctors";
    expect(needsFrom(text, "full")).toMatchObject({ users: true, admin: true, ui: true, api: true });
    const guide = planningGuide("full", text);
    expect(guide).toContain("Production bar");
    expect(guide).toMatch(/Accounts/);

    const nodes = raiseTheBar(
      [
        { owner: "backend", title: "Booking API", criteria: ["POST /bookings creates a booking"] },
        { owner: "frontend", title: "Booking screens", criteria: [] },
        { owner: "testing", title: "Tests" },
      ],
      "full",
      text,
    );
    const backend = nodes[0]?.criteria ?? [];
    expect(backend[0]).toBe("POST /bookings creates a booking");
    expect(backend.some((c) => /login/.test(c) && /hashed/.test(c))).toBe(true);
    expect(backend.some((c) => /403/.test(c))).toBe(true);
    for (const n of nodes) {
      expect((n.criteria ?? []).length).toBeGreaterThan(0);
      expect((n.criteria ?? []).length).toBeLessThanOrEqual(8);
    }
    // Running it twice adds nothing new.
    expect(raiseTheBar(nodes, "full", text)).toEqual(nodes);
  });

  test("fixes and questions keep their plan as it is", () => {
    const nodes = [{ owner: "backend", title: "Fix the date bug", criteria: ["the test passes"] }];
    expect(raiseTheBar(nodes, "fix", "fix the login date bug")).toEqual(nodes);
    expect(planningGuide("fix", "fix the login date bug")).toBe("");
    expect(planningGuide("ask", "how does login work?")).toBe("");
  });
});
