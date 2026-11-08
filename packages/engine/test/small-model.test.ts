import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ModelInfo,
  ModelProvider,
  ToolCall,
} from "@depo/model-gateway";
import type { DepoEvent } from "@depo/shared";
import { startFakeOllama } from "../../../scripts/fake-ollama-lib";
import { aliasFor } from "../src/agent/aliases";
import { blockCalls, searchReplaceBlocks } from "../src/agent/blocks";
import { dumpInProgress } from "../src/agent/codedump";
import { type LoopParams, retryAdvice, runAgentLoop } from "../src/agent/loop";
import { codingSystemPrompt } from "../src/agent/prompt";
import { isSmallModel, modelBillions, pickStepUp } from "../src/agent/small";
import {
  balanceBrackets,
  extractTextToolCalls,
  missingCommas,
  parseTextToolCalls,
  pythonish,
  unknownToolCalls,
} from "../src/agent/textcalls";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { createEngine, type Engine } from "../src/engine";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { normalizeArgs, projectPath } from "../src/tools/args";
import { appendFileTool } from "../src/tools/fs-tools";
import { TEST_TOKEN, tempDir } from "./helpers";

const TOOLS = ["read_file", "list_dir", "write_file", "edit_file", "append_file", "run_command", "search"];

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function project(): string {
  const t = tempDir("depo small");
  cleanup = t.cleanup;
  const root = path.join(t.dir, "proj");
  fs.mkdirSync(path.join(root, "be", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "be", "schema.sql"),
    "CREATE TABLE IF NOT EXISTS users (\n  id INT PRIMARY KEY\n);\n",
  );
  fs.writeFileSync(path.join(root, "be", "src", "app.ts"), 'const port = 3000;\nconsole.log("up");\n');
  return root;
}

describe("broken JSON from a 3B model is repaired", () => {
  test('a missing "]" (the error that ended the owner\'s run) is put back', () => {
    const reply =
      '{"name": "edit_file", "arguments": {"path": "be/schema.sql", "edits": [{"search": "id INT", "replace": "id BIGINT"}}}';
    const calls = parseTextToolCalls(reply, TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments).toEqual({
      path: "be/schema.sql",
      edits: [{ search: "id INT", replace: "id BIGINT" }],
    });
  });

  test('quotes inside a value that were not written as \\" are escaped', () => {
    const reply =
      '<tool_call>\n{"name": "write_file", "arguments": {"path": "be/a.ts", "content": "console.log("hi");"}}\n</tool_call>';
    expect(parseTextToolCalls(reply, TOOLS)[0]?.arguments).toEqual({
      path: "be/a.ts",
      content: 'console.log("hi");',
    });
    const edit =
      '{"name": "edit_file", "arguments": {"path": "a.txt", "edits": [{"search": "say "hi"", "replace": "say "bye""}]}}';
    expect(parseTextToolCalls(edit, TOOLS)[0]?.arguments).toEqual({
      path: "a.txt",
      edits: [{ search: 'say "hi"', replace: 'say "bye"' }],
    });
  });

  test("trailing and missing commas, Python literals and single quotes", () => {
    expect(JSON.parse(pythonish('{"a": [1, 2,], "b": True, "c": None,}'))).toEqual({
      a: [1, 2],
      b: true,
      c: null,
    });
    expect(JSON.parse(pythonish("{'name': 'read_file'}"))).toEqual({ name: "read_file" });
    expect(JSON.parse(missingCommas('{"a": "x" "b": 1 "c": {"d": 2} "e": [3]}'))).toEqual({
      a: "x",
      b: 1,
      c: { d: 2 },
      e: [3],
    });
    const reply = '{"name": "read_file" "arguments": {"path": "be/src/app.ts",}}';
    expect(parseTextToolCalls(reply, TOOLS)[0]?.arguments).toEqual({ path: "be/src/app.ts" });
  });

  test('a long edit with raw line breaks, an odd stray quote and a missing "]" is still read', () => {
    const reply = [
      "<tool_call>",
      '{"name": "edit_file", "arguments": {"path": "be/src/db/schema.sql", "edits": [{"search": "  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id)',
      ');", "replace": "  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id)',
      ");",
      "",
      "CREATE TABLE IF NOT EXISTS skills (",
      '  name VARCHAR(255) NOT NULL DEFAULT "",',
      '  label VARCHAR(10) DEFAULT "it\'s "new"',
      ');"}}',
      "</tool_call>",
    ].join("\n");
    const edit = (
      parseTextToolCalls(reply, TOOLS)[0]?.arguments as { edits: { search: string; replace: string }[] }
    )?.edits[0];
    expect(edit?.search).toBe("  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id)\n);");
    expect(edit?.replace).toContain('name VARCHAR(255) NOT NULL DEFAULT "",\n');
    expect(edit?.replace.endsWith('DEFAULT "it\'s "new"\n);')).toBe(true);
  });

  test("a call left open at the end is closed", () => {
    const reply = 'Let me look.\n{"name": "read_file", "arguments": {"path": "be/src/app.ts"';
    expect(parseTextToolCalls(reply, TOOLS)[0]?.arguments).toEqual({ path: "be/src/app.ts" });
    expect(balanceBrackets('{"a": [1, 2}]}')).toBe('{"a": [1, 2]}');
  });

  test("other shapes of a call: arguments next to the name, the OpenAI function shape", () => {
    const flat = '{"name": "write_file", "path": "be/n.md", "content": "notes"}';
    expect(parseTextToolCalls(flat, TOOLS)[0]).toMatchObject({
      name: "write_file",
      arguments: { path: "be/n.md", content: "notes" },
    });
    const openai =
      '{"type": "function", "function": {"name": "read_file", "arguments": "{\\"path\\": \\"a.ts\\"}"}}';
    expect(parseTextToolCalls(openai, TOOLS)[0]).toMatchObject({
      name: "read_file",
      arguments: { path: "a.ts" },
    });
    // A package.json is still not a call.
    expect(parseTextToolCalls('{"name": "fe", "version": "1.0.0"}', TOOLS)).toEqual([]);
  });
});

