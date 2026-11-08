import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ChatMessage, ChatRequest, ModelProvider } from "@depo/model-gateway";
import { type LoopParams, runAgentLoop } from "../src/agent/loop";
import { missingParts, notDoneNote, requestedParts } from "../src/agent/request-check";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { executeTool, onlyComments, type ToolContext } from "../src/tools/index";
import { foreignKeyProblems } from "../src/tools/sqlcheck";
import { tempDir } from "./helpers";

// The blueprint's tables, then the tables qwen2.5-coder:3b added on the owner's PC (user_id INT).
const USERS = `CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY users_email (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;
const SCANS = `CREATE TABLE IF NOT EXISTS scans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(10) NOT NULL,
  message TEXT,
  user_id INT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

const PART1 = `Build "Skill Finder".

## Search API
GET /api/skills/search?q=&sort=best|stars|updated&scripts=1&offset=0&limit=20 returns { items, total }.

## Skill API (query parameters, so the existing route table works)
- GET /api/skill?id= : the skill with skillMd, files and safety.
- GET /api/skill/file?id=&path= : one text file, at most 200 KB.
- GET /api/skill/download?id= : a ZIP of the skill folder.

## Front end
- / : a big search box labelled "What should your agent be able to do?".
- /skills/[id] : name, description, a repo link.
`;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function project(): { root: string; dir: string } {
  const t = tempDir("depo finish guards");
  cleanup = t.cleanup;
  const root = path.join(t.dir, "proj");
  fs.mkdirSync(path.join(root, "be", "src", "db"), { recursive: true });
  fs.mkdirSync(path.join(root, "fe", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "be", "src", "db", "schema.sql"), USERS);
  fs.writeFileSync(
    path.join(root, "be", "src", "app.ts"),
    'const routes = {\n  "GET /api/health": health,\n  "POST /api/auth/login": login,\n};\n',
  );
  fs.writeFileSync(
    path.join(root, "fe", "app", "layout.tsx"),
    "export default function L() { return null; }\n",
  );
  fs.writeFileSync(
    path.join(root, "fe", "app", "page.tsx"),
    "export default function P() { return null; }\n",
  );
  return { root, dir: t.dir };
}

describe("foreign keys MySQL refuses are found before the migration", () => {
  test("the owner's scans.user_id INT against users.id BIGINT UNSIGNED", () => {
    const problems = foreignKeyProblems(USERS + SCANS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      "scans.user_id is INT but it references users.id, which is BIGINT UNSIGNED",
    );
    expect(problems[0]).toContain("Declare scans.user_id as BIGINT UNSIGNED");
  });

  test("matching types, inline references and string keys are fine; unknown tables are skipped", () => {
    const ok = `${USERS}
CREATE TABLE IF NOT EXISTS favorites (
  user_id BIGINT UNSIGNED NOT NULL REFERENCES users(id),
  skill_id INT NOT NULL,
  note VARCHAR(20) DEFAULT 'a,b',
  PRIMARY KEY (user_id, skill_id),
  CONSTRAINT fav_skill FOREIGN KEY (skill_id) REFERENCES skills(id)
);
CREATE TABLE IF NOT EXISTS tags (code CHAR(8) PRIMARY KEY);
CREATE TABLE IF NOT EXISTS skill_tags (tag VARCHAR(8), FOREIGN KEY (tag) REFERENCES tags(code));`;
    expect(foreignKeyProblems(ok)).toEqual([]);
    const inlineWrong = `${USERS}CREATE TABLE t (owner INT UNSIGNED REFERENCES users(id));`;
    expect(foreignKeyProblems(inlineWrong)[0]).toContain("t.owner is INT UNSIGNED");
  });

  test("text that is only comments", () => {
    expect(onlyComments("\n\n-- Additional tables as needed\n")).toBe(true);
    expect(onlyComments("/* later */\n# note\n")).toBe(true);
    expect(onlyComments("-- skills\nCREATE TABLE skills (id INT);")).toBe(false);
    expect(onlyComments("# Notes\n", "be/notes.md")).toBe(false);
  });
});

