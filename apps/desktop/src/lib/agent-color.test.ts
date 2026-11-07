import { describe, expect, it } from "vitest";
import { agentInitials, agentKey, agentTone } from "./agent-color";

describe("agent colours", () => {
  it("reads ids and display names the same way", () => {
    expect(agentKey("UI/UX Design")).toBe("ui-ux-design");
    expect(agentKey("Coder Agent (1.0.0)")).toBe("coder");
    expect(agentTone("ui-ux-design")).toBe(agentTone("UI/UX Design"));
    expect(agentTone("DevOps and Documentation")).toBe("ops");
  });

  it("gives each family its own colour and a calm default", () => {
    expect(agentTone("manager")).toBe("lead");
    expect(agentTone("security")).toBe("security");
    expect(agentTone("database")).toBe("data");
    expect(agentTone("someone new")).toBe("docs");
    expect(agentTone(undefined)).toBe("docs");
  });

  it("makes short initials for avatars", () => {
    expect(agentInitials("UI/UX Design")).toBe("UX");
    expect(agentInitials("Backend")).toBe("BE");
    expect(agentInitials("Manager")).toBe("MA");
    expect(agentInitials("Project Management")).toBe("PM");
  });
});
