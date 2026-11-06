/**
 * A light, dependency-free Mermaid checker. Mermaid itself needs a browser DOM, so the engine
 * cannot render; it can still catch what small models get wrong: no header, unbalanced brackets,
 * unclosed blocks, malformed relationships and oversized diagrams. The interface renders for real.
 */

export interface MermaidIssue {
  line: number;
  message: string;
}

export interface MermaidCheck {
  ok: boolean;
  type: string | null;
  issues: MermaidIssue[];
  /** erDiagram entity names, for cross-checking against the schema. */
  entities: string[];
  stats: { lines: number; nodes: number };
}

const HEADERS: [RegExp, string][] = [
  [/^(graph|flowchart)(\s+(TB|TD|BT|RL|LR))?\s*;?$/i, "flowchart"],
  [/^sequenceDiagram\b/, "sequence"],
  [/^classDiagram(-v2)?\b/, "class"],
  [/^stateDiagram(-v2)?\b/, "state"],
  [/^erDiagram\b/, "er"],
  [/^gantt\b/, "gantt"],
  [/^pie\b/, "pie"],
  [/^journey\b/, "journey"],
  [/^mindmap\b/, "mindmap"],
  [/^timeline\b/, "timeline"],
  [/^gitGraph\b/, "git"],
  [/^C4(Context|Container|Component|Dynamic|Deployment)\b/, "c4"],
  [/^requirementDiagram\b/, "requirement"],
  [/^quadrantChart\b/, "quadrant"],
  [/^xychart-beta\b/, "xychart"],
  [/^block-beta\b/, "block"],
  [/^architecture-beta\b/, "architecture"],
];

const MAX_NODES = 80;

function stripNoise(text: string): string[] {
  let t = text.replace(/\r\n/g, "\n");
  // YAML front matter
  t = t.replace(/^\s*---\n[\s\S]*?\n---\n/, "");
  return t.split("\n");
}

/** Count unmatched brackets in a line, ignoring text inside double quotes. */
function bracketBalance(line: string): { ok: boolean; reason?: string } {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if ("([{".includes(ch)) stack.push(ch);
    else if (")]}".includes(ch)) {
      if (stack.pop() !== pairs[ch]) return { ok: false, reason: `unexpected "${ch}"` };
    }
  }
  if (inQuote) return { ok: false, reason: "unclosed double quote" };
  if (stack.length) return { ok: false, reason: `unclosed "${stack.at(-1)}"` };
  return { ok: true };
}

