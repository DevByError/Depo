import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ChatChunk } from "@depo/model-gateway";
import { type DepoEvent, newId, type PageCheck, type PreviewInfo } from "@depo/shared";
import { startFakeOllama } from "../../../scripts/fake-ollama-lib";
import { ApprovalCenter } from "../src/approvals";
import { CdpConnection, sessionFor } from "../src/design/cdp";
import { automatedFindings, HEURISTICS, scoreAudit } from "../src/design/ux";
import { createEngine, type Engine } from "../src/engine";
import { createLogger } from "../src/logger";
import { AutoPreview } from "../src/preview/auto";
import { QaService } from "../src/qa/service";
import {
  checkDir,
  listChecks,
  loadCheck,
  pruneChecks,
  QaPathError,
  resolveCheckImage,
  saveCheck,
} from "../src/qa/store";
import { executeTool, type ToolContext } from "../src/tools/index";
import "../src/tools/qa-tools";
import { startFakeCdp } from "./fake-cdp";
import { TEST_TOKEN, tempDir, waitFor } from "./helpers";

const stops: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const id = () => newId("qa");

function check(o: Partial<PageCheck> = {}): PageCheck {
  return {
    id: id(),
    projectId: "prj_1",
    taskId: "tsk_1",
    url: "http://127.0.0.1:3000/",
    by: "frontend@1.0.0",
    at: new Date().toISOString(),
    expectText: null,
    views: [],
    vision: null,
    summary: "ok",
    ok: true,
    durationMs: 10,
    ...o,
  };
}

/** A bus stand-in that records events. */
function bus() {
  const events: DepoEvent[] = [];
  return {
    events,
    emit(e: Omit<DepoEvent, "id" | "ts" | "seq">) {
      const ev = { ...e, id: "evt_x", ts: new Date().toISOString(), seq: events.length } as DepoEvent;
      events.push(ev);
      return ev;
    },
    subscribe() {
      return () => {};
    },
  };
}

describe("check store and screenshot paths", () => {
  test("only check images inside the root are served", () => {
    const t = tempDir("depo qa store");
    stops.push(t.cleanup);
    const root = path.join(t.dir, "tree");
    const cid = id();
    fs.mkdirSync(checkDir(root, cid), { recursive: true });
    fs.writeFileSync(path.join(checkDir(root, cid), "phone.png"), "png");
    fs.writeFileSync(path.join(checkDir(root, cid), "desktop-thumb.png"), "png");
    fs.writeFileSync(path.join(root, "secret.png"), "secret");
    const good = resolveCheckImage(root, `.depo/qa/${cid}/phone.png`);
    expect(fs.readFileSync(good, "utf8")).toBe("png");
    // Windows separators and a leading ./ are fine.
    expect(resolveCheckImage(root, `.\\.depo\\qa\\${cid}\\desktop-thumb.png`)).toBe(
      fs.realpathSync.native(path.join(checkDir(root, cid), "desktop-thumb.png")),
    );
    for (const bad of [
      "secret.png",
      `.depo/qa/${cid}/../../secret.png`,
      `.depo/qa/${cid}/check.json`,
      `.depo/qa/${cid}/evil.png`,
      `.depo/qa/qa_123/phone.png`,
      path.join(root, ".depo", "qa", cid, "phone.png"),
      `C:\\Windows\\${cid}\\phone.png`,
      `.depo/qa/${cid}/phone.png:stream`,
      `../.depo/qa/${cid}/phone.png`,
    ])
      expect(() => resolveCheckImage(root, bad)).toThrow(QaPathError);
    expect(() => resolveCheckImage(root, `.depo/qa/${cid}/tablet.png`)).toThrow(/no longer exists/);
  });

  test.skipIf(process.platform === "win32")("a link that points outside the root is refused", () => {
    const t = tempDir("depo qa store");
    stops.push(t.cleanup);
    const root = path.join(t.dir, "tree");
    const cid = id();
    fs.mkdirSync(checkDir(root, cid), { recursive: true });
    fs.writeFileSync(path.join(t.dir, "outside.png"), "secret");
    fs.symlinkSync(path.join(t.dir, "outside.png"), path.join(checkDir(root, cid), "phone.png"));
    expect(() => resolveCheckImage(root, `.depo/qa/${cid}/phone.png`)).toThrow(/outside/);
  });

  test("save, load, list newest first, prune old checks", async () => {
    const t = tempDir("depo qa store");
    stops.push(t.cleanup);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = check();
      ids.push(c.id);
      saveCheck(t.dir, c);
      await Bun.sleep(2);
    }
    expect(loadCheck(t.dir, ids[0] as string)?.id).toBe(ids[0] as string);
    expect(loadCheck(t.dir, id())).toBeNull();
    expect(listChecks(t.dir, 3).map((c) => c.id)).toEqual(ids.slice(2).reverse());
    pruneChecks(t.dir, 2);
    expect(listChecks(t.dir, 10).map((c) => c.id)).toEqual(ids.slice(3).reverse());
    expect(() => checkDir(t.dir, "../evil")).toThrow(QaPathError);
  });
});

