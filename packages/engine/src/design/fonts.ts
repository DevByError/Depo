/**
 * A small library of open-licence fonts that agents may choose from. Everything here is under the
 * SIL Open Font License (or Apache 2.0) and available from Fontsource, so a generated project can
 * self-host it (`npm i @fontsource/inter`) and never call a font CDN.
 */
export interface FontEntry {
  family: string;
  category: "sans" | "serif" | "mono" | "display" | "arabic";
  license: "OFL-1.1" | "Apache-2.0";
  /** npm package that ships the files for self-hosting. */
  fontsource: string;
  weights: number[];
  /** Scripts the font covers beyond Latin. */
  scripts: string[];
  /** Good for these moods. */
  tags: string[];
}

export const FONT_LIBRARY: FontEntry[] = [
  {
    family: "Inter",
    category: "sans",
    license: "OFL-1.1",
    fontsource: "@fontsource/inter",
    weights: [400, 500, 600, 700],
    scripts: ["latin", "cyrillic", "greek"],
    tags: ["neutral", "ui", "dashboard", "modern"],
  },
  {
    family: "Roboto",
    category: "sans",
    license: "Apache-2.0",
    fontsource: "@fontsource/roboto",
    weights: [400, 500, 700],
    scripts: ["latin", "cyrillic", "greek"],
    tags: ["neutral", "android", "ui"],
  },
  {
    family: "Open Sans",
    category: "sans",
    license: "OFL-1.1",
    fontsource: "@fontsource/open-sans",
    weights: [400, 600, 700],
    scripts: ["latin", "cyrillic", "greek"],
    tags: ["friendly", "web", "readable"],
  },
  {
    family: "Lato",
    category: "sans",
    license: "OFL-1.1",
    fontsource: "@fontsource/lato",
    weights: [400, 700],
    scripts: ["latin"],
    tags: ["friendly", "business"],
  },
  {
    family: "Source Sans 3",
    category: "sans",
    license: "OFL-1.1",
    fontsource: "@fontsource/source-sans-3",
    weights: [400, 600, 700],
    scripts: ["latin", "cyrillic", "greek"],
    tags: ["ui", "enterprise", "readable"],
  },
  {
    family: "Nunito",
    category: "sans",
    license: "OFL-1.1",
    fontsource: "@fontsource/nunito",
    weights: [400, 600, 700],
    scripts: ["latin", "cyrillic"],
    tags: ["friendly", "rounded", "playful", "education"],
  },
  {
    family: "Poppins",
    category: "sans",
    license: "OFL-1.1",
    fontsource: "@fontsource/poppins",
    weights: [400, 500, 600, 700],
    scripts: ["latin", "devanagari"],
    tags: ["geometric", "startup", "marketing"],
  },
  {
    family: "Montserrat",
    category: "sans",
    license: "OFL-1.1",
    fontsource: "@fontsource/montserrat",
    weights: [400, 500, 600, 700],
    scripts: ["latin", "cyrillic"],
    tags: ["geometric", "headings", "marketing"],
  },
  {
    family: "Work Sans",
    category: "sans",
    license: "OFL-1.1",
    fontsource: "@fontsource/work-sans",
    weights: [400, 500, 600],
    scripts: ["latin"],
    tags: ["clean", "saas"],
  },
  {
    family: "DM Sans",
    category: "sans",
    license: "OFL-1.1",
    fontsource: "@fontsource/dm-sans",
    weights: [400, 500, 700],
    scripts: ["latin"],
    tags: ["geometric", "saas", "modern"],
  },
  {
    family: "Merriweather",
    category: "serif",
    license: "OFL-1.1",
    fontsource: "@fontsource/merriweather",
    weights: [400, 700],
    scripts: ["latin", "cyrillic"],
    tags: ["editorial", "reading", "trust"],
  },
  {
    family: "Lora",
    category: "serif",
    license: "OFL-1.1",
    fontsource: "@fontsource/lora",
    weights: [400, 600, 700],
    scripts: ["latin", "cyrillic"],
    tags: ["editorial", "elegant", "blog"],
  },
  {
    family: "Playfair Display",
    category: "display",
    license: "OFL-1.1",
    fontsource: "@fontsource/playfair-display",
    weights: [400, 600, 700],
    scripts: ["latin", "cyrillic"],
    tags: ["headings", "luxury", "editorial"],
  },
  {
    family: "JetBrains Mono",
    category: "mono",
    license: "OFL-1.1",
    fontsource: "@fontsource/jetbrains-mono",
    weights: [400, 500, 700],
    scripts: ["latin", "cyrillic"],
    tags: ["code", "developer"],
  },
  {
    family: "Fira Code",
    category: "mono",
    license: "OFL-1.1",
    fontsource: "@fontsource/fira-code",
    weights: [400, 500, 700],
    scripts: ["latin"],
    tags: ["code", "developer"],
  },
  {
    family: "Cairo",
    category: "arabic",
    license: "OFL-1.1",
    fontsource: "@fontsource/cairo",
    weights: [400, 600, 700],
    scripts: ["arabic", "latin"],
    tags: ["rtl", "arabic", "ui", "modern"],
  },
  {
    family: "Tajawal",
    category: "arabic",
    license: "OFL-1.1",
    fontsource: "@fontsource/tajawal",
    weights: [400, 500, 700],
    scripts: ["arabic", "latin"],
    tags: ["rtl", "arabic", "ui", "clean"],
  },
  {
    family: "Noto Sans Arabic",
    category: "arabic",
    license: "OFL-1.1",
    fontsource: "@fontsource/noto-sans-arabic",
    weights: [400, 500, 700],
    scripts: ["arabic"],
    tags: ["rtl", "arabic", "neutral"],
  },
  {
    family: "Noto Kufi Arabic",
    category: "arabic",
    license: "OFL-1.1",
    fontsource: "@fontsource/noto-kufi-arabic",
    weights: [400, 600, 700],
    scripts: ["arabic"],
    tags: ["rtl", "arabic", "headings"],
  },
  {
    family: "Amiri",
    category: "arabic",
    license: "OFL-1.1",
    fontsource: "@fontsource/amiri",
    weights: [400, 700],
    scripts: ["arabic", "latin"],
    tags: ["rtl", "arabic", "reading", "classic"],
  },
  {
    family: "IBM Plex Sans Arabic",
    category: "arabic",
    license: "OFL-1.1",
    fontsource: "@fontsource/ibm-plex-sans-arabic",
    weights: [400, 500, 700],
    scripts: ["arabic"],
    tags: ["rtl", "arabic", "enterprise"],
  },
];

