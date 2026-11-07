import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ApiSchema, type DepoEvent, type RpcResponse } from "@depo/shared";
import { FAKE_COMMIT, startFakeOllama } from "../../../scripts/fake-ollama-lib";
import { tasks as tasksTable } from "../src/db/schema";
import { createEngine, type Engine } from "../src/engine";
import {
  branchSlug,
  cleanMessage,
  commitScope,
  commitType,
  messageFromDraft,
  summaryFrom,
  templateMessage,
} from "../src/git/message";
import { cUnquote, parseLog, parsePorcelain, parseUnifiedDiff } from "../src/git/repo";
import { TEST_TOKEN, tempDir } from "./helpers";

/**
 * Git commits for applied change sets, on real temporary repositories in folders with spaces and
 * non-ASCII names. Git's global and system config are switched off so the machine's own
 * identity cannot leak in.
 */

const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
let globalCfg = { dir: "", cleanup: () => {} };
beforeAll(() => {
  globalCfg = tempDir("depo git cfg");
  const file = path.join(globalCfg.dir, "gitconfig");
  fs.writeFileSync(file, "");
  process.env.GIT_CONFIG_GLOBAL = file;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved.global;
  if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
  globalCfg.cleanup();
});

let engine: Engine | null = null;
let cleanup = () => {};
let stopFake = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  stopFake();
  stopFake = () => {};
  cleanup();
  cleanup = () => {};
});

function g(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "core.quotepath=off", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);

