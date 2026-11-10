import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildPlan, columnsOf, isGoOn } from "../src/agent/plan";
import { changedSince, restoreSavePoint, takeSavePoint } from "../src/agent/savepoint";
import { checkStep } from "../src/agent/step-check";
import { filesForStep, stepPrompt } from "../src/agent/step-prompt";
import { tempDir } from "./helpers";

// The owner's ask: Depo shows every step it will take before it starts, like Claude does, and
// works through them one by one. The plan comes from the request's own text (ADR-0086).

const SKILL_FINDER = fs.readFileSync(path.join(import.meta.dir, "fixtures", "skill-finder-part1.md"), "utf8");

describe("the plan comes from the request's own sections", () => {
  test("Skill Finder part 1: a step per table, route, page and kind of test, then Depo's check", () => {
    const plan = buildPlan(SKILL_FINDER);
    expect(plan.steps.map((s) => s.title)).toEqual([
      "Add the skills table",
      "Add the scans table",
      "Add the favorites table",
      "Add the github_accounts table",
      "Add the methods you need to the Store interface and to both stores",
      "Build the demo skills (bun run db:seed)",
      "Build GET /api/skills/search",
      "Build GET /api/skill",
      "Build GET /api/skill/file",
      "Build GET /api/skill/download",
      "Build what every page shares",
      "Build the page /",
      "Build the page /skills/[id]",
      "Write tests: Front matter parsing (normal, quoted values, CRLF line endings, missing fiel…",
      "Write tests: search ranking (a name match beats a description match, sort by stars, the s…",
      "Write tests: the file route refusing ..",
      "Write tests: the ZIP having one top folder",
      "Write tests: the safety warnings",
      "Run the app and check it",
    ]);
    expect(plan.steps.map((s) => s.id).slice(0, 3)).toEqual(["s1", "s2", "s3"]);
    expect(plan.steps.at(-1)?.kind).toBe("check");
    expect(plan.doneMeans).toStartWith("the tests pass, migrate and seed work");
    // The opening paragraphs are what every step sees; "Done means" is not among them.
    expect(plan.overview).toContain("routes in be/src/app.ts");
    expect(plan.overview).not.toContain("Done means");
  });

  test("table steps know their columns; route steps keep the section's notes", () => {
    const plan = buildPlan(SKILL_FINDER);
    const favorites = plan.steps.find((s) => s.title === "Add the favorites table");
    expect(favorites?.table).toEqual({ name: "favorites", columns: ["user_id", "skill_id", "created_at"] });
    const skills = plan.steps.find((s) => s.table?.name === "skills");
    expect(skills?.table?.columns).toContain("skill_md");
    expect(skills?.table?.columns).not.toContain("unique");
    const file = plan.steps.find((s) => s.route?.path === "/api/skill/file");
    expect(file?.spec).toContain("Refuse binary files");
    expect(file?.notes).toContain("be/.data/skills/<id>/<skill-name>/");
    const search = plan.steps.find((s) => s.route?.path === "/api/skills/search");
    expect(search?.spec).toContain("MATCH ... AGAINST");
    const home = plan.steps.find((s) => s.page === "/");
    expect(home?.notes).toContain("phones (390 px)");
  });

  test("a short request is one step and the check", () => {
    const plan = buildPlan("Make the login button blue.");
    expect(plan.steps.map((s) => [s.kind, s.title])).toEqual([
      ["build", "Make the login button blue"],
      ["check", "Run the app and check it"],
    ]);
    expect(plan.steps[0]?.spec).toBe("Make the login button blue.");
  });

  test("a request without headings: its routes and pages, or its numbered steps", () => {
    const routes = buildPlan("Add these:\n- GET /api/users : list them\n- /users : a page with the list");
    expect(routes.steps.map((s) => s.title)).toEqual([
      "Build GET /api/users",
      "Build the page /users",
      "Run the app and check it",
    ]);
    const numbered = buildPlan("Please:\n1. Add a dark mode toggle.\n2. Save the choice in localStorage.\n");
    expect(numbered.steps.map((s) => s.title)).toEqual([
      "Add a dark mode toggle",
      "Save the choice in localStorage",
      "Run the app and check it",
    ]);
  });

  test("columns stop at the first sentence and skip keys", () => {
    expect(columnsOf("user_id, skill_id, created_at; primary key (user_id, skill_id)")).toEqual([
      "user_id",
      "skill_id",
      "created_at",
    ]);
    expect(columnsOf("id, name (up to 80, unique), body (TEXT). Index on (name).")).toEqual([
      "id",
      "name",
      "body",
    ]);
  });

  test('"go on" and friends continue the last plan; a real request does not', () => {
    for (const t of [
      "go on",
      "Go on.",
      "continue",
      "ok, continue",
      "fix it",
      "fix the errors",
      "keep going please",
    ])
      expect(isGoOn(t)).toBe(true);
    for (const t of [
      "add a dark mode",
      "go on and add a footer with links to the docs and the blog",
      "fix the header colour",
    ])
      expect(isGoOn(t)).toBe(false);
  });
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function project(files: Record<string, string>): string {
  const t = tempDir("depo plan");
  cleanup = t.cleanup;
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(t.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(t.dir, rel), text);
  }
  return t.dir;
}

const USERS =
  "CREATE TABLE IF NOT EXISTS users (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  email VARCHAR(200) NOT NULL\n);\n";

describe("Depo checks each step in code", () => {
  test("a table step passes only with its table and every column the request lists", () => {
    const root = project({ "be/src/db/schema.sql": USERS });
    const step = buildPlan(SKILL_FINDER).steps.find((s) => s.table?.name === "favorites");
    if (!step) throw new Error("no favorites step");
    const overview = "new tables at the end of be/src/db/schema.sql";
    expect(checkStep(step, root, { changed: [], overview })[0]).toContain(
      "There is no CREATE TABLE for favorites in be/src/db/schema.sql yet",
    );
    fs.appendFileSync(
      path.join(root, "be/src/db/schema.sql"),
      "CREATE TABLE IF NOT EXISTS favorites (\n  user_id BIGINT UNSIGNED NOT NULL,\n  skill_id BIGINT UNSIGNED NOT NULL\n);\n",
    );
    expect(checkStep(step, root, { changed: ["be/src/db/schema.sql"], overview })).toEqual([
      "The favorites table in be/src/db/schema.sql is missing the column created_at (the request lists it). Add it to its CREATE TABLE with an edit.",
    ]);
    fs.writeFileSync(
      path.join(root, "be/src/db/schema.sql"),
      `${USERS}CREATE TABLE IF NOT EXISTS favorites (\n  user_id INT NOT NULL,\n  skill_id BIGINT UNSIGNED NOT NULL,\n  created_at DATETIME NOT NULL,\n  FOREIGN KEY (user_id) REFERENCES users(id)\n);\n`,
    );
    expect(checkStep(step, root, { changed: ["be/src/db/schema.sql"], overview })[0]).toContain(
      "favorites.user_id is INT but it references users.id, which is BIGINT UNSIGNED",
    );
  });

  test("a route step needs the route in the code and code that compiles", () => {
    const root = project({ "be/src/app.ts": 'const routes = {\n  "GET /api/health": () => 1,\n};\n' });
    const step = buildPlan(SKILL_FINDER).steps.find((s) => s.route?.path === "/api/skill");
    if (!step) throw new Error("no route step");
    expect(checkStep(step, root, { changed: [] })[0]).toContain(
      "The route GET /api/skill is not in the code yet",
    );
    // "/api/skills/search" is not "/api/skill".
    fs.writeFileSync(
      path.join(root, "be/src/app.ts"),
      'const routes = {\n  "GET /api/skills/search": () => 1,\n};\n',
    );
    expect(checkStep(step, root, { changed: [] })).toHaveLength(1);
    fs.writeFileSync(path.join(root, "be/src/app.ts"), 'const routes = {\n  "GET /api/skill": () => 1,\n'); // unclosed
    const broken = checkStep(step, root, { changed: ["be/src/app.ts"] });
    expect(broken).toHaveLength(1);
    expect(broken[0]).toContain("be/src/app.ts does not compile");
  });

  test("a build step that changed nothing is not done, unless the model said it was already there", () => {
    const root = project({ "a.ts": "export const a = 1;\n" });
    const step = buildPlan("Make the login button blue.").steps[0];
    if (!step) throw new Error("no step");
    expect(checkStep(step, root, { changed: [] })).toEqual(["Nothing changed in this step."]);
    expect(checkStep(step, root, { changed: [], acceptUnchanged: true })).toEqual([]);
  });

  test("a test step needs a test file", () => {
    const root = project({ "be/src/app.ts": "export {};\n" });
    const step = buildPlan(SKILL_FINDER).steps.find((s) => s.kind === "tests");
    if (!step) throw new Error("no tests step");
    expect(checkStep(step, root, { changed: ["be/src/app.ts"] })[0]).toContain("No test file was written");
    expect(checkStep(step, root, { changed: ["be/src/frontmatter.test.ts"] })).toEqual([]);
  });
});

describe("each step sees a short prompt with its files already read", () => {
  test("a table step gets the schema; a route step the route table and the stores", () => {
    const root = project({
      "be/src/db/schema.sql": USERS,
      "be/src/app.ts":
        'const routes = {\n  "GET /api/health": () => 1,\n  "POST /api/auth/login": () => 2,\n};\n',
      "be/src/db/store.ts": "export interface Store {\n  kind: string;\n}\n",
      "be/src/db/memory.ts":
        'import type { Store } from "./store";\nexport class MemoryStore implements Store {\n  kind = "memory";\n}\n',
    });
    const plan = buildPlan(SKILL_FINDER);
    const table = plan.steps.find((s) => s.table?.name === "scans");
    const route = plan.steps.find((s) => s.route?.path === "/api/skill");
    if (!table || !route) throw new Error("missing steps");
    expect(filesForStep(table, plan, root)).toEqual(["be/src/db/schema.sql"]);
    expect(filesForStep(route, plan, root)).toEqual([
      "be/src/app.ts",
      "be/src/db/store.ts",
      "be/src/db/memory.ts",
    ]);
    const p = stepPrompt({
      step: table,
      plan,
      root,
      done: ["Add the skills table"],
      later: ["Add the favorites table", "Add the github_accounts table"],
      index: 2,
      total: 19,
      earlier: [],
      blocks: true,
      budget: 8000,
    });
    expect(p.shown).toEqual(["be/src/db/schema.sql"]);
    expect(p.text).toContain("Step 2 of 19: Add the scans table");
    expect(p.text).toContain("Do step 2 now, and only this step.");
    expect(p.text).toContain("Done before this step: Add the skills table.");
    expect(p.text).toContain(
      "Later steps (not now): Add the favorites table; Add the github_accounts table.",
    );
    expect(p.text).toContain("Add no other table and no ALTER statement.");
    expect(p.text).toContain("CREATE TABLE IF NOT EXISTS users");
    // The whole request is not in the prompt: only this step's part and the overview.
    expect(p.text).not.toContain("react-markdown");
  });

  test("the owner's design references go with the steps that build what the owner sees", () => {
    const root = project({ "be/src/db/schema.sql": USERS });
    const plan = buildPlan(SKILL_FINDER);
    const table = plan.steps.find((s) => s.kind === "table");
    const page = plan.steps.find((s) => s.kind === "page" || s.kind === "build");
    if (!table || !page) throw new Error("missing steps");
    const design =
      'Design reference: the owner wants the same look and feel. Reference 1: the picture "login.png"';
    const input = {
      plan,
      root,
      done: [],
      later: [],
      index: 1,
      total: 5,
      earlier: [],
      blocks: true,
      budget: 8000,
      design,
    };
    expect(stepPrompt({ ...input, step: page }).text).toContain(
      "The owner's design references (make what this step builds look like this):\nDesign reference: the owner wants",
    );
    expect(stepPrompt({ ...input, step: table }).text).not.toContain("Design reference");
  });
});

describe("save points put a step's files back exactly", () => {
  test("changed, added and deleted files go back; installed packages are left alone", () => {
    const root = project({
      "be/src/app.ts": "export const a = 1;\n",
      "be/src/db/schema.sql": USERS,
      "be/node_modules/x/index.js": "module.exports = 1;\n",
    });
    const sp = takeSavePoint(root);
    if (!sp) throw new Error("no save point");
    fs.writeFileSync(path.join(root, "be/src/app.ts"), "broken(");
    fs.rmSync(path.join(root, "be/src/db/schema.sql"));
    fs.mkdirSync(path.join(root, "be/src/app/api/skills"), { recursive: true });
    fs.writeFileSync(path.join(root, "be/src/app/api/skills/search.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, "be/node_modules/x/new.js"), "1");
    expect(changedSince(root, sp)).toEqual([
      "be/src/app.ts",
      "be/src/app/api/skills/search.ts",
      "be/src/db/schema.sql",
    ]);
    const r = restoreSavePoint(root, sp);
    expect(r.restored.sort()).toEqual(["be/src/app.ts", "be/src/db/schema.sql"]);
    expect(r.removed).toEqual(["be/src/app/api/skills/search.ts"]);
    expect(fs.readFileSync(path.join(root, "be/src/app.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(fs.existsSync(path.join(root, "be/src/app"))).toBe(false);
    expect(fs.existsSync(path.join(root, "be/node_modules/x/new.js"))).toBe(true);
    expect(changedSince(root, sp)).toEqual([]);
  });
});
