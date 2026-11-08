import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { DepoEvent } from "@depo/shared";
import { startFakeOllama } from "../../../scripts/fake-ollama-lib";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir } from "./helpers";

// A request with sections runs as Depo's step plan (ADR-0086): the plan is saved before the model
// starts, each step runs on its own, Depo's feedback shows as Depo's step (not as the owner), and
// the answer says what is done and what is not.

let engine: Engine | null = null;
let stopFake = () => {};
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  stopFake();
  cleanup();
  cleanup = () => {};
});

const REQUEST = `Build the notes app.

Keep its structure: routes in be/src/app.ts, new tables at the end of be/src/db/schema.sql.

## Database
- notes: id, title, body
- tags: id, name, color

## API
- GET /api/notes : the notes, newest first
`;

async function setup() {
  const t = tempDir("depo step mode");
  cleanup = t.cleanup;
  const fake = startFakeOllama();
  stopFake = fake.stop;
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    tasks: { retryDelayMs: 10 },
  });
  engine = e;
  await e.start();
  e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: fake.url, enabled: true }]);
  e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
  const proj = path.join(t.dir, "notes app");
  fs.mkdirSync(path.join(proj, "be/src/db"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, "be/src/db/schema.sql"),
    "CREATE TABLE IF NOT EXISTS users (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY\n);\n",
  );
  fs.writeFileSync(
    path.join(proj, "be/src/app.ts"),
    'export const routes = {\n  "GET /api/health": () => ({ ok: true }),\n};\n',
  );
  const project = await e.projects.open(proj);
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  return { e, project, events };
}

describe("step mode", () => {
  test("the plan is shown first, steps run one by one, a step that never passes is named", async () => {
    const { e, project, events } = await setup();
    const task = e.tasks.send(project.id, REQUEST);
    await e.tasks.settled(task.id);
    const { task: done, messages, plans } = e.tasks.get(task.id);
    expect(done.status).toBe("review");

    expect(plans).toHaveLength(1);
    const plan = plans[0];
    const firstUser = messages.find((m) => m.role === "user");
    expect(plan?.messageId).toBe(firstUser?.id ?? "");
    expect(plan?.steps.map((s) => [s.title, s.status])).toEqual([
      ["Add the notes table", "done"],
      ["Add the tags table", "blocked"],
      ["Build GET /api/notes", "done"],
      // Tests run with Depo's finish line off.
      ["Run the app and check it", "skipped"],
    ]);
    expect(plan?.steps[1]?.note).toContain("missing the column color");

    // The plan was saved before any step ran: the first plan event comes before the first model reply.
    const planned = events.findIndex((ev) => ev.taskId === task.id && ev.details?.stepPlan === true);
    const replied = events.findIndex(
      (ev) => ev.taskId === task.id && ev.type === "thinking" && !ev.ephemeral,
    );
    expect(planned).toBeGreaterThanOrEqual(0);
    expect(planned).toBeLessThan(replied);

    // Only the owner's message is a user item; Depo's checks are Depo's steps.
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    const depo = messages.filter((m) => m.agent === "tester@depo");
    expect(depo.length).toBeGreaterThan(0);
    expect(depo[0]?.role).toBe("assistant");
    expect(depo[0]?.text).toContain('Depo checked "Add the tags table" and it is not done yet:');

    // The answer says what is done and what is not.
    const answer = messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
    expect(answer).toContain("3 of 4 steps are done. One step is not done yet:");
    expect(answer).toContain('Send "go on"');
    expect(done.summary).toContain("Add the tags table");
  }, 60_000);
});
