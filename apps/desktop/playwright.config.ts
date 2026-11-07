import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The e2e run starts a real engine (fresh data folder) and the built UI, then drives it in Chromium,
// which is the same engine family as WebView2 on Windows.
export const E2E_TOKEN = "e2e".repeat(16);
export const E2E_ENGINE_PORT = 47201;
export const FAKE_OLLAMA_PORT = 47211;
// Every temp folder of a run lives under one root (engine data, project copies), removed by the
// global teardown. The config is loaded by the runner and by every worker: the first load picks the
// root and the environment hands it on, so a run makes one folder, not one per load.
process.env.DEPO_E2E_TMP ??= mkdtempSync(path.join(tmpdir(), "depo e2e "));
export const E2E_TMP: string = process.env.DEPO_E2E_TMP;
const dataDir = path.join(E2E_TMP, "data");

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 30_000,
  // One engine is shared by every spec, and specs change its settings, so they run one at a time.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:1421/?engine=${encodeURIComponent(`ws://127.0.0.1:${E2E_ENGINE_PORT}/rpc?token=${E2E_TOKEN}`)}`,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        // Optional: point at a pre-installed Chromium instead of `playwright install`.
        ...(process.env.PW_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
  webServer: [
    {
      command: "bun ../../scripts/fake-ollama.ts",
      url: `http://127.0.0.1:${FAKE_OLLAMA_PORT}/`,
      // A short pause per agent step, so tasks in two projects visibly overlap.
      env: { FAKE_OLLAMA_PORT: String(FAKE_OLLAMA_PORT), FAKE_OLLAMA_STEP_MS: "400" },
      reuseExistingServer: false,
    },
    {
      command: "bun ../../packages/engine/src/main.ts",
      port: E2E_ENGINE_PORT,
      env: {
        DEPO_ENGINE_TOKEN: E2E_TOKEN,
        DEPO_ENGINE_PORT: String(E2E_ENGINE_PORT),
        DEPO_DATA_DIR: dataDir,
      },
      // A normal stop, so the engine also stops the previews it started (they run in their own
      // process group and would outlive a killed engine on macOS and Linux).
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      reuseExistingServer: false,
    },
    {
      command: "bun run build:ui && bun run preview",
      url: "http://127.0.0.1:1421",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