describe("QaService", () => {
  function service(o: { previews?: PreviewInfo[]; vision?: string | null } = {}) {
    const t = tempDir("depo qa svc");
    stops.push(t.cleanup);
    const fake = startFakeCdp();
    stops.push(fake.stop);
    const ws = path.join(t.dir, "workspaces", "tsk_1", "tree");
    fs.mkdirSync(path.join(ws, "docs", "design"), { recursive: true });
    fs.writeFileSync(path.join(ws, "docs", "design", "preview.html"), "<h1>Style guide</h1>");
    const b = bus();
    const visionCalls: { prompt: string; images: number }[] = [];
    const svc = new QaService({
      bus: b as unknown as ConstructorParameters<typeof QaService>[0]["bus"],
      logger: createLogger({ dir: path.join(t.dir, "logs"), level: "error" }),
      dataDir: path.join(t.dir, "qa"),
      workspaceRoot: (taskId) => (taskId === "tsk_1" ? ws : null),
      taskProject: (taskId) => (taskId === "tsk_1" ? "prj_1" : "prj_other"),
      taskTitle: () => "Add a booking page",
      previews: { list: () => o.previews ?? [] },
      models: {
        resolve: (role) =>
          role === "vision" && o.vision !== undefined && o.vision !== null
            ? {
                model: "llava:7b",
                contextLength: 4096,
                provider: {
                  async *chat(req: { messages: { content: string; images?: string[] }[] }) {
                    visionCalls.push({
                      prompt: req.messages[0]?.content ?? "",
                      images: req.messages[0]?.images?.length ?? 0,
                    });
                    yield { type: "text", delta: o.vision as string } satisfies ChatChunk;
                    yield { type: "done", finishReason: "stop", usage: null } satisfies ChatChunk;
                  },
                } as unknown as NonNullable<ReturnType<Engine["models"]["resolve"]>>["provider"],
              }
            : null,
      },
      open: async () => sessionFor(await CdpConnection.connect(fake.url)),
    });
    return { svc, ws, fake, events: b.events, visionCalls, dataDir: path.join(t.dir, "qa") };
  }

  const running = (o: Partial<PreviewInfo>): PreviewInfo => ({
    id: newId("prv"),
    projectId: "prj_1",
    taskId: "tsk_1",
    target: "workspace",
    kind: "vite",
    label: "Vite app",
    role: "frontend",
    command: "npm run dev",
    cwd: "",
    port: 5173,
    url: "http://127.0.0.1:5173/",
    state: "running",
    phase: "Running",
    error: null,
    exitCode: null,
    startedBy: "frontend@1.0.0",
    groupId: null,
    approvalId: null,
    startedAt: new Date().toISOString(),
    readyAt: null,
    stoppedAt: null,
    ...o,
  });

  test("what to open: a path on the running frontend, a full local URL, nothing from the internet", () => {
    const { svc } = service({
      previews: [
        running({ role: "backend", url: "http://127.0.0.1:8000/", port: 8000 }),
        running({}),
        running({ taskId: null, url: "http://127.0.0.1:4000/" }),
      ],
    });
    expect(svc.resolveUrl("prj_1", "tsk_1", "/login")).toBe("http://127.0.0.1:5173/login");
    expect(svc.resolveUrl("prj_1", "tsk_1", "")).toBe("http://127.0.0.1:5173/");
    expect(svc.resolveUrl("prj_1", "tsk_1", "settings")).toBe("http://127.0.0.1:5173/settings");
    expect(svc.resolveUrl("prj_1", null, "/")).toBe("http://127.0.0.1:4000/");
    expect(svc.resolveUrl("prj_1", "tsk_1", "http://localhost:9999/x")).toBe("http://localhost:9999/x");
    expect(() => svc.resolveUrl("prj_1", "tsk_1", "https://example.com/")).toThrow(/not a local address/);
    expect(() => svc.resolveUrl("prj_1", "tsk_1", "file:///C:/Windows/win.ini")).toThrow(
      /not a local address/,
    );
    expect(() => service().svc.resolveUrl("prj_1", "tsk_1", "/")).toThrow(/Start it with start_preview/);
    expect(() => svc.root("prj_1", "tsk_2")).toThrow(/another project/);
  });

  test("a check is saved with its screenshots, announced, listed and served as data URLs", async () => {
    const { svc, ws, events } = service({ previews: [running({})] });
    const c = await svc.check({
      projectId: "prj_1",
      taskId: "tsk_1",
      url: "/",
      widths: ["desktop", "phone"],
      by: "user",
    });
    expect(c.views.map((v) => v.width)).toEqual(["phone", "desktop"]);
    expect(c.ok).toBe(false);
    expect(c.summary).toContain("Checked / at phone and desktop widths.");
    expect(fs.existsSync(path.join(ws, ".depo", "qa", c.id, "check.json"))).toBe(true);
    expect(svc.get("prj_1", "tsk_1", c.id).id).toBe(c.id);
    expect(svc.list("prj_1", "tsk_1").map((x) => x.id)).toEqual([c.id]);
    const shot = svc.screenshot("prj_1", "tsk_1", c.views[0]?.thumbnail ?? "");
    expect(shot.dataUrl.startsWith("data:image/png;base64,iVBOR")).toBe(true);
    expect(shot.bytes).toBeGreaterThan(10);
    expect(() => svc.screenshot("prj_1", "tsk_1", `.depo/qa/${c.id}/check.json`)).toThrow(QaPathError);
    expect(() => svc.get("prj_1", "tsk_1", "../../x")).toThrow(/not a page check id/);
    const shots = events.filter((e) => e.type === "rendering_screenshot");
    expect(shots.map((e) => e.status)).toEqual(["started", "failed"]);
    expect(shots[1]?.details).toMatchObject({
      checkId: c.id,
      url: "http://127.0.0.1:5173/",
      ok: false,
      consoleErrors: 3,
      failedRequests: 2,
      a11y: { critical: 1, serious: 1, moderate: 1, minor: 0 },
      thumbnails: {
        phone: `.depo/qa/${c.id}/phone-thumb.png`,
        desktop: `.depo/qa/${c.id}/desktop-thumb.png`,
      },
    });
    expect(shots[1]?.agent).toBe("user");
  });

  test("checks of the project folder live in Depo's own folder, never in the project", async () => {
    const { svc, dataDir } = service({ previews: [running({ taskId: null })] });
    const c = await svc.check({ projectId: "prj_1", taskId: null, widths: ["desktop"], by: "user" });
    expect(fs.existsSync(path.join(dataDir, "prj_1", ".depo", "qa", c.id, "desktop.png"))).toBe(true);
    expect(svc.list("prj_1", null)).toHaveLength(1);
  });

  test("the vision model looks at the desktop screenshot when one is set up, else it is skipped", async () => {
    const withVision = service({ previews: [running({})], vision: "The footer overlaps the form." });
    const c = await withVision.svc.check({
      projectId: "prj_1",
      taskId: "tsk_1",
      by: "frontend@1.0.0",
      review: true,
    });
    expect(c.vision).toBe("The footer overlaps the form.");
    expect(withVision.visionCalls).toHaveLength(1);
    expect(withVision.visionCalls[0]?.images).toBe(1);
    expect(withVision.visionCalls[0]?.prompt).toContain("Add a booking page");
    expect(withVision.visionCalls[0]?.prompt).toContain("1440px");
    const without = service({ previews: [running({})] });
    const d = await without.svc.check({
      projectId: "prj_1",
      taskId: "tsk_1",
      by: "frontend@1.0.0",
      review: true,
    });
    expect(d.vision).toBeNull();
  });

  test("a plain HTML file in the workspace is served for the check only", async () => {
    const { svc, fake } = service();
    await svc.check({
      projectId: "prj_1",
      taskId: "tsk_1",
      file: "docs/design/preview.html",
      widths: ["phone"],
      by: "ui-ux-design@1.0.0",
    });
    const nav = fake.received.find((r) => r.method === "Page.navigate");
    const url = String(nav?.params.url);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/docs\/design\/preview\.html$/);
    // The built-in server is gone after the check.
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    await expect(
      svc.check({ projectId: "prj_1", taskId: "tsk_1", file: "../outside.html", by: "x" }),
    ).rejects.toThrow(/leaves the project folder/);
    await expect(
      svc.check({ projectId: "prj_1", taskId: "tsk_1", file: "missing.html", by: "x" }),
    ).rejects.toThrow(/File not found/);
  });

  test("check_page through the tool registry: formatted for the model, refused without an app", async () => {
    const { svc, ws } = service({ previews: [running({})] });
    const ctx: ToolContext = {
      root: ws,
      bus: bus() as unknown as ToolContext["bus"],
      approvals: new ApprovalCenter(bus() as unknown as ConstructorParameters<typeof ApprovalCenter>[0]),
      projectId: "prj_1",
      taskId: "tsk_1",
      agent: "frontend@1.0.0",
      qa: svc,
    };
    const r = await executeTool(
      "check_page",
      {
        url: "/",
        widths: ["phone"],
        steps: [{ action: "click", selector: "#save" }],
        expect_text: "Saved",
        review: false,
      },
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^Page check qa_[0-9a-f]{28} of http:\/\/127\.0\.0\.1:5173\/, 1 width/);
    expect(r.content).toContain("Steps: all 1 worked at phone.");
    expect(r.content).toContain("critical image-alt x2");
    expect(svc.latestForAgent(ctx, 5)).toHaveLength(1);
    const bad = await executeTool("check_page", { url: "https://example.com" }, ctx);
    expect(bad).toMatchObject({ isError: true });
    expect(bad.content).toContain("not a local address");
    const noQa = await executeTool("check_page", {}, { ...ctx, qa: undefined });
    expect(noQa.content).toContain("only available while working on a project task");
    const badStep = await executeTool("check_page", { steps: [{ action: "hover", selector: "a" }] }, ctx);
    expect(badStep.content).toContain("Invalid arguments for check_page");
  });

  test("no browser on the PC: a clear message instead of a crash", async () => {
    const t = tempDir("depo qa svc");
    stops.push(t.cleanup);
    const svc = new QaService({
      bus: bus() as unknown as ConstructorParameters<typeof QaService>[0]["bus"],
      logger: createLogger({ dir: path.join(t.dir, "logs"), level: "error" }),
      dataDir: path.join(t.dir, "qa"),
      workspaceRoot: () => t.dir,
      taskProject: () => "prj_1",
      previews: { list: () => [] },
      hasBrowser: () => false,
    });
    await expect(svc.check({ projectId: "prj_1", taskId: null, by: "user" })).rejects.toThrow(/No browser/);
  });

  test("after close, no new check starts", async () => {
    const t = tempDir("depo qa svc");
    stops.push(t.cleanup);
    let opened = 0;
    const svc = new QaService({
      bus: bus() as unknown as ConstructorParameters<typeof QaService>[0]["bus"],
      logger: createLogger({ dir: path.join(t.dir, "logs"), level: "error" }),
      dataDir: path.join(t.dir, "qa"),
      workspaceRoot: () => t.dir,
      taskProject: () => "prj_1",
      previews: { list: () => [] },
      open: async () => {
        opened++;
        throw new Error("not used");
      },
    });
    await svc.close();
    await expect(
      svc.check({ projectId: "prj_1", taskId: null, by: "user", url: "http://127.0.0.1:9/" }),
    ).rejects.toThrow(/closing/);
    expect(opened).toBe(0);
  });
});

