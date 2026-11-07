/**
 * One colour per agent family, so an agent looks the same everywhere (chat, team view, activity, logs).
 * The colours are theme tokens (styles.css, --agent-*), readable as text on every surface in both themes.
 */
export type AgentTone = "lead" | "design" | "build" | "data" | "quality" | "ops" | "security" | "docs";

const BY_AGENT: Record<string, AgentTone> = {
  manager: "lead",
  thinking: "lead",
  reasoning: "lead",
  "project-management": "lead",
  "ui-ux-design": "design",
  diagram: "design",
  backend: "build",
  frontend: "build",
  integration: "build",
  coder: "build",
  starter: "ops",
  tester: "quality",
  database: "data",
  "ai-integration": "data",
  testing: "quality",
  enhancement: "quality",
  security: "security",
  "devops-docs": "ops",
  "devops-documentation": "ops",
};

/** Accepts an agent id ("ui-ux-design") or a display name ("UI/UX Design", "Coder Agent (1.0.0)"). */
export function agentKey(idOrName: string | null | undefined): string {
  if (!idOrName) return "";
  return idOrName
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\bagent\b/g, "")
    .replace(/\band\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function agentTone(idOrName: string | null | undefined): AgentTone {
  const key = agentKey(idOrName);
  return BY_AGENT[key] ?? "docs";
}

/** Literal class names, so Tailwind sees every one of them. */
export const AGENT_TEXT: Record<AgentTone, string> = {
  lead: "text-agent-lead",
  design: "text-agent-design",
  build: "text-agent-build",
  data: "text-agent-data",
  quality: "text-agent-quality",
  ops: "text-agent-ops",
  security: "text-agent-security",
  docs: "text-agent-docs",
};

export const AGENT_BG: Record<AgentTone, string> = {
  lead: "bg-agent-lead",
  design: "bg-agent-design",
  build: "bg-agent-build",
  data: "bg-agent-data",
  quality: "bg-agent-quality",
  ops: "bg-agent-ops",
  security: "bg-agent-security",
  docs: "bg-agent-docs",
};

/** A soft tint for chips and avatars (the colour at low opacity over the surface). */
export const AGENT_SOFT: Record<AgentTone, string> = {
  lead: "bg-agent-lead/12 text-agent-lead",
  design: "bg-agent-design/12 text-agent-design",
  build: "bg-agent-build/12 text-agent-build",
  data: "bg-agent-data/12 text-agent-data",
  quality: "bg-agent-quality/12 text-agent-quality",
  ops: "bg-agent-ops/12 text-agent-ops",
  security: "bg-agent-security/12 text-agent-security",
  docs: "bg-agent-docs/12 text-agent-docs",
};

export const AGENT_BORDER: Record<AgentTone, string> = {
  lead: "border-agent-lead",
  design: "border-agent-design",
  build: "border-agent-build",
  data: "border-agent-data",
  quality: "border-agent-quality",
  ops: "border-agent-ops",
  security: "border-agent-security",
  docs: "border-agent-docs",
};

/** Two-letter initials for an agent avatar: "UI/UX Design" -> "UX", "Backend" -> "BE". */
export function agentInitials(name: string): string {
  const special: Record<string, string> = {
    "ui-ux-design": "UX",
    "ai-integration": "AI",
    "devops-docs": "DO",
    "devops-documentation": "DO",
    "project-management": "PM",
    backend: "BE",
    frontend: "FE",
    database: "DB",
    starter: "ST",
    tester: "TE",
  };
  const key = agentKey(name);
  if (special[key]) return special[key];
  const words = key.split("-").filter(Boolean);
  if (words.length >= 2) return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  return key.slice(0, 2).toUpperCase();
}
