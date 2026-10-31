import type { ChatItem } from "@depo/shared";
import { describe, expect, it } from "vitest";
import { groupTurns } from "./ChatPanel";

const item = (id: string, role: ChatItem["role"], text = id, isError = false): ChatItem => ({
  id,
  role,
  text,
  toolName: role === "tool" ? "read_file" : null,
  isError,
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
});
