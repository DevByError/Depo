import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ChatMessage, ModelProvider } from "@depo/model-gateway";
import {
  type DesignReference,
  isRunReport,
  type PreviewDetection,
  type PreviewInfo,
  type RunRecipe,
} from "@depo/shared";
import {
  type FinishDeps,
  finishSummary,
  problemsPrompt,
  runFinishLine,
  usesMysql,
} from "../src/agent/finish";
import { kickstart } from "../src/agent/kickstart";
import { describesStepsForOwner, runAgentLoop } from "../src/agent/loop";
import { extractTextToolCalls } from "../src/agent/textcalls";
import { ApprovalCenter } from "../src/approvals";
import { blueprintFor, wantsNextBun } from "../src/blueprints/plan";
import { openDatabase } from "../src/db";
import { dataSteps } from "../src/devdb/hooks";
import type { DevDbInfo } from "../src/devdb/service";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { cleanModelName } from "../src/models/manager";
import { contrast, fromHex } from "../src/references/palette";
import { applyTheme, THEME_START, themeFromReference } from "../src/references/theme";
import type { ToolContext } from "../src/tools/index";
import { resolveInside } from "../src/tools/paths";
import { tempDir } from "./helpers";

/** The owner's request from the failed run, word for word. */
const OWNER_REQUEST =
  'create a front end folder "fe" and a backend folder "be" use next for the front end and typescript with bun for the back end . create a mysql database . i want registration / log in / log ou system . the UI design should follow the image i sent';

/** What Depo measured from the owner's Google sign-in picture. */
const GOOGLE_CARD: DesignReference = {
  id: "ref_1",
  kind: "image",
  name: "signin.png",
  url: null,
  state: "studied",
  mode: "light",
  width: 736,
  height: 552,
  palette: [
    { hex: "#fcfefe", share: 0.5, role: "background" },
    { hex: "#e8f1f8", share: 0.2, role: "surface" },
    { hex: "#565758", share: 0.03, role: "text" },
    { hex: "#666768", share: 0.02, role: "muted" },
    { hex: "#6197ce", share: 0.15, role: "primary" },
    { hex: "#d7e6f2", share: 0.05, role: "border" },
  ],
  fonts: ["Inter"],
  radius: "16px",
  notes: [],
  vision: false,
  facts: null,
  error: null,
} as unknown as DesignReference;

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

function temp(label: string): string {
  const t = tempDir(label);
  cleanups.push(t.cleanup);
  return t.dir;
}

function busAndApprovals(dir: string) {
  const logger = createLogger({ dir: path.join(dir, "logs"), level: "error", stderr: false });
  const db = openDatabase({ file: path.join(dir, "db", "t.db"), backupsDir: path.join(dir, "bk"), logger });
  cleanups.push(() => db.close());
  const bus = new EventBus(db.db, logger);
  return { bus, approvals: new ApprovalCenter(bus), logger };
}

