import type { ChatItem } from "@depo/shared";
import { describe, expect, it } from "vitest";
import { groupTurns } from "./ChatPanel";

const item = (id: string, role: ChatItem["role"], text = id, isError = false): ChatItem => ({
  id,
  role,
  text,
  toolName: role === "tool" ? "read_file" : null,
  isError,
  agent: null,
  createdAt: "2026-10-31T00:00:00Z",
});

describe("groupTurns", () => {
  it("puts each prompt with its work and answer", () => {
    const turns = groupTurns([
      item("u1", "user"),
      item("a1", "assistant", "Let me look"),
      item("t1", "tool"),
      item("a2", "assistant", "Done"),
      item("u2", "user"),
      item("t2", "tool"),
      item("e", "assistant", "Ollama dropped the connection", true),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.steps.map((s) => s.id)).toEqual(["a1", "t1"]);
    expect(turns[0]?.answer?.id).toBe("a2");
    expect(turns[1]?.steps.map((s) => s.id)).toEqual(["t2"]);
    expect(turns[1]?.answer?.isError).toBe(true);
  });

  it("a turn still working has no answer yet", () => {
    const [t] = groupTurns([item("u1", "user"), item("a1", "assistant"), item("t1", "tool")]);
    expect(t?.answer).toBeNull();
    expect(t?.steps).toHaveLength(2);
  });

  it("while working, the latest text is narration, not the answer", () => {
    const items = [item("u1", "user"), item("t1", "tool"), item("a1", "assistant", "Now the tests.")];
    const [working] = groupTurns(items, { working: true });
    expect(working?.answer).toBeNull();
    expect(working?.steps.map((s) => s.id)).toEqual(["t1", "a1"]);
    const [done] = groupTurns(items);
    expect(done?.answer?.id).toBe("a1");
  });

  it("the Manager's plan becomes a card and Depo's note sits under the answer", () => {
    const plan = {
      ...item("p", "assistant", "**Plan** — Notes API.\n1. **Backend**: Build it"),
      agent: "manager@1.0.0",
    };
    const handoff = { ...item("h", "assistant", "**Backend** — Build it"), agent: "backend@1.0.0" };
    const [t] = groupTurns([
      item("u1", "user"),
      plan,
      handoff,
      item("t1", "tool"),
      item("a1", "assistant", "Done. Tests passed."),
      item("n1", "assistant", "Note from Depo: the last test run (pytest) failed."),
    ]);
    expect(t?.plan?.plan.tasks[0]).toMatchObject({ owner: "Backend", title: "Build it" });
    expect(t?.steps.map((s) => s.id)).toEqual(["h", "t1"]);
    expect(t?.answer?.id).toBe("a1");
    expect(t?.note?.id).toBe("n1");
  });
});
