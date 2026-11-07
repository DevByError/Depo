import fs from "node:fs";
import path from "node:path";
import type { DesignReference, SwatchRole } from "@depo/shared";
import { contrast, fromHex, luminance, modeOf, type Rgb, toHex } from "./palette";

/**
 * The look of a design reference written straight into the project's design tokens, so the app
 * matches the picture before any model touches it. A blueprint keeps its tokens between
 * `depo:theme:start` and `depo:theme:end` markers in its CSS; Depo replaces that block. Every text
 * colour is checked against WCAG AA (4.5:1) and nudged darker or lighter until it passes.
 */

export interface ThemeTokens {
  mode: "light" | "dark";
  bg: string;
  /** The page's background: the plain colour, or a gradient when the design paints its page in colour. */
  pageBg: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  primaryHover: string;
  primaryText: string;
  accent: string;
  danger: string;
  success: string;
  focus: string;
  radius: string;
  font: string;
}

export const THEME_START = "/* depo:theme:start */";
export const THEME_END = "/* depo:theme:end */";

const FONT_STACK = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const AA = 4.5;

const DEFAULTS: Record<"light" | "dark", Omit<ThemeTokens, "mode" | "radius" | "font">> = {
  light: {
    bg: "#f4f6fb",
    pageBg: "var(--bg)",
    surface: "#ffffff",
    surfaceMuted: "#f1f4f9",
    border: "#dde3ec",
    text: "#1c2430",
    muted: "#5b6676",
    primary: "#1a6fd6",
    primaryHover: "#155db4",
    primaryText: "#ffffff",
    accent: "#0f9d8a",
    danger: "#b42318",
    success: "#067647",
    focus: "#1a6fd6",
  },
  dark: {
    bg: "#0f141b",
    pageBg: "var(--bg)",
    surface: "#171e28",
    surfaceMuted: "#1d2532",
    border: "#2a3444",
    text: "#e6ebf2",
    muted: "#a3adbb",
    primary: "#4d9bff",
    primaryHover: "#6eadff",
    primaryText: "#0b1220",
    accent: "#2cc6b0",
    danger: "#ff8a80",
    success: "#5fd39a",
    focus: "#4d9bff",
  },
};

/** Mix two colours: t = 0 gives a, 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const x = fromHex(a);
  const y = fromHex(b);
  return toHex([0, 1, 2].map((i) => (x[i] as number) + ((y[i] as number) - (x[i] as number)) * t) as Rgb);
}

/** Move `fg` towards black or white (whichever is further from `bg`) until it reaches `ratio`. */
export function withContrast(fg: string, bg: string, ratio = AA): string {
  const back = fromHex(bg);
  if (contrast(fromHex(fg), back) >= ratio) return fg;
  const target = luminance(back) > 0.4 ? "#000000" : "#ffffff";
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(fg, target, t);
    if (contrast(fromHex(c), back) >= ratio) return c;
  }
  return target;
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = fromHex(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return toHex([ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255]);
}

/** The same hue, a little richer and darker, until white text on it reaches `ratio` (null when it cannot). */
export function deepen(hex: string, ratio = AA, on = "#ffffff"): string | null {
  const [h, s0, l0] = toHsl(hex);
  const s = s0 < 0.12 ? s0 : Math.min(0.85, s0 + 0.15);
  for (let l = l0; l >= 0.12; l -= 0.01) {
    const c = fromHsl(h, s, l);
    if (contrast([255, 255, 255], fromHex(c)) >= ratio && contrast(fromHex(on), fromHex(c)) >= ratio)
      return c;
  }
  return null;
}

/** The text colour for a filled button: white or near-black, whichever reads; null when neither. */
function buttonText(fill: string): string | null {
  const c = fromHex(fill);
  if (contrast([255, 255, 255], c) >= AA) return "#ffffff";
  if (contrast([11, 18, 32], c) >= AA) return "#0b1220";
  return null;
}