describe("AutoPreview at shutdown", () => {
  test("a start still detecting when the engine stops never starts the app", async () => {
    const t = tempDir("depo auto");
    stops.push(t.cleanup);
    let release: () => void = () => {};
    const detecting = new Promise<void>((r) => {
      release = r;
    });
    const starts: string[] = [];
    const auto = new AutoPreview({
      bus: bus() as unknown as ConstructorParameters<typeof AutoPreview>[0]["bus"],
      logger: createLogger({ dir: path.join(t.dir, "logs"), level: "error" }),
      enabled: () => true,
      changeSetStatus: () => null,
      previews: {
        detect: async () => {
          await detecting;
          return {
            target: "workspace",
            root: t.dir,
            recipes: [
              {
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
              },
            ],
            suggested: 0,
            override: "",
            notes: [],
          };
        },
        start: async (req) => {
          starts.push(req.taskId ?? "");
          throw new Error("must not start");
        },
        stop: async () => true,
        list: () => [],
        get: () => null,
      },
    });
    auto.attach();
    const pending = auto.onReview("prj_1", "tsk_1");
    const closed = auto.detach();
    release();
    await closed;
    expect(await pending).toEqual({ started: false, reason: "disabled" });
    expect(starts).toEqual([]);
    expect(await auto.onReview("prj_1", "tsk_2")).toEqual({ started: false, reason: "disabled" });
  });
});

