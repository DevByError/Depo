import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { ChatChunk, ChatRequest, ModelProvider } from "@depo/model-gateway";
import type { DepoEvent } from "@depo/shared";
import { openDatabase } from "../src/db";
import { findBrowser } from "../src/design/browser";
import { launchBrowser } from "../src/design/cdp";
import { createEngine, type Engine } from "../src/engine";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { captureLink } from "../src/references/capture";
import {
  assignRoles,
  contrast,
  fromHex,
  modeOf,
  paletteDifferences,
  paletteFromPixels,
  parseCssColor,
} from "../src/references/palette";
import { parseVision, ReferenceService } from "../src/references/service";
import {
  checkReferenceUrl,
  isPrivateAddress,
  isPrivateHost,
  OutsideRequestGate,
} from "../src/references/url";
import { REFERENCE_TOOLS } from "../src/tools/reference-tools";
import { TEST_TOKEN, tempDir } from "./helpers";

/**
 * Design references: the owner sends a picture or a link and wants the same look. Colours come
 * from the pixels, a link's styles from the page, the layout from the vision model; agents get a
 * brief and a tool to compare their screens. Browser parts run when a Chromium-family browser exists.
 */

const BROWSER =
  [process.env.DEPO_BROWSER, process.env.PW_CHROMIUM_PATH, findBrowser(), "/opt/pw-browsers/chromium"].find(
    (p): p is string => !!p && fs.existsSync(p),
  ) ?? null;

// ---- a tiny PNG writer for test pictures ------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC[(c ^ x) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A PNG painted by `paint(x, y)` returning [r, g, b]. */
function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BG: [number, number, number] = [11, 18, 32]; // #0b1220
const SURFACE: [number, number, number] = [22, 32, 52]; // #162034
const TEXT: [number, number, number] = [230, 237, 247]; // #e6edf7
const TEAL: [number, number, number] = [20, 184, 166]; // #14b8a6

/** A dark dashboard: background, a sidebar surface, a teal button and light text lines. */
const DASHBOARD = png(400, 250, (x, y) => {
  if (x < 90) return y >= 30 && y < 34 && x > 10 && x < 70 ? TEXT : SURFACE;
  if (x >= 300 && x < 380 && y >= 20 && y < 44) return TEAL;
  if (y % 30 >= 10 && y % 30 < 13 && x >= 110 && x < 280) return TEXT;
  return BG;
});

function pixelsOf(colors: [[number, number, number], number][]): Uint8Array {
  const total = colors.reduce((n, [, c]) => n + c, 0);
  const out = new Uint8Array(total * 4);
  let i = 0;
  for (const [rgb, count] of colors)
    for (let k = 0; k < count; k++) {
      out.set([...rgb, 255], i);
      i += 4;
    }
  return out;
}

// ---- colour maths -----------------------------------------------------------------------------

