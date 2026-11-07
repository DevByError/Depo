import type { AgentId, WorkMode } from "@depo/shared";
import { detectStack } from "../agent/stack";
import aiIntegrationCore from "./core/ai-integration.md" with { type: "text" };
import backendCore from "./core/backend.md" with { type: "text" };
import coderCore from "./core/coder.md" with { type: "text" };
import databaseCore from "./core/database.md" with { type: "text" };
import devopsDocsCore from "./core/devops-docs.md" with { type: "text" };
import diagramCore from "./core/diagram.md" with { type: "text" };
import enhancementCore from "./core/enhancement.md" with { type: "text" };
import frontendCore from "./core/frontend.md" with { type: "text" };
import integrationCore from "./core/integration.md" with { type: "text" };
import managerCore from "./core/manager.md" with { type: "text" };
import projectManagementCore from "./core/project-management.md" with { type: "text" };
import reasoningCore from "./core/reasoning.md" with { type: "text" };
import securityCore from "./core/security.md" with { type: "text" };
import testingCore from "./core/testing.md" with { type: "text" };
import thinkingCore from "./core/thinking.md" with { type: "text" };
import uiUxDesignCore from "./core/ui-ux-design.md" with { type: "text" };
import accessibilityMd from "./topics/accessibility.md" with { type: "text" };
import apiDesignMd from "./topics/api-design.md" with { type: "text" };
import authMd from "./topics/auth.md" with { type: "text" };
import contractsMd from "./topics/contracts.md" with { type: "text" };
import designSystemMd from "./topics/design-system.md" with { type: "text" };
import djangoDrfMd from "./topics/django-drf.md" with { type: "text" };
import dockerCiMd from "./topics/docker-ci.md" with { type: "text" };
import docsRunScriptsMd from "./topics/docs-run-scripts.md" with { type: "text" };
import fastapiMd from "./topics/fastapi.md" with { type: "text" };
import localAiRagMd from "./topics/local-ai-rag.md" with { type: "text" };
import mermaidMd from "./topics/mermaid.md" with { type: "text" };
import mobileMd from "./topics/mobile.md" with { type: "text" };
import mongodbMd from "./topics/mongodb.md" with { type: "text" };
import nestjsMd from "./topics/nestjs.md" with { type: "text" };
import nextjsMd from "./topics/nextjs.md" with { type: "text" };
import nodeApiMd from "./topics/node-api.md" with { type: "text" };
import owaspMd from "./topics/owasp.md" with { type: "text" };
import performanceMd from "./topics/performance.md" with { type: "text" };
import postgresMd from "./topics/postgres.md" with { type: "text" };
import productBriefMd from "./topics/product-brief.md" with { type: "text" };
import productionBaselineMd from "./topics/production-baseline.md" with { type: "text" };
import pythonDataMd from "./topics/python-data.md" with { type: "text" };
import rbacMd from "./topics/rbac.md" with { type: "text" };
import reactViteMd from "./topics/react-vite.md" with { type: "text" };
import redisMd from "./topics/redis.md" with { type: "text" };
import tailwindShadcnMd from "./topics/tailwind-shadcn.md" with { type: "text" };
import testingStrategyMd from "./topics/testing-strategy.md" with { type: "text" };

/**
 * Playbooks: Depo's curated engineering knowledge, embedded in the engine (Markdown files imported
 * as text, so `bun build --compile` ships them inside the executable).
 *
 * Loaded progressively, because every prompt byte costs time on a small local GPU:
 * - a short core per agent (definition of done, checklist, anti-patterns) is always in its prompt;
 * - one or two topic sections are added when the request or the project's stack calls for them and
 *   the model's context leaves room (none on 8k models);
 * - everything else is one `read_playbook` call away.
 */

/** The 15 team agents plus the single coding agent. */
export type PlaybookAgent = AgentId | "coder";

export interface PlaybookTopic {
  id: string;
  title: string;
  summary: string;
  /** Agents the topic is for, most relevant first. */
  agents: PlaybookAgent[];
  /** Lower-case words and phrases that make the topic relevant (request text and stack hints). */
  triggers: string[];
  /** "new": only for requests that build something new (the production baseline). */
  when: "always" | "new";
  body: string;
}

