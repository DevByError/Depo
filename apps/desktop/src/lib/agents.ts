/** The default agent team (spec Section 4). Agents become runnable in Phase 3. */
export interface AgentInfo {
  id: string;
  name: string;
  group: "Leadership" | "Design" | "Builders" | "Quality" | "Delivery";
  role: string;
}

export const AGENT_TEAM: readonly AgentInfo[] = [
  { id: "manager", name: "Manager", group: "Leadership", role: "Plans the task graph and leads the team" },
  { id: "thinking", name: "Thinking", group: "Leadership", role: "Explores options and trade-offs" },
  { id: "reasoning", name: "Reasoning", group: "Leadership", role: "Critic and verifier (two-key rule)" },
  {
    id: "pm",
    name: "Project Management",
    group: "Leadership",
    role: "Business brief, user stories, UX audits, decks",
  },
  { id: "design", name: "UI/UX Design", group: "Design", role: "Design system, layouts, visual QA" },
  { id: "diagram", name: "Diagram", group: "Design", role: "Architecture, ERD, flows (Mermaid)" },
  { id: "backend", name: "Backend", group: "Builders", role: "APIs and server logic" },
  { id: "frontend", name: "Frontend", group: "Builders", role: "Web, mobile and desktop UI" },
  { id: "database", name: "Database", group: "Builders", role: "Schemas, migrations, queries" },
  { id: "integration", name: "Integration", group: "Builders", role: "Contracts, typed clients, E2E wiring" },
  { id: "ai-integration", name: "AI Integration", group: "Builders", role: "Local AI features in apps" },
  { id: "testing", name: "Testing", group: "Quality", role: "Build, test and fix loop" },
  { id: "security", name: "Security", group: "Quality", role: "Threat models, scans, audits" },
  { id: "enhancement", name: "Enhancement", group: "Quality", role: "Performance and caching" },
  { id: "devops", name: "DevOps & Docs", group: "Delivery", role: "Docker, CI, docs" },
];
