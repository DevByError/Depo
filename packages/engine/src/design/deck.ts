import fs from "node:fs";
import path from "node:path";
import PptxGenJS from "pptxgenjs";
import { z } from "zod";
import { resolveInside } from "../tools/paths";
import { findBrowser, printPdf } from "./browser";

export const SlideSchema = z.object({
  layout: z.enum(["title", "bullets", "two-column", "stats", "image"]).default("bullets"),
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).optional(),
  bullets: z.array(z.string().max(220)).max(8).optional(),
  left: z.array(z.string().max(160)).max(6).optional(),
  right: z.array(z.string().max(160)).max(6).optional(),
  stats: z
    .array(z.object({ label: z.string().max(40), value: z.string().max(20) }))
    .max(4)
    .optional(),
  /** Path of a PNG or JPG inside the project (a real screenshot of the system). */
  image: z.string().max(300).optional(),
  notes: z.string().max(1500).optional(),
});

export const DeckSpecSchema = z.object({
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).optional(),
  kind: z.enum(["pitch", "progress"]).default("pitch"),
  theme: z
    .object({
      background: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#0f172a"),
      text: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#f8fafc"),
      accent: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#38bdf8"),
      font: z
        .string()
        .regex(
          /^[A-Za-z0-9 ._-]{1,60}$/,
          "Font names may only use letters, digits, spaces, dots, dashes and underscores",
        )
        .default("Inter"),
    })
    .default({ background: "#0f172a", text: "#f8fafc", accent: "#38bdf8", font: "Inter" }),
  slides: z.array(SlideSchema).min(1).max(30),
});
export type DeckSpec = z.infer<typeof DeckSpecSchema>;
export type Slide = z.infer<typeof SlideSchema>;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function imageData(root: string, rel: string): { b64: string; mime: string } | null {
  try {
    const { abs } = resolveInside(root, rel);
    const ext = path.extname(abs).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : null;
    if (!mime) return null;
    return { b64: fs.readFileSync(abs).toString("base64"), mime };
  } catch {
    return null;
  }
}