describe("the UX audit hears what page checks found", () => {
  test("serious axe issues and console errors per page go into the audit", () => {
    const view = (
      counts: number,
      violations: { id: string; impact: "critical" | "serious" | "minor" }[],
    ) => ({
      width: "desktop" as const,
      viewport: { width: 1440, height: 900 },
      screenshot: null,
      thumbnail: null,
      loaded: true,
      status: 200,
      title: "",
      consoleErrors: [],
      consoleErrorCount: counts,
      failedRequests: [],
      failedRequestCount: 0,
      a11y: {
        ran: true,
        counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
        violations: violations.map((v) => ({
          ...v,
          help: `${v.id} help`,
          helpUrl: "",
          count: 2,
          targets: [],
        })),
        error: null,
      },
      expectFound: null,
      steps: [],
      error: null,
      durationMs: 1,
    });
    const newest = check({
      url: "http://127.0.0.1:5173/login",
      views: [
        view(2, [
          { id: "label", impact: "critical" },
          { id: "color-contrast", impact: "serious" },
        ]),
      ],
    });
    const older = check({
      url: "http://127.0.0.1:5173/login",
      views: [view(9, [{ id: "x", impact: "critical" }])],
    });
    const home = check({
      url: "http://127.0.0.1:5173/",
      views: [view(0, [{ id: "minor-thing", impact: "minor" }])],
    });
    const f = automatedFindings([newest, older, home]);
    expect(f).toMatchObject({ pages: 2, critical: 1, serious: 1, consoleErrors: 2 });
    expect(f.lines).toEqual([
      "/login: critical label (2 elements): label help",
      "/login: serious color-contrast (2 elements): color-contrast help",
      "/login: 2 console errors",
    ]);
    const audit = scoreAudit(
      {
        summary: "Fine overall.",
        scores: HEURISTICS.map((h) => ({ heuristic: h, score: 4, evidence: "seen", fix: "" })),
      },
      f,
    );
    expect(audit.markdown).toContain("## Automated page checks (axe-core, console)");
    expect(audit.markdown).toContain("- /login: critical label (2 elements): label help");
    expect(JSON.parse(audit.json).automated).toEqual({ pages: 2, critical: 1, serious: 1, consoleErrors: 2 });
    expect(audit.blocksRelease).toBe(false);
    const clean = scoreAudit(
      { summary: "x", scores: HEURISTICS.map((h) => ({ heuristic: h, score: 4, evidence: "e", fix: "" })) },
      automatedFindings([home]),
    );
    expect(clean.markdown).toContain(
      "1 page checked: no critical or serious accessibility issues and no console errors.",
    );
    expect(
      scoreAudit({
        summary: "x",
        scores: HEURISTICS.map((h) => ({ heuristic: h, score: 4, evidence: "e", fix: "" })),
      }).markdown,
    ).not.toContain("Automated");
  });
});

