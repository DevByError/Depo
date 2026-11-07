import {
  type A11yCounts,
  type A11yImpact,
  A11yImpactSchema,
  type A11yViolation,
  A11yViolationSchema,
} from "@depo/shared";
import axeSource from "axe-core/axe.min.js" with { type: "text" };
import { z } from "zod";

/**
 * axe-core, the accessibility engine behind most automated WCAG checks, embedded in the engine as
 * text (imported with `type: "text"`, so `bun build --compile` ships it) and injected into the page
 * under test through the DevTools Protocol. Nothing is fetched at run time.
 */

/** Install axe in the page. `define`, `module` and `exports` are hidden so a page using AMD or CommonJS globals still gets `window.axe`. */
export function axeInjection(source: string = axeSource): string {
  return `(function (define, module, exports) {\n${source}\n;return typeof window.axe;\n})(undefined, undefined, undefined)`;
}

/** Run axe on the whole document and return the violations, already trimmed, as a JSON string. */
export const AXE_RUN = `(() => window.axe.run(document, { resultTypes: ["violations"] }).then((r) => JSON.stringify(
  r.violations.map((v) => ({
    id: String(v.id),
    impact: v.impact || null,
    help: String(v.help || "").slice(0, 300),
    helpUrl: String(v.helpUrl || "").slice(0, 300),
    count: v.nodes.length,
    targets: v.nodes.slice(0, 5).map((n) => [].concat(n.target).join(" ").slice(0, 300)),
  }))
)))()`;

const RANK: Record<A11yImpact, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

export function emptyCounts(): A11yCounts {
  return { critical: 0, serious: 0, moderate: 0, minor: 0 };
}

/** Parse what AXE_RUN returned: violations sorted most serious first (max 20) and counts by impact. */
export function shapeAxe(json: string): { violations: A11yViolation[]; counts: A11yCounts } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("axe returned something that is not JSON.");
  }
  const parsed = z
    .array(
      z.object({
        id: z.string(),
        impact: z.string().nullable().optional(),
        help: z.string().optional(),
        helpUrl: z.string().optional(),
        count: z.number().int().min(0),
        targets: z.array(z.string()).optional(),
      }),
    )
    .safeParse(raw);
  if (!parsed.success) throw new Error("axe returned results in an unexpected shape.");
  const counts = emptyCounts();
  const violations: A11yViolation[] = [];
  for (const v of parsed.data) {
    const impact = A11yImpactSchema.safeParse(v.impact).success ? (v.impact as A11yImpact) : null;
    if (impact) counts[impact] += 1;
    const item = A11yViolationSchema.safeParse({
      id: v.id.slice(0, 100),
      impact,
      help: (v.help ?? "").slice(0, 300),
      helpUrl: (v.helpUrl ?? "").slice(0, 300),
      count: v.count,
      targets: (v.targets ?? []).slice(0, 5).map((t) => t.slice(0, 300)),
    });
    if (item.success) violations.push(item.data);
  }
  violations.sort((a, b) => (a.impact ? RANK[a.impact] : 4) - (b.impact ? RANK[b.impact] : 4));
  return { violations: violations.slice(0, 20), counts };
}
