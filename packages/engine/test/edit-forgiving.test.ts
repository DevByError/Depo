import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFileTool } from "../src/tools/fs-tools";

function withFile(body: string, run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "depo edit "));
  try {
    fs.writeFileSync(path.join(root, "a.ts"), body);
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("edit_file forgives small differences", () => {
  const file = "function a() {\n  const x = 1;\n  return x;\n}\n\nfunction b() {\n  return 2;\n}\n";
  test("wrong indentation is matched and the replacement is re-indented", () => {
    withFile(file, (root) => {
      const r = editFileTool(root, "a.ts", [
        { search: "const x = 1;\nreturn x;", replace: "const x = 5;\nreturn x;" },
      ]);
      expect(r.notes[0]).toContain("indentation");
      expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toContain("  const x = 5;\n  return x;");
    });
  });
  test("spacing differences inside a line are matched", () => {
    withFile(file, (root) => {
      editFileTool(root, "a.ts", [{ search: "const  x =  1;", replace: "const x = 9;" }]);
      expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toContain("const x = 9;");
    });
  });
  test("a block with one wrong middle line is matched when the ends agree", () => {
    const big = "if (a) {\n  one();\n  two();\n  three();\n  four();\n}\n";
    withFile(big, (root) => {
      const r = editFileTool(root, "a.ts", [
        {
          search: "if (a) {\n  one();\n  twoo();\n  three();\n  four();\n}",
          replace: "if (b) {\n  one();\n}",
        },
      ]);
      expect(r.notes[0]).toContain("closest block");
      expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toBe("if (b) {\n  one();\n}\n");
    });
  });
  test("text that is truly absent still fails", () => {
    withFile(file, (root) => {
      expect(() => editFileTool(root, "a.ts", [{ search: "nothing like this", replace: "x" }])).toThrow(
        "not found",
      );
    });
  });
});

describe("history stays light", () => {
  test("old tool output shrinks early and in one step, the newest stays whole", async () => {
    const { compressHistory } = await import("../src/agent/tasks");
    const big = "y".repeat(3000);
    const h: import("@depo/model-gateway").ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
    ];
    for (let i = 0; i < 6; i++) {
      h.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `c${i}`, name: "read_file", arguments: {}, rawArguments: "{}" }],
      });
      h.push({ role: "tool", toolCallId: `c${i}`, name: "read_file", content: big });
    }
    compressHistory(h, 16384);
    const before = h.reduce((n, m) => n + m.content.length, 0);
    for (let i = 0; i < 4; i++) h.push({ role: "tool", toolCallId: "z", name: "read_file", content: big });
    compressHistory(h, 16384);
    const after = h.reduce((n, m) => n + m.content.length, 0);
    expect(after).toBeLessThan(before + 4 * 3000);
    expect(h.at(-1)?.content).toBe(big);
    expect(h[3]?.content.length).toBeLessThan(400);
  });
});

describe("line replacement, read stubs and step tools", () => {
  test("replace_lines swaps whole lines and keeps CRLF files CRLF", async () => {
    const { replaceLinesTool } = await import("../src/tools/fs-tools");
    withFile("a\r\nb\r\nc\r\n", (root) => {
      const r = replaceLinesTool(root, "a.ts", 2, 2, "B1\nB2");
      expect(r).toMatchObject({ removed: 1, added: 2 });
      expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toBe("a\r\nB1\r\nB2\r\nc\r\n");
      expect(() => replaceLinesTool(root, "a.ts", 9, 9, "x")).toThrow("do not exist");
    });
  });

  test("a failed search shows the lines around the nearest match", () => {
    withFile("one\ntwo\nconst port = 3000;\nfour\n", (root) => {
      let msg = "";
      try {
        editFileTool(root, "a.ts", [{ search: "wrong first line\nconst port = 3000;", replace: "x" }]);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain("3│ const port = 3000;");
      expect(msg).toContain("replace_lines");
    });
  });

  test("a step gets only the tools it needs", async () => {
    const { stepTools } = await import("../src/agent/step-runner");
    const all = [
      "read_file",
      "edit_file",
      "write_file",
      "delete_file",
      "remember",
      "dev_database",
      "check_page",
      "start_preview",
      "run_command",
    ];
    const route = stepTools(all, { kind: "route", title: "GET /api/skills" });
    expect(route).toEqual(["read_file", "edit_file", "write_file", "run_command"]);
    expect(stepTools(all, { kind: "page", title: "the skills page" })).toContain("check_page");
    expect(stepTools(all, { kind: "build", title: "remove the old header" })).toContain("delete_file");
  });
});
