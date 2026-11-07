import type { BrowserSession, CdpPage } from "../design/cdp";

/**
 * What the headless browser does for a design reference: shrink a picture and hand back its pixels
 * (Bun has no image decoder; every Windows PC has Edge), and open a link to take screenshots and
 * read the page's real colours, fonts, sizes and corner radii from the computed styles.
 */

export interface ImagePixels {
  width: number;
  height: number;
  /** RGBA of the picture sampled down to at most 640 px on the long side (nearest neighbour). */
  rgba: Uint8Array;
  /** The picture as a JPEG at most 1280 px wide, for the vision model (base64). */
  preview: string;
}

const PIXELS_SCRIPT = (dataUrl: string) => `(async () => {
  const img = new Image();
  img.decoding = "sync";
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error("The picture could not be read.")); img.src = ${JSON.stringify(dataUrl)}; });
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error("The picture is empty.");
  const fit = (max) => { const s = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; };
  const [sw, sh] = fit(640);
  const c = document.createElement("canvas"); c.width = sw; c.height = sh;
  const g = c.getContext("2d", { willReadFrequently: true });
  // Nearest neighbour keeps real pixel colours (thin text, small badges) instead of blends.
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, sw, sh);
  const data = g.getImageData(0, 0, sw, sh).data;
  let bin = "";
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
  const pw = Math.min(1280, w), ph = Math.max(1, Math.round(h * (pw / w)));
  const p = document.createElement("canvas"); p.width = pw; p.height = Math.min(ph, 2400);
  const pg = p.getContext("2d");
  pg.fillStyle = "#ffffff"; pg.fillRect(0, 0, p.width, p.height);
  pg.drawImage(img, 0, 0, pw, ph);
  return { width: w, height: h, rgba: btoa(bin), preview: p.toDataURL("image/jpeg", 0.85).split(",")[1] };
})()`;

/** Decode a picture in a blank tab and return its size, shrunk pixels and a preview for the vision model. */
export async function imagePixels(session: BrowserSession, mime: string, data: Buffer): Promise<ImagePixels> {
  const page = await session.newPage();
  try {
    const r = await page.evaluate<{ width: number; height: number; rgba: string; preview: string }>(
      PIXELS_SCRIPT(`data:${mime};base64,${data.toString("base64")}`),
      { awaitPromise: true, timeoutMs: 30_000 },
    );
    return {
      width: r.width,
      height: r.height,
      rgba: new Uint8Array(Buffer.from(r.rgba, "base64")),
      preview: r.preview,
    };
  } finally {
    page.dispose();
  }
}

/** Facts read from a page's computed styles. Colours are as the browser reports them (rgb()). */
export interface PageFacts {
  title: string;
  bodyBackground: string;
  bodyColor: string;
  /** Background colours weighted by the area they cover. */
  backgrounds: { color: string; area: number }[];
  /** Text colours weighted by the amount of text. */
  textColors: { color: string; chars: number }[];
  /** Font families weighted by the amount of text, first family of each stack. */
  fonts: { family: string; chars: number }[];
  headingFont: string | null;
  sizes: { h1: string | null; h2: string | null; body: string | null };
  radii: { value: string; count: number }[];
  buttons: { background: string; color: string; radius: string; weight: string }[];
  /** Custom properties declared on :root or html that look like design tokens. */
  vars: Record<string, string>;
  /** Width of the main content column in CSS pixels. */
  contentWidth: number | null;
}

