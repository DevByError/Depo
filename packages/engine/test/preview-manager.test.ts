import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { DepoEvent, RunRecipe } from "@depo/shared";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { PreviewManager } from "../src/preview/manager";
import { isListening } from "../src/preview/ports";
import { executeTool, type ToolContext } from "../src/tools/index";
import { tempDir, waitFor } from "./helpers";

/**
 * The preview manager with real processes: start, readiness, logs, restart, stop, failures, the
 * install approval, cleanup when a workspace or project goes away, and the agent tools.
 */

const SERVER = `const http = require("http");
const port = Number(process.env.PORT);
http
  .createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url, method: req.method, from: process.env.WHO || "project" }));
  })
  .listen(port, "127.0.0.1", () => console.log("listening on http://127.0.0.1:" + port));
`;

let dir = "";
let projectRoot = "";
let wsRoot = "";
let cleanup = () => {};
let closeDb = () => {};
let bus: EventBus;
let approvals: ApprovalCenter;
let events: DepoEvent[];
let manager: PreviewManager;

function writeApp(root: string) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo" }));
  fs.writeFileSync(path.join(root, "server.js"), SERVER);
}

beforeEach(() => {
  const t = tempDir("depo previews");
  cleanup = t.cleanup;
  dir = t.dir;
  projectRoot = path.join(dir, "my project");
  wsRoot = path.join(dir, "workspaces", "tsk_1", "tree");
  writeApp(projectRoot);
  writeApp(wsRoot);
  const logger = createLogger({ dir: path.join(dir, "logs"), level: "error", stderr: false });
  const db = openDatabase({ file: path.join(dir, "db", "t.db"), backupsDir: path.join(dir, "bk"), logger });
  closeDb = () => db.close();
  bus = new EventBus(db.db, logger);
  events = [];
  bus.subscribe((e) => events.push(e));
  approvals = new ApprovalCenter(bus);
  manager = new PreviewManager({
    bus,
    approvals,
    logger,
    projectRoot: (id) => (id === "prj_1" ? projectRoot : null),
    workspaceRoot: (id) => (id === "tsk_1" && fs.existsSync(wsRoot) ? wsRoot : null),
    taskProject: (id) => (id === "tsk_1" ? "prj_1" : null),
    tasks: () => [
      { id: "tsk_1", title: "Add a page", status: "review" },
      { id: "tsk_2", title: "Old task", status: "done" },
    ],
    override: () => "",
    commandRules: () => null,
    readyTimeoutMs: 15_000,
    pollMs: 100,
  });
});

afterEach(async () => {
  await manager.stopAll();
  closeDb();
  cleanup();
});

const custom = (command: string, extra: Partial<RunRecipe> = {}): RunRecipe => ({
  id: "custom",
  kind: "custom",
  label: "Test command",
  command,
  cwd: "",
  env: { PORT: "{port}" },
  port: 0,
  readyPath: "/",
  role: "app",
  missing: null,
  ...extra,
});