const CORES: Record<PlaybookAgent, string> = {
  manager: managerCore,
  thinking: thinkingCore,
  reasoning: reasoningCore,
  "project-management": projectManagementCore,
  "ui-ux-design": uiUxDesignCore,
  diagram: diagramCore,
  backend: backendCore,
  frontend: frontendCore,
  database: databaseCore,
  integration: integrationCore,
  "ai-integration": aiIntegrationCore,
  testing: testingCore,
  security: securityCore,
  enhancement: enhancementCore,
  "devops-docs": devopsDocsCore,
  coder: coderCore,
};

function parseTopic(id: string, raw: string): PlaybookTopic {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw.replace(/\r\n/g, "\n"));
  if (!m) throw new Error(`Playbook topic "${id}" has no header.`);
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const list = (s: string | undefined) =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    id,
    title: meta.title ?? id,
    summary: meta.summary ?? "",
    agents: list(meta.agents) as PlaybookAgent[],
    triggers: list(meta.triggers).map((t) => t.toLowerCase()),
    when: meta.when === "new" ? "new" : "always",
    body: (m[2] ?? "").trim(),
  };
}

/** Specific stacks first, cross-cutting topics after: the order breaks ties when choosing. */
export const TOPICS: readonly PlaybookTopic[] = [
  parseTopic("fastapi", fastapiMd),
  parseTopic("django-drf", djangoDrfMd),
  parseTopic("nestjs", nestjsMd),
  parseTopic("node-api", nodeApiMd),
  parseTopic("nextjs", nextjsMd),
  parseTopic("react-vite", reactViteMd),
  parseTopic("mobile", mobileMd),
  parseTopic("tailwind-shadcn", tailwindShadcnMd),
  parseTopic("python-data", pythonDataMd),
  parseTopic("postgres", postgresMd),
  parseTopic("mongodb", mongodbMd),
  parseTopic("redis", redisMd),
  parseTopic("auth", authMd),
  parseTopic("rbac", rbacMd),
  parseTopic("api-design", apiDesignMd),
  parseTopic("contracts", contractsMd),
  parseTopic("local-ai-rag", localAiRagMd),
  parseTopic("testing-strategy", testingStrategyMd),
  parseTopic("owasp", owaspMd),
  parseTopic("performance", performanceMd),
  parseTopic("accessibility", accessibilityMd),
  parseTopic("design-system", designSystemMd),
  parseTopic("docker-ci", dockerCiMd),
  parseTopic("docs-run-scripts", docsRunScriptsMd),
  parseTopic("mermaid", mermaidMd),
  parseTopic("product-brief", productBriefMd),
  parseTopic("production-baseline", productionBaselineMd),
];

// ---- cores ---------------------------------------------------------------------------------

export function coreFor(agent: string): string {
  return (CORES as Record<string, string>)[agent]?.trim() ?? "";
}

/** The "Definition of done" bullets of an agent's core: what a reviewer checks the work against. */
export function definitionOfDone(agent: string): string {
  const core = coreFor(agent);
  const m = /## Definition of done\n([\s\S]*?)(?:\n## |$)/.exec(core);
  return (m?.[1] ?? "").trim();
}

export function topicsFor(agent: string): PlaybookTopic[] {
  return TOPICS.filter((t) => agent === "coder" || t.agents.includes(agent as PlaybookAgent));
}

export function topicListLine(agent: string): string {
  const ids = topicsFor(agent).map((t) => t.id);
  return `Playbook topics for you: ${ids.join(", ")}. Call read_playbook with a topic (or a query) before working in an area you are not sure about; with no arguments it lists all ${TOPICS.length} topics.`;
}

/** The always-on part of an agent's prompt: its core playbook and the topics it can load. */
export function corePrompt(agent: string): string {
  const core = coreFor(agent);
  if (!core) return "";
  return `# Your playbook\n${core}\n\n${topicListLine(agent)}`;
}

// ---- choosing topics -----------------------------------------------------------------------

const wordRes = new Map<string, RegExp>();
function wordRe(phrase: string): RegExp {
  let re = wordRes.get(phrase);
  if (!re) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\s+/g, "[\\s_-]+");
    re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
    wordRes.set(phrase, re);
  }
  return re;
}