describe("what went wrong in the owner's run", () => {
  test("a pretend `cd` becomes the next command's folder, and a fence with several calls is read", () => {
    const text = [
      "I will set up the backend.",
      "```json",
      '{"name": "cd", "arguments": {"path": "be"}}',
      '{"name": "run_command", "arguments": {"command": "bun init -y"}}',
      '{"name": "cd", "arguments": {"path": "../fe"}}',
      '{"name": "run_command", "arguments": {"command": "bun install", "cwd": "web"}}',
      "```",
    ].join("\n");
    const r = extractTextToolCalls(text, ["run_command", "write_file"]);
    expect(r.calls.map((c) => c.arguments)).toEqual([
      { command: "bun init -y", cwd: "be" },
      { command: "bun install", cwd: "web" },
    ]);
    expect(r.rest).toBe("I will set up the backend.");
  });

  test("agents are told .depo is Depo's folder, and where the file goes instead", () => {
    const root = temp("depo paths");
    expect(() => resolveInside(root, ".depo/package.json")).toThrow(
      /Depo's own working folder.*package\.json/,
    );
  });

  test("a pasted Ollama command in the download box is read as the model's name", () => {
    expect(cleanModelName("ollama pull qwen2.5-coder:3b")).toBe("qwen2.5-coder:3b");
    expect(cleanModelName("`qwen2.5-coder:7b`")).toBe("qwen2.5-coder:7b");
    expect(() => cleanModelName("ollama ps")).toThrow(/is an Ollama command, not a model name/);
  });

  test("a list of steps for the owner is not taken as the answer", () => {
    expect(describesStepsForOwner("Navigate to the fe folder and run the following: npm install", 0)).toBe(
      true,
    );
    expect(describesStepsForOwner("Create a `be/src/index.ts` file with this code:", 3)).toBe(true);
    expect(describesStepsForOwner("Done: added the login page and its tests (4 passed).", 5)).toBe(false);
    expect(describesStepsForOwner("You can now run the app with run.cmd.", 12)).toBe(false);
  });

  test("allow for this task, or for the whole project", async () => {
    const dir = temp("depo approvals");
    const { bus, approvals } = busAndApprovals(dir);
    let full = false;
    approvals.useProjectGrants({ has: () => full, grant: () => (full = true) });
    const ask = (taskId: string, kind: "command" | "apply" = "command") =>
      approvals.request({
        projectId: "prj_1",
        taskId,
        agent: "coder",
        kind,
        title: "Run x?",
        reason: "install",
      });
    const first = ask("tsk_1");
    approvals.respond(approvals.list()[0]?.id ?? "", true, "task");
    expect(await first).toBe(true);
    expect(await ask("tsk_1")).toBe(true); // no question this time
    const other = ask("tsk_2");
    expect(approvals.list()).toHaveLength(1);
    approvals.respond(approvals.list()[0]?.id ?? "", true, "project");
    expect(await other).toBe(true);
    expect(full).toBe(true);
    expect(await ask("tsk_3")).toBe(true);
    // Applying changes still always asks.
    void ask("tsk_3", "apply");
    expect(approvals.list()).toHaveLength(1);
    void bus;
  });
});