describe("preview manager", () => {
  test("starts the project, waits until it answers, keeps logs, restarts on the same port, stops the tree", async () => {
    expect(manager.targets("prj_1").map((t) => t.taskId)).toEqual([null, "tsk_1"]);
    const d = await manager.detect("prj_1");
    expect(d.recipes[d.suggested]?.command).toBe("node server.js");

    const { preview } = await manager.start({ projectId: "prj_1" });
    expect(preview.state).toBe("starting");
    expect(preview.target).toBe("project");
    const ready = await manager.settled(preview.id);
    expect(ready?.state).toBe("running");
    expect(ready?.url).toBe(`http://127.0.0.1:${preview.port}/`);
    const body = (await (await fetch(`${ready?.url}hello`)).json()) as { path: string };
    expect(body.path).toBe("/hello");

    const logs = manager.logs(preview.id);
    expect(logs.lines.some((l) => l.text.includes("listening on http://127.0.0.1"))).toBe(true);
    expect(logs.lines.some((l) => l.stream === "depo" && l.text === "$ node server.js")).toBe(true);
    expect(manager.logs(preview.id, logs.next).lines).toEqual([]);
    expect(events.some((e) => e.type === "preview_started" && e.status === "succeeded")).toBe(true);

    const restarted = await manager.restart(preview.id);
    expect(restarted.id).toBe(preview.id);
    expect(restarted.port).toBe(preview.port);
    expect((await manager.settled(preview.id))?.state).toBe("running");
    expect((await fetch(`${ready?.url}`)).status).toBe(200);

    expect(await manager.stop(preview.id)).toBe(true);
    expect(manager.get(preview.id)?.state).toBe("stopped");
    expect(await isListening(preview.port)).toBe(false);
    expect(events.some((e) => e.type === "preview_stopped" && e.status === "succeeded")).toBe(true);
  });

  test("a crash and a silent app fail with a clear message and the last log lines", async () => {
    const crash = await manager.start({
      projectId: "prj_1",
      recipe: custom(`node -e "console.error('boom'); process.exit(3)"`),
    });
    const failed = await manager.settled(crash.preview.id);
    expect(failed?.state).toBe("failed");
    expect(failed?.error).toContain("exit code 3");
    expect(manager.logs(crash.preview.id).lines.some((l) => l.stream === "err" && l.text === "boom")).toBe(
      true,
    );

    const quick = new PreviewManager({
      bus,
      approvals,
      logger: createLogger({ dir: path.join(dir, "logs"), level: "error", stderr: false }),
      projectRoot: () => projectRoot,
      workspaceRoot: () => null,
      taskProject: () => null,
      tasks: () => [],
      override: () => "",
      commandRules: () => null,
      readyTimeoutMs: 1200,
      pollMs: 100,
    });
    try {
      const silent = await quick.start({
        projectId: "prj_1",
        recipe: custom(`node -e "console.log('working'); setInterval(() => {}, 1000)"`),
      });
      const timedOut = await quick.settled(silent.preview.id);
      expect(timedOut?.state).toBe("failed");
      expect(timedOut?.error).toContain("did not answer");
      expect(quick.logs(silent.preview.id).lines.some((l) => l.text === "working")).toBe(true);
      expect(
        events.some(
          (e) => e.type === "preview_stopped" && e.status === "failed" && /did not answer/.test(e.text),
        ),
      ).toBe(true);
    } finally {
      await quick.stopAll();
    }
  });

  test("commands the policy refuses are never started", async () => {
    await expect(manager.start({ projectId: "prj_1", recipe: custom("format c:") })).rejects.toThrow(
      "not allowed",
    );
    await expect(
      manager.start({ projectId: "prj_1", recipe: custom("node server.js", { cwd: "../.." }) }),
    ).rejects.toThrow("not inside the project");
  });

  test("installing packages waits for the user's approval; declining fails the preview without installing", async () => {
    const recipe = custom("node server.js", {
      missing: { reason: "Packages are missing.", install: "npm install", cwd: "" },
    });
    const { preview } = await manager.start({ projectId: "prj_1", recipe, install: true });
    const pending = await waitFor(() => approvals.list().find((a) => a.details?.previewId === preview.id));
    expect(pending.title).toContain("npm install");
    expect(manager.get(preview.id)?.approvalId).toBe(pending.id);
    expect(manager.get(preview.id)?.phase).toContain("install");
    approvals.respond(pending.id, false);
    const done = await manager.settled(preview.id);
    expect(done?.state).toBe("failed");
    expect(done?.error).toContain("declined");
    expect(fs.existsSync(path.join(projectRoot, "node_modules"))).toBe(false);
  });

  test("a task's copy runs separately and stops when the copy or the project is removed", async () => {
    const ws = await manager.start({
      projectId: "prj_1",
      taskId: "tsk_1",
      recipe: custom("node server.js", { env: { PORT: "{port}", WHO: "copy" } }),
    });
    expect(ws.preview.target).toBe("workspace");
    expect((await manager.settled(ws.preview.id))?.state).toBe("running");
    const body = (await (await fetch(ws.preview.url)).json()) as { from: string };
    expect(body.from).toBe("copy");
    expect(manager.urlFor("tsk_1")).toBe(ws.preview.url);

    manager.stopRoot(path.dirname(wsRoot));
    await waitFor(() => (manager.get(ws.preview.id)?.state === "stopped" ? true : undefined));

    const proj = await manager.start({ projectId: "prj_1" });
    expect((await manager.settled(proj.preview.id))?.state).toBe("running");
    expect(await manager.stopProject("prj_1")).toBe(1);
    expect(manager.get(proj.preview.id)?.state).toBe("stopped");
    await expect(manager.start({ projectId: "prj_1", taskId: "tsk_9" })).rejects.toThrow("another project");
  });

  test("static sites run on the built-in server", async () => {
    fs.rmSync(path.join(projectRoot, "package.json"));
    fs.rmSync(path.join(projectRoot, "server.js"));
    fs.writeFileSync(path.join(projectRoot, "index.html"), "<h1>Static</h1>");
    const { preview } = await manager.start({ projectId: "prj_1" });
    expect(preview.kind).toBe("static");
    expect((await manager.settled(preview.id))?.state).toBe("running");
    expect(await (await fetch(preview.url)).text()).toBe("<h1>Static</h1>");
    expect(manager.logs(preview.id).lines.some((l) => l.text === "GET / 200")).toBe(true);
  });
});