export function checkMermaid(source: string): MermaidCheck {
  const raw = stripNoise(source);
  const issues: MermaidIssue[] = [];
  const entities: string[] = [];
  const nodes = new Set<string>();
  let type: string | null = null;
  let headerLine = -1;
  let depth = 0; // blocks: subgraph/end, loop/alt/opt/par/end, state { }
  let entityOpen = false;

  const lines = raw.map((l, i) => ({ n: i + 1, t: l.replace(/%%.*$/, "").trim() }));
  for (const { n, t } of lines) {
    if (!t) continue;
    if (type === null) {
      const h = HEADERS.find(([re]) => re.test(t));
      if (!h) {
        issues.push({
          line: n,
          message:
            'The first line must name the diagram type, e.g. "flowchart LR", "sequenceDiagram", "erDiagram" or "stateDiagram-v2".',
        });
        break;
      }
      type = h[1];
      headerLine = n;
      continue;
    }
    if (n === headerLine) continue;
    if (type === "flowchart") {
      if (/^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(t)) continue;
      if (/^subgraph\b/.test(t)) {
        depth++;
        continue;
      }
      if (t === "end") {
        depth--;
        if (depth < 0) issues.push({ line: n, message: '"end" without a matching "subgraph".' });
        depth = Math.max(0, depth);
        continue;
      }
      const b = bracketBalance(t);
      if (!b.ok) issues.push({ line: n, message: `Unbalanced brackets: ${b.reason}.` });
      if (/(-->|---|==>|-\.->|--[ox]|<-->)\s*$/.test(t))
        issues.push({ line: n, message: "An arrow has nothing after it." });
      if (/^\s*(-->|---|==>|-\.->)/.test(t))
        issues.push({ line: n, message: "An arrow has nothing before it." });
      for (const m of t.matchAll(
        /(?:^|[\s&;])([A-Za-z_][\w-]*)(?=\s*(?:\[|\(|\{|>|-->|---|==>|-\.|--|\s*&|\s*$))/g,
      )) {
        if (m[1]) nodes.add(m[1]);
      }
    } else if (type === "sequence") {
      if (/^(loop|alt|opt|par|critical|break|rect)\b/.test(t)) depth++;
      else if (t === "end") {
        depth--;
        if (depth < 0) issues.push({ line: n, message: '"end" without a matching block.' });
        depth = Math.max(0, depth);
      } else if (/^(participant|actor)\b/.test(t)) {
        const name = /^(?:participant|actor)\s+(\S+)/.exec(t)?.[1];
        if (name) nodes.add(name);
      } else if (
        /(->>|-->>|->|-->|-x|--x|-\)|--\))/.test(t) &&
        !/^[\w .-]+\s*(->>|-->>|->|-->|-x|--x|-\)|--\))[+-]?\s*[\w .-]+\s*:/.test(t)
      ) {
        if (!/^(note|activate|deactivate|autonumber|title)\b/i.test(t)) {
          issues.push({ line: n, message: 'A message must look like "A->>B: text".' });
        }
      }
    } else if (type === "er") {
      if (entityOpen) {
        if (t === "}") entityOpen = false;
        else if (!/^[\w[\]()]+\s+[\w[\]()]+(\s+(PK|FK|UK)(\s*,\s*(PK|FK|UK))*)?(\s+".*")?$/.test(t))
          issues.push({
            line: n,
            message: `Bad attribute "${t}". Use "type name" with optional PK, FK or UK.`,
          });
        continue;
      }
      const ent = /^([A-Za-z_][\w-]*)\s*\{\s*$/.exec(t);
      if (ent?.[1]) {
        entityOpen = true;
        entities.push(ent[1]);
        nodes.add(ent[1]);
        continue;
      }
      const rel =
        /^([A-Za-z_][\w-]*)\s+([|}o]{1,2}(?:--|\.\.)[|{o]{1,2})\s+([A-Za-z_][\w-]*)\s*:\s*(.+)$/.exec(t);
      if (rel) {
        for (const e of [rel[1], rel[3]])
          if (e) {
            nodes.add(e);
            if (!entities.includes(e)) entities.push(e);
          }
        continue;
      }
      if (/^[A-Za-z_][\w-]*$/.test(t)) {
        entities.push(t);
        nodes.add(t);
        continue;
      }
      issues.push({
        line: n,
        message: `Cannot read "${t}". A relationship looks like: USER ||--o{ TODO : owns`,
      });
    } else if (type === "state") {
      if (t.endsWith("{")) depth++;
      else if (t === "}") {
        depth--;
        if (depth < 0) issues.push({ line: n, message: 'Unexpected "}".' });
        depth = Math.max(0, depth);
      }
      for (const m of t.matchAll(/([A-Za-z_][\w]*)\s*-->/g)) if (m[1]) nodes.add(m[1]);
    } else {
      nodes.add(String(n));
    }
  }
  if (type === null && issues.length === 0) {
    issues.push({ line: 1, message: "The diagram is empty." });
  }
  if (depth > 0)
    issues.push({
      line: lines.length,
      message: `${depth} block(s) are not closed ("end" or "}" is missing).`,
    });
  if (entityOpen) issues.push({ line: lines.length, message: 'An entity is not closed with "}".' });
  if (nodes.size > MAX_NODES) {
    issues.push({
      line: 1,
      message: `Too many nodes (${nodes.size}). Split it into diagrams of at most ${MAX_NODES}.`,
    });
  }
  return {
    ok: issues.length === 0,
    type,
    issues,
    entities: [...new Set(entities)],
    stats: { lines: lines.filter((l) => l.t).length, nodes: nodes.size },
  };
}