describe("append_file on the owner's schema", () => {
  function ctxFor(root: string, dir: string): ToolContext {
    const logger = createLogger({ dir: path.join(dir, "logs"), level: "error", stderr: false });
    const db = openDatabase({ file: path.join(dir, "db", "t.db"), backupsDir: path.join(dir, "bk"), logger });
    const prev = cleanup;
    cleanup = () => {
      db.close();
      prev?.();
    };
    const bus = new EventBus(db.db, logger);
    return {
      root,
      bus,
      approvals: new ApprovalCenter(bus),
      projectId: null,
      taskId: null,
      agent: "coder",
      readPaths: new Set<string>(),
    };
  }

  test("needs the file read first (and shows it), refuses a comment, and warns about a bad foreign key", async () => {
    const { root, dir } = project();
    const ctx = ctxFor(root, dir);
    const first = await executeTool("append_file", { path: "be/src/db/schema.sql", content: SCANS }, ctx);
    expect(first.isError).toBe(true);
    expect(first.content).toContain("you had not read be/src/db/schema.sql");
    expect(first.content).toContain("id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY");
    // Shown once, so it now counts as read.
    const comment = await executeTool(
      "append_file",
      { path: "be/src/db/schema.sql", content: "\n-- Additional tables as needed\n" },
      ctx,
    );
    expect(comment.isError).toBe(true);
    expect(comment.content).toContain("only a comment");
    const added = await executeTool("append_file", { path: "be/src/db/schema.sql", content: SCANS }, ctx);
    expect(added.isError).toBe(false);
    expect(added.content).toContain("Warning from Depo: the migration will fail.");
    expect(added.content).toContain("Declare scans.user_id as BIGINT UNSIGNED");
    const fixed = await executeTool(
      "edit_file",
      {
        path: "be/src/db/schema.sql",
        edits: [{ search: "  user_id INT,", replace: "  user_id BIGINT UNSIGNED," }],
      },
      ctx,
    );
    expect(fixed.content).toBe("Applied 1 edit(s) to be/src/db/schema.sql.");
  });
});

