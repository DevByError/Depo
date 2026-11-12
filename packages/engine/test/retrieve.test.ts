import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chunkLines, relevantParts, words } from "../src/agent/retrieve";
import { shownFiles } from "../src/agent/step-prompt";

/** A back end file with 30 routes, 20 lines each: 600 lines, about 11 KB. */
function bigRoutesFile(): string {
  const names = Array.from({ length: 30 }, (_, i) => `thing${i}`);
  const head =
    'import { Hono } from "hono";\nimport { store } from "./store";\n\nexport const app = new Hono();\n\n';
  const routes = names.map(
    (n) =>
      `// ${n}\napp.get("/api/${n}", async (c) => {\n  const rows = await store.list${n[0]?.toUpperCase()}${n.slice(1)}();\n  if (!rows.length) return c.json({ error: "none" }, 404);\n  return c.json(rows);\n});\n${"// padding line\n".repeat(11)}`,
  );
  return head + routes.join("\n");
}

describe("retrieval for a step prompt", () => {
  test("words splits camelCase and drops filler", () => {
    expect(words("listSkillsByTag the route for /api/skills_search")).toEqual([
      "list",
      "skills",
      "tag",
      "route",
      "api",
      "skills",
      "search",
    ]);
  });

  test("chunks cover every line once and break at blank lines", () => {
    const lines = bigRoutesFile().split("\n");
    const chunks = chunkLines(lines);
    expect(chunks[0]?.start).toBe(1);
    expect(chunks.at(-1)?.end).toBe(lines.length);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]?.start).toBe((chunks[i - 1]?.end ?? 0) + 1);
  });

  test("the chunk about the step is kept, with the imports, and the rest is cut", () => {
    const body = bigRoutesFile();
    const r = relevantParts(body, "GET /api/thing17 returns the rows from listThing17", 3000);
    expect(r).not.toBeNull();
    expect(r?.text).toContain('app.get("/api/thing17"');
    expect(r?.text).toContain('import { Hono } from "hono";');
    expect(r?.text).not.toContain('app.get("/api/thing3"');
    expect(r?.text).toContain("not shown");
    expect(r?.text.length ?? 0).toBeLessThan(3200);
    expect(body.length).toBeGreaterThan(10_000);
  });

  test("nothing matching means nothing is invented", () => {
    expect(relevantParts(bigRoutesFile(), "zebra giraffe", 3000)).toBeNull();
  });

  test("shownFiles shows a too-big file as its matching parts instead of skipping it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "depo retrieve "));
    try {
      fs.mkdirSync(path.join(root, "be/src"), { recursive: true });
      fs.writeFileSync(path.join(root, "be/src/app.ts"), bigRoutesFile());
      const without = shownFiles(root, ["be/src/app.ts"], 4000);
      expect(without.shown).toEqual([]);
      const withQuery = shownFiles(root, ["be/src/app.ts"], 4000, "GET /api/thing9 lists thing9");
      expect(withQuery.shown).toEqual(["be/src/app.ts"]);
      expect(withQuery.text).toContain('app.get("/api/thing9"');
      expect(withQuery.text).toContain("the parts that match this step");
      expect(withQuery.text.length).toBeLessThan(4300);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