describe("a starting point and the picture's look, without a model", () => {
  test("the owner's request picks the Next.js + Bun + MySQL blueprint, other stacks do not", () => {
    expect(wantsNextBun(OWNER_REQUEST)).toBe(true);
    expect(blueprintFor("single", OWNER_REQUEST)?.id).toBe("next-bun-mysql");
    expect(blueprintFor("full", OWNER_REQUEST)?.id).toBe("next-bun-mysql");
    expect(blueprintFor("single", "a next.js app with an express api")).toBeNull();
    expect(blueprintFor("single", "Next.js front end, Bun API, postgres database")).toBeNull();
    expect(blueprintFor("single", "the next step: add a bun server")).toBeNull();
  });

  test("the theme keeps the picture's colours and fixes contrast to WCAG AA", () => {
    const t = themeFromReference(GOOGLE_CARD);
    expect(t).not.toBeNull();
    if (!t) return;
    // The light-blue page and the white card, the right way round.
    expect(t.bg).toBe("#e8f1f8");
    expect(t.surface).toBe("#fcfefe");
    expect(t.radius).toBe("16px");
    expect(t.font.startsWith("Inter, ")).toBe(true);
    // #6197ce has 3.1:1 with white: darkened (same hue) until a white label reads.
    expect(t.primaryText).toBe("#ffffff");
    expect(contrast(fromHex(t.primary), [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    // The primary is link text on the card too (axe failed #2778cb on #fcfefe at 4.47:1).
    for (const c of [t.text, t.muted, t.accent, t.danger, t.primary])
      expect(contrast(fromHex(c), fromHex(t.surface))).toBeGreaterThanOrEqual(4.5);
    // A generic family read from a picture adds nothing in front of the stack.
    const generic = themeFromReference({ ...GOOGLE_CARD, fonts: ["sans-serif"] });
    expect(generic?.font.startsWith('"Segoe UI"')).toBe(true);
    expect(themeFromReference({ ...GOOGLE_CARD, fonts: ["serif"] })?.font).toContain("Georgia");
  });

  test("kickstart writes the blueprint into the empty copy and the theme into its tokens", () => {
    const root = temp("depo kick");
    const r = kickstart({
      mode: "single",
      text: OWNER_REQUEST,
      root,
      projectName: "Login Demo",
      references: [GOOGLE_CARD],
      newReferences: true,
    });
    expect(r?.blueprint?.id).toBe("next-bun-mysql");
    expect(r?.files).toContain("be/src/auth/routes.ts");
    expect(r?.files).toContain("fe/app/login/page.tsx");
    expect(r?.themed).toEqual(["fe/app/globals.css"]);
    const css = fs.readFileSync(path.join(root, "fe", "app", "globals.css"), "utf8");
    expect(css).toContain(THEME_START);
    expect(css).toContain("--bg: #e8f1f8;");
    expect(css).toContain("--radius: 16px;");
    expect(r?.note).toContain("Depo already wrote the Next.js + Bun + MySQL app starting project");
    expect(r?.note).toContain("top level: be/, fe/, README.md");
    // A later run neither rewrites the project nor the agents' own token changes.
    fs.writeFileSync(
      path.join(root, "fe", "app", "globals.css"),
      css.replace("--radius: 16px;", "--radius: 4px;"),
    );
    expect(
      kickstart({
        mode: "single",
        text: OWNER_REQUEST,
        root,
        projectName: "x",
        references: [GOOGLE_CARD],
        newReferences: false,
      }),
    ).toBeNull();
    expect(fs.readFileSync(path.join(root, "fe", "app", "globals.css"), "utf8")).toContain("--radius: 4px;");
    // New references for a project that already exists: only the tokens change.
    expect(applyTheme(root, [GOOGLE_CARD])?.files).toEqual(["fe/app/globals.css"]);
  });

  test("the blueprint's app uses MySQL, and its migrate and seed scripts are found", () => {
    const root = temp("depo steps");
    kickstart({
      mode: "single",
      text: OWNER_REQUEST,
      root,
      projectName: "Login Demo",
      references: [],
      newReferences: false,
    });
    expect(usesMysql(root)).toBe(true);
    expect(dataSteps(root)).toEqual([{ cwd: "be", commands: ["bun run db:migrate", "bun run db:seed"] }]);
  });
});

// ---- the finish line --------------------------------------------------------------------------

function preview(over: Partial<PreviewInfo>): PreviewInfo {
  return {
    id: "pv_1",
    projectId: "prj_1",
    taskId: "tsk_1",
    target: "workspace",
    kind: "next",
    label: "Next.js (fe)",
    role: "frontend",
    command: "",
    cwd: "fe",
    port: 3000,
    url: "http://127.0.0.1:3000/",
    state: "running",
    phase: "running",
    error: null,
    exitCode: null,
    startedBy: "engine",
    groupId: null,
    approvalId: null,
    startedAt: new Date().toISOString(),
    readyAt: null,
    stoppedAt: null,
    ...over,
  } as PreviewInfo;
}

function recipe(missing: boolean): RunRecipe {
  const part = (cwd: string, role: "frontend" | "backend"): RunRecipe => ({
    id: `${cwd}`,
    kind: role === "frontend" ? "next" : "bun",
    label: cwd,
    command: "bun run dev",
    cwd,
    env: {},
    port: 0,
    readyPath: "/",
    role,
    // `echo` stands in for the package manager: allowed by the command policy, quick and offline.
    missing: missing ? { reason: "no node_modules", install: `echo installed-${cwd}`, cwd } : null,
  });
  return {
    ...part("", "frontend"),
    id: "both",
    kind: "both",
    parts: [part("be", "backend"), part("fe", "frontend")],
  };
}

function finishSetup(o: {
  installs?: boolean;
  previews?: PreviewInfo[];
  consoleErrors?: string[];
  seedOutput?: string;
  testsFail?: boolean;
}) {
  const dir = temp("depo finish");
  const { bus, approvals } = busAndApprovals(dir);
  const root = path.join(dir, "copy");
  fs.mkdirSync(root);
  kickstart({
    mode: "single",
    text: OWNER_REQUEST,
    root,
    projectName: "Login Demo",
    references: [],
    newReferences: false,
  });
  // The app's scripts, replaced by quick stand-ins that print what the real ones print.
  const pkgFile = path.join(root, "be", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  pkg.scripts["db:migrate"] = "echo migrated";
  pkg.scripts["db:seed"] = `echo ${o.seedOutput ?? "demo@example.com / demo12345"}`;
  pkg.scripts.test = o.testsFail ? "echo 1 fail && exit 1" : "echo 8 pass";
  fs.writeFileSync(pkgFile, JSON.stringify(pkg));
  const fePkgFile = path.join(root, "fe", "package.json");
  const fePkg = JSON.parse(fs.readFileSync(fePkgFile, "utf8"));
  fePkg.scripts.test = "echo 3 pass";
  fs.writeFileSync(fePkgFile, JSON.stringify(fePkg));
  let installed = !o.installs;
  const stopped: string[] = [];
  const calls: string[] = [];
  const db: DevDbInfo = {
    projectId: "prj_1",
    state: "running",
    engine: "mariadb",
    version: "11.4.5",
    port: 3307,
    database: "login_demo",
    user: "app",
    password: "pw",
    url: "mysql://app:pw@127.0.0.1:3307/login_demo",
    dataDir: null,
    message: null,
  };
  const started = o.previews ?? [
    preview({ id: "pv_be", label: "Bun (be)", role: "backend", url: "http://127.0.0.1:4000/" }),
    preview({}),
  ];
  const deps: FinishDeps = {
    projectName: "Login Demo",
    startTimeoutMs: 2000,
    previews: {
      detect: async (): Promise<PreviewDetection> =>
        ({ target: "workspace", recipes: [recipe(!installed)], suggested: 0 }) as unknown as PreviewDetection,
      list: () => [preview({ id: "pv_old", state: "running" })],
      stop: async (id) => {
        stopped.push(id);
        return true;
      },
      settled: async (id) => started.find((p) => p.id === id) ?? null,
      logs: () => ({ lines: [{ seq: 1, stream: "err", text: "Error: Cannot find module 'mysql2'" }] }),
    },
    autoStart: async () => {
      calls.push("autoStart");
      return { started: true, previews: started };
    },
    devdb: {
      ensure: async () => {
        calls.push("db");
        return db;
      },
      writeEnv: (r, info) => {
        fs.writeFileSync(path.join(r, "be", ".env"), `DATABASE_URL=${info.url}\n`);
        return ["be/.env"];
      },
    },
    qa: {
      check: async () =>
        ({
          id: "qa_1",
          url: "http://127.0.0.1:3000/",
          views: [
            {
              loaded: true,
              status: 200,
              error: null,
              consoleErrors: (o.consoleErrors ?? []).map((text) => ({ kind: "console", text, source: null })),
              failedRequests: [],
            },
          ],
        }) as never,
    },
  };
  const ctx: ToolContext = {
    root,
    bus,
    approvals,
    projectId: "prj_1",
    taskId: "tsk_1",
    agent: "coder",
    // What the owner's "Allow all in this project" covers; here only what the test runs.
    commandRules: { allow: ["echo", "bun run db:migrate", "bun run db:seed", "bun run test"], deny: [] },
  };
  const markInstalled = () => {
    installed = true;
  };
  return { deps, ctx, root, stopped, calls, markInstalled, bus };
}

describe("the finish line: Depo runs the work like the owner will", () => {
  test("installs, sets up the database and demo data, restarts the app and checks the page", async () => {
    const s = finishSetup({ installs: true });
    // The stand-in install "works": the next detection finds the packages.
    s.bus.subscribe((e) => {
      if (
        e.type === "running_command" &&
        e.status === "succeeded" &&
        String(e.text).startsWith("echo installed-fe")
      )
        s.markInstalled();
    });
    const r = await runFinishLine(s.ctx, s.deps, new AbortController().signal);
    expect(r.problems).toEqual([]);
    expect(r.running.map((p) => p.url)).toEqual(["http://127.0.0.1:3000/", "http://127.0.0.1:4000/"]);
    expect(r.notes).toContain("Installed the packages in be.");
    expect(r.notes).toContain("Installed the packages in fe.");
    expect(r.notes).toContain("Tests pass in be (`bun run test`).");
    expect(r.notes).toContain("Tests pass in fe (`bun run test`).");
    expect(r.notes.some((n) => n.startsWith("Test database: login_demo on 127.0.0.1:3307"))).toBe(true);
    expect(r.notes).toContain("Demo sign-ins: demo@example.com / demo12345.");
    expect(r.notes.some((n) => n.includes("no console errors"))).toBe(true);
    expect(s.stopped).toEqual(["pv_old"]);
    expect(fs.readFileSync(path.join(s.root, "be", ".env"), "utf8")).toContain("DATABASE_URL=mysql://");
    const summary = finishSummary(r);
    expect(isRunReport(summary)).toBe(true);
    expect(summary.split("\n")[1]).toBe(
      "Running now: Next.js (fe) http://127.0.0.1:3000/ · Bun (be) http://127.0.0.1:4000/",
    );
    expect(finishSummary({ problems: [], running: [], notes: [], blocked: [] })).toBe("");
  }, 30_000);

  test("failing tests come back to the agent before the app is started", async () => {
    const s = finishSetup({ testsFail: true });
    const r = await runFinishLine(s.ctx, s.deps, new AbortController().signal);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("The tests in be fail (`bun run test`)");
    expect(r.problems[0]).toContain("1 fail");
    expect(s.calls).not.toContain("autoStart");
  }, 30_000);

  test("Depo's own test database not starting goes to the owner, not to the agent", async () => {
    const s = finishSetup({});
    s.deps.devdb = {
      ensure: async () => {
        throw new Error(
          "The test database did not start on port 50538. [ERROR] [MY-012271] [InnoDB] The innodb_system data file 'ibdata1' must be writable",
        );
      },
      writeEnv: () => [],
    };
    const r = await runFinishLine(s.ctx, s.deps, new AbortController().signal);
    expect(r.problems).toEqual([]);
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0]).toContain("Depo's test database did not start");
    expect(s.calls).not.toContain("autoStart");
    const summary = finishSummary(r);
    expect(summary).toContain("Depo could not check the app: Depo's test database did not start");
    expect(summary).toContain("must be writable");
  }, 30_000);

  test("an app that does not start comes back to the agent with its last output lines", async () => {
    const s = finishSetup({
      previews: [
        preview({
          id: "pv_be",
          label: "Bun (be)",
          role: "backend",
          state: "failed",
          error: "exited with code 1",
        }),
      ],
    });
    const r = await runFinishLine(s.ctx, s.deps, new AbortController().signal);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("Bun (be) did not start: exited with code 1.");
    expect(r.problems[0]).toContain("Cannot find module 'mysql2'");
    expect(problemsPrompt(r)).toContain("Do not tell the owner to fix it.");
  }, 30_000);

  test("console errors on the page are problems too", async () => {
    const s = finishSetup({
      consoleErrors: ["TypeError: Cannot read properties of undefined (reading 'name')"],
    });
    const r = await runFinishLine(s.ctx, s.deps, new AbortController().signal);
    expect(r.problems[0]).toContain("console error: TypeError");
  }, 30_000);

  test("the agent loop sends the problems back once, then finishes with the links", async () => {
    const dir = temp("depo finish loop");
    const { bus, approvals } = busAndApprovals(dir);
    const root = path.join(dir, "copy");
    fs.mkdirSync(root);
    const replies = [
      { name: "write_file", arguments: { path: "be/src/index.ts", content: "export {};\n" } },
      "Done: the API is ready.",
      { name: "write_file", arguments: { path: "be/src/index.ts", content: "console.log('ok');\n" } },
      "Fixed the start script.",
    ];
    let i = 0;
    const requests: ChatMessage[][] = [];
    const provider: ModelProvider = {
      id: "fake",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      health: async () => ({ ok: true, version: "fake", message: null }),
      listModels: async () => [],
      embed: async () => [],
      chat: (req) => {
        requests.push([...req.messages]);
        const r = replies[Math.min(i++, replies.length - 1)];
        return (async function* (): AsyncIterable<ChatChunk> {
          if (typeof r === "string") yield { type: "text", delta: r };
          else
            yield {
              type: "tool_call",
              call: {
                id: `c${i}`,
                name: r?.name ?? "",
                arguments: r?.arguments,
                rawArguments: JSON.stringify(r?.arguments),
              },
            } as ChatChunk;
          yield { type: "done", finishReason: "stop", usage: null };
        })();
      },
    };
    let rounds = 0;
    const history: ChatMessage[] = [
      { role: "system", content: "You are a coder." },
      { role: "user", content: "Build the API." },
    ];
    const res = await runAgentLoop({
      provider,
      model: "m",
      contextLength: 32_768,
      history,
      toolNames: ["write_file"],
      ctx: { root, bus, approvals, projectId: "prj_1", taskId: "tsk_1", agent: "coder" },
      maxSteps: 10,
      signal: new AbortController().signal,
      job: { projectId: "prj_1", taskId: "tsk_1", label: "t" },
      emit: () => {},
      persist: () => {},
      beforeFinish: async ({ changed }) => {
        expect(changed).toEqual(["be/src/index.ts"]);
        rounds++;
        return rounds === 1
          ? { retry: "Depo tried to run your work: Bun (be) did not start." }
          : { append: "Running now: http://127.0.0.1:3000/" };
      },
    });
    expect(rounds).toBe(2);
    expect(res.finalText).toBe("Fixed the start script.\n\nRunning now: http://127.0.0.1:3000/");
    expect(requests[2]?.at(-1)?.content).toContain("Bun (be) did not start");
  });
});

describe("when the model runtime falls over", () => {
  test("refused, dropped and crashed calls are told apart; the context halves after crashes", async () => {
    const { ModelGatewayError } = await import("@depo/model-gateway");
    const { fallOf, smallerContext, waitForRuntime } = await import("../src/models/revive");
    expect(
      fallOf(
        new ModelGatewayError(
          "unreachable",
          "Ollama is not running or not reachable.",
          undefined,
          "ECONNREFUSED",
        ),
      ),
    ).toBe("refused");
    expect(
      fallOf(
        new ModelGatewayError(
          "unreachable",
          "Ollama dropped the connection",
          undefined,
          "ECONNRESET: socket hang up",
        ),
      ),
    ).toBe("dropped");
    expect(
      fallOf(
        new ModelGatewayError(
          "http",
          "Ollama returned 500: llama runner process has terminated: exit status 2",
          500,
        ),
      ),
    ).toBe("crashed");
    expect(fallOf(new ModelGatewayError("http", "Ollama returned 500: model not found", 500))).toBeNull();
    // The runner hangs while Ollama itself still answers (seen on a 4 GB card running a 7b model).
    expect(
      fallOf(
        new ModelGatewayError(
          "http",
          'Ollama returned 500: {"error":"Post \\"http://127.0.0.1:50574/tokenize\\": dial tcp 127.0.0.1:50574: connectex: A connection attempt failed because the connected party did not properly respond after a period of time"}',
          500,
        ),
      ),
    ).toBe("crashed");
    expect(
      fallOf(
        new ModelGatewayError("http", 'Ollama returned 500: Post "http://127.0.0.1:1/completion": EOF', 500),
      ),
    ).toBe("crashed");
    expect(
      fallOf(
        new ModelGatewayError(
          "unreachable",
          "Could not connect to Ollama in time (ETIMEDOUT: Connection timed out).",
          undefined,
          "ETIMEDOUT: Connection timed out",
        ),
      ),
    ).toBe("dropped");
    expect(
      fallOf(new ModelGatewayError("unreachable", "x", undefined, "EHOSTUNREACH: no route to host")),
    ).toBeNull();
    expect(smallerContext(32_768)).toBe(16_384);
    expect(smallerContext(6000)).toBe(4096);
    // Comes back on the third health check; a local Ollama that is down is started once.
    let checks = 0;
    let starts = 0;
    const ok = await waitForRuntime(
      {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        health: async () => ({ ok: ++checks >= 3, version: "x", message: null }),
      },
      { pollMs: 5, timeoutMs: 2000, start: () => ++starts > 0 },
    );
    expect(ok).toBe(true);
    expect(starts).toBe(1);
  });

  test("the agent loop retries a dropped call with a smaller context after the second crash", async () => {
    const dir = temp("depo crash");
    const { bus, approvals } = busAndApprovals(dir);
    const { ModelGatewayError } = await import("@depo/model-gateway");
    const seen: number[] = [];
    let n = 0;
    const events: string[] = [];
    const provider: ModelProvider = {
      id: "fake",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      health: async () => ({ ok: true, version: "fake", message: null }),
      listModels: async () => [],
      embed: async () => [],
      chat: (req) => {
        seen.push(req.contextLength ?? 0);
        const fail = n++ < 2;
        return (async function* (): AsyncIterable<ChatChunk> {
          if (fail)
            throw new ModelGatewayError(
              "unreachable",
              "Ollama dropped the connection (ECONNRESET).",
              undefined,
              "ECONNRESET",
            );
          yield { type: "text", delta: "All good." };
          yield { type: "done", finishReason: "stop", usage: null };
        })();
      },
    };
    const res = await runAgentLoop({
      provider,
      model: "m",
      contextLength: 32_768,
      history: [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ],
      toolNames: [],
      ctx: { root: dir, bus, approvals, projectId: "prj_1", taskId: "tsk_1", agent: "coder" },
      maxSteps: 3,
      signal: new AbortController().signal,
      job: { projectId: "prj_1", taskId: "tsk_1", label: "t" },
      retryDelayMs: 1,
      emit: (e) => events.push(e.text),
      persist: () => {},
    });
    expect(res.finalText).toBe("All good.");
    expect(seen).toEqual([32_768, 32_768, 16_384]);
    expect(events.some((t) => t.includes("smaller context (16,384 tokens)"))).toBe(true);
  });

  test("a hung model process is unloaded before the retry, so Ollama starts a fresh one", async () => {
    const dir = temp("depo hung");
    const { bus, approvals } = busAndApprovals(dir);
    const { ModelGatewayError } = await import("@depo/model-gateway");
    const order: string[] = [];
    let n = 0;
    const provider: ModelProvider = {
      id: "fake",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      health: async () => ({ ok: true, version: "fake", message: null }),
      listModels: async () => [],
      embed: async () => [],
      unload: async (model) => {
        order.push(`unload ${model}`);
      },
      chat: () => {
        order.push("chat");
        const fail = n++ < 1;
        return (async function* (): AsyncIterable<ChatChunk> {
          if (fail)
            throw new ModelGatewayError(
              "http",
              'Ollama returned 500: {"error":"Post \\"http://127.0.0.1:50574/tokenize\\": dial tcp 127.0.0.1:50574: connectex: did not properly respond"}',
              500,
            );
          yield { type: "text", delta: "Back." };
          yield { type: "done", finishReason: "stop", usage: null };
        })();
      },
    };
    const res = await runAgentLoop({
      provider,
      model: "qwen2.5-coder:7b",
      contextLength: 8192,
      history: [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ],
      toolNames: [],
      ctx: { root: dir, bus, approvals, projectId: "prj_1", taskId: "tsk_1", agent: "coder" },
      maxSteps: 3,
      signal: new AbortController().signal,
      job: { projectId: "prj_1", taskId: "tsk_1", label: "t" },
      retryDelayMs: 1,
      emit: () => {},
      persist: () => {},
    });
    expect(res.finalText).toBe("Back.");
    expect(order).toEqual(["chat", "unload qwen2.5-coder:7b", "chat"]);
  });
});
