import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { fixtureCopy, seriousA11yViolations, useFakeOllamaAsCoder } from "./helpers";

test.describe.configure({ mode: "serial" });

test('Phase 1 acceptance: "add a /health endpoint to this FastAPI project"', async ({ page }) => {
  test.setTimeout(120_000);
  const project = fixtureCopy();
  const mainPy = path.join(project, "app", "main.py");
  const original = readFileSync(mainPy, "utf8");

  await page.goto("");
  await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
  await useFakeOllamaAsCoder(page);

  // Open the project by path (the browser build has no native folder picker).
  await page.getByRole("button", { name: "Open a project folder", exact: true }).click();
  await page.getByLabel("Project folder path").fill(project);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("list", { name: "Projects", exact: true })).toContainText("fastapi-demo");

  // Ask for the change.
  await page.getByRole("tab", { name: "Chat" }).click();
  await page.getByLabel("Message the coding agent").fill("add a /health endpoint to this FastAPI project");
  await page.getByRole("button", { name: "Send" }).click();

  // The agent works in the copy, runs the tests, and hands over a diff.
  await expect(page.getByTestId("task-status")).toContainText("Ready for review", { timeout: 60_000 });
  const convo = page.getByRole("list", { name: "Conversation" });
  // The answer is shown; the work behind it folds into one dropdown, each step into its own.
  await expect(convo).toContainText("2 passed");
  const work = convo.getByRole("button", { name: /the work \(\d+ steps\)/ });
  if ((await work.getAttribute("aria-expanded")) !== "true") await work.click();
  await expect(convo).toContainText("edit_file");
  await expect(convo).toContainText("run_command");
  const feed = page.getByRole("log", { name: "Activity feed" });
  await expect(feed).toContainText("Changes ready for review");
  // Nothing has touched the real project yet.
  expect(readFileSync(mainPy, "utf8")).toBe(original);

  // Review and apply.
  await page.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByRole("tab", { name: "Diff Review" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText('@app.get("/health")').first()).toBeVisible();
  await page.getByRole("button", { name: /^Apply/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "A checkpoint was saved" })).toBeVisible();
  await expect.poll(() => readFileSync(mainPy, "utf8")).toContain('@app.get("/health")');

  // And undo puts the project back.
  await page.getByRole("button", { name: "Undo", exact: true }).first().click();
  await expect.poll(() => readFileSync(mainPy, "utf8")).toBe(original);
});

for (const theme of ["dark", "light"] as const) {
  test(`Chat screen has no serious accessibility violations (${theme})`, async ({ page }) => {
    await page.goto("");
    await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
    await page.getByRole("tab", { name: "Chat" }).click();
    await page
      .getByRole("button", { name: /fastapi-demo/ })
      .first()
      .click();
    await page.getByRole("navigation", { name: "Tasks" }).getByRole("button").nth(1).click();
    await expect(page.getByTestId("task-status")).toBeVisible();
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    expect(await seriousA11yViolations(page)).toEqual([]);
  });
}
