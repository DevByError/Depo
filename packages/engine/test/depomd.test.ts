import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEPO_MD,
  type DepoEntry,
  depoMdForPrompt,
  readDepoMd,
  recordInDepoMd,
  updatedDepoMd,
} from "../src/projectdoc/depomd";

const entry = (over: Partial<DepoEntry> = {}): DepoEntry => ({
  at: "2026-11-13T10:00:00.000Z",
  title: "Add login",
  request: "Add a login page",
  answer: "Login page added with a form and a test.",
  outcome: "review",
  done: ["POST /api/login", "the login page"],
  blocked: [],
  pending: [],
  files: ["be/src/login.ts", "fe/app/login/page.tsx"],
  ...over,
});
const start = () =>
  "# DEPO.md: shop\n\n## What this project is\nA shop.\n\n## Working rules\n- Never touch billing.\n";

describe("DEPO.md", () => {
  test("a new file has the sections, the log entry and a clean Next", () => {
    const out = updatedDepoMd("", entry(), () => "# DEPO.md: shop\n\n## What this project is\nA shop.\n");
    expect(out).toContain("## Status log (newest first)");
    expect(out).toContain("- 2026-11-13 (ready for review; Add login): Login page added");
    expect(out).toContain("Done: POST /api/login; the login page.");
    expect(out).toContain("Files: be/src/login.ts, fe/app/login/page.tsx.");
    expect(out).toContain("## Next\n1. Nothing is waiting");
    expect(out).toContain("## Known issues\n- None recorded.");
  });

  test("the owner's text stays; the log grows newest first; Next and Known issues follow the last task", () => {
    const first = updatedDepoMd(
      start(),
      entry({ blocked: [{ title: "GET /api/skills", note: "route missing" }] }),
      start,
    );
    expect(first).toContain("- Never touch billing.");
    expect(first).toContain("1. Finish: GET /api/skills (route missing).");
    expect(first).toContain("- GET /api/skills: route missing (Depo, 2026-11-13)");
    const second = updatedDepoMd(
      first,
      entry({ at: "2026-11-14T09:00:00.000Z", title: "Fix skills" }),
      start,
    );
    const log = second.slice(second.indexOf("## Status log"));
    expect(log.indexOf("2026-11-14")).toBeLessThan(log.indexOf("2026-11-13"));
    // A clean task clears what Depo itself had written as an issue.
    expect(second).toContain("## Known issues\n- None recorded.");
    expect(second).toContain("1. Nothing is waiting");
    expect(second).toContain("- Never touch billing.");
  });

  test("a line the owner wrote under Known issues is never removed", () => {
    const text = `${start()}\n## Known issues\n- The payment sandbox is slow on Mondays.\n`;
    const out = updatedDepoMd(text, entry({ blocked: [{ title: "Orders page", note: "empty" }] }), start);
    expect(out).toContain("- The payment sandbox is slow on Mondays.");
    expect(out).toContain("- Orders page: empty (Depo, 2026-11-13)");
  });

  test("the log keeps the newest 40 entries", () => {
    let text = start();
    for (let i = 0; i < 45; i++)
      text = updatedDepoMd(
        text,
        entry({ title: `task ${i}`, at: `2026-11-13T10:00:${String(i).padStart(2, "0")}.000Z` }),
        start,
      );
    expect((text.match(/^- 2026-/gm) ?? []).length).toBe(40);
    expect(text).toContain("task 44");
    expect(text).not.toContain("task 0)");
  });

  test("the prompt copy keeps the top, Next and Known issues, then as many log entries as fit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "depo md "));
    try {
      expect(readDepoMd(root)).toBe("");
      expect(depoMdForPrompt(root, 3000)).toBe("");
      let text = start();
      for (let i = 0; i < 30; i++)
        text = updatedDepoMd(
          text,
          entry({ title: `task ${i}`, at: `2026-11-13T10:00:${String(i).padStart(2, "0")}.000Z` }),
          start,
        );
      fs.writeFileSync(path.join(root, DEPO_MD), text);
      const small = depoMdForPrompt(root, 1500);
      expect(small.length).toBeLessThanOrEqual(1500);
      expect(small).toContain("Never touch billing");
      expect(small).toContain("## Next");
      expect(small).toContain("task 29");
      expect(small).not.toContain("task 1)");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("recordInDepoMd creates the file from the project's own files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "depo md new "));
    try {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "x", scripts: { test: "bun test" } }),
      );
      recordInDepoMd(root, "shop", entry());
      const text = readDepoMd(root);
      expect(text.startsWith("# DEPO.md: shop")).toBe(true);
      expect(text).toContain("## Commands");
      expect(text).toContain("## Status log (newest first)");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
