import type { PageCheck } from "@depo/shared";
import { z } from "zod";

/** Nielsen's ten usability heuristics, the yardstick of the UX audit. */
export const HEURISTICS = [
  "Visibility of system status",
  "Match between system and the real world",
  "User control and freedom",
  "Consistency and standards",
  "Error prevention",
  "Recognition rather than recall",
  "Flexibility and efficiency of use",
  "Aesthetic and minimalist design",
  "Help users recognize, diagnose and recover from errors",
  "Help and documentation",
] as const;

export const UxAuditSchema = z.object({
  summary: z.string().min(1).max(1500),
  scores: z
    .array(
      z.object({
        heuristic: z.string().min(3).max(120),
        score: z.number().int().min(1).max(5),
        evidence: z.string().min(1).max(600),
        fix: z.string().max(600).default(""),
      }),
    )
    .min(10)
    .max(10),
});
export type UxAudit = z.infer<typeof UxAuditSchema>;

export interface UxResult {
  overall: number;
  grade: "A" | "B" | "C" | "D" | "F";
  blocksRelease: boolean;
  reasons: string[];
  markdown: string;
  json: string;
}

/** Match a heuristic name written by a model to the canonical list. */
export function canonicalHeuristic(name: string): string | null {
  const n = name.toLowerCase().replace(/^\d+[.)]\s*/, "");
  return (
    HEURISTICS.find(
      (h) => n.includes(h.toLowerCase().slice(0, 14)) || h.toLowerCase().includes(n.slice(0, 14)),
    ) ?? null
  );
}

/** What the latest page checks found that a UX audit should weigh: per page, the serious problems. */
export interface AutomatedFindings {
  lines: string[];
  critical: number;
  serious: number;
  consoleErrors: number;
  pages: number;
}

/** Summarise page checks (newest first) for the audit: the newest check per URL, critical and serious axe issues, console errors. */
export function automatedFindings(checks: PageCheck[]): AutomatedFindings {
  const seen = new Set<string>();
  const out: AutomatedFindings = { lines: [], critical: 0, serious: 0, consoleErrors: 0, pages: 0 };
  for (const c of checks) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.pages++;
    let page = c.url;
    try {
      page = new URL(c.url).pathname || "/";
    } catch {
      // keep the full address
    }
    const worst = new Map<string, { impact: string; help: string; count: number }>();
    let errors = 0;
    for (const v of c.views) {
      errors = Math.max(errors, v.consoleErrorCount);
      for (const a of v.a11y.violations)
        if (a.impact === "critical" || a.impact === "serious")
          worst.set(a.id, {
            impact: a.impact,
            help: a.help,
            count: Math.max(a.count, worst.get(a.id)?.count ?? 0),
          });
    }
    out.consoleErrors += errors;
    for (const [id, w] of worst) {
      if (w.impact === "critical") out.critical++;
      else out.serious++;
      if (out.lines.length < 12)
        out.lines.push(`${page}: ${w.impact} ${id} (${w.count} elements): ${w.help}`);
    }
    if (errors && out.lines.length < 12)
      out.lines.push(`${page}: ${errors} console error${errors === 1 ? "" : "s"}`);
  }
  return out;
}

export function scoreAudit(a: UxAudit, automated?: AutomatedFindings): UxResult {
  const seen = new Set<string>();
  const rows = a.scores.map((s) => {
    const h = canonicalHeuristic(s.heuristic) ?? s.heuristic;
    seen.add(h);
    return { ...s, heuristic: h };
  });
  const missing = HEURISTICS.filter((h) => !seen.has(h));
  if (missing.length) throw new Error(`Score all ten heuristics. Missing: ${missing.join("; ")}`);
  const avg = rows.reduce((n, r) => n + r.score, 0) / rows.length;
  const overall = Math.round((avg / 5) * 100);
  const grade = overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 70 ? "C" : overall >= 60 ? "D" : "F";
  const reasons: string[] = [];
  if (overall < 60) reasons.push(`The overall score is ${overall}/100 (below 60).`);
  for (const r of rows)
    if (r.score === 1) reasons.push(`"${r.heuristic}" scored 1/5: ${r.evidence.slice(0, 120)}`);
  const markdown = [
    "# UX audit",
    `Overall: **${overall}/100** (grade ${grade}). ${reasons.length ? "**Blocks release.**" : "Release is not blocked."}`,
    "",
    a.summary,
    "",
    "| # | Heuristic | Score | Evidence | Fix |",
    "|---|---|---|---|---|",
    ...rows.map(
      (r, i) =>
        `| ${i + 1} | ${r.heuristic} | ${r.score}/5 | ${r.evidence.replace(/\|/g, "/")} | ${r.fix.replace(/\|/g, "/")} |`,
    ),
    ...(reasons.length ? ["", "## Why the release is blocked", ...reasons.map((r) => `- ${r}`)] : []),
    ...(automated?.pages
      ? [
          "",
          "## Automated page checks (axe-core, console)",
          automated.lines.length
            ? automated.lines.map((l) => `- ${l.replace(/\|/g, "/")}`).join("\n")
            : `- ${automated.pages} page${automated.pages === 1 ? "" : "s"} checked: no critical or serious accessibility issues and no console errors.`,
        ]
      : []),
  ].join("\n");
  const json = JSON.stringify({
    overall,
    grade,
    blocksRelease: reasons.length > 0,
    scores: rows.map((r) => ({ heuristic: r.heuristic, score: r.score })),
    ...(automated?.pages
      ? {
          automated: {
            pages: automated.pages,
            critical: automated.critical,
            serious: automated.serious,
            consoleErrors: automated.consoleErrors,
          },
        }
      : {}),
    at: new Date().toISOString(),
  });
  return { overall, grade, blocksRelease: reasons.length > 0, reasons, markdown, json };
}