describe("parts of the request that are not built yet", () => {
  test("routes and pages are read from the request", () => {
    const parts = requestedParts(PART1);
    expect(parts.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/skills/search",
      "GET /api/skill",
      "GET /api/skill/file",
      "GET /api/skill/download",
    ]);
    expect(parts.pages).toEqual(["/", "/skills/[id]"]);
  });

  test("what is missing shrinks as the code is written; /api/skill is not /api/skills/search", () => {
    const { root } = project();
    expect(missingParts(PART1, root)).toEqual([
      "the route GET /api/skills/search",
      "the route GET /api/skill",
      "the route GET /api/skill/file",
      "the route GET /api/skill/download",
      "the page /skills/[id] (fe/app/skills/[id]/page.tsx)",
    ]);
    fs.appendFileSync(path.join(root, "be", "src", "app.ts"), 'routes["GET /api/skills/search"] = search;\n');
    fs.mkdirSync(path.join(root, "fe", "app", "skills", "[skillId]"), { recursive: true });
    fs.writeFileSync(path.join(root, "fe", "app", "skills", "[skillId]", "page.tsx"), "export default 1;\n");
    expect(missingParts(PART1, root)).toEqual([
      "the route GET /api/skill",
      "the route GET /api/skill/file",
      "the route GET /api/skill/download",
    ]);
    // Code in node_modules does not count.
    fs.mkdirSync(path.join(root, "be", "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(root, "be", "node_modules", "x", "i.js"), '"/api/skill" "/api/skill/file"');
    expect(missingParts(PART1, root)).toHaveLength(3);
    expect(notDoneNote(["the route GET /api/skill"], true)).toContain("write the code as file blocks");
    expect(missingParts("Make the buttons blue.", root)).toEqual([]);
  });
});

describe("the loop does not accept an unfinished or unchanged answer", () => {
  const answer = (text: string) =>
    async function* (): AsyncIterable<ChatChunk> {
      if (text) yield { type: "text", delta: text };
      yield { type: "done", finishReason: "stop", usage: null };
    };

  function setup(replies: string[]) {
    const { root, dir } = project();
    const logger = createLogger({ dir: path.join(dir, "logs"), level: "error", stderr: false });
    const db = openDatabase({ file: path.join(dir, "db", "t.db"), backupsDir: path.join(dir, "bk"), logger });
    const prev = cleanup;
    cleanup = () => {
      db.close();
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
        return answer(replies[Math.min(i++, replies.length - 1)] ?? "")();
      },
    };
    const history: ChatMessage[] = [
      { role: "system", content: "You are a coder." },
      { role: "user", content: PART1 },
    ];
    const events: string[] = [];
    const params: LoopParams = {
      provider,
      model: "qwen2.5-coder:3b",
      contextLength: 16_384,
      history,
      toolNames: ["read_file", "write_file", "edit_file", "append_file", "run_command"],
      ctx: { root, bus, approvals: new ApprovalCenter(bus), projectId: null, taskId: null, agent: "coder" },
      maxSteps: 20,
      signal: new AbortController().signal,
      job: { projectId: "prj_1", taskId: "tsk_1", label: "test" },
      emit: (e) => events.push(e.text),
      persist: () => {},
      fileBlocks: true,
    };
    return { params, requests, history, events, root };
  }

  const call = (name: string, args: Record<string, unknown>) => JSON.stringify({ name, arguments: args });

  test("an empty answer and an answer with parts missing are sent back until the parts exist", async () => {
    const route = (p: string) =>
      call("edit_file", {
        path: "be/src/app.ts",
        edits: [{ search: "const routes = {", replace: `const routes = {\n  "GET ${p}": h,` }],
      });
    const page =
      "fe/app/skills/[id]/page.tsx\n```tsx\nexport default function Skill() {\n  return null;\n}\n```";
    const { params, history, events, root } = setup([
      "",
      "All done.",
      route("/api/skills/search"),
      route("/api/skill"),
      "Done with the API.",
      route("/api/skill/file"),
      route("/api/skill/download"),
      page,
      "Built the routes and the skill page.",
    ]);
    params.checkDone = () => missingParts(PART1, root);
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Built the routes and the skill page.");
    expect(events).toContain("The model stopped without a word. Asking it to go on.");
    const asks = history.filter((m) => m.role === "user" && m.content.startsWith("Not done yet."));
    expect(asks).toHaveLength(2);
    expect(asks[0]?.content).toContain("- the route GET /api/skills/search");
    expect(asks[1]?.content).not.toContain("/api/skills/search");
    expect(missingParts(PART1, root)).toEqual([]);
  });

  test("when the list stops getting shorter, the answer is taken after one more try", async () => {
    const { params, history, root } = setup(["Done."]);
    params.checkDone = () => missingParts(PART1, root);
    const res = await runAgentLoop(params);
    expect(res.finalText).toBe("Done.");
    expect(history.filter((m) => m.role === "user" && m.content.startsWith("Not done yet."))).toHaveLength(2);
  });

  test("a reply to Depo's problem report that changes nothing goes to the larger model until its fix is done", async () => {
    const report =
      "Depo tried to run your work the way the owner will, and it does not work yet:\n- `bun run db:migrate` in be failed against the test database:\nerror: Referencing column 'user_id' and referenced column 'id' in foreign key constraint 'scans_ibfk_1' are incompatible.\nFix the cause, then finish with a short summary.";
    const { params, requests, history, events } = setup([
      "Added the tables.",
      "The migrations were applied and all tests passed.",
      call("read_file", { path: "be/src/db/schema.sql" }),
      call("edit_file", {
        path: "be/src/db/schema.sql",
        edits: [{ search: "  name VARCHAR(80) NOT NULL,", replace: "  name VARCHAR(80) NOT NULL," }],
      }),
      "Changed scans.user_id to BIGINT UNSIGNED.",
      "Everything works.",
    ]);
    params.stepUp = { model: "qwen2.5-coder:7b" };
    let rounds = 0;
    params.beforeFinish = async () => (rounds++ === 0 ? { retry: report } : { append: "Depo ran the app." });
    const res = await runAgentLoop(params);
    expect(res.finalText).toContain("Changed scans.user_id to BIGINT UNSIGNED.");
    expect(requests.map((r) => r.model)).toEqual([
      "qwen2.5-coder:3b",
      "qwen2.5-coder:3b",
      "qwen2.5-coder:7b",
      "qwen2.5-coder:7b",
      "qwen2.5-coder:7b",
    ]);
    // The false claim is not left in the history, and the model is shown the error again.
    expect(history.some((m) => m.content.includes("all tests passed"))).toBe(false);
    const push = history.find(
      (m) => m.role === "user" && m.content.startsWith("You changed nothing since Depo's report"),
    );
    expect(push?.content).toContain("are incompatible");
    expect(
      events.some((e) =>
        e.includes(
          "answered Depo's problem report without changing anything, so Depo asked qwen2.5-coder:7b",
        ),
      ),
    ).toBe(true);
    expect(events.some((e) => e.includes("qwen2.5-coder:7b finished its fix"))).toBe(true);
    expect(rounds).toBe(2);
  });

  test("the same append twice on an unchanged file runs once", async () => {
    const { params, root, events } = setup([
      call("append_file", { path: "be/notes.md", content: "# Notes" }),
      call("append_file", { path: "be/notes.md", content: "# Notes" }),
      "Wrote the notes.",
    ]);
    await runAgentLoop(params);
    expect(fs.readFileSync(path.join(root, "be", "notes.md"), "utf8")).toBe("# Notes\n");
    expect(events.some((e) => e.includes("Depo skipped it"))).toBe(true);
  });
});
