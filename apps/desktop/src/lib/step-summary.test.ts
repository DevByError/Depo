import type { ChatItem } from "@depo/shared";
import { describe, expect, it } from "vitest";
import {
  agentName,
  describeNote,
  diffLines,
  editHunks,
  parsePlan,
  parseTestSummary,
  summarizeStep,
} from "./step-summary";

const step = (toolName: string, text: string, args?: ChatItem["args"], isError = false) => ({
  toolName,
  text,
  isError,
  args,
});
const line = (s: ReturnType<typeof summarizeStep>) => [s.title, s.meta].filter(Boolean).join(" · ");

describe("summarizeStep", () => {
  it("reads: path and line count from the output", () => {
    const s = summarizeStep(
      step("read_file", "app/main.py (13 lines)\n 1: from fastapi import FastAPI", { path: "app/main.py" }),
    );
    expect(line(s)).toBe("Read app/main.py · 13 lines");
    expect(s.kind).toBe("read");
    expect(s.failed).toBe(false);
    const part = summarizeStep(step("read_file", "big.py (900 lines)\n...\n[showing lines 1-200 of 900]"));
    expect(line(part)).toBe("Read big.py · lines 1–200 of 900");
  });

  it("edits: file and number of changes", () => {
    const s = summarizeStep(
      step("edit_file", "Applied 1 edit(s) to app/main.py.", {
        path: "app/main.py",
        edits: [{ search: "a", replace: "b" }],
      }),
    );
    expect(line(s)).toBe("Edited app/main.py · 1 change");
    expect(line(summarizeStep(step("edit_file", "Applied 3 edit(s) to x.ts.")))).toBe(
      "Edited x.ts · 3 changes",
    );
  });

  it("a failed edit is marked with its reason", () => {
    const s = summarizeStep(
      step(
        "edit_file",
        "The search text was not found in app/main.py.\nRead the file again.",
        { path: "app/main.py" },
        true,
      ),
    );
    expect(s.failed).toBe(true);
    expect(s.title).toBe("Edited app/main.py");
    expect(s.meta).toBeNull();
    expect(s.reason).toBe("The search text was not found in app/main.py.");
  });

  it("commands: the command and a test result", () => {
    const passed = summarizeStep(
      step("run_command", "Exit code 0.\n..\n2 passed in 0.31s", { command: "python -m pytest -q" }),
    );
    expect(line(passed)).toBe("Ran python -m pytest -q · 2 passed");
    expect(passed.kind).toBe("test");
    expect(passed.exitCode).toBe(0);

    const failed = summarizeStep(
      step(
        "run_command",
        "Exit code 1.\n.F\nFAILED tests/test_main.py::test_health - assert 404 == 200\n1 failed, 1 passed in 0.2s",
        { command: "python -m pytest -q" },
      ),
    );
    expect(line(failed)).toBe("Ran python -m pytest -q · 1 failed, 1 passed");
    expect(failed.failed).toBe(true);
    expect(failed.reason).toBe("FAILED tests/test_main.py::test_health - assert 404 == 200");

    expect(line(summarizeStep(step("run_command", "Exit code 0.\nok", { command: "npm test" })))).toBe(
      "Ran npm test · passed",
    );
    expect(
      line(summarizeStep(step("run_command", "Exit code 0.\nbuilt", { command: "npm run build" }))),
    ).toBe("Ran npm run build · done");
    const broke = summarizeStep(
      step("run_command", "Exit code 2.\nerror: cannot find module x", { command: "tsc" }),
    );
    expect(line(broke)).toBe("Ran tsc · exit code 2");
    expect(broke.failed).toBe(true);
    expect(broke.reason).toBe("error: cannot find module x");
    const slow = summarizeStep(step("run_command", "Timed out after 300s.\n...", { command: "sleep 999" }));
    expect(slow.meta).toBe("timed out");
    expect(slow.failed).toBe(true);
  });

  it("a refused command keeps the refusal as its reason", () => {
    const s = summarizeStep(
      step(
        "run_command",
        "This command is not allowed: it deletes files. Find another way.",
        { command: "rm -rf /" },
        true,
      ),
    );
    expect(s.title).toBe("Ran rm -rf /");
    expect(s.failed).toBe(true);
    expect(s.reason).toBe("This command is not allowed: it deletes files. Find another way.");
  });

  it("searches: the pattern and match count", () => {
    const hits = "app/main.py:6: @app.get('/health')\napp/main.py:9: health\ntests/test_main.py:3: health";
    expect(line(summarizeStep(step("search", hits, { pattern: "health" })))).toBe(
      "Searched for 'health' · 3 matches",
    );
    expect(line(summarizeStep(step("search", "No matches.", { pattern: "nope" })))).toBe(
      "Searched for 'nope' · no matches",
    );
    expect(line(summarizeStep(step("search", "a.py:1: x")))).toBe("Searched the code · 1 match");
  });

  it("lists, writes, messages and unknown tools", () => {
    expect(line(summarizeStep(step("list_dir", "app/\napp/main.py\ntests/", { path: "." })))).toBe(
      "Listed the project · 3 items",
    );
    expect(
      line(
        summarizeStep(
          step("write_file", "Created tests/t.py (40 bytes).", { path: "tests/t.py", content: "a\nb\nc" }),
        ),
      ),
    ).toBe("Created tests/t.py · 3 lines");
    expect(line(summarizeStep(step("write_file", "Wrote a.py (2048 bytes).")))).toBe("Wrote a.py · 2.0 KB");
    expect(summarizeStep(step("send_message", "Sent.", { to: "testing", type: "handoff" })).title).toBe(
      "Handed work to Testing",
    );
    const other = summarizeStep(step("lookup_docs", "..."));
    expect(other.title).toBe("Lookup docs");
    expect(other.kind).toBe("tool");
  });
});

