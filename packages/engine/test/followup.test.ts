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
import { compactEarlierTurns, copyRepoMap, copyTree, isFollowUp } from "../src/agent/followup";
import { type LoopParams, runAgentLoop } from "../src/agent/loop";
import { firstTextCallEnd, inventsToolResult, withoutInventedResults } from "../src/agent/textcalls";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { refuseFolderOrPlaceholder } from "../src/tools/index";
import { tempDir } from "./helpers";

/**
 * From the owner's run on their PC (qwen2.5-coder:3b): the follow-up "make the UI/UX responsive"
 * saw a stale map ("README.md (2 lines)") and the first answer was a made-up "<tool_response>", so
 * the model started the whole app again, writing 8,192 tokens of invented steps per reply.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function copyWithApp(): string {
  const t = tempDir("depo followup");
  cleanups.push(t.cleanup);
  const root = path.join(t.dir, "copy");
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("README.md", "# test\n");
  write("fe/app/page.tsx", "export default function Home() {\n  return null;\n}\n");
  write("fe/app/globals.css", ":root {\n  --bg: #fff;\n}\n");
  write("be/src/index.ts", "export async function start(port: number) {\n  return port;\n}\n");
  write("be/node_modules/x/index.js", "module.exports = 1;\n");
  return root;
}

const OWNER_FIRST =
  'create a front end folder "fe" and a backend folder "be"\nuse next for the front end and typescript with bun for the back end .';
const BRIEF = "# Design reference\nTheme: light. Primary #2778cb.";
const OWNER_FOLLOWUP =
  "make the UI/UX responsive , even the mobile and the abb , they should fit every where";

/** The stored transcript of the owner's task, as the model saw it on the follow-up. */
function ownersHistory(): ChatMessage[] {
  return [
    { role: "system", content: "You are a coder." },
    { role: "user", content: `${OWNER_FIRST}\n\n${BRIEF}` },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "text_1", name: "repo_map", arguments: {}, rawArguments: "{}" }],
    },
    { role: "tool", toolCallId: "text_1", name: "repo_map", content: "README.md (2 lines)" },
    { role: "assistant", content: "<tool_response>\napp/ (10 files)\ndb/ (3 files)\nlib/ (4 files)" },
    { role: "user", content: OWNER_FOLLOWUP },
  ];
}

describe("the agent sees its copy as it is now", () => {
  test("the map lists the copy's files, not the project folder's stale index", () => {
    const root = copyWithApp();
    const map = copyRepoMap(root, "README.md (2 lines)\nold.ts (9 lines)\n  1: function gone()", 4000);
    expect(map).toContain("README.md (2 lines)");
    expect(map).toContain("fe/app/page.tsx (3 lines)");
    expect(map).toContain("  1: export default function Home()");
    expect(map).toContain("be/src/index.ts (3 lines)");
    expect(map).not.toContain("old.ts"); // not in the copy any more
    expect(map).not.toContain("node_modules");
    // A folder only.
    expect(copyRepoMap(root, "", 4000, "fe/")).not.toContain("be/");
  });

  test("the tree fits its budget by folding folders", () => {
    const root = copyWithApp();
    const full = copyTree(root, 4000);
    expect(full).toContain("fe/ (2 files)");
    expect(full).toContain("  app/page.tsx (3 lines)");
    const small = copyTree(root, 60);
    expect(small).toContain("fe/ (2 files)");
    expect(small).not.toContain("page.tsx");
  });
});

