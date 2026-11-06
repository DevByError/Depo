import { afterEach, describe, expect, test } from "bun:test";

process.env.DEPO_NO_BROWSER = "1";

import fs from "node:fs";
import path from "node:path";
import { buildDeck, DeckSpecSchema, deckHtml } from "../src/design/deck";
import { FONT_LIBRARY, searchFonts, suggestPairing, typeScale } from "../src/design/fonts";
import { checkMermaid } from "../src/design/mermaid";
import type { DesignService } from "../src/design/service";
import { HEURISTICS, scoreAudit, UxAuditSchema } from "../src/design/ux";
import { createEngine, type Engine } from "../src/engine";
import { executeTool, type TeamHooks, type ToolContext } from "../src/tools/index";
import "../src/tools/design-tools";
import { TEST_TOKEN, tempDir } from "./helpers";

let cleanup: (() => void)[] = [];
let engine: Engine | null = null;
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  for (const c of cleanup) c();
  cleanup = [];
});

describe("mermaid checker", () => {
  test("accepts valid diagrams of the common types", () => {
    expect(checkMermaid("flowchart LR\n  A[Web] --> B(API)\n  B --> C[(DB)]").ok).toBe(true);
    expect(checkMermaid("graph TD\n  subgraph Backend\n    A --> B\n  end").ok).toBe(true);
    expect(checkMermaid("sequenceDiagram\n  participant U\n  U->>API: login\n  API-->>U: token").ok).toBe(
      true,
    );
    expect(checkMermaid("stateDiagram-v2\n  [*] --> Open\n  Open --> Done").ok).toBe(true);
    const er = checkMermaid(
      "erDiagram\n  USER ||--o{ TODO : owns\n  USER {\n    int id PK\n    string email UK\n  }\n  TODO {\n    int id PK\n    int user_id FK\n  }",
    );
    expect(er.ok).toBe(true);
    expect(er.type).toBe("er");
    expect(er.entities.sort()).toEqual(["TODO", "USER"]);
  });

  test("finds the mistakes small models make", () => {
    const noHeader = checkMermaid("A --> B");
    expect(noHeader.ok).toBe(false);
    expect(noHeader.issues[0]?.message).toContain("first line");
    expect(checkMermaid("flowchart LR\n  A[Web --> B").issues[0]?.message).toContain("Unbalanced");
    expect(
      checkMermaid("flowchart LR\n  subgraph X\n    A --> B").issues.some((i) =>
        i.message.includes("not closed"),
      ),
    ).toBe(true);
    expect(checkMermaid("flowchart LR\n  A -->").issues[0]?.message).toContain("nothing after");
    expect(checkMermaid("erDiagram\n  USER -> TODO").ok).toBe(false);
    expect(
      checkMermaid("erDiagram\n  USER {\n    int id PK").issues.some((i) => i.message.includes("not closed")),
    ).toBe(true);
    expect(checkMermaid("sequenceDiagram\n  loop forever\n    A->>B: hi").ok).toBe(false);
    expect(checkMermaid("").ok).toBe(false);
  });

  test("ignores comments and front matter, and caps the size", () => {
    expect(checkMermaid("---\ntitle: x\n---\nflowchart LR\n  %% note\n  A --> B").ok).toBe(true);
    const big = `flowchart LR\n${Array.from({ length: 100 }, (_, i) => `  N${i} --> N${i + 1}`).join("\n")}`;
    expect(checkMermaid(big).issues.some((i) => i.message.includes("Too many nodes"))).toBe(true);
  });
});

