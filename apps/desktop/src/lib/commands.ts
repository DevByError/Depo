import type { CenterTab } from "@/store/ui";

export interface Command {
  id: string;
  title: string;
  /** Extra words that should find this command. */
  keywords?: string;
  group: "Go to" | "Do" | "Help";
  run(): void;
}

/** Every tab in the centre, in the order they appear. Typed so a renamed tab cannot be forgotten. */
export const TAB_COMMANDS: { id: CenterTab; label: string; keywords: string }[] = [
  { id: "overview", label: "Project", keywords: "overview dashboard home" },
  { id: "chat", label: "Chat", keywords: "task prompt talk ask" },
  { id: "plan", label: "Plan", keywords: "board kanban team agents" },
  { id: "files", label: "Files", keywords: "browse code" },
  { id: "diff", label: "Diff Review", keywords: "changes approve apply review" },
  { id: "memory", label: "Memory", keywords: "facts decisions remember" },
  { id: "design", label: "Design", keywords: "tokens fonts colors ux" },
  { id: "diagrams", label: "Diagrams", keywords: "mermaid erd flow" },
  { id: "slides", label: "Slides", keywords: "deck pitch presentation" },
  { id: "agent-lab", label: "Agent Lab", keywords: "agents versions evaluate compare promote" },
  { id: "showcase", label: "Showcase", keywords: "demo manager features versions overview numbers" },
  { id: "skills", label: "Skills", keywords: "mcp extensions" },
  { id: "models", label: "Models", keywords: "ollama gpu download" },
  { id: "knowledge", label: "Knowledge", keywords: "packs docs osv" },
  { id: "blocks", label: "Blocks", keywords: "building blocks login roles auth" },
  { id: "security", label: "Security", keywords: "scan secrets vulnerabilities" },
  { id: "team", label: "Team", keywords: "agents mission control decisions live graph" },
  { id: "preview", label: "Preview", keywords: "run app link browser localhost start server" },
];

/**
 * Score how well a query matches a text: 0 = no match. Consecutive letters and word starts score
 * higher, so "dl" finds "Diff Review"? no, but "dif" and "dr" do.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 1;
  const t = text.toLowerCase();
  const at = t.indexOf(query.toLowerCase().trim());
  if (at >= 0) return 100 - Math.min(at, 50) + (at === 0 ? 20 : 0);
  let score = 0;
  let ti = 0;
  let run = 0;
  let first = -1;
  // A scattered match only counts when every jump lands on a word start ("nt" for "New task").
  let jumpsOnWords = true;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    const wordStart = found === 0 || t[found - 1] === " ";
    if (first < 0) first = found;
    else if (found !== ti && !wordStart) jumpsOnWords = false;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (wordStart ? 3 : 0);
    ti = found + 1;
  }
  // Letters spread over the whole title ("health" in "Switch between dark and light theme") are noise.
  if (!jumpsOnWords && ti - first > q.length * 2 + 2) return 0;
  return score;
}

export function filterCommands(commands: Command[], query: string): Command[] {
  if (!query.trim()) return commands;
  return commands
    .map((c) => ({ c, s: Math.max(fuzzyScore(query, c.title), fuzzyScore(query, c.keywords ?? "") * 0.6) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}