describe("a follow-up builds on the earlier work", () => {
  test("the owner's follow-up gets a summary, the files now and the new request last", () => {
    const history = ownersHistory();
    expect(isFollowUp(history)).toBe(true);
    const root = copyWithApp();
    const out = compactEarlierTurns(history, { tree: copyTree(root), brief: BRIEF });
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("system");
    const msg = out[1]?.content ?? "";
    expect(out[1]?.role).toBe("user");
    expect(msg).toContain("Earlier in this task (already done");
    expect(msg).toContain('Request: create a front end folder "fe"');
    expect(msg).toContain("fe/ (2 files)");
    expect(msg).toContain(`Design reference (still applies):\n${BRIEF}`);
    expect(msg.indexOf("New request, do this now: make the UI/UX responsive")).toBeGreaterThan(
      msg.indexOf("fe/ (2 files)"),
    );
    expect(msg).toContain("Do not start over");
    // Neither the made-up result nor the stale map reach the model again.
    expect(msg).not.toContain("<tool_response>");
    expect(msg).not.toContain("README.md (2 lines)");
    expect(msg.split(BRIEF)).toHaveLength(2); // the brief once
  });

  test("the first request is left alone", () => {
    const first: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: OWNER_FIRST },
    ];
    expect(isFollowUp(first)).toBe(false);
    expect(compactEarlierTurns(first, { tree: "" })).toBe(first);
  });
});

describe("tool calls written as text", () => {
  const TOOLS = ["write_file", "read_file", "list_dir"];

  test("the end of the first complete call is found while the reply streams", () => {
    const text =
      'Sure:\n```json\n{"name": "my-app", "version": "1.0.0"}\n```\n<tool_response>\n{"name": "write_file", "arguments": {"path": "fe/a.ts", "content": "x"}}\n';
    const end = firstTextCallEnd(text, TOOLS);
    expect(text.slice(0, end).endsWith('"content": "x"}}')).toBe(true);
    expect(
      firstTextCallEnd('{"name": "write_file", "arguments": {"path": "a", "content": "unfinished', TOOLS),
    ).toBe(-1);
  });

  test("made-up results are recognised and removed", () => {
    expect(inventsToolResult("<tool_response>\napp/ (10 files)")).toBe(true);
    expect(inventsToolResult("Added the media queries.")).toBe(false);
    expect(withoutInventedResults("Done.\n<tool_response>\napp/ (10 files)")).toBe("Done.");
    expect(withoutInventedResults("A <tool_response>x</tool_response> B")).toBe("A  B");
  });

  test("writing a folder or a placeholder is refused with what is already there", () => {
    const root = copyWithApp();
    expect(() => refuseFolderOrPlaceholder(root, "fe/", "Folder created.")).toThrow(
      /fe\/ is a folder, not a file\. It already exists and has: app\/\./,
    );
    expect(() => refuseFolderOrPlaceholder(root, "new-folder/", "x")).toThrow(/is a folder, not a file/);
    expect(() => refuseFolderOrPlaceholder(root, "fe/app/x.ts", "Folder created.")).toThrow(
      /is not file content/,
    );
    expect(() => refuseFolderOrPlaceholder(root, "fe/app/x.ts", "export const x = 1;\n")).not.toThrow();
  });
});