describe("made-up tool names and argument names", () => {
  const known = new Set(TOOLS);

  test("the owner's create_table_skills becomes append_file, and the rename is reported", () => {
    const root = project();
    const reply =
      '```json\n{"name": "create_table_skills", "arguments": {"path": "be/schema.sql", "content": "CREATE TABLE IF NOT EXISTS skills (id INT);"}}\n```';
    const r = extractTextToolCalls(reply, TOOLS, root);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({
      name: "append_file",
      arguments: { path: "be/schema.sql", content: "CREATE TABLE IF NOT EXISTS skills (id INT);" },
    });
    expect(r.renamed).toEqual({ [r.calls[0]?.id ?? ""]: "create_table_skills" });
    expect(unknownToolCalls(reply, TOOLS)).toEqual([]);
  });

  test("common names map to the real tools", () => {
    const root = project();
    const to = (name: string, args: unknown) => aliasFor(name, args, known, root);
    expect(to("create_file", { file_path: "be/x.ts", text: "x" })).toEqual({
      name: "write_file",
      args: { path: "be/x.ts", content: "x" },
    });
    expect(to("cat", { path: "be/src/app.ts" })?.name).toBe("read_file");
    expect(to("ls", { path: "/be" })).toEqual({ name: "list_dir", args: { path: "be" } });
    expect(to("str_replace", { path: "be/src/app.ts", old_str: "3000", new_str: "4000" })).toEqual({
      name: "edit_file",
      args: { path: "be/src/app.ts", edits: [{ search: "3000", replace: "4000" }] },
    });
    expect(to("exec", { cmd: "bun test", dir: "be" })).toEqual({
      name: "run_command",
      args: { command: "bun test", cwd: "be" },
    });
    expect(
      to("add_table", { path: "be/schema.sql", action: "append", content: "CREATE TABLE t (id INT);" })?.name,
    ).toBe("append_file");
    // Whole content under an "update" name would cut an existing file down: never guessed.
    expect(to("update_file", { path: "be/src/app.ts", content: "only part" })).toBeNull();
    expect(to("update_file", { path: "be/src/new.ts", content: "new" })?.name).toBe("write_file");
    // Without the tool it would map to, nothing is guessed.
    expect(aliasFor("cat", { path: "a" }, new Set(["write_file"]))).toBeNull();
    expect(to("make_coffee", { strength: 3 })).toBeNull();
  });

  test("arguments with other names are renamed before the tool checks them", () => {
    expect(normalizeArgs("write_file", { file_path: "a.ts", code: "x" })).toEqual({
      path: "a.ts",
      content: "x",
    });
    expect(normalizeArgs("edit_file", { path: "a.ts", edits: { old_str: "a", new_str: "b" } })).toEqual({
      path: "a.ts",
      edits: [{ search: "a", replace: "b" }],
    });
    expect(normalizeArgs("edit_file", { path: "a.ts", search: "a", replace: "b" })).toEqual({
      path: "a.ts",
      edits: [{ search: "a", replace: "b" }],
    });
    expect(normalizeArgs("run_command", { cmd: ["bun", "test"], working_dir: "./be" })).toEqual({
      command: "bun test",
      cwd: "./be",
    });
    expect(normalizeArgs("read_file", { filename: "/be/src/app.ts", start: 2 })).toEqual({
      path: "be/src/app.ts",
      start_line: 2,
    });
    expect(projectPath("/")).toBe(".");
    expect(projectPath("/tmp/proj/be", "/tmp/proj")).toBe("/tmp/proj/be");
  });
});

