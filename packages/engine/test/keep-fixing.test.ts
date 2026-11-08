import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ChatMessage, ChatRequest, ModelProvider } from "@depo/model-gateway";
import { FixRounds, finishSummary, MAX_FIX_ROUNDS, problemKey, problemsPrompt } from "../src/agent/finish";
import { FIX_STEPS, type LoopParams, runAgentLoop } from "../src/agent/loop";
import { runUntilWorking } from "../src/agent/tasks";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { tempDir } from "./helpers";

// The owner's rule: when the app shows an error, the agents read it and fix it again and again
// until it works. Depo stops only when fixing gets nowhere (the same error keeps coming back,
// also with the larger model), and then it says so.

const MIGRATE = (line: number) =>
  `\`bun run db:migrate\` in be failed against the test database:\nat schema.sql:${line}\nerror: Referencing column 'user_id' and referenced column 'id' in foreign key constraint 'scans_ibfk_1' are incompatible.`;

describe("fix rounds go on while fixing gets somewhere", () => {
  test("new problems are fixed; the same problem again goes to the larger model; the 4th time stops", () => {
    const r = new FixRounds();
    expect(r.next([MIGRATE(40)])).toBe("fix");
    expect(r.next(["Bun app in be did not start:\nerror: Cannot find module './skills'"])).toBe("fix");
    expect(r.next(["Bun app in be did not start:\nerror: Cannot find module './skills'"])).toBe("again");
    expect(r.next(["Bun app in be did not start:\nerror: Cannot find module './skills'"])).toBe("again");
    expect(r.stopped).toBeNull();
    expect(r.next(["Bun app in be did not start:\nerror: Cannot find module './skills'"])).toBe("stop");
    expect(r.stopped).toBe(
      "Depo stopped after 4 rounds of fixing: the same problem came back 3 times after a fix.",
    );
    expect(r.rounds).toBe(4);
  });

  test("line numbers and ports do not make a problem new", () => {
    expect(problemKey(MIGRATE(40))).toBe(problemKey(MIGRATE(57)));
    expect(problemKey(MIGRATE(40))).not.toBe(problemKey("Tests failed in be:\nerror: expected 2, got 3"));
  });

  test("at most MAX_FIX_ROUNDS rounds, even while the problems keep changing", () => {
    const r = new FixRounds();
    for (let i = 0; i < MAX_FIX_ROUNDS; i++) expect(r.next([`problem ${"x".repeat(i + 1)}`])).toBe("fix");
    expect(r.next(["one more"])).toBe("stop");
    expect(r.stopped).toBe(
      `Depo stopped after ${MAX_FIX_ROUNDS} rounds of fixing, the most it does in one run.`,
    );
  });

  test("the same problem again tells the model its fix did not work; a stop is explained to the owner", () => {
    const res = { problems: [MIGRATE(40)], running: [], notes: [], blocked: [] };
    expect(problemsPrompt(res, { again: true })).toContain("the same problem is still there");
    expect(problemsPrompt(res, { again: true })).toContain("Look for a different cause");
    const summary = finishSummary(
      res,
      "Depo stopped after 4 rounds of fixing: the same problem came back 3 times after a fix.",
    );
    expect(summary).toContain("Still not working:");
    expect(summary).toContain('Send "go on" to keep fixing');
  });
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

type Reply = string | { name: string; arguments: Record<string, unknown> };

function setup(replies: Reply[], over: Partial<LoopParams> = {}) {
  const t = tempDir("depo keep fixing");
  const root = path.join(t.dir, "copy");
  fs.mkdirSync(root);
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
      const r = replies[Math.min(i++, replies.length - 1)];
      const n = i;
      return (async function* (): AsyncIterable<ChatChunk> {
        if (typeof r === "string") yield { type: "text", delta: r };
        else if (r)
          yield {
            type: "tool_call",
            call: {
              id: `c${n}`,
              name: r.name,
              arguments: r.arguments,
              rawArguments: JSON.stringify(r.arguments),
            },
          } as ChatChunk;
        yield { type: "done", finishReason: "stop", usage: null };
      })();
    },
  };
  const history: ChatMessage[] = [
    { role: "system", content: "You are a coder." },
    { role: "user", content: "Build the API." },
  ];
  const events: string[] = [];
  const params: LoopParams = {
    provider,
    model: "qwen2.5-coder:3b",
    contextLength: 16_384,
    history,
    toolNames: ["write_file", "read_file"],
    ctx: { root, bus, approvals: new ApprovalCenter(bus), projectId: null, taskId: null, agent: "coder" },
    maxSteps: 3,
    signal: new AbortController().signal,
    job: { projectId: "prj_1", taskId: "tsk_1", label: "t" },
    emit: (e) => events.push(e.text),
    persist: () => {},
    ...over,
  };
  return { params, requests, history, events, root };
}

const write = (content: string): Reply => ({
  name: "write_file",
  arguments: { path: "be/src/index.ts", content },
});

