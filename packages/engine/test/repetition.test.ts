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
import { type LoopParams, MAX_REPLY_TOKENS, runAgentLoop, uniqueCalls } from "../src/agent/loop";
import { findRepetition, RepetitionGuard } from "../src/agent/repetition";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { tempDir } from "./helpers";

// What qwen2.5-coder:3b wrote for 55 minutes on the owner's PC: four text tool calls, over and over.
const LOOP_LINES = ["compare", "hash", "sign", "jwtDecode"].map(
  (name) =>
    `{"name": "edit_file", "arguments": {"path":"be/src/auth/auth.test.ts","edits":[{"replace":"import { ${name} } from 'bcrypt'\\n","replace_all":false,"search":"${name}"}]}}`,
);

describe("findRepetition", () => {
  test("finds the repeated tool calls and keeps one copy", () => {
    const intro = "I will fix the imports.\n";
    const text = `${intro}${`${LOOP_LINES.join("\n")}\n`.repeat(5)}{"name": "edit_fi`;
    const r = findRepetition(text);
    expect(r).not.toBeNull();
    expect(r?.times).toBe(5);
    expect(r?.unit).toBe(LOOP_LINES.join("\n"));
    expect(text.slice(0, r?.keep)).toBe(`${intro}${LOOP_LINES.join("\n")}\n`);
  });

  test("a long line that repeats a phrase is caught too", () => {
    const text = `The answer is: ${"the user table, ".repeat(60)}`;
    const r = findRepetition(text);
    expect(r?.unit).toBe("the user table, ");
    expect(text.slice(0, r?.keep).trimEnd()).toBe("The answer is: the user table,");
  });

  test("normal replies are left alone", () => {
    const code = [
      "export function total(items: Item[]): number {",
      "  let sum = 0;",
      "  for (const item of items) {",
      "    if (item.price > 0) {",
      "      sum += item.price;",
      "    }",
      "  }",
      "  return sum;",
      "}",
      "",
    ].join("\n");
    const samples = [
      code.repeat(2),
      `${"}\n".repeat(40)}`,
      `${" ".repeat(900)}\n`,
      `${"\n".repeat(900)}`,
      "| Name | Type |\n|---|---|\n| id | int |\n| email | text |\n| password_hash | text |\n| role | text |\n",
      Array.from({ length: 40 }, (_, i) => `tests/test_auth.py::test_case_${i} PASSED`).join("\n"),
      `{"name":"write_file","arguments":{"path":"a.ts","content":"${"line\\n".repeat(300)}"}}`,
      `${"=".repeat(60)}\nSummary\n${"=".repeat(60)}\n- Added sign up\n- Added log in\n- Added log out\n`,
      `- [ ] Check it\n`.repeat(8),
    ];
    for (const s of samples) expect(findRepetition(s)).toBeNull();
  });

  test("the guard only looks every few hundred characters", () => {
    const g = new RepetitionGuard(256);
    const loop = `${LOOP_LINES.join("\n")}\n`.repeat(4);
    expect(g.check(loop.slice(0, 100))).toBeNull();
    expect(g.check(loop)).not.toBeNull();
  });

  test("the same call twice in one reply runs once", () => {
    const call = (id: string, path: string) => ({
      id,
      name: "read_file",
      arguments: { path },
      rawArguments: JSON.stringify({ path }),
    });
    expect(uniqueCalls([call("1", "a"), call("2", "b"), call("3", "a")]).map((c) => c.id)).toEqual([
      "1",
      "2",
    ]);
  });
});

