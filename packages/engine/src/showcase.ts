import type { AgentLab } from "./agents/lab";
import { MANIFESTS } from "./agents/manifests";
import { BLOCKS } from "./blocks";
import { BLUEPRINTS } from "./blueprints";
import { TOOLS } from "./tools";

export interface Showcase {
  generatedAt: string;
  totals: {
    agents: number;
    agentVersions: number;
    evalRuns: number;
    tasks: number;
    tasksReviewed: number;
    events: number;
    toolCalls: number;
    toolFailures: number;
    errors: number;
    approvalsAsked: number;
    approvalsAutomatic: number;
    projects: number;
    memoryFacts: number;
  };
  tasksByStatus: { status: string; count: number }[];
  agents: {
    id: string;
    name: string;
    group: string;
    activeVersion: string;
    versions: { version: string; note: string; source: string; active: boolean; score: number | null }[];
  }[];
  recentErrors: { at: string; agent: string; text: string }[];
  library: { tools: number; blueprints: string[]; blocks: number; playbooks: number };
  features: { area: string; title: string; detail: string }[];
}

const WORK =
  "'reading_file','searching','writing_file','editing_file','running_command','installing_dependency','testing','linting','security_scan'";

const FEATURES: Showcase["features"] = [
  {
    area: "Agents",
    title: "15 specialist agents",
    detail:
      "Manager, thinking, design, backend, frontend, database, testing, security and more, each with a playbook, tools and reviewers.",
  },
  {
    area: "Agents",
    title: "Agent Lab with versions",
    detail:
      "Every agent has versions (1.0 ships, 1.1 is the mistake-fixing upgrade). Compare two versions on the same checks, promote the better one, roll back in one click.",
  },
  {
    area: "Safety",
    title: "Private copy and Diff Review",
    detail:
      "Agents work in a shadow copy. Nothing reaches your real files until you approve the diff. Every apply has a checkpoint and an undo.",
  },
  {
    area: "Safety",
    title: "One question, then no more prompts",
    detail:
      "At the start of a task Depo asks once whether to allow everything. If yes, commands and tools run without asking again; blocked commands stay blocked.",
  },
  {
    area: "Accuracy",
    title: "Tools decide correctness",
    detail:
      "Tests, type checks, linters and a page check run on the copy. A change that stops a file from compiling is refused and undone.",
  },
  {
    area: "Accuracy",
    title: "Forgiving edits",
    detail:
      "When a small model copies code with wrong spacing or indentation, Depo still finds the right lines instead of failing the step.",
  },
  {
    area: "Accuracy",
    title: "Exact errors",
    detail:
      "A failure shows the real message, its code, its cause chain and where it came from, not a summary.",
  },
  {
    area: "Speed",
    title: "Plan first, step by step",
    detail:
      "A request is split into steps, shown first, and each step is checked in code. A stuck step climbs to a larger model and comes back.",
  },
  {
    area: "Speed",
    title: "Built for a modest PC",
    detail:
      "One model at a time on a small GPU, prompt order for prefix reuse, keep-alive, model warm-up and learned time estimates.",
  },
  {
    area: "Quality",
    title: "Security and testing depth",
    detail:
      "Semgrep, gitleaks, OSV, Trivy, Bandit, ZAP, k6 and Lighthouse when installed; offline vulnerability data.",
  },
  {
    area: "Quality",
    title: "Design from references",
    detail: "Give a picture or a link; Depo reads colours, fonts and layout and compares the result to it.",
  },
  {
    area: "Extend",
    title: "Skills, MCP and knowledge packs",
    detail:
      "Skills and MCP servers are scanned and untrusted until you enable them. Knowledge packs are searched offline.",
  },
  {
    area: "Local",
    title: "No cloud, no account, no cost per token",
    detail: "Models run on this PC through Ollama, llama.cpp or LM Studio. Depo itself has no login.",
  },
];

/** Real numbers from this PC's Depo data, for showing what the system does and has done. */
export function buildShowcase(lab: AgentLab, library: { playbooks: number }): Showcase {
  const n = (sql: string, ...p: (string | number | null)[]) => Number(lab.all(sql, ...p)[0]?.c ?? 0);
  const tasksByStatus = lab
    .all("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status ORDER BY c DESC")
    .map((r) => ({ status: String(r.status), count: Number(r.c) }));
  const agents = MANIFESTS.map((m) => {
    const versions = lab.versions(m.id).map((v) => ({
      version: v.version,
      note: v.note,
      source: v.source,
      active: v.active,
      score: v.lastScore,
    }));
    return {
      id: m.id,
      name: m.name,
      group: m.group,
      activeVersion: versions.find((v) => v.active)?.version ?? m.version,
      versions,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      agents: MANIFESTS.length,
      agentVersions: agents.reduce((s, a) => s + a.versions.length, 0),
      evalRuns: n("SELECT COUNT(*) AS c FROM agent_eval_runs"),
      tasks: n("SELECT COUNT(*) AS c FROM tasks"),
      tasksReviewed: n("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('review','done','applied')"),
      events: n("SELECT COUNT(*) AS c FROM events"),
      toolCalls: n(`SELECT COUNT(*) AS c FROM events WHERE type IN (${WORK})`),
      toolFailures: n(`SELECT COUNT(*) AS c FROM events WHERE type IN (${WORK}) AND status = 'failed'`),
      errors: n("SELECT COUNT(*) AS c FROM events WHERE type = 'error'"),
      approvalsAsked: n("SELECT COUNT(*) AS c FROM events WHERE type = 'waiting_for_user'"),
      approvalsAutomatic: n(
        "SELECT COUNT(*) AS c FROM events WHERE type = 'info' AND text LIKE 'Allowed (%'",
      ),
      projects: n("SELECT COUNT(*) AS c FROM projects"),
      memoryFacts: n("SELECT COUNT(*) AS c FROM memory_facts"),
    },
    tasksByStatus,
    agents,
    recentErrors: lab
      .all("SELECT ts, agent, text FROM events WHERE type = 'error' ORDER BY seq DESC LIMIT 8")
      .map((r) => ({ at: String(r.ts), agent: String(r.agent), text: String(r.text).slice(0, 600) })),
    library: {
      tools: TOOLS.length,
      blueprints: BLUEPRINTS.map((b) => b.title),
      blocks: BLOCKS.length,
      playbooks: library.playbooks,
    },
    features: FEATURES,
  };
}
