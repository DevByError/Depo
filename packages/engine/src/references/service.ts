import fs from "node:fs";
import path from "node:path";
import { collectChat } from "@depo/model-gateway";
import {
  type DesignReference,
  newId,
  REFERENCE_MAX_IMAGE_BYTES,
  type ReferenceInput,
  referenceHost,
  type Swatch,
  type SwatchRole,
} from "@depo/shared";
import { findBrowser } from "../design/browser";
import { type BrowserSession, launchBrowser } from "../design/cdp";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import type { ModelManager } from "../models/manager";
import type { ModelScheduler } from "../scheduler/scheduler";
import { captureLink, imagePixels, type PageFacts } from "./capture";
import { assignRoles, modeOf, paletteDifferences, paletteFromPixels, parseCssColor, toHex } from "./palette";
import { checkReferenceUrl, OutsideRequestGate } from "./url";

/**
 * Design references for a task: pictures and links the owner sent with a message. Kept in Depo's
 * data folder (`references/<task>/`), studied once (colours from the pixels, a link's real styles,
 * the vision model's notes), copied into the private copy for the agents, and turned into a brief.
 */

interface StoredReference extends DesignReference {
  /** The picture or desktop screenshot, a file name in the task's folder. */
  file: string | null;
  mime: string | null;
  /** JPEG at most 1280 px wide for the vision model. */
  preview: string | null;
  /** Phone-width screenshot of a link. */
  phone: string | null;
  facts: PageFacts | null;
  createdAt: string;
}

export interface ReferenceServiceOptions {
  /** `<data>/references`. */
  dataDir: string;
  bus: EventBus;
  logger: Logger;
  models: Pick<ModelManager, "resolve">;
  scheduler?: ModelScheduler;
  /** Test hook: how to get a headless browser. */
  open?: () => Promise<BrowserSession>;
  /** Test hook: whether a browser is installed. */
  hasBrowser?: () => boolean;
  /** Test hook: which requests an outside page may make. */
  gate?: (url: string) => Promise<boolean>;
}