describe("fonts", () => {
  test("every font is open licence, self-hostable and the library has Arabic", () => {
    expect(FONT_LIBRARY.length).toBeGreaterThanOrEqual(15);
    for (const f of FONT_LIBRARY) {
      expect(["OFL-1.1", "Apache-2.0"]).toContain(f.license);
      expect(f.fontsource.startsWith("@fontsource/")).toBe(true);
    }
    expect(FONT_LIBRARY.filter((f) => f.scripts.includes("arabic")).length).toBeGreaterThanOrEqual(4);
  });

  test("right-to-left asks only return fonts with Arabic, and a pairing uses two families at most", () => {
    const rtl = searchFonts({ rtl: true });
    expect(rtl.length).toBeGreaterThan(0);
    expect(rtl.every((f) => f.scripts.includes("arabic"))).toBe(true);
    const p = suggestPairing({ rtl: true });
    expect(p.body.scripts).toContain("arabic");
    expect(new Set([p.heading.family, p.body.family]).size).toBeLessThanOrEqual(2);
    const scale = typeScale(16, 1.25);
    expect(scale.base).toBe(16);
    expect(scale.lg).toBe(20);
    expect(scale["2xl"]).toBeGreaterThan(scale.xl ?? 0);
  });
});

describe("UX audit", () => {
  const rows = (score: number) =>
    HEURISTICS.map((h) => ({ heuristic: h, score, evidence: "Seen in the app.", fix: "" }));

  test("scores all ten heuristics out of 100", () => {
    const r = scoreAudit(UxAuditSchema.parse({ summary: "Good.", scores: rows(4) }));
    expect(r.overall).toBe(80);
    expect(r.grade).toBe("B");
    expect(r.blocksRelease).toBe(false);
    expect(r.markdown).toContain("| 1 | Visibility of system status | 4/5 |");
  });

  test("a very low score or any 1/5 blocks the release; sloppy names are matched", () => {
    expect(scoreAudit(UxAuditSchema.parse({ summary: "Bad.", scores: rows(2) })).blocksRelease).toBe(true);
    const mixed = rows(5);
    mixed[4] = { ...mixed[4], score: 1 } as (typeof mixed)[number];
    const r = scoreAudit(UxAuditSchema.parse({ summary: "One disaster.", scores: mixed }));
    expect(r.blocksRelease).toBe(true);
    expect(r.reasons[0]).toContain("Error prevention");
    const sloppy = rows(4).map((x, i) => ({ ...x, heuristic: `${i + 1}. ${x.heuristic.toUpperCase()}` }));
    expect(scoreAudit(UxAuditSchema.parse({ summary: "ok", scores: sloppy })).overall).toBe(80);
    expect(() => UxAuditSchema.parse({ summary: "x", scores: rows(4).slice(0, 5) })).toThrow();
  });
});

