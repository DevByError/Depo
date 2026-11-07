import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findBrowser, safeUrl, screenshot } from "../design/browser";
import { buildDeck, DeckSpecSchema } from "../design/deck";
import { type FONT_LIBRARY, searchFonts, suggestPairing, typeScale } from "../design/fonts";
import { checkMermaid } from "../design/mermaid";
import { automatedFindings, scoreAudit, UxAuditSchema } from "../design/ux";
import { type AgentTool, registerTools, type ToolContext, tool } from "./index";
import { resolveInside, ToolError } from "./paths";

const resolveInRoot = (root: string, rel: string) => resolveInside(root, rel).abs;

/** Design and presentation tools (Phase 4): diagrams, fonts, screenshots, decks and the UX audit. */

function note(
  ctx: ToolContext,
  type: "rendering_screenshot" | "writing_file" | "reviewing",
  text: string,
  details?: Record<string, string | number | boolean>,
) {
  ctx.bus.emit({
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    agent: ctx.agent,
    type,
    text,
    details: details ?? null,
    status: "succeeded",
  });
}

const WIDTHS = [360, 768, 1024, 1440];
const HEIGHT_FOR: Record<number, number> = { 360: 800, 768: 1024, 1024: 768, 1440: 900 };

function schemaText(ctx: ToolContext): string {
  const parts: string[] = [];
  for (const e of ctx.team?.list() ?? []) {
    if (e.section.startsWith("schema/")) parts.push(ctx.team?.read(e.section)?.content ?? "");
  }
  // Migrations and models in the project itself.
  const stack = [ctx.root];
  let seen = 0;
  while (stack.length && seen < 400) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (d.name === "node_modules" || d.name.startsWith(".")) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) stack.push(full);
      else if (/\.(sql|prisma)$|models?\.py$|schema\.(ts|py)$/.test(d.name)) {
        seen++;
        try {
          parts.push(fs.readFileSync(full, "utf8").slice(0, 40_000));
        } catch {
          // unreadable file: ignore
        }
      }
    }
  }
  return parts.join("\n").toLowerCase();
}

const stem = (s: string) =>
  s
    .toLowerCase()
    .replace(/(ies)$/, "y")
    .replace(/s$/, "");