/** Tokens for a reference: its measured colours in each role, fixed up for contrast. */
export function themeFromReference(ref: DesignReference): ThemeTokens | null {
  const role = (r: SwatchRole) => ref.palette.find((s) => s.role === r)?.hex ?? null;
  const background = role("background");
  if (!background) return null;
  const mode = ref.mode ?? modeOf(background);
  const d = DEFAULTS[mode];
  // Cards are lighter than the page in both light and dark designs, so the darker of the two big
  // quiet colours is the page and the lighter one the card.
  let bg = background;
  let surface = role("surface") ?? (mode === "light" ? "#ffffff" : mix(background, "#ffffff", 0.06));
  if (luminance(fromHex(surface)) < luminance(fromHex(bg))) [bg, surface] = [surface, bg];
  if (bg === surface) bg = mix(surface, "#000000", 0.04);
  // In a picture, text is measured from anti-aliased glyphs, which reads lighter than the colour
  // the designer chose: aim higher for a picture's main text (exact CSS colours from a link stay).
  const text = withContrast(role("text") ?? d.text, surface, ref.kind === "image" ? 10 : AA);
  const fixText = (c: string) => withContrast(withContrast(c, surface), bg);
  // The primary fills buttons: keep its hue and make it deeper (lighter in a dark theme) until its
  // label reads. A light theme prefers white labels, as most designs use them.
  const base = role("primary") ?? d.primary;
  const towards = mode === "light" ? "#000000" : "#ffffff";
  let primary = base;
  let label: string | null = null;
  if (mode === "light") {
    // The primary is also link text on the card, so it has to read there as well as under a label.
    const reads = (c: string) =>
      contrast([255, 255, 255], fromHex(c)) >= AA && contrast(fromHex(surface), fromHex(c)) >= AA;
    const deep = reads(base) ? base : deepen(base, AA, surface);
    if (deep && contrast(fromHex(deep), fromHex(base)) < 3.2) [primary, label] = [deep, "#ffffff"];
  }
  if (!label) label = buttonText(base);
  for (let t = 0.05; !label && t <= 0.95; t += 0.05) {
    const c = mix(base, towards, t);
    label = buttonText(c);
    if (label) primary = c;
  }
  const primaryText = label ?? (mode === "light" ? "#ffffff" : "#0b1220");
  const hover = mix(primary, primaryText === "#ffffff" ? "#000000" : "#ffffff", 0.14);
  // A design that paints its page in colour (a gradient behind the card): a soft gradient too.
  const brand = ref.palette.find((x) => x.role === "primary");
  const pageBg =
    mode === "light" && brand && brand.share >= 0.08
      ? `linear-gradient(160deg, ${mix(brand.hex, bg, 0.25)} 0%, ${bg} 65%)`
      : "var(--bg)";
  return {
    mode,
    bg,
    pageBg,
    surface,
    surfaceMuted: mix(surface, text, 0.035),
    border: role("border") ?? mix(surface, text, 0.14),
    text: fixText(text),
    muted: fixText(role("muted") ?? d.muted),
    primary,
    primaryHover: hover,
    primaryText,
    // Links and accents sit on the card as text.
    accent: withContrast(role("accent") ?? primary, surface),
    danger: withContrast(role("danger") ?? d.danger, surface),
    success: withContrast(role("success") ?? d.success, surface),
    focus: withContrast(primary, surface, 3),
    radius: normRadius(ref.radius) ?? "12px",
    font: fontFor(ref.fonts[0]),
  };
}

function normRadius(r: string | null): string | null {
  if (!r) return null;
  const m = /^(\d+(?:\.\d+)?)px$/.exec(r.trim());
  if (!m) return null;
  const n = Math.min(28, Math.max(0, Math.round(Number(m[1]))));
  return `${n}px`;
}

/** The reference's font first, then the usual stack; a generic family ("sans-serif") alone adds nothing. */
function fontFor(first: string | undefined): string {
  const name = first?.replace(/["';{}<>]/g, "").trim();
  if (!name || /^(sans-serif|system-ui|ui-sans-serif)$/i.test(name)) return FONT_STACK;
  if (/^(serif|ui-serif)$/i.test(name)) return 'Georgia, "Times New Roman", serif';
  if (/^(monospace|ui-monospace)$/i.test(name)) return 'ui-monospace, Consolas, "Courier New", monospace';
  return `${quoteFont(name)}, ${FONT_STACK}`;
}

function quoteFont(f: string): string {
  const name = f.replace(/["';{}<>]/g, "").trim();
  return /^[a-z-]+$/i.test(name) && !/\s/.test(name) ? name : `"${name}"`;
}

/** The CSS between the markers. */
export function themeBlock(t: ThemeTokens): string {
  const rows: [string, string][] = [
    ["--bg", t.bg],
    ["--page-bg", t.pageBg],
    ["--surface", t.surface],
    ["--surface-muted", t.surfaceMuted],
    ["--border", t.border],
    ["--text", t.text],
    ["--muted", t.muted],
    ["--primary", t.primary],
    ["--primary-hover", t.primaryHover],
    ["--primary-text", t.primaryText],
    ["--accent", t.accent],
    ["--danger", t.danger],
    ["--success", t.success],
    ["--focus", t.focus],
    ["--radius", t.radius],
    ["--font", t.font],
  ];
  return [
    THEME_START,
    ":root {",
    `  color-scheme: ${t.mode};`,
    ...rows.map(([k, v]) => `  ${k}: ${v};`),
    "}",
    THEME_END,
  ].join("\n");
}

/** Replace the theme block in CSS text; null when it has no markers. */
export function replaceThemeBlock(css: string, t: ThemeTokens): string | null {
  const a = css.indexOf(THEME_START);
  const b = css.indexOf(THEME_END);
  if (a < 0 || b < a) return null;
  const eol = css.includes("\r\n") ? "\r\n" : "\n";
  return css.slice(0, a) + themeBlock(t).replace(/\n/g, eol) + css.slice(b + THEME_END.length);
}

const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".depo", ".venv", "venv"]);

/** CSS files with a theme block, at most four folders deep. */
export function themedFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4 && !SKIP.has(e.name)) walk(abs, depth + 1);
      } else if (e.name.endsWith(".css")) {
        try {
          if (fs.readFileSync(abs, "utf8").includes(THEME_START)) out.push(abs);
        } catch {
          // unreadable: skip
        }
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

/**
 * Write the first studied reference's look into every theme block under `root`. Returns the
 * changed files (relative, forward slashes) and the tokens, or null when nothing was changed.
 */
export function applyTheme(
  root: string,
  refs: DesignReference[],
): { files: string[]; tokens: ThemeTokens; from: DesignReference } | null {
  const from = refs.find((r) => r.state === "studied" && r.palette.some((s) => s.role === "background"));
  if (!from) return null;
  const tokens = themeFromReference(from);
  if (!tokens) return null;
  const files: string[] = [];
  for (const abs of themedFiles(root)) {
    const css = fs.readFileSync(abs, "utf8");
    const next = replaceThemeBlock(css, tokens);
    if (next !== null && next !== css) {
      fs.writeFileSync(abs, next, "utf8");
      files.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  }
  return files.length ? { files, tokens, from } : null;
}
