import type { BlueprintFile, BlueprintVars } from "./types";

/**
 * Filling in templates. Tokens are distinctive (`__DEPO_NAME__`) so they never clash with the
 * code around them, and every value is escaped for the place it goes: the owner's project name is
 * text from a person, not code. Scripts (.cmd, .ps1, .sh) never contain it.
 */

/** A package-safe name: lower case letters, digits and dashes ("My Shop!" -> "my-shop"). */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return slug || "app";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL = /[\x00-\x1f\x7f]+/g;

/** One line of plain text: no control characters, trimmed. */
function oneLine(s: string, max: number): string {
  return s.replace(CONTROL, " ").trim().slice(0, max);
}

export function render(template: string, vars: BlueprintVars): string {
  const name = oneLine(vars.name, 80) || "My app";
  const description = (vars.description ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 2000);
  return (
    template
      // README: the description paragraph, or nothing when there is none.
      .replace(/__DEPO_DESCRIPTION__\n\n/g, description ? `${description}\n\n` : "")
      .replace(/__DEPO_DESCRIPTION__/g, description)
      // JSON.stringify gives a valid string literal for Python and TypeScript alike.
      .replace(/__DEPO_PY_NAME__|__DEPO_JS_NAME__/g, () => JSON.stringify(name))
      .replace(/__DEPO_HTML_NAME__/g, () => escapeHtml(name))
      .replace(/__DEPO_SLUG__/g, slugify(name))
      .replace(/__DEPO_NAME__/g, () => name)
  );
}

/** Windows scripts get Windows line endings (cmd.exe misreads labels in long LF-only files). */
export function withLineEndings(path: string, content: string): string {
  return /\.(cmd|bat|ps1)$/i.test(path) ? content.replace(/\r?\n/g, "\r\n") : content;
}

/** Render a set of templates (path -> template), optionally under a folder. */
export function renderSet(
  templates: Record<string, string>,
  vars: BlueprintVars,
  prefix = "",
  extra: Record<string, string> = {},
): BlueprintFile[] {
  const all = { ...templates, ...extra };
  return Object.keys(all)
    .sort()
    .map((rel) => {
      const path = prefix ? `${prefix}/${rel}` : rel;
      return { path, content: withLineEndings(path, render(all[rel] ?? "", vars)) };
    });
}
