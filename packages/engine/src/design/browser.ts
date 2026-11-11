import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removeInBackground, removeTree } from "../util/remove";

/**
 * Screenshots and PDFs through the browser that is already on the PC (Edge, Chrome or Chromium)
 * in headless mode. Nothing is downloaded and no extra runtime is bundled with the engine.
 */
export function findBrowser(): string | null {
  if (process.env.DEPO_NO_BROWSER === "1") return null;
  const env = process.env.DEPO_BROWSER;
  if (env && fs.existsSync(env)) return env;
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates =
    process.platform === "win32"
      ? [
          path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
          path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
          path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
          path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
          path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
          ];
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}

/** Only local files and the app under test (localhost) may be opened: no browsing the internet. */
export function safeUrl(target: string, root: string): string {
  if (/^https?:\/\//i.test(target)) {
    const u = new URL(target);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
      throw new Error("Only localhost addresses can be opened. Depo does not browse the internet.");
    return u.toString();
  }
  const abs = path.resolve(root, target);
  const rel = path.relative(path.resolve(root), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("The page must be inside the project.");
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${target}`);
  return pathToFileURL(abs).toString();
}

async function runBrowser(
  browser: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; err: string }> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "depo-browser-"));
  try {
    const proc = Bun.spawn(
      [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe", windowsHide: true },
    );
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, err };
  } finally {
    if (!(await removeTree(profile, { tries: 3, delayMs: 100 }))) removeInBackground(profile);
  }
}

export async function screenshot(opts: {
  url: string;
  out: string;
  width: number;
  height: number;
  timeoutMs?: number;
}): Promise<void> {
  const browser = findBrowser();
  if (!browser)
    throw new Error("No browser found (Edge or Chrome). Install one or set DEPO_BROWSER to its path.");
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.rmSync(opts.out, { force: true });
  const r = await runBrowser(
    browser,
    [
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--virtual-time-budget=4000",
      `--window-size=${opts.width},${opts.height}`,
      `--screenshot=${opts.out}`,
      opts.url,
    ],
    opts.timeoutMs ?? 30_000,
  );
  if (!fs.existsSync(opts.out)) {
    throw new Error(`The browser did not produce a screenshot (exit ${r.code}). ${r.err.slice(-300)}`.trim());
  }
}

export async function printPdf(opts: { url: string; out: string; timeoutMs?: number }): Promise<void> {
  const browser = findBrowser();
  if (!browser) throw new Error("No browser found (Edge or Chrome) to make the PDF.");
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.rmSync(opts.out, { force: true });
  const r = await runBrowser(
    browser,
    ["--no-pdf-header-footer", "--virtual-time-budget=4000", `--print-to-pdf=${opts.out}`, opts.url],
    opts.timeoutMs ?? 45_000,
  );
  if (!fs.existsSync(opts.out))
    throw new Error(`The browser did not produce a PDF (exit ${r.code}). ${r.err.slice(-300)}`.trim());
}