describe("the agent loop stops a reply that repeats itself", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  function setup(replies: ((req: ChatRequest) => AsyncIterable<ChatChunk>)[]) {
    const t = tempDir("depo loop");
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
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "a.txt"), "alpha\n");
    fs.writeFileSync(path.join(root, "b.txt"), "beta\n");
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
      { role: "user", content: "Look at the two files." },
    ];
    const events: { type: string; text: string }[] = [];
    const params: LoopParams = {
      provider,
      model: "qwen2.5-coder:3b",
      contextLength: 32_768,
      history,
      toolNames: ["read_file"],
      ctx: {
        root,
        bus,
        approvals: new ApprovalCenter(bus),
        projectId: null,
        taskId: null,
        agent: "coder",
      },
      maxSteps: 10,
      signal: new AbortController().signal,
      job: { projectId: "prj_1", taskId: "tsk_1", label: "test" },
      emit: (e) => events.push({ type: e.type, text: e.text }),
      persist: () => {},
    };
    return { params, requests, history, events, root };
  }

  /** Streams the same lines until Depo stops it (or a safety limit, so a failing test ends). */
  const looping = (lines: string[]) =>
    async function* (req: ChatRequest): AsyncIterable<ChatChunk> {
      for (let n = 0; n < 20_000; n++) {
        if (req.signal?.aborted) throw new ModelGatewayError("cancelled", "Cancelled");
        yield { type: "text", delta: `${lines[n % lines.length]}\n` };
        await Promise.resolve();
      }
      yield { type: "done", finishReason: "stop", usage: null };
    };
  const answer = (text: string, finishReason: "stop" | "length" = "stop") =>
    async function* (): AsyncIterable<ChatChunk> {
      yield { type: "text", delta: text };
      yield { type: "done", finishReason, usage: null };
    };

  test("repeated tool calls run once, the model is told, and the task carries on", async () => {
    const calls = ["a.txt", "b.txt"].map(
      (f) => `{"name": "read_file", "arguments": {"path": "${f}", "note": "${"x".repeat(80)}"}}`,
    );
    const { params, requests, history, events } = setup([looping(calls), answer("Both files are read.")]);
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Both files are read.");
    expect(res.steps).toBe(2);
    expect(requests[0]?.maxTokens).toBe(MAX_REPLY_TOKENS);
    const tools = history.filter((m) => m.role === "tool");
    expect(tools.map((m) => m.content.includes("alpha") || m.content.includes("beta"))).toEqual([true, true]);
    expect(history.some((m) => m.role === "user" && m.content.includes("Depo stopped your last reply"))).toBe(
      true,
    );
    // Stopped soon after the calls (before the repetition guard): the extra copies never run.
    expect(events.some((e) => e.type === "retrying" && e.text.includes("Depo stopped it there"))).toBe(true);
  });

  test("a model that keeps repeating itself ends the task with a plain reason", async () => {
    const ramble = ["I will now write the login page with a form, a button and a link to sign up."];
    const { params } = setup([looping(ramble)]);
    await expect(runAgentLoop(params)).rejects.toThrow(/kept repeating the same lines/);
  });

  test("a reply cut off at the length limit is not taken as the answer", async () => {
    const { params, history } = setup([
      answer("Here is the whole plan: first the database, then", "length"),
      answer("Done."),
    ]);
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Done.");
    expect(history.some((m) => m.role === "user" && m.content.includes("too long and was cut off"))).toBe(
      true,
    );
  });

  test("reading the same file again with nothing changed is pointed out, then cut short", async () => {
    const read = '{"name": "read_file", "arguments": {"path": "a.txt"}}';
    const { params, history } = setup([answer(read), answer(read), answer(read), answer("Done.")]);
    params.toolNames = ["read_file", "edit_file"];
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Done.");
    const tools = history.filter((m) => m.role === "tool").map((m) => m.content);
    expect(tools).toHaveLength(3);
    expect(tools[0]).toContain("alpha");
    expect(tools[0]).not.toContain("already made this exact call");
    expect(tools[1]).toContain("alpha");
    expect(tools[1]).toContain("already made this exact call");
    expect(tools[2]).not.toContain("alpha");
    expect(tools[2]).toContain("3 times");
  });

  test("the same edit again on a file that already has it is skipped, not added twice", async () => {
    const read = '{"name": "read_file", "arguments": {"path": "a.txt"}}';
    const edit =
      '{"name": "edit_file", "arguments": {"path": "a.txt", "edits": [{"search": "alpha", "replace": "alpha\\nmore"}]}}';
    const { params, history, events, root } = setup([
      answer(read),
      answer(edit),
      answer(read),
      answer(edit),
      answer("Done."),
    ]);
    params.toolNames = ["read_file", "edit_file"];
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Done.");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("alpha\nmore\n");
    const tools = history.filter((m) => m.role === "tool").map((m) => m.content);
    expect(tools[3]).toContain("already made this exact edit");
    expect(events.some((e) => e.text.includes("Depo skipped it"))).toBe(true);
  });

  test("a change in between makes the same read new again", async () => {
    const read = '{"name": "read_file", "arguments": {"path": "a.txt"}}';
    const edit =
      '{"name": "edit_file", "arguments": {"path": "a.txt", "edits": [{"search": "alpha", "replace": "gamma"}]}}';
    const { params, history } = setup([answer(read), answer(edit), answer(read), answer("Done.")]);
    params.toolNames = ["read_file", "edit_file"];
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Done.");
    const tools = history.filter((m) => m.role === "tool").map((m) => m.content);
    expect(tools[2]).toContain("gamma");
    expect(tools.some((t) => t.includes("already made this exact call"))).toBe(false);
  });
});