describe("palette", () => {
  test("main colours from pixels, small colourful ones kept, roles guessed", () => {
    const px = pixelsOf([
      [BG, 6000],
      [SURFACE, 2500],
      [TEXT, 600],
      [[138, 151, 173], 300], // muted text #8a97ad
      [TEAL, 60],
      [[245, 158, 11], 15], // amber accent, 0.16%
    ]);
    const colors = paletteFromPixels(px, { max: 10 });
    expect(colors[0]?.hex).toBe("#0b1220");
    expect(colors.map((c) => c.hex)).toContain("#14b8a6");
    expect(colors.map((c) => c.hex)).toContain("#f59e0b");
    const roles = Object.fromEntries(
      assignRoles(colors)
        .filter((s) => s.role)
        .map((s) => [s.role, s.hex]),
    );
    expect(roles).toMatchObject({
      background: "#0b1220",
      surface: "#162034",
      text: "#e6edf7",
      muted: "#8a97ad",
      primary: "#14b8a6",
      accent: "#f59e0b",
    });
    expect(modeOf("#0b1220")).toBe("dark");
    expect(modeOf("#f8fafc")).toBe("light");
  });

  test("near-identical shades merge and transparent pixels are skipped", () => {
    const px = pixelsOf([
      [[255, 255, 255], 500],
      [[252, 252, 252], 500],
    ]);
    const withHole = new Uint8Array([...px, 0, 0, 0, 0]);
    expect(paletteFromPixels(withHole)).toHaveLength(1);
    expect(paletteFromPixels(new Uint8Array(0))).toEqual([]);
  });

  test("CSS colours as browsers report them", () => {
    expect(parseCssColor("rgb(20, 184, 166)")).toEqual(TEAL);
    expect(parseCssColor("#fff")).toEqual([255, 255, 255]);
    expect(parseCssColor("#14b8a6")).toEqual(TEAL);
    expect(parseCssColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(parseCssColor("transparent")).toBeNull();
    // Half-transparent black over white is mid grey.
    expect(parseCssColor("rgba(0, 0, 0, 0.5)")).toEqual([128, 128, 128]);
    expect(parseCssColor("rgb(0 0 0 / 50%)", [0, 0, 0])).toEqual([0, 0, 0]);
    expect(parseCssColor("color(srgb 1 0 0)")).toEqual([255, 0, 0]);
    expect(parseCssColor("hsl(0 0% 0%)")).toBeNull();
  });

  test("contrast and palette differences", () => {
    expect(contrast(fromHex("#000000"), fromHex("#ffffff"))).toBeCloseTo(21, 0);
    const ref = assignRoles([
      { hex: "#0b1220", share: 0.6 },
      { hex: "#e6edf7", share: 0.1 },
      { hex: "#14b8a6", share: 0.02 },
    ]);
    const same = assignRoles([
      { hex: "#0c1322", share: 0.6 },
      { hex: "#e6edf7", share: 0.1 },
      { hex: "#15b9a7", share: 0.02 },
    ]);
    expect(paletteDifferences(ref, same)).toEqual([]);
    const light = assignRoles([
      { hex: "#ffffff", share: 0.7 },
      { hex: "#111111", share: 0.1 },
      { hex: "#2563eb", share: 0.02 },
    ]);
    const diffs = paletteDifferences(ref, light).join("\n");
    expect(diffs).toContain("background: reference #0b1220, yours #ffffff");
    expect(diffs).toContain("primary: reference #14b8a6, yours #2563eb");
  });
});

// ---- addresses --------------------------------------------------------------------------------

describe("which links can be opened", () => {
  test("public sites and the owner's own app; nothing else", () => {
    const pub = checkReferenceUrl("dribbble.com/shots/123");
    expect(pub.ok && pub.url.toString()).toBe("https://dribbble.com/shots/123");
    expect(pub.ok && pub.local).toBe(false);
    const local = checkReferenceUrl("http://127.0.0.1:5173/");
    expect(local.ok && local.local).toBe(true);
    for (const bad of [
      "file:///C:/secret.html",
      "javascript:alert(1)",
      "https://user:pw@example.com/",
      "http://192.168.1.1/",
      "http://10.0.0.5:8080",
      "http://router/",
      "http://printer.local/",
      "http://[fe80::1]/",
      "http://169.254.169.254/latest/meta-data",
      "not a url at all",
    ])
      expect(checkReferenceUrl(bad).ok).toBe(false);
  });

  test("private addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.0.10",
      "100.64.0.1",
      "169.254.1.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "::ffff:192.168.1.1",
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "104.16.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
  });

  test("an outside page may load public hosts only, checked by name resolution", async () => {
    const lookups: string[] = [];
    const gate = new OutsideRequestGate(async (host) => {
      lookups.push(host);
      return host === "evil.example" ? ["10.0.0.1"] : ["93.184.216.34"];
    });
    expect(await gate.allowed("https://fonts.example.org/inter.woff2")).toBe(true);
    expect(await gate.allowed("https://fonts.example.org/other.woff2")).toBe(true);
    expect(lookups).toEqual(["fonts.example.org"]); // cached per host
    expect(await gate.allowed("https://evil.example/x")).toBe(false);
    expect(await gate.allowed("http://127.0.0.1:11434/api/delete")).toBe(false);
    expect(await gate.allowed("ws://example.org/socket")).toBe(false);
    expect(await gate.allowed("data:image/png;base64,AAAA")).toBe(true);
  });
});

describe("the vision model's notes", () => {
  test("bullet lines become notes; role lines correct the palette", () => {
    const palette = assignRoles([
      { hex: "#ffffff", share: 0.7 },
      { hex: "#111827", share: 0.1 },
      { hex: "#2563eb", share: 0.02 },
      { hex: "#f97316", share: 0.01 },
    ]);
    const r = parseVision(
      "Here is what I see:\n- Left sidebar with icons, content in cards\n* **Typography:** sans-serif, bold headings\n1. Corners about 12px\n- Role: #f97316 is the primary\n",
      palette,
    );
    expect(r.notes).toEqual([
      "Left sidebar with icons, content in cards",
      "Typography: sans-serif, bold headings",
      "Corners about 12px",
    ]);
    expect(r.palette.find((s) => s.role === "primary")?.hex).toBe("#f97316");
    expect(parseVision("Dark theme with teal accents.\nCards have soft shadows.", []).notes).toHaveLength(2);
  });
});

