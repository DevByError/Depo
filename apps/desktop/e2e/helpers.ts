import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { FAKE_OLLAMA_PORT } from "../playwright.config";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/fixtures/fastapi-demo",
);

/** A fresh copy of the FastAPI demo project, so applying changes never touches the repo. */
export function fixtureCopy(name = "fastapi-demo"): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "depo e2e ")), name);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

export async function useFakeOllamaAsCoder(page: Page) {
  await page.getByRole("tab", { name: "Models" }).click();
  const panel = page.getByRole("region", { name: "Models" });
  const runtimes = panel.getByRole("region", { name: "Runtimes" });
  await runtimes.getByRole("button", { name: "Edit" }).click();
  await runtimes.getByLabel("Ollama address").fill(`http://127.0.0.1:${FAKE_OLLAMA_PORT}`);
  await runtimes.getByRole("button", { name: "Save" }).click();
  await expect(runtimes).toContainText("0.0.0-fake");
  const plan = panel.getByRole("region", { name: "Auto-Fit plan" });
  const coder = plan.getByLabel("Use").first();
  await coder.selectOption({ label: "qwen2.5-coder:1.5b · ollama" });
  await expect(coder).toHaveValue(/qwen2\.5-coder/);
}

export async function seriousA11yViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}
