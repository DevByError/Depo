import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ChatRequest, ModelProvider, ToolCall } from "@depo/model-gateway";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir } from "./helpers";

process.env.DEPO_NO_BROWSER = "1";

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

let id = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: `c${++id}`,
  name,
  arguments: args,
  rawArguments: JSON.stringify(args),
});

/**
 * A scripted team for "backend only" work. The Backend agent writes insecure code and the Security
 * agent finds it through the security_scan tool that the engine hands it as an extra. Another
 * agent uses a building block. Nothing here knows about the engine's internals: it only sees prompts and tools.
 */
function team(seen: { tools: Set<string>; toolResults: string[] }): ModelProvider {
  return {
    id: "fake",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:1",
    async health() {
      return { ok: true, version: "fake", message: null };
    },
    async listModels() {
      return [];
    },
    async embed(_m, inputs) {
      return inputs.map(() => [0]);
    },
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      for (const t of req.tools ?? []) seen.tools.add(t.name);
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      const who = /You are the ([\w/ -]+?) agent\./.exec(sys)?.[1] ?? "";
      const n = req.messages.filter((m) => m.role === "tool").length;
      for (const m of req.messages) if (m.role === "tool") seen.toolResults.push(m.content);
      let calls: ToolCall[] = [];
      let text = `${who || "Agent"} done.`;
      if (req.jsonSchema && sys.includes("Plan the work as a task graph")) {
        text = "no plan today";
      } else if (who === "Backend" && n === 0) {
        calls = [call("use_block", { id: "rate-limit-ts" })];
      } else if (who === "Backend" && n === 1) {
        calls = [
          call("write_file", {
            path: "src/legacy.py",
            content:
              "import hashlib\n\ndef h(p):\n    return hashlib.md5(p.encode()).hexdigest()\n\nresult = eval(input())\n",
          }),
        ];
      } else if (who === "Testing" && n === 0) {
        calls = [call("run_command", { command: "bun test" })];
      } else if (who === "Security" && n === 0) {
        calls = [call("security_scan", {})];
      } else if (who === "Security" && n === 1) {
        calls = [
          call("bb_write", {
            section: "reviews/security.md",
            content: "Scanned: blocking findings in src/legacy.py.",
          }),
        ];
      }
      if (calls.length) text = "";
      if (text) yield { type: "text", delta: text };
      for (const c of calls) yield { type: "tool_call", call: c };
      yield { type: "done", finishReason: calls.length ? "tool_calls" : "stop", usage: null };
    },
  } as ModelProvider;
}

test("a team run uses building blocks and the Security agent's scanner, and the score reaches the dashboard", async () => {
  const t = tempDir("depo integration");
  cleanup = t.cleanup;
  const seen = { tools: new Set<string>(), toolResults: [] as string[] };
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    tasks: { retryDelayMs: 10 },
    models: { providerFactory: () => team(seen) },
  });
  engine = e;
  await e.start();
  e.models.setProviders([{ id: "fake", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }]);
  e.models.assign("coder", { providerId: "fake", model: "fake-model" });
  e.models.assign("reasoning", { providerId: "fake", model: "fake-model" });
  e.settings.set("team.approve_plan", false);
  e.settings.set("team.reviews", "off");
  const proj = path.join(t.dir, "app");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "app", scripts: { test: "bun test" } }),
  );
  fs.writeFileSync(
    path.join(proj, "src", "app.test.ts"),
    'import { expect, test } from "bun:test";\ntest("works", () => expect(1 + 1).toBe(2));\n',
  );
  const project = await e.projects.open(proj);

  const task = e.tasks.send(project.id, "add a legacy hasher", undefined, "backend");
  await e.tasks.settled(task.id);
  expect(e.tasks.get(task.id).task.status).not.toBe("failed");

  // The tools were offered to the right agents.
  expect(seen.tools.has("use_block")).toBe(true);
  expect(seen.tools.has("security_scan")).toBe(true);
  expect(seen.tools.has("performance_check")).toBe(true);

  // The block was added in the private workspace and the scan saw the insecure file.
  const ws = e.tasks.workspaceRoot(task.id) as string;
  expect(fs.existsSync(path.join(ws, "src/rate-limit/index.ts"))).toBe(true);
  expect(fs.existsSync(path.join(proj, "src/rate-limit/index.ts"))).toBe(false);
  const scan = seen.toolResults.find((r) => r.startsWith("Security score"));
  expect(scan).toContain("src/legacy.py");
  expect(scan).toContain("RELEASE BLOCKED");

  // The score is on the blackboard, the report is a project note, and the dashboard can read it.
  const score = JSON.parse(e.tasks.blackboard.read(project.id, "scores/security.json")?.content ?? "{}");
  expect(score.blocksRelease).toBe(true);
  expect(score.overall).toBeLessThan(100);
  expect(e.tasks.blackboard.read(project.id, "reviews/security-scan.md")?.content).toContain("py.eval");
  const { handlers } = await import("../src/api/handlers");
  const scores = (await handlers["scores.get"]?.({ projectId: project.id }, {
    tasks: e.tasks,
  } as never)) as { security: { blocksRelease: boolean } | null };
  expect(scores.security?.blocksRelease).toBe(true);

  // The final answer tells the person the release is blocked.
  const final = e.tasks
    .get(task.id)
    .messages.map((m) => m.text)
    .join(" ");
  expect(final).toContain("Quality scores:");
  expect(final).toContain("blocks the release");

  // The audit trail shows the scan.
  const recent = e.bus.recent({ limit: 500 });
  expect(recent.some((ev) => ev.type === "security_scan" && ev.taskId === task.id)).toBe(true);
}, 90_000);
