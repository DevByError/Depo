import { afterEach, describe, expect, test } from "bun:test";

process.env.DEPO_NO_BROWSER = "1";

import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ChatRequest, ModelProvider, ToolCall } from "@depo/model-gateway";
import { Blackboard, cleanSection, mayWrite } from "../src/agents/blackboard";
import { MANIFESTS, MODE_AGENTS, manifestOf } from "../src/agents/manifests";
import { agentStatuses, sanitizePlan, templateNodes } from "../src/agents/team";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir } from "./helpers";

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
  id: `c${++callId}`,
  name,
  arguments: args,
  rawArguments: JSON.stringify(args),
});

interface Reply {
  text?: string;
  calls?: ToolCall[];
}

/** A scripted model that plays every agent of the team. */
function teamModel(opts: { rejectBackend?: number | "always"; log?: string[] } = {}): ModelProvider {
  const reviewsSeen = new Map<string, number>();
  const reply = (req: ChatRequest): Reply => {
    const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
    const users = req.messages.filter((m) => m.role === "user");
    const lastUser = users.at(-1)?.content ?? "";
    // Manager planning (structured output).
    if (req.jsonSchema && sys.includes("Plan the work as a task graph")) {
      return {
        text: JSON.stringify({
          summary: "Build the data layer, then the API, then test and audit it.",
          nodes: [
            {
              id: "database",
              title: "Tasks table",
              owner: "database",
              deps: [],
              criteria: ["schema written"],
            },
            {
              id: "backend",
              title: "Tasks API with login",
              owner: "backend",
              deps: ["database"],
              criteria: ["route tests pass"],
            },
            {
              id: "testing",
              title: "Run the suite",
              owner: "testing",
              deps: ["backend"],
              criteria: ["suite passes"],
            },
            {
              id: "security",
              title: "Audit",
              owner: "security",
              deps: ["testing"],
              criteria: ["findings written"],
            },
          ],
          questions: [],
        }),
      };
    }
    const who = /You are the ([\w/ ]+?) agent\./.exec(sys)?.[1] ?? "";
    // Reviews.
    const rev = /Review the work of the ([\w/ ]+?) agent\.\nTask: (.*)/.exec(lastUser);
    if (rev) {
      const toolsDone = req.messages.filter((m) => m.role === "tool").length;
      if (toolsDone === 0) return { calls: [call("list_dir", { path: "." })] };
      const key = rev[2] ?? "";
      const n = (reviewsSeen.get(key) ?? 0) + 1;
      reviewsSeen.set(key, n);
      opts.log?.push(`review:${who}:${rev[1]}:${n}`);
      const rejects =
        rev[1] === "Backend" &&
        (opts.rejectBackend === "always" ||
          (typeof opts.rejectBackend === "number" && n <= opts.rejectBackend));
      return {
        text: JSON.stringify(
          rejects
            ? {
                verdict: "changes",
                findings: [
                  {
                    grade: "blocking",
                    file: "src/app.ts",
                    line: 1,
                    text: "Passwords are stored in plain text",
                  },
                ],
                confidence: 0.9,
              }
            : {
                verdict: "approve",
                findings: [{ grade: "nice_to_have", text: "Add a README line" }],
                confidence: 0.8,
              },
        ),
      };
    }
    const tools = req.messages.filter((m) => m.role === "tool");
    const lastIdx = req.messages.map((m) => m.role).lastIndexOf("user");
    const stepsSinceUser = req.messages.slice(lastIdx).filter((m) => m.role === "tool").length;
    const feedback = lastUser.includes("found blocking problems");
    opts.log?.push(`${who}:${feedback ? "fix" : stepsSinceUser}`);
    if (who === "Database") {
      return [
        {
          calls: [
            call("write_file", {
              path: "db/schema.sql",
              content: "create table tasks (id integer primary key, title text not null);\n",
            }),
          ],
        },
        {
          calls: [call("bb_write", { section: "schema/tables.md", content: "tasks(id pk, title not null)" })],
        },
        {
          calls: [
            call("send_message", {
              to: "backend",
              type: "handoff",
              summary: "Schema is in db/schema.sql",
              artifacts: ["schema/tables.md"],
            }),
          ],
        },
        { text: "Created the tasks table." },
      ][Math.min(stepsSinceUser, 3)] as Reply;
    }
    if (who === "Backend") {
      if (feedback) {
        return stepsSinceUser === 0
          ? {
              calls: [
                call("write_file", {
                  path: "src/app.ts",
                  content: 'export const hash = (p: string) => "h:" + p.length;\n',
                }),
              ],
            }
          : { text: "Hashed the passwords." };
      }
      return [
        {
          calls: [
            call("write_file", { path: "src/app.ts", content: "export const login = (p: string) => p;\n" }),
          ],
        },
        {
          calls: [call("bb_write", { section: "decisions.md", content: "Use token login.", mode: "append" })],
        },
        { calls: [call("bb_write", { section: "brief.md", content: "not mine" })] },
        { calls: [call("run_command", { command: "bun test" })] },
        { text: "Built the tasks API and its tests; tests pass." },
      ][Math.min(stepsSinceUser, 4)] as Reply;
    }
    if (who === "Testing") {
      return stepsSinceUser === 0
        ? { calls: [call("run_command", { command: "bun test" })] }
        : { text: "The whole suite passes." };
    }
    if (who === "Security") {
      return stepsSinceUser === 0
        ? {
            calls: [
              call("bb_write", { section: "reviews/security.md", content: "No high severity findings." }),
            ],
          }
        : { text: "Audit done: nothing blocking." };
    }
    void tools;
    return { text: `${who || "Agent"}: done.` };
  };

  return {
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
      const r = reply(req);
      if (r.text) yield { type: "text", delta: r.text };
      for (const c of r.calls ?? []) yield { type: "tool_call", call: c };
      yield { type: "done", finishReason: r.calls?.length ? "tool_calls" : "stop", usage: null };
    },
  };
}

