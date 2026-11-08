import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  ModelGatewayError,
  type ModelProvider,
} from "@depo/model-gateway";
import { codeBlocks, dumpInProgress, filesFromDump, isCodeDump } from "../src/agent/codedump";
import { BROKEN_STUB, type LoopParams, runAgentLoop } from "../src/agent/loop";
import {
  fixBadEscapes,
  inventsToolResult,
  parseTextToolCalls,
  textCallProblem,
  unknownToolCalls,
  withoutStrayResultTag,
} from "../src/agent/textcalls";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { tempDir } from "./helpers";

const TOOLS = ["read_file", "write_file", "edit_file", "run_command"];

/** A plausible route file, `n` handlers long. */
function routes(n: number): string {
  const out = ['import { Hono } from "hono";', "", "export const app = new Hono();", ""];
  for (let i = 0; i < n; i++)
    out.push(
      `app.get("/api/skills/${i}", async (c) => {`,
      `  const rows = await db.query("SELECT * FROM skills WHERE id = ?", [${i}]);`,
      "  return c.json(rows);",
      "});",
      "",
    );
  return out.join("\n");
}

describe("code pasted into a reply", () => {
  test("code blocks are found, also one still being written", () => {
    const text = "Intro\n```ts be/a.ts\nconst a = 1;\n```\nThen\n```py\nprint(1)\n";
    const blocks = codeBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ info: "ts be/a.ts", body: "const a = 1;\n", closed: true });
    expect(blocks[1]).toMatchObject({ info: "py", closed: false });
  });

  test("a long reply with a big code block and no tool call is a dump; commands and tool calls are not", () => {
    const dump = `Here is the updated app.ts:\n\n\`\`\`typescript\n${routes(30)}`;
    expect(dump.length).toBeGreaterThan(3000);
    expect(dumpInProgress(dump, TOOLS)).toBe(true);
    expect(dumpInProgress(dump.slice(0, 2000), TOOLS)).toBe(false);
    const shell = `Run these:\n\`\`\`bash\n${"bun install\n".repeat(300)}`;
    expect(dumpInProgress(shell, TOOLS)).toBe(false);
    const call = `{"name": "write_file", "arguments": {"path": "be/a.ts", "content": "\`\`\`ts\n${routes(30)}`;
    expect(dumpInProgress(call, TOOLS)).toBe(false);
    expect(isCodeDump(`Done:\n\`\`\`ts\n${routes(2)}\n\`\`\`\n`)).toBe(true);
    expect(isCodeDump("Done. Run `bun dev` to start it.")).toBe(false);
    expect(
      isCodeDump(
        "Run:\n```bash\ncd be\nbun install\nbun run db:migrate\nbun run db:seed\nbun dev\ncd ../fe\nbun install\nbun dev\n```",
      ),
    ).toBe(false);
  });

  test("complete files named by a path are taken; partial ones and unsafe paths are not", () => {
    const t = tempDir("depo dump");
    try {
      fs.mkdirSync(path.join(t.dir, "be", "src"), { recursive: true });
      fs.writeFileSync(path.join(t.dir, "be", "src", "app.ts"), routes(20));
      const text = [
        "I'll create the scanner and update the store.",
        "",
        "**be/src/github/scanner.ts**",
        "```ts",
        routes(2),
        "```",
        "",
        '```ts title="be/src/github/client.ts"',
        routes(1),
        "```",
        "",
        "```sql",
        "-- be/src/db/schema.sql",
        "CREATE TABLE IF NOT EXISTS skills (",
        "  id INT PRIMARY KEY,",
        "  name VARCHAR(100)",
        ");",
        "```",
        "",
        "Now `be/src/db/store.ts`:",
        "```ts",
        "export function store() {",
        "  // ... existing code",
        "  return 1;",
        "}",
        "```",
        "",
        "And be/src/app.ts (only the new route):",
        "```ts",
        routes(1),
        "```",
        "",
        "`../outside.ts`",
        "```ts",
        routes(1),
        "```",
        "",
        "```bash",
        "# be/run.sh",
        "bun install",
        "bun dev",
        "```",
      ].join("\n");
      const { files, existing } = filesFromDump(text, t.dir);
      // The partial app.ts is not saved over the real one; the model is told to edit it instead.
      expect(existing).toEqual(["be/src/app.ts"]);
      expect(files.map((f) => f.path)).toEqual([
        "be/src/github/scanner.ts",
        "be/src/github/client.ts",
        "be/src/db/schema.sql",
      ]);
      expect(files[2]?.content.startsWith("CREATE TABLE")).toBe(true);
      expect(files[0]?.content.endsWith("\n")).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("new tables pasted for an existing schema are not saved over it (seen on the owner's PC)", () => {
    const t = tempDir("depo dump schema");
    try {
      fs.mkdirSync(path.join(t.dir, "be", "src", "db"), { recursive: true });
      fs.writeFileSync(
        path.join(t.dir, "be", "src", "db", "schema.sql"),
        "CREATE TABLE IF NOT EXISTS users (\n  id INT PRIMARY KEY\n);\n",
      );
      const text = [
        "### Step 1: Update `schema.sql`",
        "",
        "```sql",
        "-- be/src/db/schema.sql",
        "CREATE TABLE IF NOT EXISTS scans (",
        "  id INT AUTO_INCREMENT PRIMARY KEY,",
        "  status ENUM('running', 'done', 'failed') NOT NULL",
        ") ENGINE=InnoDB;",
        "```",
      ].join("\n");
      expect(filesFromDump(text, t.dir)).toEqual({ files: [], existing: ["be/src/db/schema.sql"] });
    } finally {
      t.cleanup();
    }
  });

  test("the bare <tool_response> a 7b model puts before its sentences is dropped", () => {
    // Replies seen on the owner's PC (qwen2.5-coder:7b).
    expect(withoutStrayResultTag("<tool_response>\nNo changes to be made.")).toBe("No changes to be made.");
    expect(
      withoutStrayResultTag("<tool_response>\nI apologize for that oversight. I'll read the relevant files."),
    ).toBe("I apologize for that oversight. I'll read the relevant files.");
    expect(withoutStrayResultTag("<tool_response>\nLet's start by reading `be/src/app.ts`.")).toBe(
      "Let's start by reading `be/src/app.ts`.",
    );
    // A made-up result stays a made-up result.
    const made = '<tool_response>\n{"ok": true, "path": "be/a.ts"}\n</tool_response>\nDone.';
    expect(withoutStrayResultTag(made)).toBe(made);
    expect(inventsToolResult(withoutStrayResultTag("<tool_response>\nApplied 2 edits to be/a.ts"))).toBe(
      true,
    );
  });
});

describe("tool calls a 3b model got wrong (seen on the owner's PC)", () => {
  test("a \\' inside a JSON string is read as a plain quote", () => {
    const reply =
      '```json\n{"name": "edit_file", "arguments": {"path": "be/src/app.ts", "edits": [{"search": "import { getSession } from \\\'next-auth/react\\\';", "replace": "import { getSession } from \'next-auth/react\'; import { FakeGitHub } from \'./github/client\';"}]}}\n\n```';
    const calls = parseTextToolCalls(reply, TOOLS);
    expect(calls).toHaveLength(1);
    const edit = (calls[0]?.arguments as { edits: { search: string }[] } | undefined)?.edits[0];
    expect(edit?.search).toBe("import { getSession } from 'next-auth/react';");
    // Other escapes JSON does not have keep their backslash (a regex in code).
    expect(JSON.parse(fixBadEscapes('{"a": "\\d+\\.\\$ \\u00e9 \\n"}'))).toEqual({ a: "\\d+\\.\\$ é \n" });
  });

  test("calls to tools that do not exist are named; a package.json is not a call", () => {
    const reply = [
      "```json",
      '{"name": "list_tables", "arguments": {"folder": "/be"}}',
      '{"name": "add_table", "arguments": {"path": "be/src/db/schema.sql", "action": "append", "content": "CREATE TABLE IF NOT EXISTS scans (id INT);"}}',
      '{"name": "add_table", "arguments": {"path": "be/src/db/schema.sql", "action": "append", "content": "CREATE TABLE IF NOT EXISTS favorites (user_id INT);"}}',
      "```",
    ].join("\n");
    expect(unknownToolCalls(reply, TOOLS)).toEqual(["list_tables", "add_table"]);
    expect(
      unknownToolCalls('```json\n{"name": "fe", "version": "1.0.0", "scripts": {}}\n```', TOOLS),
    ).toEqual([]);
    expect(unknownToolCalls('{"name": "edit_file", "arguments": {}}', TOOLS)).toEqual([]);
  });

  test("the reason a call could not be read is found", () => {
    // A value that is not JSON at all (a bare name) cannot be repaired.
    const broken =
      '{"name": "edit_file", "arguments": {"path": "a.txt", "edits": [{"search": say.hi, "replace": "x"}]}}';
    expect(parseTextToolCalls(broken, TOOLS)).toEqual([]);
    expect(textCallProblem(broken, TOOLS)).toBeTruthy();
    expect(textCallProblem("All done.", TOOLS)).toBeNull();
  });
});

describe("the agent loop and code pasted as text", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  function setup(replies: ((req: ChatRequest) => AsyncIterable<ChatChunk>)[]) {
    const t = tempDir("depo dump loop");
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
    const root = path.join(t.dir, "proj");
    fs.mkdirSync(path.join(root, "be", "src"), { recursive: true });
    const bus = new EventBus(db.db, logger);
    const requests: ChatRequest[] = [];
    let i = 0;
    const provider: ModelProvider = {
      id: "fake",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      health: async () => ({ ok: true, version: "fake", message: null }),
      listModels: async () => [],
      embed: async () => [],
      chat: (req) => {
        requests.push(req);
        const reply = replies[Math.min(i++, replies.length - 1)];
        if (!reply) throw new Error("no reply scripted");
        return reply(req);
      },
    };
    const history: ChatMessage[] = [
      { role: "system", content: "You are a coder." },
      { role: "user", content: "Add the skills routes." },
    ];
    const events: { type: string; text: string }[] = [];
    const params: LoopParams = {
      provider,
      model: "qwen2.5-coder:7b",
      contextLength: 32_768,
      history,
      toolNames: TOOLS,
      ctx: { root, bus, approvals: new ApprovalCenter(bus), projectId: null, taskId: null, agent: "coder" },
      maxSteps: 10,
      signal: new AbortController().signal,
      job: { projectId: "prj_1", taskId: "tsk_1", label: "test" },
      emit: (e) => events.push({ type: e.type, text: e.text }),
      persist: () => {},
    };
    return { params, requests, history, events, root };
  }

  /** Streams text in small pieces until Depo stops it; records how much was sent. */
  const streaming = (text: string, sent: { chars: number }) =>
    async function* (req: ChatRequest): AsyncIterable<ChatChunk> {
      for (let at = 0; at < text.length; at += 40) {
        if (req.signal?.aborted) throw new ModelGatewayError("cancelled", "Cancelled");
        sent.chars = at + 40;
        yield { type: "text", delta: text.slice(at, at + 40) };
        await Promise.resolve();
      }
      yield { type: "done", finishReason: "stop", usage: null };
    };
  const answer = (text: string) =>
    async function* (): AsyncIterable<ChatChunk> {
      yield { type: "text", delta: text };
      yield { type: "done", finishReason: "stop", usage: null };
    };

  test("a long code dump of a file that exists is stopped early, new files are saved, and the model is told", async () => {
    const dump = [
      "Here are the files.",
      "",
      "**be/src/routes.ts**",
      "```ts",
      routes(4),
      "```",
      "",
      "**be/src/more.ts**",
      "```ts",
      routes(300),
      "```",
    ].join("\n");
    const sent = { chars: 0 };
    const { params, history, events, root } = setup([
      streaming(dump, sent),
      answer("Saved both route files."),
    ]);
    // more.ts is there already: a whole copy of it pasted as text is a dump, not a new file.
    fs.writeFileSync(path.join(root, "be", "src", "more.ts"), "export const more = 1;\n");
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Saved both route files.");
    // Stopped long before the end of the 300-route file.
    expect(sent.chars).toBeLessThan(dump.length / 3);
    expect(fs.readFileSync(path.join(root, "be", "src", "routes.ts"), "utf8")).toBe(`${routes(4)}\n`);
    // The file still being written when Depo stopped the reply is left as it was.
    expect(fs.readFileSync(path.join(root, "be", "src", "more.ts"), "utf8")).toBe("export const more = 1;\n");
    expect(res.changed).toEqual(["be/src/routes.ts"]);
    const asked = history.find((m) => m.role === "user" && m.content.includes("pasting code"));
    expect(asked?.content).toContain("be/src/routes.ts");
    // The reply kept in the history is the words, not the pasted code.
    const said = history.find((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(said?.content).toBe("Here are the files.\n\n**be/src/more.ts**");
    expect(events.some((e) => e.type === "retrying" && e.text.includes("Depo stopped it"))).toBe(true);
  });

  test("a final answer that is code, with nothing saved, is not accepted as the answer", async () => {
    const pasted = `I have updated the app:\n\n\`\`\`typescript\n${routes(3)}\n\`\`\``;
    const { params, history } = setup([answer(pasted), answer(pasted), answer(pasted)]);
    const res = await runAgentLoop(params);
    // Asked twice to save it with its tools, then the third reply is taken as it is.
    const asks = history.filter(
      (m) => m.role === "user" && m.content.includes("pasted code into your answer"),
    );
    expect(asks).toHaveLength(2);
    expect(res.finalText).toContain("I have updated the app");
    expect(res.changed).toEqual([]);
  });

  test("a final answer that names its file is saved, and the model goes on", async () => {
    const pasted = `I created \`be/src/skills.ts\`:\n\n\`\`\`ts\n${routes(3)}\n\`\`\``;
    const { params, root } = setup([answer(pasted), answer("The skills routes are in be/src/skills.ts.")]);
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("The skills routes are in be/src/skills.ts.");
    expect(fs.readFileSync(path.join(root, "be", "src", "skills.ts"), "utf8")).toBe(`${routes(3)}\n`);
  });

  test("a stray <tool_response> before a sentence is not treated as a made-up result", async () => {
    const { params, history } = setup([answer("<tool_response>\nNo changes are needed: the routes exist.")]);
    params.toolNames = ["read_file"];
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("No changes are needed: the routes exist.");
    expect(history.some((m) => m.role === "user" && m.content.includes("You wrote a <tool_response>"))).toBe(
      false,
    );
  });

  const BROKEN =
    '{"name": "edit_file", "arguments": {"path": "be/src/db/schema.sql", "edits": [{"search": say.hi, "replace": "x"}]}}';

  test("the same unreadable call stops the task after 4 tries, not after hours, asked differently each time", async () => {
    const { params, history, events, requests } = setup([answer(BROKEN)]);
    params.maxSteps = 100;
    await expect(runAgentLoop(params)).rejects.toThrow(/could not be read/);
    expect(events.filter((e) => e.text.startsWith("The model's tool call could not be read"))).toHaveLength(
      3,
    );
    const asks = history.filter(
      (m) => m.role === "user" && m.content.startsWith("Your tool call could not be read"),
    );
    expect(asks).toHaveLength(3);
    expect(asks[0]?.content).toContain("Do not repeat the same call unchanged");
    expect(asks[0]?.content).toContain('<tool_call>\n{"name":"edit_file"');
    expect(asks[1]?.content).toContain("Make a smaller step");
    expect(asks[2]?.content).toContain("Start with the simplest step");
    // The broken call is never shown to the model again (it would copy it).
    expect(history.some((m) => m.role === "assistant" && m.content.includes("say.hi"))).toBe(false);
    expect(history.filter((m) => m.content === BROKEN_STUB)).toHaveLength(3);
    // The first reply uses the model's own sampling; the retries are careful.
    expect(requests[0]?.temperature).toBeUndefined();
    expect(requests.slice(1).every((r) => r.temperature === 0.2)).toBe(true);
  });

  test("a call that runs in between starts the count again", async () => {
    const write = '{"name": "write_file", "arguments": {"path": "be/notes.md", "content": "notes"}}';
    const { params } = setup([
      answer(BROKEN),
      answer(BROKEN),
      answer(write),
      answer(BROKEN),
      answer(BROKEN),
      answer("Done."),
    ]);
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Done.");
    expect(res.changed).toEqual(["be/notes.md"]);
  });

  test("calls to tools that do not exist are not taken as the answer", async () => {
    const madeUp =
      '```json\n{"name": "add_table", "arguments": {"path": "be/src/db/schema.sql", "action": "append", "content": "CREATE TABLE IF NOT EXISTS scans (id INT);"}}\n```';
    const write =
      '{"name": "write_file", "arguments": {"path": "be/src/db/extra.sql", "content": "CREATE TABLE IF NOT EXISTS scans (id INT);"}}';
    const { params, history, events } = setup([
      answer(madeUp),
      answer(write),
      answer("Added the scans table."),
    ]);
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Added the scans table.");
    expect(res.changed).toEqual(["be/src/db/extra.sql"]);
    const asked = history.find((m) => m.role === "user" && m.content.includes('"add_table" is not a tool'));
    expect(asked?.content).toContain("Your tools are: read_file, write_file, edit_file, run_command");
    expect(events.some((e) => e.text.includes("a tool that does not exist (add_table)"))).toBe(true);
  });
});