/** Does the text mention this word or phrase as a whole word? */
export function mentions(text: string, phrase: string): boolean {
  return wordRe(phrase).test(text);
}

const NEW_WORK =
  /\b(build|create|make|develop|new|from scratch|scaffold|start|generate|set up|setup|design|implement)\b/i;
/** Stack hints that say little about the architecture: they count less than frameworks. */
const WEAK_HINTS = new Set([
  "pytest",
  "vitest",
  "jest",
  "playwright",
  "cypress",
  "docker",
  "tanstack",
  "react hook form",
  "zod",
  "celery",
]);

/** Each specialist's own topic: always a candidate for that agent, even when no word triggers it. */
const HOME: Partial<Record<PlaybookAgent, string>> = {
  manager: "production-baseline",
  thinking: "production-baseline",
  "project-management": "product-brief",
  "ui-ux-design": "design-system",
  diagram: "mermaid",
  integration: "contracts",
  "ai-integration": "local-ai-rag",
  testing: "testing-strategy",
  security: "owasp",
  enhancement: "performance",
  "devops-docs": "docs-run-scripts",
};

export function isNewWork(text: string, mode?: WorkMode): boolean {
  return mode === "full" || NEW_WORK.test(text);
}

function scoreTopic(t: PlaybookTopic, agent: string, text: string, hints: string[], isNew: boolean): number {
  const idx = t.agents.indexOf(agent as PlaybookAgent);
  if (agent !== "coder" && idx < 0) return 0;
  if (t.when === "new" && !isNew) return 0;
  let s = 0;
  const hits = t.triggers.filter((tr) => mentions(text, tr)).length;
  if (hits > 0) s += 2 + Math.min(hits - 1, 2) * 0.5;
  const stack = hints.filter((h) => t.triggers.includes(h));
  if (stack.some((h) => !WEAK_HINTS.has(h))) s += 3;
  else if (stack.length) s += 1.5;
  if (HOME[agent as PlaybookAgent] === t.id) s += 2.5;
  if (s === 0) return 0;
  if (idx === 0 || idx === 1) s += 1;
  return s;
}

