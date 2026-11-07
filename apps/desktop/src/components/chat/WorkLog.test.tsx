import type { ChatItem } from "@depo/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkLog } from "./WorkLog";

let n = 0;
const tool = (toolName: string, text: string, args?: ChatItem["args"], isError = false): ChatItem => ({
  id: `m${++n}`,
  role: "tool",
  text,
  toolName,
  isError,
  agent: null,
  createdAt: "2026-11-07T10:00:10Z",
  args,
});
const say = (text: string): ChatItem => ({
  id: `m${++n}`,
  role: "assistant",
  text,
  toolName: null,
  isError: false,
  agent: null,
  createdAt: "2026-11-07T10:00:05Z",
});

const steps = [
  say("Let me look at the project first."),
  tool("read_file", "app/main.py (13 lines)\n...", { path: "app/main.py" }),
  tool("edit_file", "Applied 1 edit(s) to app/main.py.", {
    path: "app/main.py",
    edits: [{ search: "old line", replace: "new line" }],
  }),
  tool("run_command", "Exit code 1.\nFAILED test_x\n1 failed in 0.1s", { command: "python -m pytest -q" }),
];

describe("WorkLog", () => {
  afterEach(cleanup);

  it("is one line until the reader opens it, then one line per step", () => {
    render(
      <WorkLog
        id="t1"
        steps={steps}
        state="done"
        startedAt="2026-11-07T10:00:00Z"
        endedAt="2026-11-07T10:01:20Z"
        live={null}
      />,
    );
    const line = screen.getByRole("button", { name: /Show the work \(3 steps\)/ });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(line.textContent).toContain("Worked for 1m 20s");
    expect(line.textContent).toContain("1 failed");
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();

    fireEvent.click(line);
    const list = screen.getByRole("list", { name: "Steps" });
    expect(list.textContent).toContain("Read app/main.py · 13 lines");
    expect(list.textContent).toContain("edit_file");
    expect(list.textContent).toContain("run_command");
    expect(list.textContent).toContain("Let me look at the project first.");

    // A step opens its details: the edit as a small diff.
    fireEvent.click(within(list).getByRole("button", { name: /Edited app\/main\.py/ }));
    const diff = screen.getByRole("figure", { name: "Change 1 of 1 in app/main.py" });
    expect(diff.textContent).toContain("Removed: old line");
    expect(diff.textContent).toContain("Added: new line");

    // A failed command shows its reason and exit code.
    fireEvent.click(within(list).getByRole("button", { name: /Failed:\s*Ran python -m pytest -q/ }));
    expect(list.textContent).toContain("exit code 1");
  });

  it("stays as the reader left it when new steps arrive", () => {
    const props = { id: "t2", startedAt: "2026-11-07T10:00:00Z", endedAt: null, live: null } as const;
    const { rerender } = render(<WorkLog {...props} steps={steps.slice(0, 2)} state="working" />);
    // Working is still one line: it never opens by itself.
    expect(screen.getByRole("button", { name: /Show the work/ }).getAttribute("aria-expanded")).toBe("false");
    rerender(<WorkLog {...props} steps={steps} state="working" />);
    const line = screen.getByRole("button", { name: /the work \(3 steps\)/ });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(line);
    rerender(
      <WorkLog {...props} steps={[...steps, tool("read_file", "b.py (2 lines)\n..")]} state="working" />,
    );
    expect(
      screen.getByRole("button", { name: /Hide the work \(4 steps\)/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    rerender(<WorkLog {...props} steps={[...steps]} state="done" endedAt="2026-11-07T10:00:30Z" />);
    expect(screen.getByRole("button", { name: /Hide the work/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("while working, shows the latest step and the elapsed time", () => {
    render(
      <WorkLog
        id="t3"
        steps={steps}
        state="working"
        startedAt={new Date(Date.now() - 65_000).toISOString()}
        endedAt={null}
        live={{ text: "Reading app/main.py", agent: "coder@1.0.0" }}
      />,
    );
    const line = screen.getByRole("button", { name: /Working/ });
    expect(line.textContent).toContain("Working");
    expect(line.textContent).toContain("3 steps");
    expect(line.textContent).toContain("Reading app/main.py");
    expect(line.textContent).toMatch(/1m 0[5-9]s/);
  });
});
