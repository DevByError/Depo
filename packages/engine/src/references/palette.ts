import type { Swatch, SwatchRole } from "@depo/shared";

/**
 * Colour maths for design references: the main colours of a picture from its pixels, CSS colour
 * parsing for values read from a page, WCAG contrast, and a best guess at each colour's role.
 */

export type Rgb = [number, number, number];

export function toHex([r, g, b]: Rgb): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function fromHex(hex: string): Rgb {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m?.[1]) throw new Error(`Not a colour: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance (0 black .. 1 white). */
export function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CIE Lab (D65), for distances that match what people see. */
export function toLab([r, g, b]: Rgb): [number, number, number] {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function deltaE(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** How colourful (Lab chroma): greys are near 0, a strong teal is about 40. */
export function chroma(c: Rgb): number {
  const [, a, b] = toLab(c);
  return Math.hypot(a, b);
}

function hue(c: Rgb): number {
  const [, a, b] = toLab(c);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

/**
 * A CSS colour as the browser reports it (`rgb(…)`, `rgba(…)`, `#abc`, `color(srgb …)`), blended
 * over `under` when it is partly transparent. Null for transparent or unknown values.
 */
export function parseCssColor(value: string, under: Rgb = [255, 255, 255]): Rgb | null {
  const v = value.trim().toLowerCase();
  if (!v || v === "transparent" || v === "none") return null;
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex?.[1]) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    const n = Number.parseInt(h.slice(0, 6), 16);
    const alpha = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
    return blend([(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha, under);
  }
  const fn = v.match(/^(rgba?|color)\((.*)\)$/);
  if (!fn?.[2]) return null;
  let body = fn[2].trim();
  let scale = 1;
  if (fn[1] === "color") {
    if (!body.startsWith("srgb")) return null;
    body = body.slice(4).trim();
    scale = 255;
  }
  const parts = body
    .replace(/\s*\/\s*/, " / ")
    .split(/[\s,]+/)
    .filter((p) => p && p !== "/");
  if (parts.length < 3) return null;
  const num = (p: string, max: number) => (p.endsWith("%") ? (Number.parseFloat(p) / 100) * max : Number(p));
  const rgb = parts.slice(0, 3).map((p) => num(p, 255 / scale) * scale) as Rgb;
  if (rgb.some((c) => !Number.isFinite(c))) return null;
  const alpha = parts[3] !== undefined ? num(parts[3], 1) : 1;
  if (!Number.isFinite(alpha) || alpha <= 0.02) return null;
  return blend(rgb, Math.min(1, alpha), under);
}

function blend(c: Rgb, alpha: number, under: Rgb): Rgb {
  if (alpha >= 1) return c.map((v) => Math.round(v)) as Rgb;
  return c.map((v, i) => Math.round(v * alpha + (under[i] ?? 255) * (1 - alpha))) as Rgb;
}

interface Cluster {
  rgb: Rgb;
  count: number;
}

/**
 * The main colours of a picture from RGBA pixels: 4-bit buckets, merged when people would call
 * them the same colour, most common first. Small but colourful clusters (a button, a link) are
 * kept even when they cover little of the picture.
 */
export function paletteFromPixels(
  rgba: Uint8Array,
  opts: { max?: number } = {},
): { hex: string; share: number }[] {
  const max = opts.max ?? 10;
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < 128) continue;
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const k = buckets.get(key);
    if (k) {
      k.r += r;
      k.g += g;
      k.b += b;
      k.n++;
    } else buckets.set(key, { r, g, b, n: 1 });
    total++;
  }
  if (total === 0) return [];
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  const clusters: Cluster[] = [];
  for (const k of sorted) {
    const rgb: Rgb = [k.r / k.n, k.g / k.n, k.b / k.n];
    const near = clusters.find((c) => deltaE(c.rgb, rgb) < 5);
    if (near) {
      const n = near.count + k.n;
      near.rgb = near.rgb.map((v, i) => (v * near.count + (rgb[i] ?? 0) * k.n) / n) as Rgb;
      near.count = n;
    } else if (clusters.length < 64) clusters.push({ rgb, count: k.n });
  }
  clusters.sort((a, b) => b.count - a.count);
  const share = (c: Cluster) => c.count / total;
  const main = clusters.filter((c) => share(c) >= 0.004).slice(0, Math.max(1, max - 3));
  const bg = main[0]?.rgb;
  // Text: thin strokes cover little of a picture but matter most; keep the strongest contrast.
  const texts = clusters
    .filter(
      (c) =>
        !main.includes(c) && share(c) >= 0.0005 && chroma(c.rgb) < 25 && bg && contrast(c.rgb, bg) >= 4.5,
    )
    .sort((a, b) => share(b) - share(a))
    .slice(0, main.some((c) => bg && contrast(c.rgb, bg) >= 4.5 && chroma(c.rgb) < 25) ? 1 : 2);
  // Accents: the most colourful of the rest, when they are clearly visible.
  const accents = clusters
    .filter((c) => !main.includes(c) && !texts.includes(c) && share(c) >= 0.0005 && chroma(c.rgb) >= 25)
    .sort((a, b) => chroma(b.rgb) * Math.sqrt(share(b)) - chroma(a.rgb) * Math.sqrt(share(a)))
    .slice(0, Math.max(0, max - main.length - texts.length));
  return [...main, ...texts, ...accents].map((c) => ({ hex: toHex(c.rgb), share: round(share(c)) }));
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Best guess at what each colour is for. The biggest colour is the background; text is the
 * colour with the most contrast against it; the most colourful is the primary. Guesses only: the
 * vision model and the agents may correct them.
 */
