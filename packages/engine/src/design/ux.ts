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

export function scoreAudit(a: UxAudit): UxResult {
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
  ].join("\n");
  const json = JSON.stringify({
    overall,
    grade,
    blocksRelease: reasons.length > 0,
    scores: rows.map((r) => ({ heuristic: r.heuristic, score: r.score })),
    at: new Date().toISOString(),
  });
  return { overall, grade, blocksRelease: reasons.length > 0, reasons, markdown, json };
}