describe("file blocks: writing files without JSON", () => {
  test("SEARCH/REPLACE blocks are read with their path, in Aider's layout and others", () => {
    const text = [
      "I will change the port.",
      "",
      "be/src/app.ts",
      "```ts",
      "<<<<<<< SEARCH",
      "const port = 3000;",
      "=======",
      "const port = 4000;",
      ">>>>>>> REPLACE",
      "```",
      "",
      "```ts be/src/app.ts",
      "<<<<<<< SEARCH",
      'console.log("up");',
      "=======",
      'console.log("ready");',
      ">>>>>>> REPLACE",
      "<<<<<<< SEARCH",
      "=======",
      "export {};",
      ">>>>>>> REPLACE",
      "```",
      "",
      "**be/src/other.ts**",
      "<<<<<<< SEARCH",
      "a",
      "=======",
    ].join("\n");
    const { blocks, unfinished } = searchReplaceBlocks(text);
    expect(blocks.map((b) => [b.path, b.search, b.replace])).toEqual([
      ["be/src/app.ts", "const port = 3000;", "const port = 4000;"],
      ["be/src/app.ts", 'console.log("up");', 'console.log("ready");'],
      ["be/src/app.ts", "", "export {};"],
    ]);
    expect(unfinished).toBe(1);
  });

  test("blocks become edit_file, append_file and write_file calls; existing whole files are not overwritten", () => {
    const root = project();
    const text = [
      "be/src/app.ts",
      "```ts",
      "<<<<<<< SEARCH",
      "const port = 3000;",
      "=======",
      "const port = 4000;",
      ">>>>>>> REPLACE",
      "<<<<<<< SEARCH",
      'console.log("up");',
      "=======",
      'console.log("ready");',
      ">>>>>>> REPLACE",
      "```",
      "",
      "be/schema.sql",
      "```sql",
      "<<<<<<< SEARCH",
      "=======",
      "CREATE TABLE IF NOT EXISTS skills (",
      "  id INT PRIMARY KEY",
      ");",
      ">>>>>>> REPLACE",
      "```",
      "",
      "`be/src/skills.ts`",
      "```ts",
      "export const skills = [];",
      "export const count = 0;",
      "```",
      "",
      "be/src/app.ts",
      "```ts",
      "export const whole = 1;",
      "export const file = 2;",
      "```",
      "Done.",
    ].join("\n");
    const r = blockCalls(text, root, TOOLS);
    expect(r.calls.map((c) => c.name)).toEqual(["edit_file", "append_file", "write_file"]);
    expect(r.calls[0]?.arguments).toEqual({
      path: "be/src/app.ts",
      edits: [
        { search: "const port = 3000;", replace: "const port = 4000;" },
        { search: 'console.log("up");', replace: 'console.log("ready");' },
      ],
    });
    expect(r.calls[1]?.arguments).toEqual({
      path: "be/schema.sql",
      content: "CREATE TABLE IF NOT EXISTS skills (\n  id INT PRIMARY KEY\n);\n",
    });
    expect(r.calls[2]?.arguments).toEqual({
      path: "be/src/skills.ts",
      content: "export const skills = [];\nexport const count = 0;\n",
    });
    expect(r.existing).toEqual(["be/src/app.ts"]);
    expect(r.rest).not.toContain("SEARCH");
    expect(r.rest).toContain("Done.");
  });

  test("a long reply of file blocks is not cut as pasted code", () => {
    const root = project();
    const big = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    const newFile = `Here it is.\n\nbe/src/big.ts\n\`\`\`ts\n${big}\n`;
    expect(dumpInProgress(newFile, TOOLS, root)).toBe(false);
    const sr = `be/src/app.ts\n\`\`\`ts\n<<<<<<< SEARCH\nconst port = 3000;\n=======\n${big}\n`;
    expect(dumpInProgress(sr, TOOLS, root)).toBe(false);
    // The whole of a file that exists, pasted as text, is still a dump.
    const old = `Here is app.ts.\n\nbe/src/app.ts\n\`\`\`ts\n${big}\n`;
    expect(dumpInProgress(old, TOOLS, root)).toBe(true);
  });
});