export function assignRoles(colors: { hex: string; share: number }[]): Swatch[] {
  const out: Swatch[] = colors.map((c) => ({ hex: c.hex.toLowerCase(), share: c.share, role: null }));
  if (!out.length) return out;
  const rgb = (s: Swatch) => fromHex(s.hex);
  const free = () => out.filter((s) => s.role === null);
  const take = (s: Swatch | undefined, role: SwatchRole) => {
    if (s) s.role = role;
  };
  const bg = out[0] as Swatch;
  take(bg, "background");
  const bgRgb = rgb(bg);
  const [bgL] = toLab(bgRgb);
  // Surface: a large area close to the background's lightness (cards, panels, the sidebar).
  take(
    free().find((s) => s.share >= 0.03 && chroma(rgb(s)) < 20 && Math.abs(toLab(rgb(s))[0] - bgL) <= 14),
    "surface",
  );
  // Text: the most contrast against the background among colours that are not colourful.
  const textual = free()
    .filter((s) => chroma(rgb(s)) < 22 && contrast(rgb(s), bgRgb) >= 4.5)
    .sort((a, b) => contrast(rgb(b), bgRgb) - contrast(rgb(a), bgRgb));
  take(textual[0], "text");
  take(
    free()
      .filter((s) => chroma(rgb(s)) < 22 && contrast(rgb(s), bgRgb) >= 2.5)
      .sort((a, b) => contrast(rgb(b), bgRgb) - contrast(rgb(a), bgRgb))[0],
    "muted",
  );
  // Primary and accent: colourful colours, the most visible first.
  // The brand colour is usually the colourful one used most; chroma only breaks near-ties.
  const score = (s: Swatch) => s.share * (1 + chroma(rgb(s)) / 100);
  const colourful = free()
    .filter((s) => chroma(rgb(s)) >= 25)
    .sort((a, b) => score(b) - score(a));
  const primary = colourful[0];
  take(primary, "primary");
  if (primary) {
    const h = hue(rgb(primary));
    for (const s of colourful.slice(1)) {
      const d = Math.abs(hue(rgb(s)) - h);
      const apart = Math.min(d, 360 - d) >= 35;
      if (!apart) continue;
      const hh = hue(rgb(s));
      // Clear reds and greens usually mean danger and success, not a second brand colour.
      if (hh >= 15 && hh <= 50 && chroma(rgb(s)) >= 45 && !out.some((x) => x.role === "danger"))
        take(s, "danger");
      else if (hh >= 120 && hh <= 165 && !out.some((x) => x.role === "success")) take(s, "success");
      else if (!out.some((x) => x.role === "accent")) take(s, "accent");
    }
  }
  // Border: a quiet colour a little away from the background.
  take(
    free().find((s) => {
      const d = Math.abs(toLab(rgb(s))[0] - bgL);
      return chroma(rgb(s)) < 22 && d >= 3 && d <= 22;
    }),
    "border",
  );
  return out;
}

/** Light or dark, from the background. */
export function modeOf(background: string): "light" | "dark" {
  return luminance(fromHex(background)) < 0.2 ? "dark" : "light";
}

/** The colours of two palettes side by side: role by role, what differs. Empty when they match. */
export function paletteDifferences(reference: Swatch[], yours: Swatch[]): string[] {
  const lines: string[] = [];
  const roles: SwatchRole[] = ["background", "surface", "text", "primary", "accent", "border"];
  for (const role of roles) {
    const want = reference.find((s) => s.role === role);
    if (!want) continue;
    const have = yours.find((s) => s.role === role);
    if (!have) {
      lines.push(`${role}: the reference uses ${want.hex}; no matching colour found in yours.`);
      continue;
    }
    const d = deltaE(fromHex(want.hex), fromHex(have.hex));
    if (d >= 8) lines.push(`${role}: reference ${want.hex}, yours ${have.hex} (clearly different).`);
  }
  return lines;
}