describe("with the scripted model", () => {
  async function setup(o: { autoStart?: boolean } = {}) {
    const t = tempDir("depo qa engine");
    stops.push(t.cleanup);
    const ollama = startFakeOllama();
    stops.push(ollama.stop);
    const cdp = startFakeCdp({ title: "Welcome" });
    stops.push(cdp.stop);
    const e = createEngine({
      dataRoot: path.join(t.dir, "data"),
      token: TEST_TOKEN,
      heartbeatMs: 60_000,
      tasks: { retryDelayMs: 10 },
      qa: { open: async () => sessionFor(await CdpConnection.connect(cdp.url)), hasBrowser: () => true },
    });
    stops.push(() => e.stop("test"));
    await e.start();
    e.settings.set("depomd.auto", false);
    e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: ollama.url, enabled: true }]);
    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
    e.settings.set("memory.auto", false);
    if (o.autoStart === false) e.settings.set("preview.auto_start", false);
    const proj = path.join(t.dir, "trip planner");
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "README.md"), "# Trip planner\n");
    const project = await e.projects.open(proj);
    const events: DepoEvent[] = [];
    e.bus.subscribe((ev) => events.push(ev));
    return { e, project, proj, events, cdp };
  }

  const autoPreview = (e: Engine, taskId: string) =>
    e.previews.list().find((p) => p.taskId === taskId && p.auto === true);

  test("a task ready for review starts its private copy; discarding the changes stops it", async () => {
    const { e, project, events } = await setup();
    const task = e.tasks.send(project.id, "make a landing page");
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("review");
    const p = await waitFor(() => {
      const x = autoPreview(e, task.id);
      return x?.state === "running" ? x : undefined;
    }, 10_000);
    expect(p.kind).toBe("static");
    expect(p.startedBy).toBe("engine");
    const page = await fetch(p.url);
    expect(await page.text()).toContain("<h1>Welcome</h1>");
    const started = events.find((ev) => ev.type === "preview_started" && ev.status === "succeeded");
    expect(started?.details?.auto).toBe(true);
    expect(started?.taskId).toBe(task.id);
    const cs = e.projects.listChangeSets(project.id)[0];
    e.projects.discardChangeSet(cs?.id ?? "");
    await waitFor(() => (e.previews.get(p.id)?.state === "stopped" ? true : undefined), 5000);
    expect(e.previews.get(p.id)?.phase).toBe("Stopped because the changes were discarded");
  }, 30_000);

  test("a pinned preview keeps running after the changes are applied", async () => {
    const { e, project } = await setup();
    const task = e.tasks.send(project.id, "make a landing page");
    await e.tasks.settled(task.id);
    const p = await waitFor(() => {
      const x = autoPreview(e, task.id);
      return x?.state === "running" ? x : undefined;
    }, 10_000);
    expect(e.previews.setPinned(p.id, true).pinned).toBe(true);
    const cs = e.projects.listChangeSets(project.id)[0];
    e.projects.applyChangeSet(cs?.id ?? "", e.projects.workspaceFor(cs?.id ?? ""));
    await Bun.sleep(300);
    expect(e.previews.get(p.id)?.state).toBe("running");
    expect(e.autoPreview.startedFor(task.id)).toEqual([p.id]);
    expect(e.previews.setPinned(p.id, false).pinned).toBeUndefined();
  }, 30_000);

  test("an unpinned preview stops when the changes are applied", async () => {
    const { e, project } = await setup();
    const task = e.tasks.send(project.id, "make a landing page");
    await e.tasks.settled(task.id);
    const p = await waitFor(() => {
      const x = autoPreview(e, task.id);
      return x?.state === "running" ? x : undefined;
    }, 10_000);
    const cs = e.projects.listChangeSets(project.id)[0];
    e.projects.applyChangeSet(cs?.id ?? "", e.projects.workspaceFor(cs?.id ?? ""));
    await waitFor(() => (e.previews.get(p.id)?.state === "stopped" ? true : undefined), 5000);
    expect(e.previews.get(p.id)?.phase).toBe("Stopped because the changes were applied");
  }, 30_000);

  test("auto start can be turned off", async () => {
    const { e, project } = await setup({ autoStart: false });
    const task = e.tasks.send(project.id, "make a landing page");
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("review");
    await Bun.sleep(400);
    expect(e.previews.list().filter((p) => p.taskId === task.id)).toEqual([]);
  }, 30_000);

  test("a recipe that still needs packages is not started by itself", async () => {
    const { e, project, proj } = await setup();
    fs.writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({ name: "trip", scripts: { dev: "vite" }, devDependencies: { vite: "7.0.0" } }),
    );
    const task = e.tasks.send(project.id, "make a landing page");
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("review");
    const r = await e.autoPreview.onReview(project.id, task.id);
    expect(r).toEqual({ started: false, reason: "needs_install" });
    expect(e.previews.list().filter((p) => p.taskId === task.id)).toEqual([]);
  }, 30_000);

  test("the agent starts the app and looks at it with check_page in the tool loop", async () => {
    const { e, project, cdp } = await setup();
    const task = e.tasks.send(project.id, "check the landing page");
    await e.tasks.settled(task.id);
    const { messages } = e.tasks.get(task.id);
    const tool = messages.find((m) => m.role === "tool" && m.toolName === "check_page");
    expect(tool?.isError).toBe(false);
    expect(tool?.text).toMatch(/^Page check qa_[0-9a-f]{28} of http:\/\/127\.0\.0\.1:\d+\/, 2 widths/);
    expect(tool?.text).toContain("text found");
    expect(tool?.args).toMatchObject({ url: "/", expect_text: "Welcome" });
    expect(cdp.received.some((r) => r.method === "Page.navigate")).toBe(true);
    const checks = e.qa.list(project.id, task.id);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.by).toBe("coder@1.0.0");
    // The agent stopped its own preview; the review then started one for the owner.
    await waitFor(() => (autoPreview(e, task.id)?.state === "running" ? true : undefined), 10_000);
    // The screenshots are in the task's copy but never in the change set.
    const cs = e.projects.listChangeSets(project.id).find((c) => c.taskId === task.id);
    expect(cs?.files.map((f) => f.path)).toEqual(["index.html"]);
  }, 30_000);
});