const tools: AgentTool<z.ZodType>[] = [
  tool({
    name: "render_diagram",
    description:
      "Check a Mermaid diagram file (.mmd or .md with a ```mermaid block) for syntax problems. For ER diagrams it also warns about tables that do not exist in the schema. Run it after writing each diagram and fix every issue it lists.",
    schema: z.object({ path: z.string().min(1).describe("e.g. docs/diagrams/erd.mmd") }),
    async run(a, ctx) {
      const abs = resolveInRoot(ctx.root, a.path);
      if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${a.path}`);
      let text = fs.readFileSync(abs, "utf8");
      const fence = /```mermaid\s*\n([\s\S]*?)```/.exec(text);
      if (fence?.[1]) text = fence[1];
      const r = checkMermaid(text);
      const out: string[] = [];
      if (r.ok) out.push(`${a.path}: valid ${r.type} diagram (${r.stats.nodes} nodes).`);
      else
        out.push(
          `${a.path}: ${r.issues.length} problem(s):`,
          ...r.issues.map((i) => `  line ${i.line}: ${i.message}`),
        );
      if (r.type === "er" && r.entities.length) {
        const known = schemaText(ctx);
        if (known.trim()) {
          const unknown = r.entities.filter((e) => !known.includes(stem(e)));
          if (unknown.length)
            out.push(
              `Warning: these entities are not in the schema (do not invent tables): ${unknown.join(", ")}.`,
            );
        }
      }
      note(
        ctx,
        "writing_file",
        `Checked diagram ${a.path}: ${r.ok ? "valid" : `${r.issues.length} problems`}`,
        { path: a.path, ok: r.ok },
      );
      return out.join("\n");
    },
  }),
  tool({
    name: "list_fonts",
    description:
      "Browse the open-licence font library (self-hostable through Fontsource) and get a heading/body/mono pairing plus a type scale. Use at most two families per project.",
    schema: z.object({
      rtl: z.boolean().default(false).describe("Needs Arabic or another right-to-left script"),
      mood: z.array(z.string().max(30)).max(5).default([]).describe("e.g. friendly, editorial, code, saas"),
      base_size: z.number().int().min(12).max(20).default(16),
      ratio: z.number().min(1.1).max(1.6).default(1.25),
    }),
    async run(a) {
      const pair = suggestPairing({ rtl: a.rtl, mood: a.mood });
      const options = searchFonts({ rtl: a.rtl, tags: a.mood }).slice(0, 6);
      const f = (x: (typeof FONT_LIBRARY)[number]) =>
        `${x.family} (${x.category}, ${x.license}, npm i ${x.fontsource}, weights ${x.weights.join("/")}, scripts ${x.scripts.join("+")})`;
      return [
        `Suggested pairing${a.rtl ? " for right-to-left text" : ""}:`,
        `- Headings: ${f(pair.heading)}`,
        `- Body: ${f(pair.body)}`,
        `- Code: ${f(pair.mono)}`,
        "",
        "Other good matches:",
        ...options.map((o) => `- ${f(o)}`),
        "",
        `Type scale (base ${a.base_size}px, ratio ${a.ratio}): ${JSON.stringify(typeScale(a.base_size, a.ratio))}`,
        "Self-host the files; never load fonts from a CDN. Keep body lines 45-75 characters long.",
      ].join("\n");
    },
  }),
  tool({
    name: "render_screenshot",
    description:
      "Take screenshots of a page at phone (360), tablet (768), small desktop (1024) and desktop (1440) widths. The page is a local HTML file in the project or a http://localhost address. Files are saved as docs/screenshots/<name>-<width>.png.",
    schema: z.object({
      page: z.string().min(1).describe("HTML file in the project, or http://localhost:PORT/path"),
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
        .describe("short kebab-case name, e.g. home"),
      widths: z.array(z.number().int().min(320).max(2560)).max(4).default(WIDTHS),
    }),
    async run(a, ctx) {
      if (!findBrowser())
        throw new ToolError(
          "No browser (Edge or Chrome) was found on this PC, so screenshots cannot be taken. Describe what the page should look like instead.",
        );
      let url: string;
      try {
        url = safeUrl(a.page, ctx.root);
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      const made: string[] = [];
      for (const w of a.widths) {
        const rel = `docs/screenshots/${a.name}-${w}.png`;
        try {
          await screenshot({
            url,
            out: resolveInRoot(ctx.root, rel),
            width: w,
            height: HEIGHT_FOR[w] ?? 900,
          });
          made.push(rel);
          ctx.onFileChanged?.(rel);
          note(ctx, "rendering_screenshot", `Screenshot ${rel}`, { path: rel, width: w });
        } catch (err) {
          throw new ToolError(
            `Screenshot at ${w}px failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return `Saved ${made.length} screenshot(s):\n${made.join("\n")}\nUse review_screenshot on each to critique it.`;
    },
  }),
  tool({
    name: "review_screenshot",
    description:
      "Have the vision model critique a screenshot: layout, hierarchy, contrast, spacing, alignment, text overflow and missing states. Returns a list of concrete problems to fix.",
    schema: z.object({
      path: z.string().min(1),
      focus: z.string().max(300).default("overall visual quality and usability"),
    }),
    async run(a, ctx) {
      const abs = resolveInRoot(ctx.root, a.path);
      if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${a.path}`);
      if (!ctx.vision) throw new ToolError("No vision model is available in this run.");
      const b64 = fs.readFileSync(abs).toString("base64");
      const prompt = [
        "You are a senior UI/UX reviewer. Look at this screenshot of a web page.",
        `Focus: ${a.focus}.`,
        "List the concrete problems you can see (alignment, spacing, contrast, hierarchy, truncated or overflowing text, tiny tap targets, inconsistent styles, empty areas), most serious first, each with a specific fix. If it looks good, say what works. Be brief: at most 8 bullet points.",
      ].join("\n");
      const text = await ctx.vision(prompt, [b64]);
      if (text === null)
        return "No vision model is set up (Models tab, vision role), so the screenshot could not be reviewed automatically. Check contrast, spacing and hierarchy against the design system by reading the CSS instead.";
      note(ctx, "reviewing", `Vision review of ${a.path}`, { path: a.path });
      return text.trim() || "The vision model returned no comments.";
    },
  }),
  tool({
    name: "make_deck",
    description:
      "Create a presentation (pitch or progress deck) as deck.json, deck.html (keyboard navigable), deck.pptx and deck.pdf in a folder. Use real screenshots (docs/screenshots/*.png) on image slides. 6 to 12 slides: title, problem, solution, product, how it works, market or users, roadmap, status or metrics, ask.",
    schema: z.object({
      dir: z.string().min(1).default("docs/deck").describe("folder for the deck files"),
      spec: DeckSpecSchema,
    }),
    async run(a, ctx) {
      const built = await buildDeck(ctx.root, a.dir, a.spec);
      for (const f of built.files) ctx.onFileChanged?.(`${a.dir}/${f}`);
      note(ctx, "writing_file", `Deck "${a.spec.title}": ${a.spec.slides.length} slides`, {
        dir: a.dir,
        slides: a.spec.slides.length,
      });
      return `Deck written to ${a.dir}: ${built.files.join(", ")}. ${built.note}`.trim();
    },
  }),
  tool({
    name: "record_ux_audit",
    description:
      "Record the UX audit: score all ten of Nielsen's heuristics from 1 (bad) to 5 (excellent) with evidence from the real screens and code, and a fix for anything below 4. Saves reviews/ux-audit.md and scores/ux.json. A score below 60/100 or any 1/5 blocks the release.",
    schema: UxAuditSchema,
    async run(a, ctx) {
      if (!ctx.team)
        throw new ToolError("The blackboard is only available when you work as part of the team.");
      let result: ReturnType<typeof scoreAudit>;
      // What check_page found in this task (serious accessibility issues, console errors) goes into the audit.
      const automated = automatedFindings(ctx.qa?.latestForAgent(ctx, 10) ?? []);
      try {
        result = scoreAudit(a, automated);
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      ctx.team.write("reviews/ux-audit.md", result.markdown, "replace");
      ctx.team.write("scores/ux.json", result.json, "replace");
      if (result.blocksRelease) {
        ctx.team.send({
          to: "manager",
          type: "blocker",
          summary: `UX audit blocks the release (${result.overall}/100): ${result.reasons.join(" ")}`.slice(
            0,
            1800,
          ),
          confidence: 0.9,
        });
      }
      note(ctx, "reviewing", `UX audit: ${result.overall}/100 (${result.grade})`, {
        overall: result.overall,
      });
      const auto =
        automated.critical + automated.serious + automated.consoleErrors > 0
          ? ` Automated page checks found ${automated.critical} critical and ${automated.serious} serious accessibility issues and ${automated.consoleErrors} console errors (listed in the audit); send them to the owner of the screens.`
          : "";
      return `UX audit saved: ${result.overall}/100, grade ${result.grade}. ${result.blocksRelease ? `RELEASE BLOCKED: ${result.reasons.join(" ")}` : "Release is not blocked."}${auto}`;
    },
  }),
];

registerTools(...tools);
export const DESIGN_TOOL_NAMES = tools.map((t) => t.name);