/** Plays the whole team on a todo app (Next.js + FastAPI + PostgreSQL + login). */
function todoModel(): ModelProvider {
  const lines = (...l: string[]) => `${l.join("\n")}\n`;
  const files: Record<string, [string, string]> = {
    Database: [
      "db/schema.sql",
      lines(
        "create table users (id serial primary key, email text unique not null, password_hash text not null);",
        "create table todos (id serial primary key, user_id int references users(id), title text not null, done boolean default false);",
      ),
    ],
    Backend: [
      "backend/app/main.py",
      lines(
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "",
        "@app.post('/login')",
        "def login():",
        "    return {'token': 'x'}",
      ),
    ],
    Integration: ["frontend/lib/api.ts", lines("export const api = (path: string) => fetch('/api' + path);")],
    Frontend: [
      "frontend/app/page.tsx",
      lines("export default function Page() { return <main>Todos</main>; }"),
    ],
    Diagram: ["docs/diagrams/architecture.mmd", lines("flowchart LR", "  Web --> API --> DB[(PostgreSQL)]")],
    "DevOps and Documentation": ["README.md", lines("# Todo app", "Run: run.cmd")],
  };
  const sections: Record<string, string[]> = {
    "Project Management": ["brief.md", "reviews/ux-audit.md"],
    Thinking: ["options.md"],
    Reasoning: ["reviews/options-critique.md", "reviews/final.md"],
    "UI/UX Design": ["design-system.json"],
    Security: ["reviews/security.md"],
    Enhancement: ["reviews/performance.md"],
    Backend: ["openapi.yaml"],
  };
  return {
    ...teamModel(),
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      const lastUser = req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      let r: Reply;
      if (req.jsonSchema && sys.includes("Plan the work as a task graph")) {
        r = { text: "I cannot produce JSON today." };
      } else if (/Review the work of the/.test(lastUser)) {
        r = req.messages.some((m) => m.role === "tool")
          ? { text: JSON.stringify({ verdict: "approve", findings: [], confidence: 0.9 }) }
          : { calls: [call("list_dir", { path: "." })] };
      } else {
        const who = /You are the ([\w/ ]+?) agent\./.exec(sys)?.[1] ?? "";
        const title =
          /Your task: (.*)/.exec(req.messages.find((m) => m.role === "user")?.content ?? "")?.[1] ?? "";
        const n = req.messages.filter((m) => m.role === "tool").length;
        const plan: Reply[] = [];
        const f = files[who];
        if (f && who !== "Diagram") plan.push({ calls: [call("write_file", { path: f[0], content: f[1] })] });
        if (who === "Diagram") {
          const erd = title.includes("ERD and API map");
          const file = erd ? "docs/diagrams/erd.mmd" : "docs/diagrams/architecture.mmd";
          const body = erd
            ? [
                "erDiagram",
                "  USERS ||--o{ TODOS : owns",
                "  USERS {",
                "    int id PK",
                "    text email",
                "  }",
                "  TODOS {",
                "    int id PK",
                "    int user_id FK",
                "    text title",
                "  }",
              ].join("\n")
            : ["flowchart LR", "  Web --> API --> DB[(PostgreSQL)]"].join("\n");
          plan.push({ calls: [call("write_file", { path: file, content: `${body}\n` })] });
          plan.push({ calls: [call("render_diagram", { path: file })] });
        }
        if (who === "Project Management" && title.includes("UX audit")) {
          const names = [
            "Visibility of system status",
            "Match between system and the real world",
            "User control and freedom",
            "Consistency and standards",
            "Error prevention",
            "Recognition rather than recall",
            "Flexibility and efficiency of use",
            "Aesthetic and minimalist design",
            "Help users recognize, diagnose and recover from errors",
            "Help and documentation",
          ];
          plan.push({
            calls: [
              call("record_ux_audit", {
                summary: "Clear and consistent; add shortcuts.",
                scores: names.map((h, i) => ({
                  heuristic: h,
                  score: i === 6 ? 3 : 4,
                  evidence: "Seen on the todo list screen.",
                  fix: i === 6 ? "Add keyboard shortcuts." : "",
                })),
              }),
            ],
          });
        }
        if (who === "Project Management" && title.includes("deck")) {
          plan.push({
            calls: [
              call("make_deck", {
                dir: "docs/deck",
                spec: {
                  title: "Todo app",
                  kind: "pitch",
                  slides: [
                    { layout: "title", title: "Todo app", subtitle: "Plan your day" },
                    {
                      layout: "bullets",
                      title: "Problem",
                      bullets: ["Tasks are scattered", "No shared view"],
                    },
                    {
                      layout: "stats",
                      title: "Status",
                      stats: [
                        { label: "Tests", value: "pass" },
                        { label: "UX", value: "A-" },
                      ],
                    },
                  ],
                },
              }),
            ],
          });
        }
        const secs = sections[who] ?? [];
        const sec =
          who === "Reasoning"
            ? title.includes("Challenge")
              ? secs[0]
              : secs[1]
            : who === "Project Management"
              ? title.includes("UX") || title.includes("deck")
                ? undefined
                : secs[0]
              : secs[0];
        if (sec) plan.push({ calls: [call("bb_write", { section: sec, content: `${who}: ${title}` })] });
        if (who === "Testing") plan.push({ calls: [call("run_command", { command: "bun test" })] });
        r = n < plan.length ? (plan[n] as Reply) : { text: `${who} finished: ${title}` };
      }
      if (r.text) yield { type: "text", delta: r.text };
      for (const c of r.calls ?? []) yield { type: "tool_call", call: c };
      yield { type: "done", finishReason: r.calls?.length ? "tool_calls" : "stop", usage: null };
    },
  };
}