describe("the loop stops a model that invents tool results", () => {
  function setup(replies: ((req: ChatRequest) => AsyncIterable<ChatChunk>)[]) {
    const t = tempDir("depo invent");
    const logger = createLogger({ dir: path.join(t.dir, "logs"), level: "error", stderr: false });
    const db = openDatabase({
      file: path.join(t.dir, "db", "t.db"),
      backupsDir: path.join(t.dir, "bk"),
      logger,
    });
    cleanups.push(() => {
      db.close();
      t.cleanup();
    });
    const root = path.join(t.dir, "copy");
    fs.mkdirSync(path.join(root, "fe"), { recursive: true });
    fs.writeFileSync(path.join(root, "fe", "page.tsx"), "export default function Home() {}\n");
    const bus = new EventBus(db.db, logger);
    let i = 0;
    const provider: ModelProvider = {
      id: "fake",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      health: async () => ({ ok: true, version: "fake", message: null }),
      listModels: async () => [],
      embed: async () => [],
      chat: (req) => {
        const reply = replies[Math.min(i++, replies.length - 1)];
        if (!reply) throw new Error("no reply scripted");
        return reply(req);
      },
    };
    const history: ChatMessage[] = [
      { role: "system", content: "You are a coder." },
      { role: "user", content: OWNER_FOLLOWUP },
    ];
    const events: { type: string; text: string }[] = [];
    const params: LoopParams = {
      provider,
      model: "qwen2.5-coder:3b",
      contextLength: 16_384,
      history,
      toolNames: ["write_file", "read_file", "list_dir"],
      ctx: { root, bus, approvals: new ApprovalCenter(bus), projectId: null, taskId: null, agent: "coder" },
      maxSteps: 10,
      signal: new AbortController().signal,
      job: { projectId: "prj_1", taskId: "tsk_1", label: "test" },
      emit: (e) => events.push({ type: e.type, text: e.text }),
      persist: () => {},
    };
    return { params, history, events };
  }

  const answer = (text: string) =>
    async function* (): AsyncIterable<ChatChunk> {
      yield { type: "text", delta: text };
      yield { type: "done", finishReason: "stop", usage: null };
    };

  test("the owner's 8,192-token reply is cut right after its first calls", async () => {
    // What the model wrote: a step, two calls inside a made-up <tool_response>, then 17 more steps.
    let sent = 0;
    const steps = (req: ChatRequest) =>
      (async function* (): AsyncIterable<ChatChunk> {
        const head = [
          "I apologize for the misunderstanding. Let's start again:\n1. Create the `fe` and `be` folders:\n````\n<tool_response>\n",
          '{\n  "name": "write_file",\n  "arguments": {\n    "path": "fe/",\n    "content": "Folder created."\n  }\n}\n',
          '{\n  "name": "write_file",\n  "arguments": {\n    "path": "be/",\n    "content": "Folder created."\n  }\n}\n',
          "</tool_response>\n````\n",
        ];
        for (const h of head) {
          sent += h.length;
          yield { type: "text", delta: h };
        }
        for (let n = 2; n < 5000; n++) {
          if (req.signal?.aborted) throw new ModelGatewayError("cancelled", "Cancelled");
          const step = `${n}. Create a \`src${n}\` folder in the \`fe\` folder:\n<tool_response>\n{"name": "write_file", "arguments": {"path": "fe/src${n}/", "content": "Folder created."}}\n</tool_response>\n\n`;
          sent += step.length;
          yield { type: "text", delta: step };
          await Promise.resolve();
        }
        yield { type: "done", finishReason: "length", usage: null };
      })();
    const { params, history, events } = setup([
      steps,
      answer("Added responsive breakpoints to fe/page.tsx."),
    ]);
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Added responsive breakpoints to fe/page.tsx.");
    // Stopped within a few hundred characters of the calls, not 30,000 characters later.
    expect(sent).toBeLessThan(1500);
    expect(events.some((e) => e.type === "retrying" && e.text.includes("Depo stopped it there"))).toBe(true);
    const tools = history.filter((m) => m.role === "tool").map((m) => m.content);
    expect(tools[0]).toContain("fe/ is a folder, not a file. It already exists and has: page.tsx.");
    expect(tools[1]).toContain("be/ is a folder, not a file.");
    expect(tools.some((t) => t.includes("src2"))).toBe(false);
    expect(history.some((m) => m.role === "user" && m.content.includes("wait for its result"))).toBe(true);
  });

  test("an answer that is a made-up tool result is sent back, then cleaned", async () => {
    const fake = "<tool_response>\napp/ (10 files)\ndb/ (3 files)";
    const { params, history, events } = setup([answer(fake), answer(fake), answer(`Done.\n${fake}`)]);
    const res = await runAgentLoop(params);
    expect(events.filter((e) => e.text.includes("wrote a tool result itself"))).toHaveLength(2);
    expect(
      history.some((m) => m.role === "user" && m.content.includes("Only Depo writes tool results")),
    ).toBe(true);
    expect(res.finalText).toBe("Done.");
  });
});
