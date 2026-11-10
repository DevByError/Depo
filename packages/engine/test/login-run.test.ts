import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ModelProvider } from "@depo/model-gateway";
import { type LoopParams, runAgentLoop } from "../src/agent/loop";
import { asksForChange, NOTHING_CHANGED, notDoneNote, stillToDo } from "../src/agent/request-check";
import { SMALL_MODEL_TOOLS } from "../src/agent/small";
import { unknownToolCalls } from "../src/agent/textcalls";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { tempDir } from "./helpers";

// The owner's login-system run (qwen2.5-coder:3b, two design references): the model wrote a call
// to a made-up tool as text, left open at the end ({"name": "safe-file-edits", "arguments":
// {"path": "fe/app/globals.css", "content": "…), nothing ran, and Depo took it as the answer.

const OPEN_CALL =
  '{"name": "safe-file-edits", "arguments": {"path":"fe/app/globals.css","content":"@tailwind base;\\n:root {\\n  --bg-color: #d7e3fe;\\n}\\n/* Typography */\\nbody { font-family: \'Arial\', sans-serif; }\\n';
const REQUEST =
  "* the first image is the UI/UX that i wat you to follow\n* the second image is the image you will use for the background\n\nbuild a Register - Login - Logout system that is working end to end\nthe UI should be responsible and follow the theme in the first photo";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("a request for a change that changed nothing is not done", () => {
  test("a made-up tool call left open at the end is caught", () => {
    expect(unknownToolCalls(OPEN_CALL, SMALL_MODEL_TOOLS)).toEqual(["safe-file-edits"]);
  });

  test("which requests ask for a change", () => {
    expect(asksForChange(REQUEST)).toBe(true);
    expect(asksForChange("make the header sticky")).toBe(true);
    expect(asksForChange("How do I add a page?")).toBe(false);
    expect(asksForChange("why does the login fail?")).toBe(false);
    expect(asksForChange("thanks")).toBe(false);
    expect(asksForChange("thanks", true)).toBe(true);
  });

  test("the to-do list: the change itself while no file changed", () => {
    const t = tempDir("depo todo");
    cleanup = t.cleanup;
    expect(stillToDo(REQUEST, t.dir, [])).toEqual([NOTHING_CHANGED]);
    expect(stillToDo(REQUEST, t.dir, ["fe/app/globals.css"])).toEqual([]);
    expect(stillToDo("why does it fail?", t.dir, [])).toEqual([]);
    // A follow-up question after a build request is judged by its own words.
    expect(
      stillToDo(`${REQUEST}\nhow does the login work?`, t.dir, [], { latest: "how does the login work?" }),
    ).toEqual([]);
    // A picture with no words still asks for a change.
    expect(stillToDo("like this", t.dir, [], { hasReferences: true })).toEqual([NOTHING_CHANGED]);
    expect(notDoneNote([NOTHING_CHANGED], true)).toContain("no file has changed");
  });

  test("the loop sends the model back until a file changes", async () => {
    const t = tempDir("depo login run");
    const root = path.join(t.dir, "copy");
    fs.mkdirSync(path.join(root, "fe/app"), { recursive: true });
    fs.writeFileSync(path.join(root, "fe/app/globals.css"), "body {}\n");
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
    const bus = new EventBus(db.db, logger);
    const replies = [
      OPEN_CALL,
      "Done: I updated the theme.",
      '{"name": "write_file", "arguments": {"path": "fe/app/theme.css", "content": ":root { --bg: #d7e3fe; }\\n"}}',
      "Done: added fe/app/theme.css with the reference's colours.",
    ];
    const seen: string[] = [];
    let i = 0;
    const provider: ModelProvider = {
      id: "fake",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      health: async () => ({ ok: true, version: "fake", message: null }),
      listModels: async () => [],
      embed: async () => [],
      chat: (req) => {
        seen.push(String(req.messages.at(-1)?.content ?? ""));
        const r = replies[Math.min(i++, replies.length - 1)] ?? "";
        return (async function* (): AsyncIterable<ChatChunk> {
          yield { type: "text", delta: r };
          yield { type: "done", finishReason: "stop", usage: null };
        })();
      },
    };
    const events: string[] = [];
    const params: LoopParams = {
      provider,
      model: "qwen2.5-coder:3b",
      contextLength: 16_384,
      history: [
        { role: "system", content: "You are a coder." },
        { role: "user", content: REQUEST },
      ],
      toolNames: SMALL_MODEL_TOOLS,
      ctx: {
        root,
        bus,
        approvals: new ApprovalCenter(bus),
        projectId: null,
        taskId: null,
        agent: "coder",
        readPaths: new Set(),
      },
      maxSteps: 10,
      signal: new AbortController().signal,
      job: { projectId: "prj_1", taskId: "tsk_1", label: "t" },
      emit: (e) => events.push(e.text),
      persist: () => {},
      fileBlocks: true,
      checkDone: ({ changed }) => stillToDo(REQUEST, root, changed),
    };
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Done: added fe/app/theme.css with the reference's colours.");
    expect(fs.readFileSync(path.join(root, "fe/app/theme.css"), "utf8")).toContain("#d7e3fe");
    expect(events.some((e) => e.includes("safe-file-edits"))).toBe(true);
    expect(seen.some((s) => s.startsWith("Not done yet: no file has changed"))).toBe(true);
  });
});