describe("the loop keeps fixing", () => {
  test("every fix round gets its own steps, so fixing goes past the step limit", async () => {
    const { params } = setup([
      write("a"),
      "Done.",
      write("b"),
      "Fixed the migration.",
      write("c"),
      "Fixed the start script.",
      write("d"),
      "Fixed the page.",
    ]);
    let round = 0;
    params.beforeFinish = async () => {
      round++;
      if (round === 1) return { retry: `Depo found:\n- ${MIGRATE(40)}` };
      if (round === 2) return { retry: "Depo found:\n- Bun app in be did not start" };
      if (round === 3) return { retry: "Depo found:\n- console error: x is not defined" };
      return { append: "Running now: http://127.0.0.1:3000/" };
    };
    const res = await runAgentLoop(params);
    expect(round).toBe(4);
    expect(res.steps).toBe(8);
    expect(res.hitLimit).toBe(false);
    expect(res.finalText).toBe("Fixed the page.\n\nRunning now: http://127.0.0.1:3000/");
  });

  test("when the same problem comes back, the larger model takes the next round, then hands back", async () => {
    const { params, requests, events } = setup(
      [write("a"), "Done.", write("b"), "Fixed.", write("c"), "Fixed it properly."],
      {
        stepUp: { model: "qwen2.5-coder:7b" },
        maxSteps: 10,
      },
    );
    let round = 0;
    params.beforeFinish = async () => {
      round++;
      if (round === 1) return { retry: `Depo found:\n- ${MIGRATE(40)}` };
      if (round === 2) return { retry: `Depo ran it again:\n- ${MIGRATE(40)}`, stepUp: true };
      return { append: "Running now: http://127.0.0.1:3000/" };
    };
    const res = await runAgentLoop(params);
    expect(res.finalText).toContain("Fixed it properly.");
    expect(requests.map((r) => r.model.replace("qwen2.5-coder:", ""))).toEqual([
      "3b",
      "3b",
      "3b",
      "3b",
      "7b",
      "7b",
    ]);
    expect(events).toContain(
      "The same problem came back after qwen2.5-coder:3b's fix, so Depo asked qwen2.5-coder:7b to fix it. Depo goes back to qwen2.5-coder:3b after the fix.",
    );
    expect(events.some((e) => e.startsWith("qwen2.5-coder:7b finished its fix"))).toBe(true);
  });
});

describe("out of steps with errors left: Depo keeps fixing", () => {
  test("the run goes on with fresh steps and the report open until the app runs", async () => {
    const { params, history, events } = setup(
      [write("a"), write("b"), write("c"), "Fixed the start script."],
      {
        maxSteps: 2,
      },
    );
    const added: ChatMessage[] = [];
    let checks = 0;
    const checkApp = async () => {
      checks++;
      return checks === 1
        ? { retry: "Depo tried to run your work:\n- Bun app in be did not start" }
        : { append: "Running now: http://127.0.0.1:4000/" };
    };
    params.beforeFinish = checkApp;
    const out = await runUntilWorking({
      params,
      checkApp,
      hasChanges: () => true,
      addMessage: (m) => added.push(m),
      emit: params.emit,
      signal: params.signal,
    });
    expect(out.steps).toBe(4);
    expect(out.result.finalText).toBe("Fixed the start script.\n\nRunning now: http://127.0.0.1:4000/");
    expect(out.report).toBe("");
    expect(events).toContain(
      `The model used its 2 steps and Depo found problems in the app, so it goes on fixing them with ${FIX_STEPS} more steps.`,
    );
    expect(added[0]?.content).toContain("Bun app in be did not start");
    expect(history.some((m) => m.role === "user" && m.content.includes("Bun app in be did not start"))).toBe(
      true,
    );
  });

  test("a reply that changes nothing while fixing is pushed back; with stepUp the larger model starts", async () => {
    const { params, requests, history } = setup(["It works now.", write("x"), "Fixed."], {
      stepUp: { model: "qwen2.5-coder:7b" },
      fixing: {
        report: "Depo tried to run your work:\n- Bun app in be did not start\nerror: Cannot find module",
        stepUp: true,
      },
      maxSteps: 5,
    });
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Fixed.");
    expect(requests[0]?.model).toBe("qwen2.5-coder:7b");
    expect(
      history.some(
        (m) => m.role === "user" && m.content.startsWith("You changed nothing since Depo's report"),
      ),
    ).toBe(true);
  });

  test("when Depo stops fixing, the run report says why", async () => {
    const { params } = setup([write("a")], { maxSteps: 1 });
    const stopped = finishSummary(
      { problems: [MIGRATE(40)], running: [], notes: [], blocked: [] },
      "Depo stopped after 4 rounds of fixing: the same problem came back 3 times after a fix.",
    );
    const out = await runUntilWorking({
      params,
      checkApp: async () => ({ append: stopped }),
      hasChanges: () => true,
      addMessage: () => {},
      emit: params.emit,
      signal: params.signal,
    });
    expect(out.result.hitLimit).toBe(true);
    expect(out.report).toContain('Send "go on" to keep fixing');
  });
});
