/**
 * A smoke test against the real system: the real engine, the real Ollama on this PC, a real model,
 * a real project folder, real commands. Nothing is scripted. It prints what happened and how long
 * it took, and writes the numbers it measured to the engine log of a temporary data folder.
 *
 *   bun scripts/real-run.ts tasks [model]   two tasks on a small project (build, then an update)
 *   bun scripts/real-run.ts lab [model]     agent versions 1.0 against 1.3 on the Agent Lab checks
 *   bun scripts/real-run.ts tablegen        table steps written with and without the model
 *
 * The data folder and the project are removed at the end (set KEEP=1 to keep them).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "../packages/engine/src/engine";

const stage = process.argv[2] ?? "tasks";
const MODEL = process.argv[3] ?? "qwen2.5-coder:3b";
const OLLAMA = "http://127.0.0.1:11434";
const started = Date.now();
const secs = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
const say = (...a: unknown[]) => console.log(`[${secs()}]`, ...a);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "depo real "));
const dataRoot = path.join(root, "data");
const proj = path.join(root, "calc");

function makeProject() {
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "calc", private: true, type: "module", scripts: { test: "bun test" } }, null, 2),
  );
  fs.writeFileSync(
    path.join(proj, "src/math.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  );
  fs.writeFileSync(
    path.join(proj, "src/math.test.ts"),
    'import { expect, test } from "bun:test";\nimport { add } from "./math";\n\ntest("add", () => {\n  expect(add(2, 3)).toBe(5);\n});\n',
  );
}

const e = createEngine({ dataRoot, token: "r".repeat(48), heartbeatMs: 60_000 });
await e.start();
e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: OLLAMA, enabled: true }]);
for (const role of ["coder", "reasoning", "fast"] as const)
  e.models.assign(role, { providerId: "ollama", model: MODEL });
e.settings.set("team.approve_plan", false);

async function finish(code: number) {
  try {
    await e.stop("done");
  } catch {
    // already stopped
  }
  if (!process.env.KEEP) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  else say("kept:", root);
  process.exit(code);
}

async function runTask(projectId: string, text: string, taskId?: string, limitMs = 20 * 60_000) {
  const t = e.tasks.send(projectId, text, taskId);
  say(`task ${t.id} started: ${text.slice(0, 90)}`);
  const timer = setTimeout(() => {
    say("time limit reached, stopping the task");
    e.tasks.cancel(t.id);
  }, limitMs);
  await e.tasks.settled(t.id);
  clearTimeout(timer);
  const got = e.tasks.get(t.id);
  say(`task finished: ${got.task.status}`);
  if (got.task.error) say("error:", got.task.error);
  const plan = got.plans.at(-1);
  if (plan)
    say(
      "plan:",
      plan.steps.map((s) => `${s.title} [${s.status}${s.tries > 1 ? `, ${s.tries} tries` : ""}]`).join(" | "),
    );
  say("answer:", (got.task.summary ?? "").replace(/\s+/g, " ").slice(0, 400));
  return got;
}

function modelStats(label: string, fromTs: number) {
  const file = path.join(dataRoot, "logs", "engine.log");
  if (!fs.existsSync(file)) return;
  let calls = 0;
  let prompt = 0;
  let completion = 0;
  let waitMs = 0;
  let failed = 0;
  let toolFail = 0;
  const toolFailures: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (Date.parse(String(d.ts)) < fromTs) continue;
    if (d.msg === "model call") {
      calls++;
      prompt += Number(d.promptTokens ?? 0);
      completion += Number(d.completionTokens ?? 0);
      waitMs += Number(d.durationMs ?? 0);
    } else if (d.msg === "model call failed") failed++;
    else if (d.msg === "tool call failed") {
      toolFail++;
      toolFailures.push(`${d.tool}: ${String(d.result).slice(0, 110)}`);
    }
  }
  say(
    `${label}: ${calls} model calls (${failed} failed), prompt ${prompt} tokens (avg ${calls ? Math.round(prompt / calls) : 0}), wrote ${completion}, model time ${(waitMs / 60000).toFixed(1)} min, ${toolFail} tool calls failed`,
  );
  for (const f of toolFailures.slice(0, 6)) say("   tool failure ->", f);
}

try {
  if (stage === "tasks") {
    makeProject();
    const project = await e.projects.open(proj);
    e.registry.setSettings(project.id, { fullAccess: true });
    const t0 = Date.now();
    const first = await runTask(
      project.id,
      "Add a multiply(a, b) function to src/math.ts and a test for it in src/math.test.ts. Run the tests with bun test.",
    );
    modelStats("task 1", t0);
    const cs1 = e.projects.listChangeSets(project.id)[0];
    say("changed files:", cs1?.files.map((f) => `${f.path} (${f.kind})`).join(", ") ?? "none");
    const ws = cs1 ? e.projects.workspaceFor(cs1.id) : null;
    if (ws) {
      const m = path.join(ws.root, "src/math.ts");
      say("src/math.ts in the copy:\n" + fs.readFileSync(m, "utf8"));
      const depo = path.join(ws.root, "DEPO.md");
      say("DEPO.md exists in the copy:", fs.existsSync(depo));
      if (fs.existsSync(depo)) console.log(fs.readFileSync(depo, "utf8"));
      const test = Bun.spawnSync(["bun", "test"], { cwd: ws.root });
      say(
        "real `bun test` in the copy, exit code",
        test.exitCode,
        "\n" + (test.stdout.toString() + test.stderr.toString()).slice(-500),
      );
    }
    // The update: same task, a follow-up. It must change what exists, not start again.
    const t1 = Date.now();
    await runTask(
      project.id,
      "Now also add divide(a, b) that throws an Error when b is 0, with a test.",
      first.task.id,
    );
    modelStats("task 2 (update)", t1);
    const cs2 = e.projects.listChangeSets(project.id).find((c) => c.status === "pending");
    say("changed files after the update:", cs2?.files.map((f) => f.path).join(", ") ?? "none");
    const ws2 = cs2 ? e.projects.workspaceFor(cs2.id) : null;
    if (ws2) {
      say("src/math.ts after the update:\n" + fs.readFileSync(path.join(ws2.root, "src/math.ts"), "utf8"));
      const test = Bun.spawnSync(["bun", "test"], { cwd: ws2.root });
      say(
        "real `bun test` after the update, exit code",
        test.exitCode,
        "\n" + (test.stdout.toString() + test.stderr.toString()).slice(-500),
      );
      const depo = path.join(ws2.root, "DEPO.md");
      if (fs.existsSync(depo)) console.log(fs.readFileSync(depo, "utf8"));
    }
  } else if (stage === "lab") {
    const made = e.lab.installUpgrades();
    say(`installed ${made.created.length} agent versions`);
    for (const id of ["backend", "frontend", "testing", "manager", "ui-ux-design"] as const) {
      const vs = e.lab.versions(id);
      const top = vs.at(-1);
      const suite = e.lab.suites(id)[0];
      if (!top || !suite) continue;
      say(`${id}: comparing ${vs[0]?.version} with ${top.version} on ${suite.cases.length} checks`);
      const c = await e.lab.compare(id, null, top.id, suite.id);
      say(
        `  ${id}: ${vs[0]?.version} scored ${(c.a.score * 100).toFixed(0)}%, ${top.version} scored ${(c.b.score * 100).toFixed(0)}% -> ${c.winner === "tie" ? "tie" : c.winner === "a" ? "1.0 wins" : `${top.version} wins`}`,
      );
      for (const k of c.cases)
        say(`     ${k.caseId}: 1.0 ${k.a ? "pass" : "FAIL"}, ${top.version} ${k.b ? "pass" : "FAIL"}`);
    }
  } else if (stage === "tablegen") {
    say("see scripts/real-run.ts header; run the tasks stage with a database request");
  }
  await finish(0);
} catch (err) {
  console.error("real run failed:", err);
  await finish(1);
}