async function setup(model: ModelProvider, settings: Record<string, boolean | number | string> = {}) {
  const t = tempDir("depo team");
  cleanup = t.cleanup;
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    tasks: { retryDelayMs: 10 },
    models: { providerFactory: () => model },
  });
  engine = e;
  await e.start();
  e.models.setProviders([{ id: "fake", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }]);
  e.models.assign("coder", { providerId: "fake", model: "fake-model" });
  e.models.assign("reasoning", { providerId: "fake", model: "fake-model" });
  for (const [k, v] of Object.entries({ "team.approve_plan": false, ...settings })) e.settings.set(k, v);
  const proj = path.join(t.dir, "todo app");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "todo", scripts: { test: "bun test" } }),
  );
  fs.writeFileSync(
    path.join(proj, "src", "app.test.ts"),
    'import { expect, test } from "bun:test";\ntest("works", () => expect(1 + 1).toBe(2));\n',
  );
  const project = await e.projects.open(proj);
  return { e, proj, project };
}

describe("agent manifests", () => {
  test("there are fifteen agents, each with a unique id, tools that exist and valid reviewers", () => {
    expect(MANIFESTS).toHaveLength(15);
    expect(new Set(MANIFESTS.map((m) => m.id)).size).toBe(15);
    for (const m of MANIFESTS) {
      expect(m.prompt.length).toBeGreaterThan(200);
      for (const r of m.reviewers) expect(r).not.toBe(m.id);
      expect(m.tools).toContain("bb_read");
    }
    for (const ids of Object.values(MODE_AGENTS)) for (const id of ids) expect(manifestOf(id).id).toBe(id);
  });

  test("blackboard ownership: folders, shared decisions and traversal", () => {
    const backend = manifestOf("backend");
    expect(mayWrite(backend, "openapi.yaml")).toBe(true);
    expect(mayWrite(backend, "schema/users.md")).toBe(true);
    expect(mayWrite(backend, "brief.md")).toBe(false);
    expect(mayWrite(backend, "decisions.md")).toBe(true);
    expect(() => cleanSection("../x")).toThrow();
    expect(() => cleanSection("a//b")).toThrow();
    expect(cleanSection("reviews\\sec.md")).toBe("reviews/sec.md");
  });
});