describe("the agent loop with a small model", () => {
  const answer = (text: string, toolCalls: ToolCall[] = []) =>
    async function* (): AsyncIterable<ChatChunk> {
      if (text) yield { type: "text", delta: text };
      for (const call of toolCalls) yield { type: "tool_call", call };
      yield { type: "done", finishReason: "stop", usage: null };
    };

  function setup(replies: ((req: ChatRequest) => AsyncIterable<ChatChunk>)[]) {
    const root = project();
    const t = tempDir("depo small loop");
    const prev = cleanup;
    const logger = createLogger({ dir: path.join(t.dir, "logs"), level: "error", stderr: false });
    const db = openDatabase({
      file: path.join(t.dir, "db", "t.db"),
      backupsDir: path.join(t.dir, "bk"),
      logger,
    });
    cleanup = () => {
      db.close();
      t.cleanup();
      prev?.();
    };
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
        requests.push({ ...req, messages: [...req.messages] });
        const reply = replies[Math.min(i++, replies.length - 1)];
        if (!reply) throw new Error("no reply scripted");
        return reply(req);
      },
    };
    const history: ChatMessage[] = [
      { role: "system", content: "You are a coder." },
      { role: "user", content: "Add a skills table and route." },
    ];
    const events: { type: string; text: string }[] = [];
    const persisted: ChatMessage[] = [];
    const params: LoopParams = {
      provider,
      model: "qwen2.5-coder:3b",
      contextLength: 16_384,
      history,
      toolNames: TOOLS,
      ctx: { root, bus, approvals: new ApprovalCenter(bus), projectId: null, taskId: null, agent: "coder" },
      maxSteps: 10,
      signal: new AbortController().signal,
      job: { projectId: "prj_1", taskId: "tsk_1", label: "test" },
      emit: (e) => events.push({ type: e.type, text: e.text }),
      persist: (m) => persisted.push(m),
      fileBlocks: true,
    };
    return { params, requests, history, events, persisted, root };
  }

  test("file blocks are saved, the model keeps its own blocks in the history and reads one result note", async () => {
    const blocks = [
      "be/schema.sql",
      "```sql",
      "<<<<<<< SEARCH",
      "=======",
      "CREATE TABLE IF NOT EXISTS skills (id INT PRIMARY KEY);",
      ">>>>>>> REPLACE",
      "```",
      "",
      "be/src/skills.ts",
      "```ts",
      "export const skills = [];",
      "export const count = 0;",
      "```",
    ].join("\n");
    const { params, requests, history, persisted, root } = setup([
      answer(blocks),
      answer("Added the skills table and be/src/skills.ts."),
    ]);
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Added the skills table and be/src/skills.ts.");
    expect(res.changed.sort()).toEqual(["be/schema.sql", "be/src/skills.ts"]);
    expect(fs.readFileSync(path.join(root, "be", "schema.sql"), "utf8")).toBe(
      "CREATE TABLE IF NOT EXISTS users (\n  id INT PRIMARY KEY\n);\n\nCREATE TABLE IF NOT EXISTS skills (id INT PRIMARY KEY);\n",
    );
    // The second request shows the blocks as written (not as JSON) and one note with the results.
    const seen = requests[1]?.messages ?? [];
    expect(seen.at(-2)).toEqual({ role: "assistant", content: blocks });
    expect(seen.at(-1)?.role).toBe("user");
    expect(seen.at(-1)?.content).toContain("Depo ran your file blocks:");
    expect(seen.at(-1)?.content).toContain("append_file be/schema.sql");
    expect(seen.some((m) => m.role === "tool")).toBe(false);
    // The transcript keeps them as calls, so the activity view shows them.
    expect(persisted.filter((m) => m.role === "tool").map((m) => m.name)).toEqual([
      "append_file",
      "write_file",
    ]);
    expect(history.at(-1)?.content).toBe("Added the skills table and be/src/skills.ts.");
  });

  test("a native call to a made-up tool runs as the real tool, with a note", async () => {
    const { params, history, root } = setup([
      answer("", [
        {
          id: "c1",
          name: "create_file",
          arguments: { file_path: "be/src/n.ts", text: "export const n = 1;\n" },
          rawArguments: "",
        },
      ]),
      answer("Created be/src/n.ts."),
    ]);
    await runAgentLoop(params);
    expect(fs.readFileSync(path.join(root, "be", "src", "n.ts"), "utf8")).toBe("export const n = 1;\n");
    const result = history.find((m) => m.role === "tool");
    expect(result?.name).toBe("write_file");
    expect(result?.content).toContain('there is no tool "create_file", so Depo ran write_file');
  });

  test("when the small model is stuck, the larger one takes the step, then the small one goes on", async () => {
    const broken =
      '{"name": "edit_file", "arguments": {"path": "be/src/app.ts", "edits": [{"search": x, "replace": y}]}}';
    const fixed = '{"name": "read_file", "arguments": {"path": "be/src/app.ts"}}';
    const { params, requests, events } = setup([
      answer(broken),
      answer(broken),
      answer(broken),
      answer(fixed),
      answer("Read it; nothing to change."),
    ]);
    params.stepUp = { model: "qwen2.5-coder:7b" };
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Read it; nothing to change.");
    expect(requests.map((r) => r.model)).toEqual([
      "qwen2.5-coder:3b",
      "qwen2.5-coder:3b",
      "qwen2.5-coder:3b",
      "qwen2.5-coder:7b",
      "qwen2.5-coder:3b",
    ]);
    // Back to the model's own sampling once a call ran.
    expect(requests[4]?.temperature).toBeUndefined();
    expect(events.some((e) => e.text.includes("so Depo asked qwen2.5-coder:7b to do it"))).toBe(true);
    expect(events.some((e) => e.text.includes("Depo goes back to qwen2.5-coder:3b."))).toBe(true);
  });

  test("with a larger model the task stops only after it failed too", async () => {
    const broken = '{"name": "read_file", "arguments": {"path": be/src/app.ts}}';
    const { params, requests } = setup([answer(broken)]);
    params.stepUp = { model: "qwen2.5-coder:7b" };
    params.maxSteps = 50;
    await expect(runAgentLoop(params)).rejects.toThrow(/could not be read/);
    expect(requests.map((r) => r.model)).toEqual([
      "qwen2.5-coder:3b",
      "qwen2.5-coder:3b",
      "qwen2.5-coder:3b",
      "qwen2.5-coder:7b",
      "qwen2.5-coder:7b",
    ]);
  });

  test("an unfinished SEARCH/REPLACE block is not taken as the answer", async () => {
    const half = "be/src/app.ts\n```ts\n<<<<<<< SEARCH\nconst port = 3000;\n```";
    const done =
      "be/src/app.ts\n```ts\n<<<<<<< SEARCH\nconst port = 3000;\n=======\nconst port = 4000;\n>>>>>>> REPLACE\n```";
    const { params, history, root } = setup([answer(half), answer(done), answer("Port is 4000.")]);
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Port is 4000.");
    expect(fs.readFileSync(path.join(root, "be", "src", "app.ts"), "utf8")).toContain("const port = 4000;");
    expect(history.some((m) => m.role === "user" && m.content.includes("block was not finished"))).toBe(true);
  });

  test("retry advice points a small model to file blocks for code", () => {
    expect(retryAdvice("edit_file", 1, true)).toContain("<<<<<<< SEARCH");
    expect(retryAdvice("read_file", 1, true)).toContain('"name":"read_file"');
    expect(retryAdvice(null, 3, false)).toContain("simplest step");
  });
});