describe("parseTestSummary", () => {
  it("reads pytest, jest and bun summaries", () => {
    expect(parseTestSummary("===== 2 passed in 0.1s =====")?.text).toBe("2 passed");
    expect(parseTestSummary("Tests:       1 failed, 4 passed, 5 total")?.text).toBe("1 failed, 4 passed");
    expect(parseTestSummary(" 7 pass\n 0 fail\n")?.text).toBe("7 passed");
    expect(parseTestSummary("hello")).toBeNull();
  });
});

describe("team messages", () => {
  it("reads the Manager's plan, or leaves odd text alone", () => {
    const plan = parsePlan(
      "**Plan** — A notes API.\n1. **Database**: Data model\n2. **Backend**: The API _(after database)_",
    );
    expect(plan?.summary).toBe("A notes API.");
    expect(plan?.tasks).toEqual([
      { n: 1, owner: "Database", title: "Data model", after: [] },
      { n: 2, owner: "Backend", title: "The API", after: ["database"] },
    ]);
    expect(parsePlan("**Plan** — x\nSome other line")).toBeNull();
    expect(parsePlan("Here is my plan:\n1. do it")).toBeNull();
  });

  it("tells handoffs, reviews and narration apart", () => {
    expect(describeNote("**Backend** — Build the API")).toEqual({
      kind: "handoff",
      agent: "Backend",
      title: "Build the API",
    });
    expect(describeNote("**Reasoning** reviewed Backend: changes needed (2 findings)")).toMatchObject({
      kind: "review",
      approved: false,
    });
    expect(describeNote("Let me look at the **project** first.\nThen edit.")).toEqual({
      kind: "note",
      line: "Let me look at the project first.",
      more: true,
    });
  });

  it("names agents from their tags", () => {
    expect(agentName("backend@1.0.0")).toBe("Backend");
    expect(agentName("ui-ux-design")).toBe("UI/UX Design");
    expect(agentName("custom-helper@2.0.0")).toBe("Custom Helper");
    expect(agentName(null)).toBe("");
  });
});

describe("edit diffs", () => {
  it("keeps shared lines as context and shows the change", () => {
    expect(
      diffLines('@app.get("/items")', '@app.get("/health")\ndef health():\n\n@app.get("/items")'),
    ).toEqual([
      { type: "added", text: '@app.get("/health")' },
      { type: "added", text: "def health():" },
      { type: "added", text: "" },
      { type: "same", text: '@app.get("/items")' },
    ]);
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { type: "same", text: "a" },
      { type: "removed", text: "b" },
      { type: "added", text: "B" },
      { type: "same", text: "c" },
    ]);
  });

  it("reads search/replace pairs from the arguments", () => {
    expect(editHunks({ edits: [{ search: "a", replace: "b" }, { search: 1 }, "x"] })).toEqual([
      { search: "a", replace: "b" },
    ]);
    expect(editHunks(undefined)).toEqual([]);
  });
});
