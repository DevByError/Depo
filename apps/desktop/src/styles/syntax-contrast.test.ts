import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOKEN_KINDS } from "@/lib/highlight/tokens";

// Read from disk: the test runner hands CSS imports over empty.
const here = import.meta.dirname;
const themeCss = readFileSync(path.join(here, "../styles.css"), "utf8");
const syntaxCss = readFileSync(path.join(here, "syntax.css"), "utf8");

/**
 * Every syntax colour must meet WCAG AA (4.5:1) on every background code sits on, in both themes:
 * the surfaces, the selected-line tint and the added/removed line tints of the diffs
 * (`bg-success/10`, `/12`, `bg-danger/10`, `/12` over bg, panel and raised).
 */

type Rgb = [number, number, number];

function block(css: string, selector: RegExp): Record<string, string> {
  const m = selector.exec(css);
  if (!m) throw new Error(`No block for ${selector}`);
  const body = css.slice(m.index + m[0].length, css.indexOf("}", m.index));
  const vars: Record<string, string> = {};
  for (const v of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g))
    vars[v[1] as string] = v[2] as string;
  return vars;
}

const hex = (h: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A translucent colour composited over a surface (how `bg-success/12` is painted). */
const over = (top: Rgb, alpha: number, under: Rgb): Rgb =>
  [0, 1, 2].map((i) => (top[i] as number) * alpha + (under[i] as number) * (1 - alpha)) as Rgb;

const LIGHT = /:root,\s*\[data-theme="light"\]\s*\{/;
const DARK = /\[data-theme="dark"\]\s*\{/;

const themes = {
  light: { theme: block(themeCss, LIGHT), syntax: block(syntaxCss, LIGHT) },
  dark: { theme: block(themeCss, DARK), syntax: block(syntaxCss, DARK) },
};

function backgrounds(t: Record<string, string>): Record<string, Rgb> {
  const get = (k: string) => {
    const v = t[k];
    if (!v) throw new Error(`Missing --${k}`);
    return hex(v);
  };
  const out: Record<string, Rgb> = {};
  for (const k of ["bg", "panel", "raised", "hover", "accent-soft"]) out[k] = get(k);
  for (const under of ["bg", "panel", "raised"]) {
    for (const tint of ["success", "danger"]) {
      for (const alpha of [0.1, 0.12])
        out[`${tint}/${alpha * 100} on ${under}`] = over(get(tint), alpha, get(under));
    }
  }
  return out;
}

describe.each(Object.entries(themes))("syntax colours (%s theme)", (_name, { theme, syntax }) => {
  const colourKinds = TOKEN_KINDS.filter((k) => k !== "strong" && k !== "emphasis");

  it("defines a colour for every token kind", () => {
    for (const k of colourKinds) expect(syntax[`syn-${k}`], k).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("meets 4.5:1 on every code background", () => {
    const failures: string[] = [];
    for (const k of colourKinds) {
      const fg = hex(syntax[`syn-${k}`] ?? "#000000");
      for (const [where, bg] of Object.entries(backgrounds(theme))) {
        const ratio = contrast(fg, bg);
        if (ratio < 4.5) failures.push(`${k} on ${where}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("plain code text (fg) also passes on the tints", () => {
    const fg = hex(theme.fg ?? "#000000");
    for (const bg of Object.values(backgrounds(theme))) expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

it("uses a CSS class for every token kind", () => {
  for (const k of TOKEN_KINDS) expect(syntaxCss).toContain(`.tok-${k} {`);
});