describe("small models", () => {
  const info = (
    name: string,
    parameterSize: string | null = null,
    family: string | null = "qwen2",
  ): ModelInfo => ({
    name,
    sizeBytes: null,
    family,
    parameterSize,
    quantization: null,
    modifiedAt: null,
  });

  test("size comes from the tag or the runtime", () => {
    expect(modelBillions("qwen2.5-coder:3b")).toBe(3);
    expect(modelBillions("qwen2.5-coder:1.5b-instruct-q4_K_M")).toBe(1.5);
    expect(modelBillions("llama3.2:latest", "3.2B")).toBe(3.2);
    expect(modelBillions("tinyllama:latest", "800M")).toBe(0.8);
    expect(modelBillions("mystery")).toBeNull();
    expect(isSmallModel("qwen2.5-coder:3b")).toBe(true);
    expect(isSmallModel("qwen2.5-coder:7b")).toBe(false);
  });

  test("the step-up model is the next larger one of the same kind", () => {
    const installed = [
      info("qwen2.5-coder:3b"),
      info("qwen2.5-coder:14b"),
      info("qwen2.5-coder:7b"),
      info("qwen2.5-coder:32b"),
      info("nomic-embed-text:latest", "137M", "nomic-bert"),
    ];
    expect(pickStepUp("qwen2.5-coder:3b", installed)).toBe("qwen2.5-coder:7b");
    expect(pickStepUp("qwen2.5-coder:7b", installed)).toBeNull();
    expect(
      pickStepUp("qwen2.5-coder:3b", [info("qwen2.5-coder:3b"), info("llama3.1:8b", null, "llama")]),
    ).toBeNull();
    expect(pickStepUp("qwen2.5-coder:1.5b", [info("qwen2.5-coder:1.5b"), info("qwen2.5-coder-ft:7b")])).toBe(
      "qwen2.5-coder-ft:7b",
    );
  });

  test("the small prompt teaches file blocks and leaves out the tools it does not have", () => {
    const root = project();
    const small = codingSystemPrompt({ projectName: "p", root, small: true });
    expect(small).toContain("<<<<<<< SEARCH");
    expect(small).not.toContain("code_map");
    const big = codingSystemPrompt({ projectName: "p", root });
    expect(big).toContain("code_map");
    expect(big).not.toContain("<<<<<<< SEARCH");
  });

  test("append_file adds after a blank line, keeps Windows line ends, and creates a missing file", () => {
    const root = project();
    fs.writeFileSync(path.join(root, "w.sql"), "A;\r\nB;\r\n");
    const r = appendFileTool(root, "w.sql", "C;\nD;");
    expect(fs.readFileSync(path.join(root, "w.sql"), "utf8")).toBe("A;\r\nB;\r\n\r\nC;\r\nD;\r\n");
    expect(r).toEqual({ path: "w.sql", created: false, added: 2, total: 5 });
    expect(appendFileTool(root, "be/new.sql", "X;\n")).toMatchObject({ created: true, added: 1, total: 1 });
    expect(fs.readFileSync(path.join(root, "be", "new.sql"), "utf8")).toBe("X;\n");
  });
});