describe("plans", () => {
  test("every mode has a valid, acyclic template that only uses the mode's agents", () => {
    for (const mode of Object.keys(MODE_AGENTS) as (keyof typeof MODE_AGENTS)[]) {
      const nodes = templateNodes(mode, "build a todo app");
      const ids = new Set(nodes.map((n) => n.id));
      expect(ids.size).toBe(nodes.length);
      for (const n of nodes) {
        expect(MODE_AGENTS[mode]).toContain(n.owner);
        for (const d of n.deps ?? []) expect(ids.has(d)).toBe(true);
      }
    }
  });

  test("a cyclic, unknown or empty draft falls back; code work gets a testing step", () => {
    const fallback = templateNodes("backend", "x");
    const cyc = sanitizePlan(
      {
        summary: "",
        nodes: [
          { id: "a", title: "A", owner: "backend", deps: ["b"], criteria: [] },
          { id: "b", title: "B", owner: "database", deps: ["a"], criteria: [] },
        ],
        questions: [],
      },
      "backend",
      fallback,
    );
    expect(cyc).toBe(fallback);
    const unknown = sanitizePlan(
      {
        summary: "",
        nodes: [{ id: "a", title: "A", owner: "wizard", deps: [], criteria: [] }],
        questions: [],
      },
      "backend",
      fallback,
    );
    expect(unknown).toBe(fallback);
    const ok = sanitizePlan(
      {
        summary: "",
        nodes: [{ id: "api", title: "API", owner: "Backend", deps: ["ghost"], criteria: [] }],
        questions: [],
      },
      "backend",
      fallback,
    );
    expect(ok.map((n) => n.owner)).toEqual(["backend", "testing"]);
    expect(ok[0]?.deps).toEqual([]);
  });

  test("agent board states come from the plan", () => {
    const plan = {
      mode: "backend" as const,
      summary: "",
      version: 1,
      approved: true,
      questions: [],
      nodes: [
        {
          id: "a",
          title: "A",
          owner: "database" as const,
          deps: [],
          criteria: [],
          review: true,
          status: "doing" as const,
          attempts: 1,
        },
        {
          id: "b",
          title: "B",
          owner: "backend" as const,
          deps: ["a"],
          criteria: [],
          review: true,
          status: "review" as const,
          attempts: 1,
          reviewer: "reasoning" as const,
        },
        {
          id: "c",
          title: "C",
          owner: "testing" as const,
          deps: ["b"],
          criteria: [],
          review: true,
          status: "blocked" as const,
          attempts: 0,
          note: "waiting",
        },
      ],
    };
    const by = Object.fromEntries(agentStatuses(plan, new Set(["security"])).map((a) => [a.id, a.state]));
    expect(by.database).toBe("working");
    expect(by.reasoning).toBe("thinking");
    expect(by.testing).toBe("blocked");
    expect(by.security).toBe("waiting");
    expect(by.diagram).toBe("idle");
  });
});