const FACTS_SCRIPT = `(() => {
  const add = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
  const top = (m, n, key, val) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ [key]: k, [val]: Math.round(v) }));
  const bg = new Map(), fg = new Map(), fonts = new Map(), radii = new Map();
  const H = Math.max(innerHeight * 3, 2400);
  const els = Array.from(document.querySelectorAll("body, body *")).slice(0, 5000);
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > H) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
    const area = Math.min(r.width, innerWidth) * Math.min(r.height, H);
    if (st.backgroundColor && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(st.backgroundColor)) add(bg, st.backgroundColor, area);
    let chars = 0;
    for (const n of el.childNodes) if (n.nodeType === 3) chars += n.textContent.trim().length;
    if (chars > 0) {
      add(fg, st.color, chars);
      const fam = st.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
      if (fam) add(fonts, fam, chars);
    }
    const rad = st.borderTopLeftRadius;
    if (rad && rad !== "0px" && r.width >= 24 && r.height >= 16 && !rad.includes("%") && parseFloat(rad) < 200) add(radii, rad, 1);
  }
  const first = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
  const h1 = first("h1"), h2 = first("h2"), p = first("p") || first("body");
  const buttons = Array.from(document.querySelectorAll("button, a[class*='btn'], a[class*='button'], [role=button], input[type=submit]"))
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width >= 40 && r.height >= 20 && r.top < H; })
    .slice(0, 6)
    .map((e) => { const s = getComputedStyle(e); return { background: s.backgroundColor, color: s.color, radius: s.borderTopLeftRadius, weight: s.fontWeight }; });
  const vars = {};
  let count = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules || [])) {
      if (!rule.selectorText || !/^(:root|html|body|\\[data-theme[^\\]]*\\])$/.test(rule.selectorText.trim())) continue;
      for (const name of Array.from(rule.style)) {
        if (!name.startsWith("--") || count >= 60) continue;
        const v = rule.style.getPropertyValue(name).trim();
        if (v.length > 80) continue;
        if (/color|bg|background|fg|text|primary|accent|brand|surface|border|radius|font|shadow|muted|success|danger|warning/i.test(name)) { vars[name] = v; count++; }
      }
    }
  }
  const main = document.querySelector("main, [role=main], #root > *, #app > *, .container");
  const mw = main ? Math.round(main.getBoundingClientRect().width) : null;
  const bodySt = getComputedStyle(document.body);
  const htmlSt = getComputedStyle(document.documentElement);
  const bodyBg = /rgba\\(0, 0, 0, 0\\)|transparent/.test(bodySt.backgroundColor) ? htmlSt.backgroundColor : bodySt.backgroundColor;
  const hf = h1 || h2;
  return {
    title: (document.title || "").slice(0, 120),
    bodyBackground: bodyBg,
    bodyColor: bodySt.color,
    backgrounds: top(bg, 12, "color", "area"),
    textColors: top(fg, 8, "color", "chars"),
    fonts: top(fonts, 4, "family", "chars"),
    headingFont: hf ? hf.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "") : null,
    sizes: { h1: h1 ? h1.fontSize : null, h2: h2 ? h2.fontSize : null, body: p ? p.fontSize : null },
    radii: top(radii, 4, "value", "count"),
    buttons,
    vars,
    contentWidth: mw && mw < innerWidth ? mw : null,
  };
})()`;

export interface LinkCapture {
  /** Desktop screenshot (1440 px wide, up to 2400 px tall). */
  desktop: Buffer;
  /** Phone screenshot (390 x 844). Null when it failed. */
  phone: Buffer | null;
  facts: PageFacts | null;
  /** Requests the gate refused (local network, other schemes). */
  blocked: number;
  warnings: string[];
}

/**
 * Open a link and capture it. An outside page gets `gate` so only public sites load; the owner's
 * own app on 127.0.0.1 uses the normal local-only page.
 */
export async function captureLink(
  session: BrowserSession,
  url: string,
  gate: ((url: string) => Promise<boolean>) | null,
  timeoutMs = 25_000,
): Promise<LinkCapture> {
  const page: CdpPage = await session.newPage(gate ? { gate } : {});
  const warnings: string[] = [];
  try {
    await page.conn.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    await page.setViewport(1440, 900, false);
    const nav = await page.goto(url, timeoutMs);
    if (!nav.loaded && nav.error && !nav.status) throw new Error(`The page did not open: ${nav.error}`);
    if (nav.status !== null && nav.status >= 400)
      warnings.push(`The site answered with status ${nav.status}.`);
    if (!nav.loaded) warnings.push("The page was still loading; the capture may be incomplete.");
    await page.waitForNetworkIdle(800, 8000);
    // Web fonts and entrance animations.
    await Bun.sleep(700);
    const facts = await page
      .evaluate<PageFacts>(FACTS_SCRIPT, { timeoutMs: 10_000 })
      .catch((err: unknown) => {
        warnings.push(
          `The page's styles could not be read (${err instanceof Error ? err.message : String(err)}).`,
        );
        return null;
      });
    const desktop = await page.screenshot({ maxHeight: 2400 });
    let phone: Buffer | null = null;
    try {
      await page.setViewport(390, 844, true);
      await Bun.sleep(500);
      phone = await page.screenshot({ viewportOnly: true });
    } catch {
      warnings.push("The phone-width screenshot failed.");
    }
    const blocked = page.collected().failedRequests.filter((r) => r.blocked).length;
    return { desktop, phone, facts, blocked, warnings };
  } finally {
    page.dispose();
  }
}
