import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_TMP } from "../playwright.config";
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

test("a request with sections shows Depo's plan first, then works through it step by step", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // A project with a schema and a route table, and a request in sections (ADR-0086).
  const project = path.join(mkdtempSync(path.join(E2E_TMP, "project ")), "notes-app");
  mkdirSync(path.join(project, "be/src/db"), { recursive: true });
  writeFileSync(
    path.join(project, "be/src/db/schema.sql"),
    "CREATE TABLE IF NOT EXISTS users (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY\n);\n",
  );
  writeFileSync(
    path.join(project, "be/src/app.ts"),
    'export const routes = {\n  "GET /api/health": () => ({ ok: true }),\n};\n',
  );
  await page.goto("");
  await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
  await useFakeOllamaAsCoder(page);
  await page.getByRole("button", { name: "Open a project folder", exact: true }).click();
  await page.getByLabel("Project folder path").fill(project);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("list", { name: "Projects", exact: true })).toContainText("notes-app");

  await page.getByRole("tab", { name: "Chat" }).click();
  await page
    .getByLabel("Message the coding agent")
    .fill(
      "Build the notes app.\n\nKeep its structure: routes in be/src/app.ts, new tables at the end of be/src/db/schema.sql.\n\n## Database\n- notes: id, title, body\n- tags: id, name\n\n## API\n- GET /api/notes : the notes, newest first\n",
    );
  await page.getByRole("button", { name: "Send" }).click();

  const plan = page.getByRole("region", { name: "Depo's plan" });
  await expect(plan).toBeVisible({ timeout: 30_000 });
  await expect(plan.getByRole("listitem")).toHaveText([
    /Add the notes table/,
    /Add the tags table/,
    /Build GET \/api\/notes/,
    /Run the app and check it/,
  ]);
  // The card follows the work live.
  await expect(plan.locator('li[data-status="done"]').first()).toBeVisible({ timeout: 30_000 });
  if (process.env.DEPO_SHOT_DIR)
    await page.screenshot({ path: path.join(process.env.DEPO_SHOT_DIR, "step-plan-running.png") });
  await expect(page.getByTestId("task-status")).toContainText("Ready for review", { timeout: 60_000 });
  await expect(plan).toContainText("4 of 4 done");
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText(
    "Done: all 4 steps of the plan passed Depo's checks.",
  );
  if (process.env.DEPO_SHOT_DIR)
    await page.screenshot({ path: path.join(process.env.DEPO_SHOT_DIR, "step-plan.png") });
  expect(await seriousA11yViolations(page)).toEqual([]);
});
