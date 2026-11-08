import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ModelProvider } from "@depo/model-gateway";
import { type LoopParams, runAgentLoop } from "../src/agent/loop";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { executeTool, inferAppendPath, type ToolContext } from "../src/tools/index";
import { invalidStatements, longIdentifiers, onlyTables } from "../src/tools/sqlcheck";
import { tempDir } from "./helpers";

// Run 4 on the owner's PC (qwen2.5-coder:3b, Skill Finder part 1): invented tables with names so
// long that MySQL's own foreign key names passed 64 characters (ER_TOO_LONG_IDENT), ALTER TABLE IF
// NOT EXISTS lines, append_file calls without a path, a Next-style route file in the Bun backend,
// and replies that were only "```json".

const USERS = `CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL
);
`;
const LONG = "users_roles_permissions_roles_audit_logs_permissions_audit_logs";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function setup(files: Record<string, string> = {}): { root: string; ctx: ToolContext; dir: string } {
  const t = tempDir("depo guards");
  const root = path.join(t.dir, "copy");
  fs.mkdirSync(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
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
  return {
    root,
    dir: t.dir,
    ctx: {
      root,
      bus,
      approvals: new ApprovalCenter(bus),
      projectId: null,
      taskId: null,
      agent: "coder",
      readPaths: new Set(),
    },
  };
}

describe("names MySQL refuses as too long", () => {
  test("a table name whose implied foreign key name passes 64 characters", () => {
    const sql = `CREATE TABLE IF NOT EXISTS ${LONG} (\n  id INT PRIMARY KEY,\n  user_id BIGINT UNSIGNED,\n  FOREIGN KEY (user_id) REFERENCES users(id)\n);`;
    const p = longIdentifiers(sql);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain(`MySQL names them ${LONG}_ibfk_1`);
    expect(p[0]).toContain("at most 57 characters");
    // Without a foreign key the same name fits.
    expect(longIdentifiers(`CREATE TABLE IF NOT EXISTS ${LONG} (\n  id INT PRIMARY KEY\n);`)).toEqual([]);
    // A named constraint does not get the implied name.
    expect(
      longIdentifiers(
        `CREATE TABLE ${LONG} (\n  user_id BIGINT UNSIGNED,\n  CONSTRAINT fk_u FOREIGN KEY (user_id) REFERENCES users(id)\n);`,
      ),
    ).toEqual([]);
    expect(longIdentifiers(`CREATE TABLE t (\n  ${"c".repeat(70)} INT\n);`)[0]).toContain(
      "is 70 characters long",
    );
  });

  test("append_file refuses them, and so does an edit that adds them", async () => {
    const { ctx, root } = setup({ "be/src/db/schema.sql": USERS });
    const sql = `CREATE TABLE IF NOT EXISTS ${LONG} (\n  id INT PRIMARY KEY,\n  user_id BIGINT UNSIGNED,\n  FOREIGN KEY (user_id) REFERENCES users(id)\n);\n`;
    const r = await executeTool("append_file", { path: "be/src/db/schema.sql", content: sql }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Nothing was added");
    expect(fs.readFileSync(path.join(root, "be/src/db/schema.sql"), "utf8")).toBe(USERS);
    ctx.readPaths?.add("be/src/db/schema.sql");
    const w = await executeTool("write_file", { path: "be/src/db/schema.sql", content: USERS + sql }, ctx);
    expect(w.isError).toBe(true);
    expect(w.content).toContain("is as it was before");
    expect(fs.readFileSync(path.join(root, "be/src/db/schema.sql"), "utf8")).toBe(USERS);
  });
});

describe("a table step adds only its table", () => {
  const ADDED = `CREATE TABLE IF NOT EXISTS favorites (\n  user_id BIGINT UNSIGNED NOT NULL,\n  skill_id BIGINT UNSIGNED NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS bookings (\n  id INT PRIMARY KEY\n);\n\nALTER TABLE IF NOT EXISTS skills ADD COLUMN x INT;\nCREATE INDEX favorites_skill ON favorites (skill_id);\n`;

  test("other tables, ALTERs and stray statements are left out", () => {
    const o = onlyTables(ADDED, ["favorites"]);
    expect(o.dropped).toEqual(["bookings"]);
    expect(o.other).toBe(1);
    expect(o.sql).toContain("CREATE TABLE IF NOT EXISTS favorites");
    expect(o.sql).toContain("CREATE INDEX favorites_skill ON favorites (skill_id);");
    expect(o.sql).not.toContain("bookings");
    expect(o.sql).not.toContain("ALTER");
  });

  test("append_file in a table step says what it left out", async () => {
    const { ctx, root } = setup({ "be/src/db/schema.sql": USERS });
    ctx.step = { tables: ["favorites"], schemaFile: "be/src/db/schema.sql" };
    const r = await executeTool("append_file", { path: "be/src/db/schema.sql", content: ADDED }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain(
      "Depo left out the table bookings and 1 other statement: this step adds only favorites.",
    );
    const after = fs.readFileSync(path.join(root, "be/src/db/schema.sql"), "utf8");
    expect(after).toContain("favorites");
    expect(after).not.toContain("bookings");
    const none = await executeTool(
      "append_file",
      { path: "be/src/db/schema.sql", content: "CREATE TABLE IF NOT EXISTS bookings (id INT);\n" },
      ctx,
    );
    expect(none.isError).toBe(true);
    expect(none.content).toContain("this step adds the favorites table");
  });

  test("outside a step, ALTER TABLE IF NOT EXISTS is still left out", () => {
    const r = invalidStatements("CREATE TABLE a (id INT);\nALTER TABLE IF NOT EXISTS a ADD COLUMN b INT;\n");
    expect(r.dropped).toHaveLength(1);
    expect(r.sql).toBe("CREATE TABLE a (id INT);\n");
  });
});

describe("append_file without a path", () => {
  test("SQL goes to the schema file; other text to the step's main file", () => {
    const { root } = setup({
      "be/src/db/schema.sql": USERS,
      "be/migrations/old.sql": "CREATE TABLE x (id INT);",
    });
    expect(inferAppendPath({ content: "CREATE TABLE IF NOT EXISTS t (id INT);" }, { root })).toEqual({
      content: "CREATE TABLE IF NOT EXISTS t (id INT);",
      path: "be/src/db/schema.sql",
    });
    expect(inferAppendPath({ content: "export const x = 1;" }, { root })).toBeNull();
    expect(
      inferAppendPath({ content: "export const x = 1;" }, { root, step: { mainFile: "be/src/app.ts" } }),
    ).toEqual({
      content: "export const x = 1;",
      path: "be/src/app.ts",
    });
    expect(inferAppendPath({ path: "a.sql", content: "x" }, { root })).toBeNull();
  });
});

describe("a Next-style route file in a Bun backend", () => {
  test("is refused with where the routes are", async () => {
    const { ctx, root } = setup({
      "be/package.json": JSON.stringify({ name: "be", dependencies: { mysql2: "1" } }),
      "be/src/app.ts": 'const routes = {\n  "GET /api/health": () => 1,\n};\n',
      "fe/package.json": JSON.stringify({ name: "fe", dependencies: { next: "15" } }),
    });
    const r = await executeTool(
      "write_file",
      { path: "be/src/app/api/skills/search.ts", content: "export async function GET() {}\n" },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Its routes are in be/src/app.ts");
    expect(fs.existsSync(path.join(root, "be/src/app"))).toBe(false);
    // The Next.js app may have route handlers.
    const ok = await executeTool(
      "write_file",
      {
        path: "fe/app/api/hello/route.ts",
        content: "export async function GET() {\n  return new Response('hi');\n}\n",
      },
      ctx,
    );
    expect(ok.isError).toBe(false);
  });
});

describe("replies that are only an empty code fence", () => {
  test('"```json" is an empty reply: the model is asked to go on, then the larger model takes over', async () => {
    const { ctx } = setup();
    const replies = ["```json", "```json\n```", "Done: wrote it."];
    const models: string[] = [];
    let i = 0;
    const provider: ModelProvider = {
      id: "fake",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      health: async () => ({ ok: true, version: "fake", message: null }),
      listModels: async () => [],
      embed: async () => [],
      chat: (req) => {
        models.push(req.model);
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
        { role: "user", content: "Build it." },
      ],
      toolNames: ["write_file", "read_file"],
      ctx,
      maxSteps: 6,
      signal: new AbortController().signal,
      job: { projectId: "prj_1", taskId: "tsk_1", label: "t" },
      emit: (e) => events.push(e.text),
      persist: () => {},
      stepUp: { model: "qwen2.5-coder:7b" },
    };
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Done: wrote it.");
    expect(models).toEqual(["qwen2.5-coder:3b", "qwen2.5-coder:3b", "qwen2.5-coder:7b"]);
    expect(events).toContain("The model stopped without a word. Asking it to go on.");
    expect(
      events.some((e) =>
        e.startsWith("The model stopped without a word again, so Depo asked qwen2.5-coder:7b"),
      ),
    ).toBe(true);
  });
});