describe("a task with a small model", () => {
  let engine: Engine | null = null;
  let stopFake = () => {};
  afterEach(async () => {
    await engine?.stop("test");
    engine = null;
    stopFake();
  });

  test("gets the short tool list, the file-block prompt and the larger model for stuck steps", async () => {
    const t = tempDir("depo small task");
    const prev = cleanup;
    cleanup = () => {
      t.cleanup();
      prev?.();
    };
    const fake = startFakeOllama();
    stopFake = fake.stop;
    fake.models.set("qwen2.5-coder:7b", 4_700_000_000);
    const e = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
    engine = e;
    await e.start();
    e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: fake.url, enabled: true }]);
    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
    const proj = path.join(t.dir, "app");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "README.md"), "# app\n");
    const p = await e.projects.open(proj);
    const events: DepoEvent[] = [];
    e.bus.subscribe((ev) => events.push(ev));
    const task = e.tasks.send(p.id, "say hello");
    await e.tasks.settled(task.id);
    const chat = fake.requests.find((r) => r.path === "/api/chat");
    const tools = (chat?.body.tools as { function: { name: string } }[]) ?? [];
    expect(tools.length).toBeLessThanOrEqual(16);
    expect(tools.map((x) => x.function.name)).toContain("append_file");
    expect(tools.map((x) => x.function.name)).not.toContain("code_map");
    const sys = ((chat?.body.messages ?? []) as { role: string; content: string }[])[0];
    expect(sys?.content).toContain("<<<<<<< SEARCH");
    const note = events.find((ev) => ev.taskId === task.id && String(ev.text).includes("is a small model"));
    expect(note?.text).toContain("qwen2.5-coder:7b takes over a step it gets stuck on");
  });
});