// ---- the service ------------------------------------------------------------------------------

function fakeVision(answer: (req: ChatRequest) => string): {
  provider: ModelProvider;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  const provider: ModelProvider = {
    id: "fake",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:1",
    async health() {
      return { ok: true, version: "fake", message: null };
    },
    async listModels() {
      return [];
    },
    async embed(_m, inputs) {
      return inputs.map(() => [0]);
    },
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      requests.push(req);
      yield { type: "text", delta: answer(req) };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
  return { provider, requests };
}

let tmp: { dir: string; cleanup: () => void } | null = null;
afterEach(() => {
  tmp?.cleanup();
  tmp = null;
});

function service(o: { vision?: ModelProvider | null; browser?: boolean } = {}) {
  const t = tempDir("depo refs");
  const db = openDatabase({ file: path.join(t.dir, "depo.db"), backupsDir: path.join(t.dir, "b") });
  tmp = {
    dir: t.dir,
    cleanup: () => {
      db.close();
      t.cleanup();
    },
  };
  const logger = createLogger({ dir: path.join(t.dir, "logs"), level: "error" });
  const bus = new EventBus(db.db, logger);
  const events: DepoEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const svc = new ReferenceService({
    dataDir: path.join(tmp.dir, "references"),
    bus,
    logger,
    models: {
      resolve: (role) =>
        role === "vision" && o.vision
          ? { provider: o.vision, model: "fake-vision", contextLength: 4096 }
          : null,
    },
    ...(o.browser && BROWSER
      ? { open: () => launchBrowser({ browser: BROWSER }) }
      : { hasBrowser: () => false }),
  });
  return { svc, events, dir: t.dir, bus };
}

describe("ReferenceService without a browser", () => {
  test("checks pictures and links before keeping them", () => {
    const { svc } = service();
    expect(() =>
      svc.save("tsk_1", [
        {
          kind: "image",
          name: "notes.txt",
          mime: "image/png",
          data: Buffer.from("hello world").toString("base64"),
        },
      ]),
    ).toThrow("is not a PNG, JPEG, GIF or WebP picture");
    expect(() => svc.save("tsk_1", [{ kind: "link", url: "http://192.168.1.20/" }])).toThrow("local network");
    expect(svc.list("tsk_1")).toEqual([]);
    const refs = svc.save("tsk_1", [
      {
        kind: "image",
        name: "C:\\Users\\me\\Pictures\\My dashboard.png",
        mime: "image/png",
        data: DASHBOARD.toString("base64"),
      },
      { kind: "link", url: "https://www.example.com/pricing" },
    ]);
    expect(refs.map((r) => [r.kind, r.name, r.state])).toEqual([
      ["image", "My dashboard.png", "pending"],
      ["link", "example.com", "pending"],
    ]);
    expect(svc.pending("tsk_1")).toBe(true);
    expect(svc.image("tsk_1", refs[0]?.id ?? "").data).toBe(DASHBOARD.toString("base64"));
    expect(() => svc.image("tsk_1", refs[1]?.id ?? "")).toThrow("no picture");
    expect(() => svc.list("../etc")).toThrow("Invalid task id");
  });

  test("without a browser or vision model, a picture still gets a plain brief and a link fails clearly", async () => {
    const { svc, events } = service();
    svc.save("tsk_2", [
      { kind: "image", name: "shot.png", mime: "image/png", data: DASHBOARD.toString("base64") },
      { kind: "link", url: "https://example.com/" },
    ]);
    const refs = await svc.study({ taskId: "tsk_2", projectId: "prj_1", agent: "coder@1.0.0" });
    expect(refs[0]?.state).toBe("studied");
    expect(refs[0]?.warnings.join(" ")).toContain("Edge or Chrome was not found");
    expect(refs[0]?.warnings.join(" ")).toContain("No vision model is set up");
    expect(refs[1]?.state).toBe("failed");
    expect(refs[1]?.error).toContain("needs Edge or Chrome");
    expect(svc.brief("tsk_2")).toContain('Reference 1: the picture "shot.png"');
    const done = events.find((e) => e.type === "reviewing" && e.status === "succeeded");
    expect(done?.text).toStartWith("Design reference read");
    // Studied once: a second call has nothing to do.
    await svc.study({ taskId: "tsk_2", projectId: "prj_1", agent: "coder@1.0.0" });
    expect(events.filter((e) => e.type === "reviewing" && e.status === "started")).toHaveLength(1);
  });

  test("the agent tool refuses when the task has no reference", async () => {
    const { svc, bus } = service();
    const t = REFERENCE_TOOLS[0];
    expect(t?.name).toBe("compare_to_reference");
    await expect(
      t?.run(
        { screenshot: "a.png" },
        {
          root: "/tmp",
          bus,
          approvals: {} as never,
          projectId: "prj_1",
          taskId: "tsk_none",
          agent: "frontend@1.0.0",
          references: svc,
        },
      ) as Promise<string>,
    ).rejects.toThrow("did not send a design reference");
  });
});

describe.skipIf(!BROWSER)("ReferenceService with a real browser", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme admin</title>
<style>
:root { --brand-primary: #7c3aed; --surface-bg: #ffffff; --radius-card: 14px; --spacing-unit: 8px; }
body { margin: 0; background: #f5f3ff; color: #1e1b4b; font-family: "Fancy Sans", Georgia, serif; font-size: 15px; }
h1 { font-family: "Display Serif", serif; font-size: 40px; }
.card { background: #ffffff; border-radius: 14px; margin: 24px; padding: 24px; width: 600px; }
.btn { background: #7c3aed; color: #ffffff; border: 0; border-radius: 10px; padding: 10px 18px; font-weight: 600; }
</style></head><body><main><h1>Dashboard</h1>
<div class="card"><p>Revenue this month is up by twelve percent compared with last month.</p>
<button class="btn">New invoice</button></div>
<div class="card"><p>Three invoices are overdue.</p></div>
<img src="http://10.0.0.1/tracker.png" alt=""></main></body></html>`;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }),
    });
  });
  afterAll(() => {
    server?.stop(true);
  });

  test("a picture: colours measured from the pixels, the vision model's notes, a brief, and a comparison", async () => {
    const vision = fakeVision((req) =>
      req.messages[0]?.images?.length === 2
        ? "- The background should be dark navy, not white\n- Use 12px corners on cards"
        : "- Sidebar navigation on the left, content in a wide column\n- Sans-serif type, semibold headings\n- Rounded corners about 12px, no shadows",
    );
    const { svc, dir } = service({ vision: vision.provider, browser: true });
    const [ref] = svc.save("tsk_3", [
      { kind: "image", name: "dashboard.png", mime: "image/png", data: DASHBOARD.toString("base64") },
    ]);
    const [done] = await svc.study({ taskId: "tsk_3", projectId: "prj_1", agent: "coder@1.0.0" });
    expect(done?.state).toBe("studied");
    expect(done?.width).toBe(400);
    expect(done?.mode).toBe("dark");
    const roles = Object.fromEntries((done?.palette ?? []).filter((s) => s.role).map((s) => [s.role, s.hex]));
    expect(roles.background).toBe("#0b1220");
    expect(roles.primary).toBe("#14b8a6");
    expect(done?.vision).toBe(true);
    expect(done?.notes[0]).toContain("Sidebar navigation");
    expect(done?.radius).toBe("12px");
    // The vision model got the measured colours and one picture.
    expect(vision.requests[0]?.messages[0]?.content).toContain("#0b1220");
    expect(vision.requests[0]?.messages[0]?.images).toHaveLength(1);

    const brief = svc.brief("tsk_3");
    expect(brief).toContain("background #0b1220");
    expect(brief).toContain("primary #14b8a6");
    expect(brief).toContain(`.depo/references/${ref?.id}.png`);
    expect(brief).toContain("compare_to_reference");
    expect(svc.brief("tsk_3")).toBe(brief); // the same text every time

    const ws = path.join(dir, "copy");
    fs.mkdirSync(ws);
    svc.copyInto("tsk_3", ws);
    expect(fs.existsSync(path.join(ws, ".depo", "references", `${ref?.id}.png`))).toBe(true);

    // What the agent built: a white page with a blue button.
    const shot = path.join(ws, "built.png");
    fs.writeFileSync(
      shot,
      png(400, 250, (x, y) => (x > 300 && y < 40 ? [37, 99, 235] : [255, 255, 255])),
    );
    expect(svc.has("tsk_3")).toBe(true);
    const text = await svc.compare({ taskId: "tsk_3", projectId: "prj_1", screenshot: shot });
    expect(text).toContain("background: reference #0b1220, yours #ffffff");
    expect(text).toContain("Vision review:\n- The background should be dark navy");
    expect(vision.requests.at(-1)?.messages[0]?.images).toHaveLength(2);
  }, 60_000);

  test("a link to the owner's app: screenshots and the page's real fonts, sizes, corners and tokens", async () => {
    const { svc } = service({ browser: true });
    const url = `http://127.0.0.1:${server?.port}/`;
    svc.save("tsk_4", [{ kind: "link", url }]);
    const [done] = await svc.study({ taskId: "tsk_4", projectId: "prj_1", agent: "coder@1.0.0" });
    expect(done?.state).toBe("studied");
    expect(done?.hasImage).toBe(true);
    expect(done?.width).toBe(1440);
    expect(done?.mode).toBe("light");
    expect(done?.fonts.slice(0, 2)).toEqual(["Display Serif", "Fancy Sans"]);
    expect(done?.radius).toBe("14px");
    const roles = Object.fromEntries((done?.palette ?? []).filter((s) => s.role).map((s) => [s.role, s.hex]));
    expect(roles.background).toBe("#f5f3ff");
    expect(roles.text).toBe("#1e1b4b");
    expect(roles.primary).toBe("#7c3aed");
    const brief = svc.brief("tsk_4");
    expect(brief).toContain(`the page ${url}`);
    expect(brief).toContain("h1 40px");
    expect(brief).toContain("body 15px");
    expect(brief).toContain("--brand-primary: #7c3aed");
    expect(brief).toContain("Main button: #7c3aed with #ffffff text, radius 10px, weight 600");
    expect(svc.image("tsk_4", done?.id ?? "").mime).toBe("image/png");
  }, 60_000);

  test("an outside page goes through the gate: refused requests are blocked and counted", async () => {
    const session = await launchBrowser({ browser: BROWSER });
    const base = `http://127.0.0.1:${server?.port}/`;
    const asked: string[] = [];
    try {
      const cap = await captureLink(session, base, async (u) => {
        asked.push(u);
        return u.startsWith(base);
      });
      expect(cap.desktop.subarray(1, 4).toString("latin1")).toBe("PNG");
      expect(cap.phone).not.toBeNull();
      expect(cap.facts?.title).toBe("Acme admin");
      expect(asked).toContain("http://10.0.0.1/tracker.png");
      expect(cap.blocked).toBeGreaterThanOrEqual(1);
    } finally {
      await session.close();
    }
  }, 60_000);
});

// ---- with tasks -------------------------------------------------------------------------------

describe("design references in a task", () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop("test");
    engine = null;
  });

  test("the message keeps its references, the chat shows them, and the agent's request carries the brief", async () => {
    tmp = tempDir("depo refs task");
    const requests: ChatRequest[] = [];
    const coder: ModelProvider = {
      ...fakeVision(() => "").provider,
      async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
        requests.push(req);
        yield { type: "text", delta: "Done: the theme now follows the reference." };
        yield { type: "done", finishReason: "stop", usage: null };
      },
    };
    const e = createEngine({
      dataRoot: path.join(tmp.dir, "data"),
      token: TEST_TOKEN,
      heartbeatMs: 60_000,
      tasks: { retryDelayMs: 10 },
      models: { providerFactory: () => coder },
      references: { hasBrowser: () => false },
    });
    engine = e;
    await e.start();
    e.models.setProviders([{ id: "fake", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }]);
    e.models.assign("coder", { providerId: "fake", model: "fake-model" });
    e.settings.set("memory.auto", false);
    const proj = path.join(tmp.dir, "shop");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "index.html"), "<h1>Shop</h1>\n");
    const project = await e.projects.open(proj);

    expect(() =>
      e.tasks.send(project.id, "Make it look like this", undefined, undefined, [
        { kind: "link", url: "http://10.1.1.1/" },
      ]),
    ).toThrow("local network");
    expect(e.tasks.list(project.id)).toHaveLength(0); // a bad reference leaves no empty task

    const task = e.tasks.send(project.id, "Use the same UI and theme as this picture", undefined, undefined, [
      { kind: "image", name: "theme.png", mime: "image/png", data: DASHBOARD.toString("base64") },
    ]);
    await e.tasks.settled(task.id);
    const { messages } = e.tasks.get(task.id);
    const user = messages.find((m) => m.role === "user");
    expect(user?.text).toBe("Use the same UI and theme as this picture");
    expect(user?.references?.[0]).toMatchObject({ kind: "image", name: "theme.png", state: "studied" });
    const sent = requests[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(sent).toStartWith("Use the same UI and theme as this picture\n\nDesign reference:");
    expect(sent).toContain('the picture "theme.png"');
    // The picture is in the private copy for the agent, outside the change set.
    const root = e.tasks.workspaceRoot(task.id);
    expect(root && fs.readdirSync(path.join(root, ".depo", "references"))).toHaveLength(1);
  }, 30_000);
});
