import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBrowser } from "../src/design/browser";
import { launchBrowser } from "../src/design/cdp";
import { runPageCheck, summarize } from "../src/design/page-check";
import { tempDir } from "./helpers";

/**
 * The page check against a real headless Chromium, Edge or Chrome. Runs only when one is found:
 * DEPO_BROWSER, PW_CHROMIUM_PATH, the usual install folders, or Playwright's Chromium in this sandbox.
 */
const BROWSER =
  [process.env.DEPO_BROWSER, process.env.PW_CHROMIUM_PATH, findBrowser(), "/opt/pw-browsers/chromium"].find(
    (p): p is string => !!p && fs.existsSync(p),
  ) ?? null;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Demo shop</title>
<link rel="stylesheet" href="https://fonts.example.com/inter.css">
</head><body>
<main>
<h1>Demo shop</h1>
<img src="/logo.png">
<label for="email">Email</label><input id="email" type="email">
<button id="save" type="button">Save</button>
<p id="out"></p>
</main>
<script>
console.error("Widget failed to load");
fetch("/api/items").catch(() => {});
document.getElementById("save").addEventListener("click", () => {
  document.getElementById("out").textContent = "Saved " + document.getElementById("email").value;
});
setTimeout(() => { throw new Error("late boom"); }, 10);
</script>
</body></html>`;

let server: ReturnType<typeof Bun.serve> | null = null;
beforeAll(() => {
  if (!BROWSER) return;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/") return new Response(PAGE, { headers: { "Content-Type": "text/html" } });
      if (u.pathname === "/api/items") return new Response("boom", { status: 500 });
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server?.stop(true));

test.skipIf(!BROWSER)(
  "a real browser: widths, steps, console errors, failed and blocked requests, axe, screenshots, cleanup",
  async () => {
    const t = tempDir("depo cdp");
    const profiles = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("depo-cdp-")));
    const before = profiles();
    try {
      const url = `http://127.0.0.1:${server?.port}/`;
      const views = await runPageCheck({
        url,
        widths: ["phone", "desktop"],
        steps: [
          { action: "type", selector: "#email", text: "ana@example.com" },
          { action: "click", selector: "#save" },
          { action: "wait_for", text: "Saved" },
        ],
        expectText: "Saved ana@example.com",
        outDir: path.join(t.dir, ".depo", "qa", "qa_x"),
        relDir: ".depo/qa/qa_x",
        open: () => launchBrowser({ browser: BROWSER }),
        timeoutMs: 90_000,
      });
      expect(views.map((v) => v.width)).toEqual(["phone", "desktop"]);
      for (const v of views) {
        expect(v.error).toBeNull();
        expect(v.loaded).toBe(true);
        expect(v.status).toBe(200);
        expect(v.title).toBe("Demo shop");
        expect(v.viewport.width).toBe(v.width === "phone" ? 360 : 1440);
        expect(v.steps.every((s) => s.ok)).toBe(true);
        expect(v.expectFound).toBe(true);
        expect(v.consoleErrors.some((c) => c.kind === "console" && c.text.includes("Widget failed"))).toBe(
          true,
        );
        expect(v.consoleErrors.some((c) => c.kind === "exception" && c.text.includes("late boom"))).toBe(
          true,
        );
        expect(v.failedRequests.some((r) => r.url.endsWith("/api/items") && r.status === 500)).toBe(true);
        expect(v.failedRequests.some((r) => r.blocked && r.url.startsWith("https://fonts.example.com"))).toBe(
          true,
        );
        expect(v.failedRequests.some((r) => r.url.endsWith("/logo.png") && r.status === 404)).toBe(true);
        expect(v.a11y.ran).toBe(true);
        expect(v.a11y.violations.some((a) => a.id === "image-alt" && a.impact === "critical")).toBe(true);
        expect(v.a11y.counts.critical).toBeGreaterThanOrEqual(1);
        const png = fs.readFileSync(path.join(t.dir, v.screenshot ?? "missing"));
        expect(png.subarray(1, 4).toString()).toBe("PNG");
        const thumb = fs.readFileSync(path.join(t.dir, v.thumbnail ?? "missing"));
        expect(thumb.length).toBeLessThan(png.length);
      }
      const { ok, summary } = summarize(views, url, "Saved ana@example.com");
      expect(ok).toBe(false);
      expect(summary).toContain("console error");
      expect(summary).toContain("image-alt");
      // The browser and its temporary profile are gone.
      const leftover = [...profiles()].filter((n) => !before.has(n));
      expect(leftover).toEqual([]);
    } finally {
      t.cleanup();
    }
  },
  120_000,
);

test.skipIf(!BROWSER)(
  "a refused connection and a missing selector are reported, not thrown",
  async () => {
    const t = tempDir("depo cdp");
    try {
      const views = await runPageCheck({
        url: "http://127.0.0.1:9/",
        widths: ["desktop"],
        steps: [],
        expectText: "Hello",
        outDir: path.join(t.dir, "out"),
        relDir: ".depo/qa/qa_y",
        open: () => launchBrowser({ browser: BROWSER }),
      });
      expect(views[0]?.loaded).toBe(false);
      expect(views[0]?.error).toMatch(/ERR_CONNECTION_REFUSED|ERR_/);
      expect(views[0]?.expectFound).toBe(false);
      const ok = await runPageCheck({
        url: `http://127.0.0.1:${server?.port}/`,
        widths: ["desktop"],
        steps: [{ action: "click", selector: "#nope" }],
        expectText: null,
        outDir: path.join(t.dir, "out2"),
        relDir: ".depo/qa/qa_z",
        open: () => launchBrowser({ browser: BROWSER }),
        stepTimeoutMs: 800,
      });
      expect(ok[0]?.steps[0]?.ok).toBe(false);
      expect(ok[0]?.steps[0]?.error).toContain("#nope");
    } finally {
      t.cleanup();
    }
  },
  120_000,
);