async function setup(opts: { identity?: boolean } = {}) {
  const t = tempDir("depo git");
  cleanup = t.cleanup;
  const root = path.join(t.dir, "my app");
  fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
  fs.writeFileSync(path.join(root, "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(root, "c.txt"), "charlie\n");
  fs.writeFileSync(path.join(root, "other.txt"), "other\n");
  fs.writeFileSync(path.join(root, "other2.txt"), "other two\n");
  fs.writeFileSync(path.join(root, "src", "api", "routes.py"), "def index():\n    return 'hi'\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "secret.env\n");
  g(root, "init", "-q", "-b", "main");
  if (opts.identity !== false) {
    g(root, "config", "user.name", "Test Owner");
    g(root, "config", "user.email", "owner@example.com");
  }
  g(root, "add", ".");
  g(root, "-c", "user.name=Init", "-c", "user.email=init@example.com", "commit", "-q", "-m", "init");
  const e = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
  engine = e;
  const project = await e.projects.open(root);
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  return { e, t, root, project, events };
}

let wsCount = 0;
/** What an agent would do in its private copy, then the owner applies it. */
function applyChange(
  e: Engine,
  projectId: string,
  root: string,
  edit: (ws: string) => void,
  o: { title?: string; taskId?: string } = {},
): string {
  const ws = e.projects.createWorkspace(root, `ws-${++wsCount}`);
  edit(ws.root);
  const cs = e.projects.collectChanges(projectId, o.taskId ?? null, ws, o.title ?? "Depo changes");
  if (!cs) throw new Error("no changes");
  e.projects.applyChangeSet(cs.id, ws);
  return cs.id;
}

describe("commit messages", () => {
  test("type, scope and summary come from the files, the mode and the request", () => {
    const f = (p: string) => ({ path: p, kind: "modified" as const, additions: 1, deletions: 0 });
    expect(commitType({ files: [f("tests/test_a.py")], mode: null, request: "", title: "" })).toBe("test");
    expect(commitType({ files: [f("README.md"), f("docs/x.md")], mode: null, request: "", title: "" })).toBe(
      "docs",
    );
    expect(commitType({ files: [f("app/a.py")], mode: "fix", request: "", title: "" })).toBe("fix");
    expect(
      commitType({ files: [f("app/a.py")], mode: null, request: "The login is broken", title: "" }),
    ).toBe("fix");
    expect(commitType({ files: [f("app/a.py")], mode: null, request: "Add a health page", title: "" })).toBe(
      "feat",
    );
    expect(commitType({ files: [f("package.json")], mode: null, request: "bump", title: "" })).toBe("build");
    expect(commitScope(["src/api/a.py", "src/api/b.py", "tests/test_a.py"])).toBe("api");
    expect(commitScope(["a.py", "b.py"])).toBeNull();
    expect(summaryFrom("Please add a /health endpoint that returns ok. Also tests.", 60)).toBe(
      "add a /health endpoint that returns ok",
    );
    expect(summaryFrom("Could you make FastAPI answer faster", 60)).toBe("make FastAPI answer faster");
    expect(summaryFrom("API keys must be hidden", 60)).toBe("API keys must be hidden");
    expect(
      summaryFrom("add a very long summary that keeps going and going past the limit", 30).length,
    ).toBeLessThanOrEqual(30);
    expect(branchSlug("Add a /health endpoint, please! Café Ünïcode")).toBe(
      "add-health-endpoint-cafe-unicode",
    );
    expect(branchSlug("!!!")).toBe("changes");
  });

  test("the template lists what changed and why; a model draft is cleaned and checked", () => {
    const input = {
      title: "Add a health check endpoint",
      request: "Add a health check endpoint at /health that returns ok.",
      finalAnswer: "Added `GET /health` in `src/api/routes.py`. All tests pass (2 passed).",
      mode: "single",
      files: [
        { path: "src/api/routes.py", kind: "modified" as const, additions: 4, deletions: 0 },
        { path: "src/api/test_routes.py", kind: "added" as const, additions: 9, deletions: 0 },
      ],
    };
    const msg = templateMessage(input);
    const [head, ...rest] = msg.split("\n");
    expect(head).toBe("feat(api): add a health check endpoint");
    expect((head ?? "").length).toBeLessThanOrEqual(72);
    expect(rest[0]).toBe("");
    expect(msg).toContain("- src/api/routes.py: changed (+4)");
    expect(msg).toContain("- src/api/test_routes.py: new file (+9)");
    expect(msg).toContain("Notes: Added GET /health in src/api/routes.py.");
    const fromModel = messageFromDraft(
      {
        type: "fix",
        scope: "Bad Scope!",
        summary: "Repair the thing.\u0007",
        body: "- one\r\n\n\n\n- two\u0000",
      },
      input,
    );
    expect(fromModel.split("\n")[0]).toBe("fix: repair the thing");
    expect(fromModel).toContain("- one\n\n- two");
    expect(cleanMessage("a  \r\nb\u001b[31m\n\n\n\nc")).toBe("a\nb[31m\n\nc");
  });
});

describe("git parsing", () => {
  test("porcelain status: branch, detached, unborn, renames", () => {
    expect(parsePorcelain("## main...origin/main [ahead 1]\0 M a.txt\0?? new dir/x y.txt\0")).toEqual({
      branch: "main",
      detached: false,
      unborn: false,
      entries: [
        { code: " M", path: "a.txt", origPath: null },
        { code: "??", path: "new dir/x y.txt", origPath: null },
      ],
    });
    expect(parsePorcelain("## No commits yet on trunk\0A  a\0")).toMatchObject({
      branch: "trunk",
      unborn: true,
    });
    expect(parsePorcelain("## HEAD (no branch)\0")).toMatchObject({ branch: null, detached: true });
    expect(parsePorcelain("## main\0R  new.txt\0old.txt\0").entries).toEqual([
      { code: "R ", path: "new.txt", origPath: "old.txt" },
    ]);
  });

  test("unified diffs with spaces, quoted names, renames and binaries", () => {
    const diff = [
      "diff --git a/sp ace.txt b/sp ace.txt",
      "new file mode 100644",
      "index 0000000..b478595",
      "--- /dev/null",
      "+++ b/sp ace.txt\t",
      "@@ -0,0 +1 @@",
      "+s",
      'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
      "deleted file mode 100644",
      '--- "a/tab\\there.txt"',
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-t",
      "-u",
      "diff --git a/old name.txt b/new name.txt",
      "similarity index 90%",
      "rename from old name.txt",
      "rename to new name.txt",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.path, f.kind, f.additions, f.deletions, f.binary])).toEqual([
      ["sp ace.txt", "added", 1, 0, false],
      ["tab\there.txt", "deleted", 0, 2, false],
      ["new name.txt", "renamed", 0, 0, false],
      ["logo.png", "modified", 0, 0, true],
    ]);
    expect(files[2]?.oldPath).toBe("old name.txt");
    expect(files[0]?.hunks[0]).toEqual({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+s"] });
    expect(cUnquote('"caf\\303\\251 \\"x\\""')).toBe('café "x"');
    const capped = parseUnifiedDiff(diff, { perFile: 1, total: 10, files: 10 });
    expect(capped[1]?.truncated).toBe(true);
    expect(
      parseLog(
        "\x1eabc1234def\x1fabc1234\x1fA\x1fa@x\x1f2026-01-01T00:00:00Z\x1fsubj\x1fbody\x1d\n\n1\t2\tx\n-\t-\tbin\n",
      ),
    ).toEqual([
      {
        hash: "abc1234def",
        shortHash: "abc1234",
        author: "A",
        email: "a@x",
        date: "2026-01-01T00:00:00Z",
        subject: "subj",
        body: "body",
        files: 2,
        additions: 1,
        deletions: 2,
      },
    ]);
  });
});

describe("git commits for applied changes", () => {
  test("commits only the applied files, keeps the owner's other changes, and never pushes", async () => {
    const { e, t, root, project, events } = await setup();
    const remote = path.join(t.dir, "remote repo.git");
    g(t.dir, "init", "-q", "--bare", remote);
    g(root, "remote", "add", "origin", remote);
    g(root, "push", "-q", "origin", "main");
    const remoteHead = g(remote, "rev-parse", "main").trim();

    // The owner's own work in progress: staged, unstaged and new.
    fs.writeFileSync(path.join(root, "other.txt"), "other, staged by the owner\n");
    g(root, "add", "other.txt");
    fs.writeFileSync(path.join(root, "other2.txt"), "other two, not staged\n");
    fs.writeFileSync(path.join(root, "owner notes.txt"), "mine\n");

    const changeSetId = applyChange(e, project.id, root, (ws) => {
      fs.writeFileSync(path.join(ws, "a.txt"), "alpha, changed by Depo\n");
      fs.mkdirSync(path.join(ws, "new dir"), { recursive: true });
      fs.writeFileSync(path.join(ws, "new dir", "n ü.txt"), "new\n");
      fs.rmSync(path.join(ws, "c.txt"));
    });

    const status = await e.git.status(project.id);
    expect(status).toMatchObject({ isRepo: true, branch: "main", detached: false, unborn: false });
    expect(status.identity).toEqual({ name: "Test Owner", email: "owner@example.com" });
    expect(status.changes).toBeGreaterThanOrEqual(5);

    const draft = await e.git.draft(project.id, changeSetId, false);
    expect(draft.source).toBe("template");
    expect(draft.files.map((f) => [f.path, f.include])).toEqual([
      ["a.txt", true],
      ["c.txt", true],
      ["new dir/n ü.txt", true],
    ]);
    expect(draft.suggestedBranch).toBe("depo/depo-changes");
    expect(draft.branch).toBe("main");
    expect(draft.committed).toBeNull();
    expect(draft.message).toMatch(/^(feat|chore)/);

    const message = "feat: apply Depo's changes\n\nAsked for: a test.\n- three files";
    const res = await e.git.commit({ projectId: project.id, changeSetId, message });
    expect(res).toMatchObject({ branch: "main", createdBranch: false, skipped: [] });
    expect(res.files.sort()).toEqual(["a.txt", "c.txt", "new dir/n ü.txt"]);
    expect(res.shortHash.length).toBeGreaterThanOrEqual(7);
    expect(lines(g(root, "show", "--name-only", "--format=", "HEAD")).sort()).toEqual([
      "a.txt",
      "c.txt",
      "new dir/n ü.txt",
    ]);
    expect(g(root, "log", "-1", "--format=%B").trim()).toBe(message);
    expect(g(root, "log", "-1", "--format=%an <%ae>").trim()).toBe("Test Owner <owner@example.com>");
    // The owner's changes are exactly as they were.
    const after = lines(g(root, "status", "--porcelain=v1"));
    expect(after).toContain("M  other.txt");
    expect(after).toContain(" M other2.txt");
    expect(after).toContain(`?? "owner notes.txt"`);
    expect(after).toHaveLength(3);
    // No push, ever, and no helper files left in .git.
    expect(g(remote, "rev-parse", "main").trim()).toBe(remoteHead);
    expect(fs.readdirSync(path.join(root, ".git")).filter((f) => f.startsWith("DEPO_"))).toEqual([]);

    const ev = events.find((x) => x.type === "committed");
    expect(ev?.details).toMatchObject({ changeSetId, hash: res.hash, branch: "main", createdBranch: false });
    expect(ev?.text).toContain(`(${res.shortHash})`);

    // Committed: the draft says so and nothing is left to commit.
    const again = await e.git.draft(project.id, changeSetId, false);
    expect(again.committed).toEqual({ hash: res.hash, shortHash: res.shortHash, branch: "main" });
    expect(again.files.every((f) => !f.include)).toBe(true);
    await expect(e.git.commit({ projectId: project.id, changeSetId, message })).rejects.toThrow(
      "Nothing to commit",
    );

    // History.
    const log = await e.git.log(project.id, 10);
    expect(log.commits[0]).toMatchObject({ hash: res.hash, subject: "feat: apply Depo's changes", files: 3 });
    expect(log.commits[1]?.subject).toBe("init");
    const shown = await e.git.show(project.id, res.shortHash);
    expect(shown.commit.hash).toBe(res.hash);
    expect(shown.files.find((f) => f.path === "new dir/n ü.txt")).toMatchObject({
      kind: "added",
      additions: 1,
    });
    expect(shown.files.find((f) => f.path === "c.txt")?.kind).toBe("deleted");
    expect(shown.files.find((f) => f.path === "a.txt")?.hunks[0]?.lines).toEqual([
      "-alpha",
      "+alpha, changed by Depo",
    ]);
  });

  test("creates a depo branch first when asked, and refuses one that exists", async () => {
    const { e, root, project } = await setup();
    const mainHead = g(root, "rev-parse", "main").trim();
    const first = applyChange(
      e,
      project.id,
      root,
      (ws) => fs.writeFileSync(path.join(ws, "a.txt"), "one\n"),
      {
        title: "Add a health check",
      },
    );
    const draft = await e.git.draft(project.id, first, false);
    expect(draft.suggestedBranch).toBe("depo/add-health-check");
    const res = await e.git.commit({
      projectId: project.id,
      changeSetId: first,
      message: "feat: one",
      branch: draft.suggestedBranch,
    });
    expect(res).toMatchObject({ branch: "depo/add-health-check", createdBranch: true });
    expect(g(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("depo/add-health-check");
    expect(g(root, "rev-parse", "main").trim()).toBe(mainHead);
    expect(g(root, "rev-parse", "HEAD~1").trim()).toBe(mainHead);

    const second = applyChange(
      e,
      project.id,
      root,
      (ws) => fs.writeFileSync(path.join(ws, "a.txt"), "two\n"),
      {
        title: "Add a health check",
      },
    );
    // The suggestion skips the taken name.
    expect((await e.git.draft(project.id, second, false)).suggestedBranch).toBe("depo/add-health-check-2");
    await expect(
      e.git.commit({
        projectId: project.id,
        changeSetId: second,
        message: "feat: two",
        branch: "depo/add-health-check",
      }),
    ).rejects.toThrow("already exists");
    expect(lines(g(root, "diff", "--cached", "--name-only"))).toEqual([]);
    const params = ApiSchema["git.commit"].params;
    expect(
      params.safeParse({ projectId: "p", changeSetId: "c", message: "m", branch: "bad name" }).success,
    ).toBe(false);
    expect(params.safeParse({ projectId: "p", changeSetId: "c", message: "m", branch: "-x" }).success).toBe(
      false,
    );
  });

  test("a missing name and email is reported and can be set for this repository only", async () => {
    const { e, root, project } = await setup({ identity: false });
    const changeSetId = applyChange(e, project.id, root, (ws) =>
      fs.writeFileSync(path.join(ws, "a.txt"), "x\n"),
    );
    expect((await e.git.status(project.id)).identity).toBeNull();
    expect((await e.git.draft(project.id, changeSetId, false)).identity).toBeNull();
    await expect(e.git.commit({ projectId: project.id, changeSetId, message: "feat: x" })).rejects.toThrow(
      "Git does not know who you are yet",
    );
    await expect(e.git.setIdentity(project.id, "Owner", "not-an-email")).rejects.toThrow("email");
    await expect(e.git.setIdentity(project.id, 'Bad "quote"', "a@b.c")).rejects.toThrow("name");
    const set = await e.git.setIdentity(project.id, "Ünï Owner", "uni@example.com");
    expect(set.identity).toEqual({ name: "Ünï Owner", email: "uni@example.com" });
    expect(g(root, "config", "--local", "user.name").trim()).toBe("Ünï Owner");
    expect(fs.readFileSync(process.env.GIT_CONFIG_GLOBAL as string, "utf8")).toBe("");
    await e.git.commit({ projectId: project.id, changeSetId, message: "feat: x" });
    expect(g(root, "log", "-1", "--format=%an <%ae>").trim()).toBe("Ünï Owner <uni@example.com>");
  });

  test("files changed after the apply and ignored files are left out unless chosen", async () => {
    const { e, root, project } = await setup();
    const changeSetId = applyChange(e, project.id, root, (ws) => {
      fs.writeFileSync(path.join(ws, "a.txt"), "applied\n");
      fs.writeFileSync(path.join(ws, "b.txt"), "applied b\n");
      fs.writeFileSync(path.join(ws, "secret.env"), "TOKEN=1\n");
      fs.writeFileSync(path.join(ws, "a[1].txt"), "a file name that looks like a glob\n");
    });
    fs.writeFileSync(path.join(root, "b.txt"), "applied b, then edited by the owner\n");
    // The owner's own new file, which the glob a[1].txt would match.
    fs.writeFileSync(path.join(root, "a1.txt"), "mine\n");
    const draft = await e.git.draft(project.id, changeSetId, false);
    const byPath = Object.fromEntries(draft.files.map((f) => [f.path, f]));
    expect(byPath["a.txt"]).toMatchObject({ include: true, note: null });
    expect(byPath["b.txt"]?.include).toBe(false);
    expect(byPath["b.txt"]?.note).toContain("You changed this file after applying it");
    expect(byPath["secret.env"]?.include).toBe(false);
    expect(byPath["secret.env"]?.note).toContain("ignores");

    const res = await e.git.commit({ projectId: project.id, changeSetId, message: "fix: a" });
    expect(res.files).toEqual(["a.txt", "a[1].txt"]);
    expect(lines(g(root, "status", "--porcelain=v1", "a1.txt"))).toEqual(["?? a1.txt"]);
    expect(res.skipped.map((s) => s.path).sort()).toEqual(["b.txt", "secret.env"]);
    await expect(
      e.git.commit({ projectId: project.id, changeSetId, message: "x", files: ["nope.txt"] }),
    ).rejects.toThrow("Not one of the applied files");
    const withB = await e.git.commit({
      projectId: project.id,
      changeSetId,
      message: "feat: b",
      files: ["b.txt"],
    });
    expect(withB.files).toEqual(["b.txt"]);
    expect(g(root, "show", "HEAD:b.txt")).toBe("applied b, then edited by the owner\n");
  });

  test("a project rule that blocks git commit wins over the click, and the staging is undone", async () => {
    const { e, root, project } = await setup();
    e.registry.setSettings(project.id, { commandDeny: ["git commit"] });
    const changeSetId = applyChange(e, project.id, root, (ws) => {
      fs.writeFileSync(path.join(ws, "a.txt"), "x\n");
      fs.writeFileSync(path.join(ws, "fresh.txt"), "new\n");
    });
    await expect(e.git.commit({ projectId: project.id, changeSetId, message: "feat: x" })).rejects.toThrow(
      "will not run",
    );
    expect(lines(g(root, "diff", "--cached", "--name-only"))).toEqual([]);
    expect(g(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  test("a local model drafts the message in the background; without one the template is used", async () => {
    const { e, root, project } = await setup();
    const now = new Date().toISOString();
    e.database.db
      .insert(tasksTable)
      .values({
        id: "tsk_git1",
        projectId: project.id,
        title: "Please add a health check endpoint.",
        prompt: "Please add a health check endpoint.",
        status: "review",
        summary: "Added GET /health. Tests pass.",
        mode: "single",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const changeSetId = applyChange(
      e,
      project.id,
      root,
      (ws) => fs.writeFileSync(path.join(ws, "src", "api", "routes.py"), "def health():\n    return 'ok'\n"),
      { taskId: "tsk_git1", title: "Add a health check endpoint" },
    );
    const noModel = await e.git.draft(project.id, changeSetId, true);
    expect(noModel.source).toBe("template");
    expect(noModel.note).toContain("simple draft");
    expect(noModel.message.split("\n")[0]).toBe("feat(api): add a health check endpoint");
    expect(noModel.suggestedBranch).toBe("depo/add-health-check-endpoint");

    const fake = startFakeOllama();
    stopFake = fake.stop;
    e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: fake.url, enabled: true }]);
    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
    // The model call waits behind task work: background priority in the shared scheduler.
    const requests: { priority: string; label: string }[] = [];
    const run = e.scheduler.run.bind(e.scheduler);
    e.scheduler.run = ((req, fn, signal) => {
      requests.push({ priority: req.priority, label: req.label });
      return run(req, fn, signal);
    }) as typeof e.scheduler.run;
    const drafted = await e.git.draft(project.id, changeSetId, true);
    expect(requests).toEqual([{ priority: "background", label: "Git: commit message" }]);
    expect(drafted.source).toBe("model");
    expect(drafted.note).toBeNull();
    expect(drafted.message.split("\n")[0]).toBe(`feat(api): ${FAKE_COMMIT.summary}`);
    expect(drafted.message).toContain("- add GET /health that answers ok");
    expect(drafted.message).toContain("- src/api/routes.py: changed");
  });

  test("status, log, draft and commit answer with what their schemas promise over the WebSocket", async () => {
    const { e, t, root, project } = await setup();
    const plain = path.join(t.dir, "plain folder");
    fs.mkdirSync(plain);
    const notRepo = await e.projects.open(plain);
    const changeSetId = applyChange(e, project.id, root, (ws) =>
      fs.writeFileSync(path.join(ws, "a.txt"), "w\n"),
    );
    const { port } = await e.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${TEST_TOKEN}`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let n = 0;
    const call = (method: string, params: unknown) =>
      new Promise<RpcResponse>((resolve) => {
        const id = ++n;
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
    const ok = async <M extends keyof typeof ApiSchema>(method: M, params: unknown) => {
      const res = await call(method, params);
      if ("error" in res) throw new Error(`${method}: ${res.error.message}`);
      return ApiSchema[method].result.parse(res.result);
    };
    expect(await ok("git.status", { projectId: notRepo.id })).toMatchObject({ isRepo: false, branch: null });
    expect((await ok("git.log", { projectId: notRepo.id })).commits).toEqual([]);
    const st = await ok("git.status", { projectId: project.id });
    expect(st).toMatchObject({ isRepo: true, branch: "main", changes: 1 });
    const draft = await ok("git.draftCommit", { projectId: project.id, changeSetId, model: false });
    expect(draft.files).toHaveLength(1);
    const done = await ok("git.commit", { projectId: project.id, changeSetId, message: draft.message });
    const log = await ok("git.log", { projectId: project.id, limit: 5 });
    expect(log.commits[0]?.hash).toBe(done.hash);
    const shown = await ok("git.show", { projectId: project.id, hash: done.hash });
    expect(shown.files[0]?.path).toBe("a.txt");
    const bad = await call("git.show", { projectId: project.id, hash: "HEAD; rm -rf /" });
    expect("error" in bad).toBe(true);
    ws.close();
  });
});
