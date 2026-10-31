import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { FAKE_OLLAMA_PORT } from "../playwright.config";

test.describe.configure({ mode: "serial" });

test("Models: hardware check, Auto-Fit plan, runtime setup, download, benchmark, delete", async ({
  page,
}) => {
  await page.goto("");
  await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
  await page.getByRole("tab", { name: "Models" }).click();
  const panel = page.getByRole("region", { name: "Models" });

  // First visit profiles the PC automatically and shows a plan in plain words.
  await expect(panel.getByRole("region", { name: "This PC" })).toContainText("Memory", { timeout: 20_000 });
  const plan = panel.getByRole("region", { name: "Auto-Fit plan" });
  await expect(plan).toContainText(/Your PC can run .* Quality: \w+/);
  await expect(plan.getByRole("heading", { name: "Coder" })).toBeVisible();

  // Point Ollama at the local fake runtime.
  const runtimes = panel.getByRole("region", { name: "Runtimes" });
  await runtimes.getByRole("button", { name: "Edit" }).click();
  await runtimes.getByLabel("Ollama address").fill(`http://127.0.0.1:${FAKE_OLLAMA_PORT}`);
  await runtimes.getByRole("button", { name: "Save" }).click();
  await expect(runtimes).toContainText("0.0.0-fake");

  const installed = panel.getByRole("region", { name: "Installed models" });
  await expect(installed).toContainText("qwen2.5-coder:1.5b");

  // Download any tag; progress shows, then it appears in the list and the activity feed.
  await installed.getByLabel("Ollama model tag").fill("tinyllama:1.1b");
  await installed.getByRole("button", { name: "Download" }).click();
  await expect(installed.getByRole("progressbar", { name: "Downloading tinyllama:1.1b" })).toBeVisible();
  await expect(installed.getByRole("cell", { name: "tinyllama:1.1b", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("log", { name: "Activity feed" })).toContainText("Downloaded tinyllama:1.1b");

  // Benchmark updates the measured speed on the hardware card.
  const row = installed.getByRole("row", { name: /qwen2\.5-coder:1\.5b/ });
  await row.getByRole("button", { name: "Benchmark" }).click();
  await expect(row).toContainText("tok/s", { timeout: 10_000 });
  await expect(panel.getByRole("region", { name: "This PC" })).toContainText("Measured speed");

  // Manual override for a role, then back to Auto-Fit.
  const coderSelect = plan.getByLabel("Use").first();
  await coderSelect.selectOption({ label: "tinyllama:1.1b · ollama" });
  await expect(coderSelect).toHaveValue(/tinyllama/);
  await coderSelect.selectOption({ index: 0 });

  // Delete asks for confirmation.
  const tiny = installed.getByRole("row", { name: /tinyllama/ });
  await tiny.getByRole("button", { name: "Delete tinyllama:1.1b" }).click();
  await tiny.getByRole("button", { name: /^Delete 2\.0 GB$/ }).click();
  await expect(installed.getByRole("cell", { name: "tinyllama:1.1b", exact: true })).toBeHidden();

  // Balanced mode changes the plan description.
  await panel.getByRole("radio", { name: "Balanced" }).click();
  await expect(plan).toContainText("Balanced: a faster model");

  // Cloud addresses are refused.
  await runtimes.getByRole("button", { name: "Edit" }).click();
  await runtimes.getByLabel("LM Studio address").fill("https://api.example.com");
  await runtimes.getByRole("button", { name: "Save" }).click();
  await expect(runtimes.getByRole("alert")).toContainText("not a local or LAN address");
  await runtimes.getByRole("button", { name: "Done" }).click();
});

for (const theme of ["dark", "light"] as const) {
  test(`Models screen has no serious accessibility violations (${theme})`, async ({ page }) => {
    await page.goto("");
    await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page.getByRole("region", { name: "Auto-Fit plan" })).toContainText("Quality:", {
      timeout: 20_000,
    });
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}