describe("decks", () => {
  const spec = DeckSpecSchema.parse({
    title: "Todo <app>",
    slides: [
      { layout: "title", title: "Todo <app>", subtitle: "Plan your day" },
      {
        layout: "bullets",
        title: "Problem",
        bullets: ["Scattered tasks", "No shared view"],
        notes: "Say it slowly.",
      },
      { layout: "two-column", title: "Before / after", left: ["Chaos"], right: ["Calm"] },
      { layout: "stats", title: "Status", stats: [{ label: "Tests", value: "42" }], bullets: ["All green"] },
      { layout: "image", title: "Screen", image: "shot.png", bullets: ["Home"] },
    ],
  });

  test("the HTML deck is self-contained, escapes text and embeds screenshots", () => {
    const t = tempDir("depo deck");
    cleanup.push(t.cleanup);
    // 1x1 PNG
    fs.writeFileSync(
      path.join(t.dir, "shot.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const html = deckHtml(spec, t.dir);
    expect(html).toContain("Todo &lt;app&gt;");
    expect(html).not.toContain("<app>");
    expect(html).toContain("data:image/png;base64,");
    expect(html.match(/class="slide /g)).toHaveLength(5);
    expect(html).not.toContain("http://");
  });

  test("buildDeck writes json, html and a real pptx (a zip), and skips the PDF without a browser", async () => {
    const t = tempDir("depo deck");
    cleanup.push(t.cleanup);
    const built = await buildDeck(t.dir, "docs/deck", spec);
    expect(built.files).toEqual(["deck.json", "deck.html", "deck.pptx"]);
    expect(built.pdf).toBe(false);
    expect(built.note).toContain("PDF skipped");
    const pptx = fs.readFileSync(path.join(t.dir, "docs/deck/deck.pptx"));
    expect(pptx.subarray(0, 2).toString()).toBe("PK");
    expect(pptx.length).toBeGreaterThan(5000);
    await expect(buildDeck(t.dir, "../outside", spec)).rejects.toThrow("inside the project");
  });
});

function fakeTeam(): { team: TeamHooks; written: Map<string, string>; sent: string[] } {
  const written = new Map<string, string>();
  const sent: string[] = [];
  return {
    written,
    sent,
    team: {
      read: (s) => (written.has(s) ? { content: written.get(s) ?? "", version: 1, owner: "x" } : null),
      list: () => [...written.keys()].map((section) => ({ section, owner: "x", version: 1, size: 1 })),
      write: (s, c) => {
        written.set(s, c);
        return `Saved ${s}.`;
      },
      send: (m) => {
        sent.push(`${m.type}:${m.to}:${m.summary}`);
        return "sent";
      },
    },
  };
}

describe("design tools", () => {
  async function ctxFor(team?: TeamHooks) {
    const t = tempDir("depo design tools");
    cleanup.push(t.cleanup);
    const e = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
    engine = e;
    await e.start();
    const root = path.join(t.dir, "ws");
    fs.mkdirSync(root, { recursive: true });
    const ctx: ToolContext = {
      root,
      bus: e.bus,
      approvals: e.approvals,
      projectId: null,
      taskId: null,
      agent: "diagram@1.0.0",
      ...(team ? { team } : {}),
    };
    return { ctx, root };
  }

  test("render_diagram reports syntax problems and tables that are not in the schema", async () => {
    const f = fakeTeam();
    f.written.set("schema/tables.md", "users(id), todos(id, user_id)");
    const { ctx, root } = await ctxFor(f.team);
    fs.mkdirSync(path.join(root, "docs/diagrams"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docs/diagrams/erd.mmd"),
      "erDiagram\n  USERS ||--o{ TODOS : owns\n  USERS ||--o{ INVOICES : pays\n  USERS {\n    int id PK\n  }",
    );
    const r = await executeTool("render_diagram", { path: "docs/diagrams/erd.mmd" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("valid er diagram");
    expect(r.content).toContain("INVOICES");
    expect(r.content).not.toContain("TODOS,");
    fs.writeFileSync(path.join(root, "docs/diagrams/bad.mmd"), "flowchart LR\n  A[x --> B");
    const bad = await executeTool("render_diagram", { path: "docs/diagrams/bad.mmd" }, ctx);
    expect(bad.content).toContain("1 problem");
    expect((await executeTool("render_diagram", { path: "nope.mmd" }, ctx)).isError).toBe(true);
    expect((await executeTool("render_diagram", { path: "../x.mmd" }, ctx)).isError).toBe(true);
  });

  test("list_fonts, record_ux_audit (blocking the release) and make_deck", async () => {
    const f = fakeTeam();
    const { ctx, root } = await ctxFor(f.team);
    const fonts = await executeTool("list_fonts", { rtl: true }, ctx);
    expect(fonts.content).toContain("Headings:");
    expect(fonts.content).toContain("@fontsource/");

    const rows = HEURISTICS.map((h) => ({
      heuristic: h,
      score: 1,
      evidence: "Nothing is clear.",
      fix: "Redo it.",
    }));
    const audit = await executeTool("record_ux_audit", { summary: "Poor.", scores: rows }, ctx);
    expect(audit.isError).toBe(false);
    expect(audit.content).toContain("RELEASE BLOCKED");
    expect(JSON.parse(f.written.get("scores/ux.json") ?? "{}").blocksRelease).toBe(true);
    expect(f.written.get("reviews/ux-audit.md")).toContain("Blocks release");
    expect(f.sent[0]).toContain("blocker:manager");
    const partial = await executeTool("record_ux_audit", { summary: "x", scores: rows.slice(0, 3) }, ctx);
    expect(partial.isError).toBe(true);

    const deck = await executeTool(
      "make_deck",
      {
        dir: "docs/deck",
        spec: {
          title: "T",
          slides: [
            { layout: "title", title: "T" },
            { title: "A", bullets: ["b"] },
          ],
        },
      },
      ctx,
    );
    expect(deck.isError).toBe(false);
    expect(fs.existsSync(path.join(root, "docs/deck/deck.pptx"))).toBe(true);
    const outside = await executeTool(
      "make_deck",
      { dir: "../deck", spec: { title: "T", slides: [{ title: "A" }] } },
      ctx,
    );
    expect(outside.isError).toBe(true);
  });

  test("screenshots work only on local pages, and say so when there is no browser", async () => {
    const { ctx, root } = await ctxFor();
    fs.writeFileSync(path.join(root, "index.html"), "<h1>Hi</h1>");
    const none = await executeTool("render_screenshot", { page: "index.html", name: "home" }, ctx);
    expect(none.isError).toBe(true);
    expect(none.content).toContain("No browser");
    const review = await executeTool("review_screenshot", { path: "docs/screenshots/home-360.png" }, ctx);
    expect(review.isError).toBe(true);
  });
});

describe("design service and API", () => {
  test("lists diagrams and decks from the workspace and the project, saves user edits, exports a deck", async () => {
    const t = tempDir("depo design api");
    cleanup.push(t.cleanup);
    const e = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
    engine = e;
    await e.start();
    const proj = path.join(t.dir, "app");
    fs.mkdirSync(path.join(proj, "docs/diagrams"), { recursive: true });
    fs.writeFileSync(path.join(proj, "docs/diagrams/arch.mmd"), "flowchart LR\n  A --> B\n");
    const project = await e.projects.open(proj);
    const spec = DeckSpecSchema.parse({ title: "Pitch", slides: [{ layout: "title", title: "Pitch" }] });
    await buildDeck(proj, "docs/deck", spec);

    const svc: DesignService = e.design;
    const diagrams = await svc.listDiagrams(project.id);
    expect(diagrams.map((d) => d.path)).toEqual(["docs/diagrams/arch.mmd"]);
    expect(diagrams[0]?.source).toBe("project");
    const decks = await svc.listDecks(project.id);
    expect(decks).toHaveLength(1);
    expect(decks[0]).toMatchObject({ dir: "docs/deck", title: "Pitch", slides: 1 });
    expect(decks[0]?.files).toContain("deck.pptx");

    await svc.saveDiagram(project.id, "docs/diagrams/new.mmd", "erDiagram\n  A ||--o{ B : has");
    expect(fs.readFileSync(path.join(proj, "docs/diagrams/new.mmd"), "utf8")).toContain("erDiagram");
    await expect(svc.saveDiagram(project.id, "../../evil.mmd", "x")).rejects.toThrow("docs/diagrams");
    await expect(svc.saveDiagram(project.id, "src/app.ts", "x")).rejects.toThrow("docs/diagrams");

    const out = path.join(t.dir, "downloads");
    fs.mkdirSync(out);
    const pptx = await svc.exportDeck(project.id, undefined, "docs/deck", "pptx", out);
    expect(pptx.path.endsWith("deck.pptx")).toBe(true);
    expect(pptx.bytes).toBeGreaterThan(1000);
    const again = await svc.exportDeck(project.id, undefined, "docs/deck", "pptx", out);
    expect(again.path).not.toBe(pptx.path);
    await expect(svc.exportDeck(project.id, undefined, "docs/deck", "pdf", out)).rejects.toThrow("browser");
    await expect(svc.exportDeck(project.id, undefined, "docs/nothing", "pptx", out)).rejects.toThrow(
      "No deck",
    );
    expect(await svc.deckHtml(project.id, undefined, "docs/deck")).toContain("<section");
  });
});