/** The topics most relevant to this agent for this request and stack, best first. */
export function selectTopics(o: {
  agent: string;
  text: string;
  hints?: string[];
  mode?: WorkMode;
  max?: number;
}): PlaybookTopic[] {
  const isNew = isNewWork(o.text, o.mode);
  return TOPICS.map((t, i) => ({ t, i, s: scoreTopic(t, o.agent, o.text, o.hints ?? [], isNew) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, o.max ?? 2)
    .map((x) => x.t);
}

/**
 * How much topic text fits in the prompt for a model with this context length (in tokens).
 * Small contexts get none: the core and the topic list are already in the prompt, and the agent
 * can still call read_playbook.
 */
export function playbookBudget(contextLength: number): { topics: number; chars: number } {
  if (contextLength <= 8192) return { topics: 0, chars: 0 };
  if (contextLength <= 16_384) return { topics: 1, chars: 3600 };
  if (contextLength <= 32_768) return { topics: 2, chars: 8000 };
  return { topics: 2, chars: 11_000 };
}

/** Cut a section to `max` characters at a heading or paragraph, never inside a code block. */
export function trimSection(body: string, max: number, id: string): string {
  if (body.length <= max) return body;
  const note = `\n(Shortened to fit. read_playbook ${id} shows the rest.)`;
  const limit = Math.max(0, max - note.length);
  let cut = -1;
  const re = /\n(?=## )|\n\n/g;
  for (let m = re.exec(body); m && m.index <= limit; m = re.exec(body)) {
    const before = body.slice(0, m.index);
    if ((before.match(/```/g) ?? []).length % 2 === 0) cut = m.index;
  }
  if (cut <= 0) return "";
  return `${body.slice(0, cut).trimEnd()}${note}`;
}

/**
 * Topic sections chosen for this agent and request, within the budget for the model's context.
 * Empty when nothing is relevant or the context is small.
 */
export function autoTopicsPrompt(o: {
  agent: string;
  text: string;
  contextLength: number;
  root?: string;
  hints?: string[];
  mode?: WorkMode;
}): string {
  const budget = playbookBudget(o.contextLength);
  if (budget.topics === 0) return "";
  const hints = o.hints ?? (o.root ? detectStack(o.root).hints : []);
  const picked = selectTopics({
    agent: o.agent,
    text: o.text,
    hints,
    max: budget.topics,
    ...(o.mode ? { mode: o.mode } : {}),
  });
  if (!picked.length) return "";
  const per = Math.floor(budget.chars / picked.length);
  const parts = picked
    .map((t) => trimSection(t.body, per, t.id))
    .filter(Boolean)
    .map((s) => s.replace(/^# /, "## Playbook: "));
  if (!parts.length) return "";
  return `# Playbook sections for this task\n${parts.join("\n\n")}`;
}

// ---- the read_playbook tool ----------------------------------------------------------------

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "how",
  "what",
  "to",
  "in",
  "of",
  "a",
  "an",
  "on",
  "do",
  "i",
]);

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9.+#/-]*/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

export function searchTopics(query: string): { topic: PlaybookTopic; score: number }[] {
  const q = tokens(query);
  if (!q.length) return [];
  return TOPICS.map((t) => {
    let score = 0;
    for (const tr of t.triggers) if (mentions(query, tr)) score += 4;
    const title = new Set(tokens(t.title));
    const summary = new Set(tokens(t.summary));
    const body = t.body.toLowerCase();
    for (const w of q) {
      if (t.id === w || t.id.split("-").includes(w)) score += 3;
      if (title.has(w)) score += 2;
      if (summary.has(w)) score += 1;
      let n = 0;
      for (let i = body.indexOf(w); i >= 0 && n < 3; i = body.indexOf(w, i + w.length)) n++;
      score += n * 0.3;
    }
    return { topic: t, score };
  })
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score);
}

function norm(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\.md$/, "")
    .replace(/^core[:/ ]/, "")
    .replace(/[\s_]+/g, "-");
}

/** A topic by id, by one of its trigger words (postgresql, jwt, shadcn...), or by an id prefix. */
export function findTopic(name: string): PlaybookTopic | undefined {
  const n = norm(name);
  if (!n) return undefined;
  const plain = n.replace(/-/g, " ");
  return (
    TOPICS.find((t) => t.id === n) ??
    TOPICS.find((t) => t.triggers.includes(plain) || t.triggers.includes(n)) ??
    TOPICS.find((t) => t.id.startsWith(n))
  );
}

function listing(): string {
  return [
    `${TOPICS.length} playbook topics (read_playbook with a topic name to read one):`,
    ...TOPICS.map((t) => `- ${t.id}: ${t.title}. ${t.summary}`),
    "Agent playbooks (definition of done, checklist, what to avoid) are available too: use an agent id as the topic, e.g. backend or testing.",
  ].join("\n");
}

/** What the read_playbook tool returns. */
export function readPlaybook(a: { topic?: string | undefined; query?: string | undefined }): {
  title: string;
  text: string;
  found: boolean;
} {
  const topic = a.topic?.trim() ?? "";
  if (!topic && !a.query?.trim()) return { title: "Playbook topics", text: listing(), found: true };
  if (topic && /^(list|all|topics|index|help|\?)$/i.test(topic))
    return { title: "Playbook topics", text: listing(), found: true };
  if (topic) {
    const agent = norm(topic);
    if (agent in CORES) {
      return {
        title: `${agent} playbook`,
        text: `# Playbook of the ${agent} agent\n${coreFor(agent)}`,
        found: true,
      };
    }
    const t = findTopic(topic);
    if (t) return { title: t.title, text: t.body, found: true };
  }
  const hits = searchTopics(a.query?.trim() || topic);
  const best = hits[0];
  if (!best) {
    return {
      title: "No match",
      text: `No playbook matches "${a.query ?? topic}".\n${listing()}`,
      found: false,
    };
  }
  const others = hits.slice(1, 4).map((h) => h.topic.id);
  return {
    title: best.topic.title,
    text: `${best.topic.body}${others.length ? `\n\n(Other matching topics: ${others.join(", ")}.)` : ""}`,
    found: true,
  };
}