describe("Retry", () => {
  let engine: Engine | null = null;
  let stopFake = () => {};
  afterEach(async () => {
    await engine?.stop("test");
    engine = null;
    stopFake();
  });

  test("runs a failed task's last message again, without the failed attempt, and only after a failure or a stop", async () => {
    const t = tempDir("depo retry");
    const prev = cleanup;
    cleanup = () => {
      t.cleanup();
      prev?.();
    };
    const fake = startFakeOllama();
    stopFake = fake.stop;
    const e = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
    engine = e;
    await e.start();
    e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: fake.url, enabled: true }]);
    const proj = path.join(t.dir, "app");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "README.md"), "# app\n");
    const p = await e.projects.open(proj);
    // No coding model yet: the run fails.
    const task = e.tasks.send(p.id, "say hello");
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("failed");
    expect(() => e.tasks.retry("tsk_nope")).toThrow(/Unknown task/);

    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
    e.tasks.retry(task.id);
    await e.tasks.settled(task.id);
    const { task: after, messages } = e.tasks.get(task.id);
    expect(after.status).toBe("done");
    expect(after.error).toBeNull();
    // The message was not typed again: it is in the transcript once, and the failure stays visible.
    expect(messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["say hello"]);
    expect(messages.some((m) => m.isError)).toBe(true);
    // The model is not shown the failure, only the request.
    const chat = fake.requests.find((r) => r.path === "/api/chat");
    const sent = (chat?.body.messages as { role: string; content: string }[]) ?? [];
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "say hello" });
    expect(sent.some((m) => m.content.includes("No coding model"))).toBe(false);
    // A finished task continues with a message instead.
    expect(() => e.tasks.retry(task.id)).toThrow(/Only a task that failed or was stopped/);
  });
});