describe("preview tools", () => {
  function agentCtx(): ToolContext {
    return {
      root: wsRoot,
      bus,
      approvals,
      projectId: "prj_1",
      taskId: "tsk_1",
      agent: "testing@1.0.0",
      previews: manager,
    };
  }

  test("start_preview asks once, http_check reaches the app by path and refuses other hosts, stop_preview stops it", async () => {
    let asked = 0;
    bus.subscribe((e) => {
      if (e.type === "waiting_for_user" && e.details?.preview === true) {
        asked++;
        setTimeout(() => approvals.respond(String(e.details?.approvalId), true), 0);
      }
    });
    const ctx = agentCtx();
    const started = await executeTool("start_preview", {}, ctx);
    expect(started.isError).toBe(false);
    expect(started.content).toContain("Running: http://127.0.0.1:");
    expect(started.content).toContain("listening on");
    expect(asked).toBe(1);

    const check = await executeTool("http_check", { url: "/items/1" }, ctx);
    expect(check.isError).toBe(false);
    expect(check.content).toContain("Status: 200");
    expect(check.content).toContain('"path":"/items/1"');
    const post = await executeTool(
      "http_check",
      { url: `${manager.urlFor("tsk_1")}items`, method: "POST", json: { a: 1 } },
      ctx,
    );
    expect(post.content).toContain('"method":"POST"');
    expect(events.some((e) => e.type === "testing" && /GET .*\/items\/1: 200/.test(e.text))).toBe(true);

    for (const url of ["http://example.com/", "http://10.1.2.3:8000/", "http://127.0.0.1.nip.io/"]) {
      const refused = await executeTool("http_check", { url }, ctx);
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("Refused");
    }

    const again = await executeTool("start_preview", {}, ctx);
    expect(again.content).toContain("Already running");
    expect(asked).toBe(1);

    const stopped = await executeTool("stop_preview", {}, ctx);
    expect(stopped.content).toBe("Stopped 1 preview.");
    const none = await executeTool("http_check", { url: "/" }, ctx);
    expect(none.isError).toBe(true);
  });

  test("start_preview reports missing packages and failures with logs; declined approval stops it", async () => {
    const ctx = agentCtx();
    fs.writeFileSync(
      path.join(wsRoot, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { express: "5" }, scripts: { start: "node server.js" } }),
    );
    const missing = await executeTool("start_preview", {}, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("npm install");

    bus.subscribe((e) => {
      if (e.type === "waiting_for_user" && e.details?.preview === true)
        setTimeout(() => approvals.respond(String(e.details?.approvalId), false), 0);
    });
    const declined = await executeTool("start_preview", { command: "node server.js" }, ctx);
    expect(declined.isError).toBe(true);
    expect(declined.content).toContain("declined");

    const noTask = await executeTool("start_preview", {}, { ...ctx, taskId: null });
    expect(noTask.isError).toBe(true);
    expect(noTask.content).toContain("only available");
  });
});