describe("agent team", () => {
  test("backend mode: plan, owners work, a reviewer sends work back once, tests run, blackboard fills, diff is ready", async () => {
    const log: string[] = [];
    const { e, project } = await setup(teamModel({ rejectBackend: 1, log }));
    const task = e.tasks.send(project.id, "add task lists with login to this API", undefined, "backend");
    await e.tasks.settled(task.id);
    const { task: done, messages } = e.tasks.get(task.id);
    expect(done.status).toBe("review");
    expect(done.mode).toBe("backend");

    const state = e.tasks.teamState(task.id);
    expect(state.plan?.nodes.map((n) => [n.id, n.status])).toEqual([
      ["database", "done"],
      ["backend", "done"],
      ["testing", "done"],
      ["security", "done"],
    ]);
    // Two-key rule: the Backend work was reviewed by someone else (Security, because it mentions login), once rejected.
    expect(state.plan?.nodes.find((n) => n.id === "backend")?.attempts).toBe(2);
    expect(log.some((l) => l.startsWith("review:") && l.endsWith(":Backend:1"))).toBe(true);
    expect(log.some((l) => l.endsWith(":Backend:2"))).toBe(true);
    expect(log).toContain("Backend:fix");

    // Typed messages were recorded.
    const kinds = new Set(state.messages.map((m) => m.type));
    for (const k of ["handoff", "review", "result"] as const) expect(kinds.has(k)).toBe(true);
    expect(state.messages.every((m) => m.from.includes("@"))).toBe(true);

    // Blackboard: schema by Database, decisions appended, brief refused for Backend, reviews stored.
    const bb = new Blackboard(e.database.db);
    const sections = bb.list(project.id).map((x) => x.section);
    expect(sections).toContain("schema/tables.md");
    expect(sections).toContain("decisions.md");
    expect(sections).toContain("reviews/security.md");
    expect(sections).toContain("reviews/backend.md");
    expect(sections).not.toContain("brief.md");
    expect(bb.read(project.id, "reviews/backend.md")?.content).toContain("plain text");
    expect(messages.some((m) => m.role === "tool" && m.toolName === "bb_write" && m.isError)).toBe(true);

    // The final answer is the Manager's summary, and the agents' steps carry their names.
    const last = messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.text).toContain("finished all 4 tasks");
    expect(messages.some((m) => m.agent?.startsWith("database@"))).toBe(true);

    // The change set has the work, and the real project is untouched.
    const cs = e.projects.listChangeSets(project.id).find((c) => c.status === "pending");
    const files = cs?.files.map((f) => f.path) ?? [];
    expect(files).toContain("db/schema.sql");
    expect(files).toContain("src/app.ts");
    expect(files.some((f) => f.startsWith("docs/depo/"))).toBe(true);
    expect(fs.existsSync(path.join(project.rootPath, "db"))).toBe(false);

    const agents = state.agents;
    expect(agents.find((a) => a.id === "database")?.done).toBe(1);
    expect(agents.every((a) => a.state === "idle")).toBe(true);

    // Depo remembered what the finished team task taught (memory.auto).
    await e.tasks.autoMemory?.idle();
    expect(e.memory.list(project.id).some((f) => f.source === "auto")).toBe(true);
  }, 60_000);

  test("Phase 3 acceptance: a todo app (Next.js + FastAPI + PostgreSQL + login) goes through the full pipeline", async () => {
    const { e, project } = await setup(todoModel(), { "team.parallel": 2 });
    const started: string[] = [];
    e.bus.subscribe((ev) => {
      if (ev.type === "handoff" && ev.status === "started" && typeof ev.details?.nodeId === "string")
        started.push(ev.details.nodeId);
    });
    const task = e.tasks.send(
      project.id,
      "a todo app with Next.js, FastAPI, PostgreSQL and login",
      undefined,
      "full",
    );
    await e.tasks.settled(task.id);
    const { task: done, messages } = e.tasks.get(task.id);
    expect(done.status).toBe("review");
    const state = e.tasks.teamState(task.id);
    const nodes = state.plan?.nodes ?? [];
    expect(nodes).toHaveLength(17);
    expect(nodes.filter((n) => n.status !== "done").map((n) => `${n.id}:${n.status}:${n.note}`)).toEqual([]);

    // Dependencies were respected: every node started after all of its dependencies.
    for (const n of nodes)
      for (const d of n.deps) expect(started.indexOf(d)).toBeLessThan(started.indexOf(n.id));
    // Every code-producing step was signed off by a different agent.
    const reviews = state.messages.filter((m) => m.type === "review");
    for (const owner of [
      "database",
      "backend",
      "integration",
      "frontend",
      "ui-ux-design",
      "testing",
      "devops-docs",
    ])
      expect(reviews.some((m) => m.to.startsWith(`${owner}@`))).toBe(true);
    expect(reviews.every((m) => m.from.split("@")[0] !== m.to.split("@")[0])).toBe(true);
    // Security (login) reviews the backend and frontend login work.
    expect(reviews.some((m) => m.from.startsWith("security@") && m.to.startsWith("backend@"))).toBe(true);

    const bb = new Blackboard(e.database.db);
    const sections = bb.list(project.id).map((x) => x.section);
    for (const s of [
      "brief.md",
      "options.md",
      "design-system.json",
      "openapi.yaml",
      "reviews/security.md",
      "reviews/ux-audit.md",
      "scores/ux.json",
      "plan.json",
    ])
      expect(sections).toContain(s);

    const cs = e.projects.listChangeSets(project.id).find((c) => c.status === "pending");
    const files = cs?.files.map((f) => f.path) ?? [];
    for (const f of [
      "db/schema.sql",
      "backend/app/main.py",
      "frontend/app/page.tsx",
      "frontend/lib/api.ts",
      "docs/diagrams/architecture.mmd",
      "README.md",
      "docs/depo/brief.md",
      "docs/depo/reviews/security.md",
      "docs/diagrams/erd.mmd",
      "docs/deck/deck.pptx",
      "docs/deck/deck.html",
    ])
      expect(files).toContain(f);
    expect(messages.at(-1)?.text).toContain("finished all 17 tasks");
  }, 120_000);

  test("loop limit: work the reviewer keeps rejecting stops, later steps are blocked, and the summary says so", async () => {
    const { e, project } = await setup(teamModel({ rejectBackend: "always" }), { "team.fix_loops": 2 });
    const task = e.tasks.send(project.id, "add task lists with login", undefined, "backend");
    await e.tasks.settled(task.id);
    const state = e.tasks.teamState(task.id);
    const byId = Object.fromEntries((state.plan?.nodes ?? []).map((n) => [n.id, n]));
    expect(byId.database?.status).toBe("done");
    expect(byId.backend?.status).toBe("failed");
    expect(byId.backend?.attempts).toBe(2);
    expect(byId.testing?.status).toBe("blocked");
    expect(byId.security?.status).toBe("blocked");
    const bb = new Blackboard(e.database.db);
    expect(bb.read(project.id, "decisions.md")?.content).toContain("Unresolved after 2 attempts");
    expect(state.messages.some((m) => m.type === "blocker")).toBe(true);
    const { task: t, messages } = e.tasks.get(task.id);
    expect(t.status).toBe("review");
    expect(messages.at(-1)?.text).toContain("did not finish");
  }, 60_000);

  test("the user approves the plan before work starts; declining builds nothing", async () => {
    const { e, project } = await setup(teamModel(), { "team.approve_plan": true });
    const task = e.tasks.send(project.id, "add task lists", undefined, "backend");
    const deadline = Date.now() + 15_000;
    while (e.approvals.list().length === 0 && Date.now() < deadline) await Bun.sleep(20);
    const [req] = e.approvals.list();
    expect(req?.title).toContain("Start this plan");
    expect(e.tasks.teamState(task.id).agents.find((a) => a.id === "manager")?.state).toBe("waiting");
    e.approvals.respond(req?.id ?? "", false);
    await e.tasks.settled(task.id);
    const { task: t, messages } = e.tasks.get(task.id);
    expect(t.status).toBe("done");
    expect(messages.at(-1)?.text).toContain("declined");
    expect(e.tasks.teamState(task.id).plan?.nodes.every((n) => n.status === "todo")).toBe(true);
    // Nothing was built, so nothing is remembered.
    await e.tasks.autoMemory?.idle();
    expect(e.memory.list(project.id).some((f) => f.source === "auto")).toBe(false);
  }, 60_000);

  test("reviews can be switched off, and a single-step mode needs no negotiation", async () => {
    const log: string[] = [];
    const { e, project } = await setup(teamModel({ log }), { "team.reviews": "off" });
    const task = e.tasks.send(project.id, "answer: what does this project do?", undefined, "ask");
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("done");
    expect(log.some((l) => l.startsWith("review:"))).toBe(false);
    expect(e.tasks.teamState(task.id).plan?.nodes).toHaveLength(1);
  }, 60_000);
});