/** A modular type scale from a base size and ratio (e.g. 16 and 1.25), rounded to whole pixels. */
export function typeScale(base = 16, ratio = 1.25): Record<string, number> {
  const step = (n: number) => Math.round(base * ratio ** n);
  return {
    xs: Math.round(base / ratio / ratio),
    sm: Math.round(base / ratio),
    base,
    lg: step(1),
    xl: step(2),
    "2xl": step(3),
    "3xl": step(4),
    "4xl": step(5),
  };
}

export interface FontQuery {
  tags?: string[];
  category?: FontEntry["category"];
  /** Needs a right-to-left script (Arabic). */
  rtl?: boolean;
}

export function searchFonts(q: FontQuery): FontEntry[] {
  const tags = (q.tags ?? []).map((t) => t.toLowerCase());
  return FONT_LIBRARY.map((f) => ({
    f,
    score:
      (q.rtl ? (f.scripts.includes("arabic") ? 10 : -100) : f.category === "arabic" ? -2 : 0) +
      (q.category ? (f.category === q.category ? 5 : -5) : 0) +
      tags.filter((t) => f.tags.includes(t) || f.category === t).length * 3,
  }))
    .filter((x) => x.score > -50)
    .sort((a, b) => b.score - a.score || a.f.family.localeCompare(b.f.family))
    .map((x) => x.f);
}

/** Two families at most: one for headings and one for body text. */
export function suggestPairing(opts: { rtl?: boolean; mood?: string[] }): {
  heading: FontEntry;
  body: FontEntry;
  mono: FontEntry;
} {
  const found = searchFonts({ rtl: opts.rtl ?? false, tags: opts.mood ?? [] });
  const body =
    found.find((f) => f.category === "sans" || f.category === "arabic") ?? (FONT_LIBRARY[0] as FontEntry);
  const heading =
    found.find(
      (f) =>
        f.family !== body.family &&
        (f.category === "display" ||
          f.category === "serif" ||
          f.category === "sans" ||
          f.category === "arabic"),
    ) ?? body;
  const mono = FONT_LIBRARY.find((f) => f.category === "mono") as FontEntry;
  return { heading, body, mono };
}
