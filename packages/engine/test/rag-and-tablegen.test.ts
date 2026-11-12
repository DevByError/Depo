import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codeChunks, declares, indexFor, ProjectIndex, snippetsText } from "../src/agent/codeindex-lite";
import { buildPlan } from "../src/agent/plan";
import { stepPrompt } from "../src/agent/step-prompt";
import { generateTable, isMysqlDialect } from "../src/agent/tablegen";
import { foreignKeyProblems } from "../src/tools/sqlcheck";

const SCHEMA = `CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS skills (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL
) ENGINE=InnoDB;
`;

describe("tables Depo writes itself", () => {
  test("only for a MySQL style schema", () => {
    expect(isMysqlDialect(SCHEMA)).toBe(true);
    expect(isMysqlDialect("CREATE TABLE a (id SERIAL PRIMARY KEY);")).toBe(false);
    expect(generateTable("CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT);", "b", ["id"])).toBeNull();
  });

  test("types follow the names and the foreign keys follow the existing tables", () => {
    const g = generateTable(SCHEMA, "favorites", ["user_id", "skill_id", "created_at"]);
    expect(g).not.toBeNull();
    const sql = g?.sql ?? "";
    expect(sql).toContain("user_id BIGINT UNSIGNED NOT NULL");
    expect(sql).toContain("FOREIGN KEY (skill_id) REFERENCES skills (id)");
    expect(sql).toContain("FOREIGN KEY (user_id) REFERENCES users (id)");
    expect(sql).toContain("PRIMARY KEY (user_id, skill_id)");
    expect(sql).toContain("created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
    // MySQL would accept the whole file.
    expect(foreignKeyProblems(`${SCHEMA}\n${sql}`)).toEqual([]);
  });

  test("an id, flags, text and a typed column are all handled", () => {
    const g = generateTable(SCHEMA, "scans", [
      "id",
      "kind",
      "is_public",
      "summary",
      "score",
      "title VARCHAR(80) NOT NULL",
    ]);
    const sql = g?.sql ?? "";
    expect(sql).toContain("id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY");
    expect(sql).toContain("kind VARCHAR(50) NOT NULL");
    expect(sql).toContain("is_public TINYINT(1) NOT NULL DEFAULT 0");
    expect(sql).toContain("summary TEXT NULL");
    expect(sql).toContain("score INT NOT NULL DEFAULT 0");
    expect(sql).toContain("title VARCHAR(80) NOT NULL");
  });

  test("a table that exists, or a name that is too long, is left to the model", () => {
    expect(generateTable(SCHEMA, "users", ["id"])).toBeNull();
    expect(generateTable(SCHEMA, "t", ["x".repeat(70)])).toBeNull();
  });
});

describe("the project index", () => {
  function project(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "depo rag "));
    fs.mkdirSync(path.join(root, "be/src"), { recursive: true });
    fs.mkdirSync(path.join(root, "fe/app/skills"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "be/src/app.ts"),
      [
        'import { Hono } from "hono";',
        "export const app = new Hono();",
        "",
        'app.get("/api/skills", async (c) => {',
        "  const rows = await store.listSkills();",
        "  return c.json(rows);",
        "});",
        "",
        'app.post("/api/login", async (c) => {',
        "  const { email, password } = await c.req.json();",
        "  const user = await store.findUserByEmail(email);",
        '  if (!user) return c.json({ error: "bad login" }, 401);',
        "  return c.json({ token: sign(user.id) });",
        "});",
        "",
        'app.delete("/api/skills/:id", async (c) => {',
        "  await store.removeSkill(c.req.param('id'));",
        "  return c.body(null, 204);",
        "});",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(root, "fe/app/skills/page.tsx"),
      "export default function SkillsPage() {\n  return <main>Skills list</main>;\n}\n",
    );
    fs.writeFileSync(
      path.join(root, "be/src/auth.ts"),
      "export function sign(id: number) {\n  return `token-${id}`;\n}\n\nexport function verify(token: string) {\n  return token.startsWith('token-');\n}\n",
    );
    return root;
  }

  test("chunks follow declarations and routes, and carry the symbol's name", () => {
    expect(declares("export async function loadUser(id: string) {")).toBe("loadUser");
    expect(declares('app.post("/api/login", async (c) => {')).toBe("post /api/login");
    expect(declares("  indented();")).toBeNull();
    const lines = fs.readFileSync(path.join(project(), "be/src/app.ts"), "utf8").split("\n");
    const chunks = codeChunks(lines);
    expect(chunks.map((c) => c.symbol)).toContain("post /api/login");
    expect(chunks[0]?.start).toBe(1);
    expect(chunks.at(-1)?.end).toBe(lines.length - 1);
  });

  test("a question about login finds the login route first, not the other routes", () => {
    const root = project();
    try {
      const hits = new ProjectIndex(root).search("add a logout route like the login route with the token", {
        k: 3,
      });
      expect(hits[0]?.rel).toBe("be/src/app.ts");
      expect(hits[0]?.symbol).toBe("post /api/login");
      expect(snippetsText(hits.slice(0, 1))).toContain("be/src/app.ts (lines 9-14, post /api/login)");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("files already shown are left out, and a changed file is read again", () => {
    const root = project();
    try {
      const ix = new ProjectIndex(root);
      const without = ix.search("sign token verify", { exclude: new Set(["be/src/auth.ts"]) });
      expect(without.every((h) => h.rel !== "be/src/auth.ts")).toBe(true);
      fs.writeFileSync(
        path.join(root, "be/src/auth.ts"),
        "export function refreshSession(id: number) {\n  return `fresh-${id}`;\n}\n",
      );
      const again = ix.search("refresh session");
      expect(again[0]?.rel).toBe("be/src/auth.ts");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the step prompt shows related code from other files", () => {
    const root = project();
    try {
      const plan = buildPlan(
        "Add token refresh.\n\n## Auth\n- Write a refreshToken helper that works like sign and verify, for the token\n",
      );
      const step = plan.steps[0];
      expect(step).toBeDefined();
      if (!step) return;
      const text = stepPrompt({
        step,
        plan,
        root,
        done: [],
        later: [],
        index: 1,
        total: 2,
        earlier: [],
        blocks: false,
        budget: 8000,
      }).text;
      expect(text).toContain("Related code already in this project");
      expect(text).toContain("be/src/auth.ts");
      expect(text).toContain("export function sign(id: number)");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("indexFor keeps one index per folder", () => {
    const root = project();
    try {
      expect(indexFor(root)).toBe(indexFor(root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