const MAGIC: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  {
    mime: "image/png",
    ext: "png",
    test: (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: "gif", test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

const ROLE_NAMES: Record<SwatchRole, string> = {
  background: "background",
  surface: "surface",
  border: "border",
  text: "text",
  muted: "muted text",
  primary: "primary",
  accent: "accent",
  success: "success",
  warning: "warning",
  danger: "danger",
};

const NO_VISION =
  "No vision model is set up (Models tab, vision role), so only the colours and the page's styles were read.";

export class ReferenceService {
  private readonly log: Logger;
  private readonly gate: (url: string) => Promise<boolean>;
  /** Studies in flight per task, so a follow-up never studies the same reference twice. */
  private readonly inflight = new Map<string, Promise<DesignReference[]>>();

  constructor(private readonly o: ReferenceServiceOptions) {
    this.log = o.logger.child({ component: "references" });
    const g = new OutsideRequestGate();
    this.gate = o.gate ?? ((u) => g.allowed(u));
  }

  // ---- storage ---------------------------------------------------------------------------

  private dir(taskId: string): string {
    if (!/^[\w-]{1,64}$/.test(taskId)) throw new Error("Invalid task id.");
    return path.join(this.o.dataDir, taskId);
  }

  private load(taskId: string): StoredReference[] {
    const file = path.join(this.dir(taskId), "refs.json");
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as StoredReference[];
    } catch {
      return [];
    }
  }

  private saveAll(taskId: string, refs: StoredReference[]): void {
    const dir = this.dir(taskId);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `refs.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(refs, null, 1));
    fs.renameSync(tmp, path.join(dir, "refs.json"));
  }

  private update(taskId: string, id: string, patch: Partial<StoredReference>): StoredReference | null {
    const all = this.load(taskId);
    const i = all.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const next = { ...(all[i] as StoredReference), ...patch };
    all[i] = next;
    this.saveAll(taskId, all);
    return next;
  }

  /**
   * Check and keep what the composer sent. Pictures must really be PNG, JPEG, GIF or WebP; links
   * must be public sites or this computer. Throws a plain message for the first bad one.
   */
  save(taskId: string, inputs: ReferenceInput[]): DesignReference[] {
    if (!inputs.length) return [];
    const checked: { input: ReferenceInput; bytes?: Buffer; ext?: string; mime?: string; url?: string }[] =
      [];
    for (const input of inputs) {
      if (input.kind === "image") {
        const bytes = Buffer.from(input.data, "base64");
        if (bytes.length > REFERENCE_MAX_IMAGE_BYTES)
          throw new Error(`${input.name} is larger than ${REFERENCE_MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
        const kind = MAGIC.find((m) => m.test(bytes));
        if (!kind) throw new Error(`${input.name} is not a PNG, JPEG, GIF or WebP picture.`);
        checked.push({ input, bytes, ext: kind.ext, mime: kind.mime });
      } else {
        const u = checkReferenceUrl(input.url);
        if (!u.ok) throw new Error(u.reason);
        checked.push({ input, url: u.url.toString() });
      }
    }
    const dir = this.dir(taskId);
    fs.mkdirSync(dir, { recursive: true });
    const all = this.load(taskId);
    const added: StoredReference[] = [];
    const now = new Date().toISOString();
    for (const c of checked) {
      const id = newId("ref");
      let file: string | null = null;
      if (c.bytes && c.ext) {
        file = `${id}.${c.ext}`;
        fs.writeFileSync(path.join(dir, file), c.bytes);
      }
      added.push({
        id,
        kind: c.input.kind,
        name: c.input.kind === "image" ? cleanName(c.input.name) : referenceHost(c.url ?? ""),
        url: c.url ?? null,
        state: "pending",
        hasImage: !!file,
        width: null,
        height: null,
        mode: null,
        palette: [],
        fonts: [],
        radius: null,
        notes: [],
        vision: false,
        warnings: [],
        error: null,
        file,
        mime: c.mime ?? null,
        preview: null,
        phone: null,
        facts: null,
        createdAt: now,
      });
    }
    this.saveAll(taskId, [...all, ...added]);
    this.log.info("design references saved", {
      taskId,
      images: added.filter((r) => r.kind === "image").length,
      links: added.filter((r) => r.kind === "link").length,
    });
    return added.map(publicRef);
  }

  /** Every reference of a task, oldest first, as the chat shows them. */
  list(taskId: string): DesignReference[] {
    return this.load(taskId).map(publicRef);
  }

  /** True when the task has a studied reference with a picture (compare_to_reference can run). */
  has(taskId: string): boolean {
    return this.load(taskId).some((r) => r.state === "studied" && !!r.file);
  }

  /** True when some reference of the task still has to be studied. */
  pending(taskId: string): boolean {
    return this.load(taskId).some((r) => r.state === "pending");
  }

  /** The picture or screenshot of one reference, base64. */
  image(taskId: string, id: string): { mime: string; data: string } {
    const r = this.load(taskId).find((x) => x.id === id);
    if (!r?.file) throw new Error("This reference has no picture.");
    const file = path.join(this.dir(taskId), path.basename(r.file));
    return { mime: r.mime ?? "image/png", data: fs.readFileSync(file).toString("base64") };
  }

  /** Copy the pictures into the private copy (`.depo/references/`, never part of a change set). */
  copyInto(taskId: string, root: string): void {
    const refs = this.load(taskId).filter((r) => r.file);
    if (!refs.length) return;
    const dest = path.join(root, ".depo", "references");
    fs.mkdirSync(dest, { recursive: true });
    for (const r of refs) {
      for (const f of [r.file, r.phone]) {
        if (!f) continue;
        const to = path.join(dest, path.basename(f));
        if (!fs.existsSync(to)) fs.copyFileSync(path.join(this.dir(taskId), path.basename(f)), to);
      }
    }
  }

  // ---- studying --------------------------------------------------------------------------

  /** Study the task's references that are still pending. Never throws; failures are kept on the reference. */
  async study(o: {
    taskId: string;
    projectId: string;
    agent: string;
    signal?: AbortSignal;
  }): Promise<DesignReference[]> {
    const running = this.inflight.get(o.taskId);
    if (running) return running;
    const p = this.studyPending(o).finally(() => this.inflight.delete(o.taskId));
    this.inflight.set(o.taskId, p);
    return p;
  }

  private async studyPending(o: {
    taskId: string;
    projectId: string;
    agent: string;
    signal?: AbortSignal;
  }): Promise<DesignReference[]> {
    const pending = this.load(o.taskId).filter((r) => r.state === "pending");
    if (!pending.length) return this.list(o.taskId);
    const emit = (
      text: string,
      status: "started" | "succeeded" | "failed",
      details?: Record<string, unknown>,
    ) =>
      this.o.bus.emit({
        agent: o.agent,
        projectId: o.projectId,
        taskId: o.taskId,
        type: "reviewing",
        text,
        status,
        details: { designReference: true, ...(details ?? {}) } as never,
      });
    const label =
      pending.length === 1 ? (pending[0] as StoredReference).name : `${pending.length} design references`;
    emit(`Reading the design reference: ${label}`, "started");
    const started = performance.now();
    const hasBrowser = this.o.open ? true : (this.o.hasBrowser ?? (() => !!findBrowser()))();
    let session: BrowserSession | null = null;
    try {
      if (hasBrowser) session = await (this.o.open ?? (() => launchBrowser()))();
    } catch (err) {
      this.log.warn("no browser for design references", { err });
    }
    try {
      for (const ref of pending) {
        if (o.signal?.aborted) break;
        try {
          await this.studyOne(o, ref, session);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn("design reference failed", { taskId: o.taskId, ref: ref.id, err });
          this.update(o.taskId, ref.id, { state: "failed", error: msg.slice(0, 400) });
        }
      }
    } finally {
      await session?.close();
    }
    const done = this.list(o.taskId).filter((r) => pending.some((p) => p.id === r.id));
    const ok = done.filter((r) => r.state === "studied");
    const first = ok[0];
    emit(
      ok.length
        ? `Design reference read: ${summaryLine(first as DesignReference)}${ok.length > 1 ? ` (+${ok.length - 1} more)` : ""}`
        : `The design reference could not be read: ${done[0]?.error ?? "unknown error"}`,
      ok.length ? "succeeded" : "failed",
      { references: done.map((r) => r.id), durationMs: Math.round(performance.now() - started) },
    );
    return this.list(o.taskId);
  }

  private async studyOne(
    o: { taskId: string; projectId: string; signal?: AbortSignal },
    ref: StoredReference,
    session: BrowserSession | null,
  ): Promise<void> {
    const dir = this.dir(o.taskId);
    const warnings: string[] = [];
    let palette: Swatch[] = [];
    let width: number | null = null;
    let height: number | null = null;
    let preview: string | null = null;
    let file = ref.file;
    let phone: string | null = null;
    let facts: PageFacts | null = null;
    let mime = ref.mime;

    if (ref.kind === "link") {
      if (!session) throw new Error("Opening a link needs Edge or Chrome, and neither was found.");
      const u = checkReferenceUrl(ref.url ?? "");
      if (!u.ok) throw new Error(u.reason);
      const cap = await captureLink(session, u.url.toString(), u.local ? null : this.gate);
      warnings.push(...cap.warnings);
      if (cap.blocked) warnings.push(`${cap.blocked} request(s) to private addresses were blocked.`);
      file = `${ref.id}.png`;
      mime = "image/png";
      fs.writeFileSync(path.join(dir, file), cap.desktop);
      if (cap.phone) {
        phone = `${ref.id}-phone.png`;
        fs.writeFileSync(path.join(dir, phone), cap.phone);
      }
      facts = cap.facts;
    }

    if (file && session) {
      const px = await imagePixels(session, mime ?? "image/png", fs.readFileSync(path.join(dir, file)));
      width = px.width;
      height = px.height;
      preview = `${ref.id}-preview.jpg`;
      fs.writeFileSync(path.join(dir, preview), Buffer.from(px.preview, "base64"));
      palette = assignRoles(paletteFromPixels(px.rgba, { max: 10 }));
    } else if (file) {
      warnings.push("Edge or Chrome was not found, so the colours could not be measured.");
    }
    if (facts) palette = mergeFacts(palette, facts);

    // The vision model: layout, type, shapes, components, mood; and corrections to the roles.
    let notes: string[] = [];
    let vision = false;
    const v = this.o.models.resolve("vision");
    const visionImage = preview ?? (file && mime !== "image/gif" ? file : null);
    if (!v) warnings.push(NO_VISION);
    else if (visionImage) {
      try {
        const reply = await this.askVision(
          o,
          v,
          studyPrompt(ref, palette, facts),
          [fs.readFileSync(path.join(dir, visionImage)).toString("base64")],
          "Reading the design reference",
        );
        const parsed = parseVision(reply, palette);
        notes = parsed.notes;
        palette = parsed.palette;
        vision = notes.length > 0;
        if (!vision) warnings.push("The vision model did not describe the design.");
      } catch (err) {
        if (o.signal?.aborted) throw err;
        warnings.push(
          `The vision model failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
        );
      }
    }

    const bg = palette.find((s) => s.role === "background");
    const fonts = facts
      ? unique(
          [facts.headingFont, ...facts.fonts.map((f) => f.family)].filter((f): f is string => !!f),
        ).slice(0, 4)
      : guessFonts(notes);
    this.update(o.taskId, ref.id, {
      state: "studied",
      hasImage: !!file,
      file,
      mime,
      preview,
      phone,
      facts,
      width,
      height,
      mode: bg ? modeOf(bg.hex) : null,
      palette: palette.slice(0, 14),
      fonts,
      radius: facts?.radii[0]?.value ?? guessRadius(notes),
      notes: notes.slice(0, 16),
      vision,
      warnings: warnings.slice(0, 6),
      error: null,
    });
  }

  private async askVision(
    o: { taskId: string; projectId: string; signal?: AbortSignal },
    v: NonNullable<ReturnType<ModelManager["resolve"]>>,
    prompt: string,
    images: string[],
    label: string,
  ): Promise<string> {
    const run = () =>
      collectChat(
        v.provider.chat({
          model: v.model,
          messages: [{ role: "user", content: prompt, images }],
          ...(o.signal ? { signal: o.signal } : {}),
          contextLength: v.contextLength ?? 8192,
        }),
      );
    const res = this.o.scheduler
      ? await this.o.scheduler.run(
          { projectId: o.projectId, taskId: o.taskId, label, model: v.model, priority: "task" },
          run,
          o.signal,
        )
      : await run();
    return res.text;
  }

  // ---- the brief and comparing -----------------------------------------------------------

  /**
   * The brief every agent reads: what to match and the measured values. The same references always
   * give the same text, so the prompt prefix stays reusable across runs.
   */
  brief(taskId: string): string {
    const refs = this.load(taskId).filter((r) => r.state === "studied");
    if (!refs.length) return "";
    const lines = [
      "Design reference: the owner wants the same look and feel (UI/UX and theme) as the reference below. Match its colours, typography, spacing, corner shapes and layout closely. Keep text contrast at WCAG AA or better, and do not copy its logos, photos or text.",
    ];
    refs.forEach((r, i) => {
      const what = r.kind === "link" ? `the page ${r.url}` : `the picture "${r.name}"`;
      const size = r.width && r.height ? ` (${r.width}x${r.height})` : "";
      const where = r.file ? `, saved at .depo/references/${path.basename(r.file)}` : "";
      lines.push(`Reference ${i + 1}: ${what}${size}${where}`);
      if (r.mode) lines.push(`- Theme: ${r.mode}`);
      const named = r.palette.filter((s) => s.role);
      const others = r.palette.filter((s) => !s.role).slice(0, 4);
      if (named.length || others.length)
        lines.push(
          `- Colours (measured): ${[
            ...named.map(
              (s) =>
                `${ROLE_NAMES[s.role as SwatchRole]} ${s.hex}${s.share >= 0.01 ? ` (${Math.round(s.share * 100)}%)` : ""}`,
            ),
            ...(others.length ? [`others ${others.map((s) => s.hex).join(", ")}`] : []),
          ].join(", ")}`,
        );
      if (r.fonts.length)
        lines.push(
          `- Fonts: ${r.fonts.join(", ")} (use self-hosted open-licence fonts; pick the closest with list_fonts when a font is not free)`,
        );
      const sizes = r.facts?.sizes;
      if (sizes && (sizes.h1 || sizes.body))
        lines.push(
          `- Sizes: ${[sizes.h1 && `h1 ${sizes.h1}`, sizes.h2 && `h2 ${sizes.h2}`, sizes.body && `body ${sizes.body}`].filter(Boolean).join(", ")}`,
        );
      const shape = [
        r.radius && `corners ${r.radius}`,
        r.facts?.contentWidth && `content width about ${r.facts.contentWidth}px`,
      ].filter(Boolean);
      if (shape.length) lines.push(`- ${shape.join(", ")}`);
      const btn = r.facts?.buttons.find((b) => parseCssColor(b.background));
      if (btn) {
        const bgc = parseCssColor(btn.background);
        const fgc = parseCssColor(btn.color);
        lines.push(
          `- Main button: ${bgc ? toHex(bgc) : btn.background} with ${fgc ? toHex(fgc) : btn.color} text, radius ${btn.radius}, weight ${btn.weight}`,
        );
      }
      const vars = Object.entries(r.facts?.vars ?? {}).slice(0, 12);
      if (vars.length)
        lines.push(`- CSS tokens on the page: ${vars.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
      if (r.notes.length) {
        lines.push("- Layout and style (vision model):");
        for (const n of r.notes.slice(0, 12)) lines.push(`  - ${n}`);
      }
    });
    lines.push(
      "Work order: put these values into the design tokens first (CSS variables or the Tailwind theme), then build the screens with them. Before you finish, take a screenshot of the main page with check_page and run compare_to_reference on it; fix the differences it lists.",
    );
    const text = lines.join("\n");
    return text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
  }

  /**
   * Compare a screenshot of what was built with a reference: measured colour differences, and the
   * vision model's list of what looks different (when one is set up).
   */
  async compare(o: {
    taskId: string;
    projectId: string;
    screenshot: string;
    reference?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    const refs = this.load(o.taskId).filter((r) => r.state === "studied" && r.file);
    if (!refs.length) throw new Error("This task has no design reference to compare with.");
    const ref = refs[(o.reference ?? 1) - 1];
    if (!ref) throw new Error(`There are only ${refs.length} references with a picture.`);
    if (!fs.existsSync(o.screenshot)) throw new Error("Screenshot not found.");
    const shot = fs.readFileSync(o.screenshot);
    const lines = [`Compared with reference ${refs.indexOf(ref) + 1} (${ref.name}).`];
    let session: BrowserSession | null = null;
    let yoursPreview: string | null = null;
    try {
      const hasBrowser = this.o.open ? true : (this.o.hasBrowser ?? (() => !!findBrowser()))();
      if (hasBrowser) session = await (this.o.open ?? (() => launchBrowser()))();
      if (session) {
        const px = await imagePixels(session, mimeOf(shot), shot);
        yoursPreview = px.preview;
        const yours = assignRoles(paletteFromPixels(px.rgba, { max: 10 }));
        const diffs = paletteDifferences(ref.palette, yours);
        lines.push(
          diffs.length
            ? `Colours (measured):\n${diffs.map((d) => `- ${d}`).join("\n")}`
            : "Colours (measured): the main colours match.",
        );
      }
    } finally {
      await session?.close();
    }
    const v = this.o.models.resolve("vision");
    if (!v)
      lines.push(
        NO_VISION.replace("the colours and the page's styles were read", "the colours were compared"),
      );
    else {
      const refImg = fs.readFileSync(
        path.join(this.dir(o.taskId), path.basename(ref.preview ?? (ref.file as string))),
      );
      const reply = await this.askVision(
        o,
        v,
        [
          "The first picture is the reference design the owner wants. The second is the app as built.",
          "List what makes the second look different from the first: colours, typography, spacing, corner shapes, layout and components.",
          'Most important first, at most 8 lines starting with "- ", each with a concrete fix (CSS values where you can). If they already match well, say so in one line.',
        ].join("\n"),
        [refImg.toString("base64"), yoursPreview ?? shot.toString("base64")],
        "Comparing with the design reference",
      );
      lines.push(`Vision review:\n${reply.trim() || "(no answer)"}`);
    }
    return lines.join("\n");
  }
}

function publicRef(r: StoredReference): DesignReference {
  const { file: _f, mime: _m, preview: _p, phone: _ph, facts: _fa, createdAt: _c, ...rest } = r;
  return rest;
}

function cleanName(name: string): string {
  const base =
    name
      .replace(/[\\/]+/g, "/")
      .split("/")
      .pop() ?? "picture";
  return (
    base
      .replace(/[^\p{L}\p{N} ._()-]/gu, "")
      .trim()
      .slice(0, 120) || "picture"
  );
}

function unique(a: string[]): string[] {
  const seen = new Set<string>();
  return a.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mimeOf(b: Buffer): string {
  return MAGIC.find((m) => m.test(b))?.mime ?? "image/png";
}

/** "dark theme, background #0b1220, primary #14b8a6, Inter, 12px corners". */
export function summaryLine(r: DesignReference): string {
  const bits: string[] = [];
  if (r.mode) bits.push(`${r.mode} theme`);
  const bg = r.palette.find((s) => s.role === "background");
  const primary = r.palette.find((s) => s.role === "primary");
  if (bg) bits.push(`background ${bg.hex}`);
  if (primary) bits.push(`primary ${primary.hex}`);
  if (r.fonts[0]) bits.push(r.fonts[0]);
  if (r.radius) bits.push(`${r.radius} corners`);
  return bits.join(", ") || r.name;
}

/** Put the page's own computed colours first: they are exact, the pixels are averages. */
function mergeFacts(palette: Swatch[], facts: PageFacts): Swatch[] {
  const bodyBg = parseCssColor(facts.bodyBackground) ?? [255, 255, 255];
  const out = palette.map((s) => ({ ...s }));
  const setRole = (hex: string | null, role: SwatchRole) => {
    if (!hex) return;
    for (const s of out) if (s.role === role) s.role = null;
    const existing = out.find((s) => s.hex === hex);
    if (existing) existing.role = role;
    else out.push({ hex, share: 0, role });
  };
  const bg = parseCssColor(facts.bodyBackground);
  setRole(bg ? toHex(bg) : null, "background");
  const text = parseCssColor(facts.textColors[0]?.color ?? facts.bodyColor, bodyBg);
  setRole(text ? toHex(text) : null, "text");
  const btn = facts.buttons
    .map((b) => parseCssColor(b.background, bodyBg))
    .find((c) => c && toHex(c) !== (bg ? toHex(bg) : ""));
  if (btn) setRole(toHex(btn), "primary");
  return out;
}

function studyPrompt(ref: StoredReference, palette: Swatch[], facts: PageFacts | null): string {
  const colours = palette
    .map(
      (s) =>
        `${s.hex}${s.role ? ` (looks like ${ROLE_NAMES[s.role]})` : ""}${s.share ? ` ${Math.round(s.share * 100)}%` : ""}`,
    )
    .join(", ");
  return [
    `You are a senior product designer. The owner wants their app to look and feel like this ${ref.kind === "link" ? "web page" : "picture"}.`,
    "Describe only what is needed to recreate the same UI/UX and theme in a new app.",
    colours ? `Measured colours: ${colours}.` : "",
    facts?.fonts.length ? `Fonts used on the page: ${facts.fonts.map((f) => f.family).join(", ")}.` : "",
    'Reply with at most 12 short lines starting with "- ", covering: layout and navigation; density and spacing; typography (serif or sans, weights, relative sizes); shapes (corner radius in px, borders, shadows); components (cards, tables, buttons, inputs, badges, charts); icons and imagery; overall mood.',
    'If a colour role above looks wrong, add a line like "- Role: #14b8a6 is the primary". No preamble.',
  ]
    .filter(Boolean)
    .join("\n");
}

/** The bullet lines of the vision model's reply, with role corrections applied to the palette. */
export function parseVision(reply: string, palette: Swatch[]): { notes: string[]; palette: Swatch[] } {
  const out = palette.map((s) => ({ ...s }));
  const notes: string[] = [];
  const roles = Object.keys(ROLE_NAMES) as SwatchRole[];
  const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
  const all = reply.split(/\r?\n/).filter((l) => l.trim());
  // Bullet lines when there are any; otherwise every line that is not a heading.
  const picked = all.some((l) => BULLET.test(l))
    ? all.filter((l) => BULLET.test(l))
    : all.filter((l) => !/:\s*$/.test(l));
  for (const raw of picked) {
    const line = raw.replace(BULLET, "").replace(/\*\*/g, "").trim();
    if (!line) continue;
    const role = line.match(/^role:\s*(#[0-9a-f]{6})\s+is\s+the\s+([a-z ]+)/i);
    if (role?.[1] && role[2]) {
      const hex = role[1].toLowerCase();
      const name = role[2]
        .trim()
        .toLowerCase()
        .replace("muted text", "muted")
        .replace(/ colou?r$/, "");
      const r = roles.find((x) => x === name);
      const target = out.find((s) => s.hex === hex);
      if (r && target) {
        for (const s of out) if (s.role === r) s.role = null;
        target.role = r;
      }
      continue;
    }
    notes.push(line.slice(0, 300));
  }
  return { notes: notes.slice(0, 16), palette: out };
}

function guessFonts(notes: string[]): string[] {
  const text = notes.join(" ").toLowerCase();
  if (/\bserif\b/.test(text) && !/sans[- ]serif/.test(text)) return ["serif"];
  if (/monospace|mono\b/.test(text)) return ["sans-serif", "monospace"];
  return /sans/.test(text) ? ["sans-serif"] : [];
}

function guessRadius(notes: string[]): string | null {
  const m = notes
    .join(" ")
    .match(
      /(\d{1,2})\s?px\s+(?:corner|radius|rounded)|(?:radius|rounded|corners?)[^.\d]{0,20}(\d{1,2})\s?px/i,
    );
  const v = m?.[1] ?? m?.[2];
  return v ? `${v}px` : null;
}