/** A self-contained HTML deck: arrow keys move between slides, print gives one slide per page. */
export function deckHtml(spec: DeckSpec, root: string): string {
  const t = spec.theme;
  const slides = spec.slides.map((s, i) => {
    const img = s.image ? imageData(root, s.image) : null;
    const list = (items?: string[]) =>
      items?.length ? `<ul>${items.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : "";
    let body = "";
    if (s.layout === "title")
      body = `<h1>${esc(s.title)}</h1>${s.subtitle ? `<p class="sub">${esc(s.subtitle)}</p>` : ""}`;
    else if (s.layout === "two-column")
      body = `<h2>${esc(s.title)}</h2><div class="cols"><div>${list(s.left)}</div><div>${list(s.right)}</div></div>`;
    else if (s.layout === "stats")
      body = `<h2>${esc(s.title)}</h2><div class="stats">${(s.stats ?? []).map((x) => `<div><b>${esc(x.value)}</b><span>${esc(x.label)}</span></div>`).join("")}</div>${list(s.bullets)}`;
    else if (s.layout === "image")
      body = `<h2>${esc(s.title)}</h2>${img ? `<img alt="${esc(s.title)}" src="data:${img.mime};base64,${img.b64}">` : `<p class="sub">(image not found: ${esc(s.image ?? "")})</p>`}${list(s.bullets)}`;
    else body = `<h2>${esc(s.title)}</h2>${list(s.bullets)}`;
    return `<section class="slide ${s.layout}" data-i="${i}">${body}${s.notes ? `<aside>${esc(s.notes)}</aside>` : ""}<footer>${esc(spec.title)} · ${i + 1}</footer></section>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(spec.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root{--bg:${t.background};--fg:${t.text};--ac:${t.accent};--font:"${t.font}",system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;background:#000;color:var(--fg);font-family:var(--font)}
.slide{width:100vw;height:56.25vw;max-height:100vh;max-width:177.78vh;margin:0 auto;background:var(--bg);padding:6% 7%;position:relative;display:none;overflow:hidden}
.slide.on{display:block}
h1{font-size:5.2vw;margin:18% 0 1%;line-height:1.1}h2{font-size:3.2vw;margin:0 0 3%;color:var(--ac)}
.sub{font-size:2vw;opacity:.8}ul{font-size:2vw;line-height:1.5;padding-left:2.2vw}li{margin:.6vw 0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:4%}.stats{display:flex;gap:4%;margin:4% 0}
.stats div{flex:1;border:1px solid var(--ac);border-radius:1vw;padding:2vw}.stats b{display:block;font-size:4vw;color:var(--ac)}.stats span{font-size:1.6vw;opacity:.85}
img{max-width:100%;max-height:60%;border-radius:.8vw;border:1px solid #334155}
aside{display:none}footer{position:absolute;bottom:3%;left:7%;right:7%;font-size:1.1vw;opacity:.55}
@media print{@page{size:1280px 720px;margin:0}body{background:none}.slide{display:block!important;width:1280px;height:720px;max-width:none;max-height:none;padding:64px 90px;page-break-after:always;font-size:16px}
h1{font-size:66px}h2{font-size:42px}.sub,ul{font-size:26px}.stats b{font-size:52px}.stats span{font-size:20px}footer{font-size:14px}}
</style></head><body>
${slides.join("\n")}
<script>
const s=[...document.querySelectorAll(".slide")];let i=0;const show=n=>{i=Math.max(0,Math.min(s.length-1,n));s.forEach((e,k)=>e.classList.toggle("on",k===i));location.hash=String(i+1)};
addEventListener("keydown",e=>{if(["ArrowRight","PageDown"," "].includes(e.key))show(i+1);if(["ArrowLeft","PageUp"].includes(e.key))show(i-1)});
addEventListener("click",e=>show(i+(e.clientX>innerWidth/2?1:-1)));show((parseInt(location.hash.slice(1))||1)-1);
</script></body></html>`;
}

export async function deckPptx(spec: DeckSpec, root: string): Promise<Buffer> {
  const t = spec.theme;
  const strip = (c: string) => c.replace("#", "");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.title = spec.title;
  pptx.defineSlideMaster({ title: "DEPO", background: { color: strip(t.background) } });
  const font = t.font;
  const bullets = (items: string[], size = 20) =>
    items.map((b) => ({
      text: b,
      options: { bullet: true, fontSize: size, color: strip(t.text), fontFace: font, breakLine: true },
    }));
  for (const s of spec.slides) {
    const slide = pptx.addSlide({ masterName: "DEPO" });
    if (s.notes) slide.addNotes(s.notes);
    if (s.layout === "title") {
      slide.addText(s.title, {
        x: 0.7,
        y: 2.0,
        w: 8.6,
        h: 1.4,
        fontSize: 40,
        bold: true,
        color: strip(t.text),
        fontFace: font,
      });
      if (s.subtitle)
        slide.addText(s.subtitle, {
          x: 0.7,
          y: 3.5,
          w: 8.6,
          h: 0.8,
          fontSize: 20,
          color: strip(t.accent),
          fontFace: font,
        });
      continue;
    }
    slide.addText(s.title, {
      x: 0.6,
      y: 0.4,
      w: 8.8,
      h: 0.8,
      fontSize: 28,
      bold: true,
      color: strip(t.accent),
      fontFace: font,
    });
    if (s.layout === "two-column") {
      slide.addText(bullets(s.left ?? [], 18), { x: 0.6, y: 1.4, w: 4.3, h: 3.6, valign: "top" });
      slide.addText(bullets(s.right ?? [], 18), { x: 5.1, y: 1.4, w: 4.3, h: 3.6, valign: "top" });
    } else if (s.layout === "stats") {
      const st = s.stats ?? [];
      const w = st.length ? 8.8 / st.length - 0.2 : 2;
      st.forEach((x, k) => {
        slide.addText(x.value, {
          x: 0.6 + k * (w + 0.2),
          y: 1.5,
          w,
          h: 1.0,
          fontSize: 36,
          bold: true,
          color: strip(t.accent),
          fontFace: font,
          align: "center",
        });
        slide.addText(x.label, {
          x: 0.6 + k * (w + 0.2),
          y: 2.5,
          w,
          h: 0.5,
          fontSize: 14,
          color: strip(t.text),
          fontFace: font,
          align: "center",
        });
      });
      if (s.bullets?.length)
        slide.addText(bullets(s.bullets, 16), { x: 0.6, y: 3.3, w: 8.8, h: 1.8, valign: "top" });
    } else if (s.layout === "image") {
      const img = s.image ? imageData(root, s.image) : null;
      if (img)
        slide.addImage({
          data: `${img.mime};base64,${img.b64}`,
          x: 0.6,
          y: 1.3,
          w: 6.0,
          h: 3.4,
          sizing: { type: "contain", w: 6.0, h: 3.4 },
        });
      if (s.bullets?.length)
        slide.addText(bullets(s.bullets, 16), { x: 6.8, y: 1.3, w: 2.8, h: 3.6, valign: "top" });
    } else {
      slide.addText(bullets(s.bullets ?? [], 20), { x: 0.6, y: 1.4, w: 8.8, h: 3.7, valign: "top" });
    }
  }
  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

export interface BuiltDeck {
  dir: string;
  files: string[];
  pdf: boolean;
  note: string;
}

/** Write deck.json, deck.html, deck.pptx and (when a browser is available) deck.pdf under `dir`. */
export async function buildDeck(root: string, dir: string, spec: DeckSpec): Promise<BuiltDeck> {
  let abs: string;
  try {
    abs = resolveInside(root, dir).abs;
  } catch {
    throw new Error("The deck folder must be inside the project.");
  }
  fs.mkdirSync(abs, { recursive: true });
  const files = ["deck.json", "deck.html", "deck.pptx"];
  fs.writeFileSync(path.join(abs, "deck.json"), `${JSON.stringify(spec, null, 2)}\n`);
  fs.writeFileSync(path.join(abs, "deck.html"), deckHtml(spec, root));
  fs.writeFileSync(path.join(abs, "deck.pptx"), await deckPptx(spec, root));
  let pdf = false;
  let note = "";
  if (findBrowser()) {
    try {
      await printPdf({
        url: new URL(`file:///${path.join(abs, "deck.html").replace(/\\/g, "/")}`).toString(),
        out: path.join(abs, "deck.pdf"),
      });
      files.push("deck.pdf");
      pdf = true;
    } catch (err) {
      note = `PDF skipped: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else note = "PDF skipped: no browser found.";
  return { dir, files, pdf, note };
}
