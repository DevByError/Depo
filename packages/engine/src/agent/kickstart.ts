import type { DesignReference, WorkMode } from "@depo/shared";
import { writeBlueprint } from "../blueprints";
import { pickBlueprint } from "../blueprints/plan";
import type { Blueprint } from "../blueprints/types";
import { applyTheme, type ThemeTokens } from "../references/theme";

/**
 * The parts of a new system Depo can do without a model, done before the agents start: a tested
 * blueprint for the requested stack written into the empty private copy, and the design
 * reference's colours written into its design tokens. Small local models then extend working,
 * themed code instead of inventing a project (and its folder layout) from nothing.
 */

export interface KickstartResult {
  blueprint: Blueprint | null;
  /** Files the blueprint wrote. */
  files: string[];
  /** CSS files whose theme block now holds the reference's colours. */
  themed: string[];
  tokens: ThemeTokens | null;
  /** What the agents must know, for their prompt. */
  note: string;
}

export function kickstart(o: {
  mode: WorkMode;
  /** The owner's request. */
  text: string;
  /** The task's private copy. */
  root: string;
  projectName: string;
  references: DesignReference[];
  /** True when the references were studied in this run (the theme is only written then). */
  newReferences: boolean;
}): KickstartResult | null {
  const blueprint = pickBlueprint(o.mode, o.text, o.root);
  const files = blueprint
    ? writeBlueprint(o.root, blueprint, { name: o.projectName }).map((f) => f.path)
    : [];
  // Written once: on later runs the agents may have tuned the tokens, so they are left alone.
  const theme =
    o.references.length && (blueprint || o.newReferences) ? applyTheme(o.root, o.references) : null;
  if (!blueprint && !theme) return null;
  const lines: string[] = [];
  if (blueprint) {
    const names = [...new Set(files.map((f) => (f.includes("/") ? `${f.split("/")[0]}/` : f)))];
    const top = [
      ...names.filter((n) => n.endsWith("/")).sort(),
      ...names.filter((n) => !n.endsWith("/") && !n.startsWith(".")).sort(),
    ];
    lines.push(
      `Depo already wrote the ${blueprint.title} starting project into this folder (${files.length} files; top level: ${top.join(", ")}). It works and its tests pass. Do not create it again, do not start over and do not move it: read the files you need and extend them for the request.`,
      `Run: ${blueprint.runCommand}`,
      `Test: ${blueprint.testCommand}`,
      "How to extend it:",
      blueprint.extendGuide,
    );
  }
  if (theme) {
    lines.push(
      `Depo already put the design reference's colours, corner radius and font into the design tokens (${theme.files.join(", ")}), with text contrast fixed to WCAG AA. Keep that block; build every screen with the var(--...) tokens so the look matches the reference.`,
    );
  }
  return {
    blueprint,
    files,
    themed: theme?.files ?? [],
    tokens: theme?.tokens ?? null,
    note: lines.join("\n"),
  };
}
