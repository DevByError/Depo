import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { fixtureCopy, seriousA11yViolations, useFakeOllamaAsCoder } from "./helpers";

test.describe.configure({ mode: "serial" });

const projectsList = (page: Page) => page.getByRole("list", { name: "Projects", exact: true });

async function importFolder(page: Page, folder: string) {
  await page.getByRole("button", { name: "Import a folder or git repository" }).click();
  const dialog = page.getByRole("dialog", { name: "Import a project" });
  await dialog.getByLabel("Folder or git URL").fill(folder);
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Project overview" })).toContainText(path.basename(folder));
}

async function openProject(page: Page, name: string) {
  await projectsList(page).getByRole("button", { name, exact: true }).click();
}

async function sendTask(page: Page, text: string) {
  await page.getByRole("tab", { name: "Chat" }).click();
  await page.getByRole("navigation", { name: "Tasks" }).getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Message the coding agent").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("task-status")).toBeVisible();
}

test("Phase 2 acceptance: two projects run tasks at the same time with separate feeds", async ({ page }) => {
  test.setTimeout(180_000);
  const shop = fixtureCopy("shop-api");
  const blog = fixtureCopy("blog-api");
  await page.goto("");
  await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
  await useFakeOllamaAsCoder(page);

  await importFolder(page, shop);
  await importFolder(page, blog);
  await expect(projectsList(page)).toContainText("shop-api");
  await expect(projectsList(page)).toContainText("blog-api");

  // Start a task in each project, one right after the other.
  await openProject(page, "shop-api");
  await sendTask(page, "add a /health endpoint to this FastAPI project");
  await openProject(page, "blog-api");
  await sendTask(page, "add a /version endpoint to this FastAPI project");

  // Both are running at once, listed with their project names.
  const running = page.getByRole("list", { name: "Running tasks" });
  await expect(running.getByRole("button")).toHaveCount(2);
  await expect(running).toContainText("shop-api");
  await expect(running).toContainText("blog-api");

  // Each finishes with its own result.
  await expect(page.getByTestId("task-status")).toContainText("Ready for review", { timeout: 90_000 });
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("/version");
  await openProject(page, "shop-api");
  await page.getByRole("tab", { name: "Chat" }).click();
  await page
    .getByRole("navigation", { name: "Tasks" })
    .getByRole("button", { name: /add a \/health/ })
    .click();
  await expect(page.getByTestId("task-status")).toContainText("Ready for review", { timeout: 90_000 });
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("/health");
  await expect(page.getByRole("list", { name: "Conversation" })).not.toContainText("/version");
  await expect(running).toHaveCount(0);

  // The feed for this project holds only this project's work; "All projects" shows both.
  const feed = page.getByRole("log", { name: "Activity feed" });
  const scope = page.getByRole("radiogroup", { name: "Show activity from" });
  await scope.getByRole("radio", { name: "This project" }).click();
  await expect(feed).toContainText("Changes ready for review");
  // The feed is virtualised, so search it instead of reading what happens to be on screen.
  const filter = page.getByRole("textbox", { name: "Filter activity" });
  await filter.fill("/version");
  await expect(feed).toContainText("No activity matches this filter.");
  await scope.getByRole("radio", { name: "All projects" }).click();
  await expect(feed).toContainText("Working on: add a /version endpoint");
  await expect(feed.getByText("blog-api").first()).toBeVisible();
  await filter.fill("/health");
  await scope.getByRole("radio", { name: "This project" }).click();
  await expect(feed).toContainText("Working on: add a /health endpoint");
  await filter.fill("");

  // Changes do not cross over: shop-api's diff adds /health only.
  await page.getByRole("tab", { name: "Diff Review" }).click();
  await expect(page.getByText('@app.get("/health")').first()).toBeVisible();
  await expect(page.getByText('@app.get("/version")')).toHaveCount(0);
  await openProject(page, "blog-api");
  await page.getByRole("tab", { name: "Diff Review" }).click();
  await expect(page.getByText('@app.get("/version")').first()).toBeVisible();
  await expect(page.getByText('@app.get("/health")')).toHaveCount(0);

  // Neither real project was touched.
  expect(readFileSync(path.join(shop, "app", "main.py"), "utf8")).not.toContain("/health");
  expect(readFileSync(path.join(blog, "app", "main.py"), "utf8")).not.toContain("/version");

  // The dashboard counts the work.
  await page.getByRole("tab", { name: "Project" }).click();
  const overview = page.getByRole("region", { name: "Project overview" });
  await expect(overview.getByRole("region", { name: "Tasks" })).toContainText("To review");
  await expect(overview.getByRole("region", { name: "Last test run" })).toContainText("passed");
  await expect(page.getByTestId("index-status")).toContainText(/\d+ files/);
});

test("create, edit, remember, duplicate, archive and remove a project", async ({ page }) => {
  test.setTimeout(90_000);
  const parent = mkdtempSync(path.join(tmpdir(), "depo e2e new "));
  await page.goto("");
  await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);

  // New project wizard.
  await page.getByRole("button", { name: "New project" }).first().click();
  const wizard = page.getByRole("dialog", { name: "New project" });
  await wizard.getByLabel("Name").fill("Notes App");
  await wizard.getByLabel("Folder to create the project in").fill(parent);
  await wizard.getByLabel("What is it?").fill("A tiny notes service");
  await wizard.getByLabel("Stack").fill("Python");
  await wizard.getByRole("button", { name: "Create project" }).click();
  await expect(wizard).toBeHidden();
  const root = path.join(parent, "Notes App");
  expect(readFileSync(path.join(root, "README.md"), "utf8")).toContain("A tiny notes service");
  const overview = page.getByRole("region", { name: "Project overview" });
  await expect(overview).toContainText("Notes App");
  await expect(overview).toContainText("Created in Depo");

  // Memory: notes and a fact.
  await page.getByRole("tab", { name: "Memory" }).click();
  const memory = page.getByRole("region", { name: "Memory" });
  await expect(memory.getByLabel("Project memory notes (Markdown)")).toHaveValue(/A tiny notes service/);
  await memory.getByLabel("New memory item").fill("Notes are stored as Markdown files");
  await memory.getByRole("button", { name: "Add" }).click();
  await expect(memory.getByRole("list", { name: "Memory items" })).toContainText(
    "Notes are stored as Markdown files",
  );
  expect(await seriousA11yViolations(page)).toEqual([]);

  // Edit details.
  const row = projectsList(page).getByRole("listitem").filter({ hasText: "Notes App" });
  await row.hover();
  await row.getByRole("button", { name: "Actions for Notes App" }).click();
  await page.getByRole("menuitem", { name: "Edit details" }).click();
  const edit = page.getByRole("dialog", { name: "Edit project details" });
  await edit.getByLabel("Name").fill("Notes Service");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(projectsList(page)).toContainText("Notes Service");

  // Duplicate copies the folder and the memory.
  const svc = projectsList(page).getByRole("listitem").filter({ hasText: "Notes Service" });
  await svc.hover();
  await svc.getByRole("button", { name: "Actions for Notes Service" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Made a copy" })).toBeVisible();
  expect(existsSync(path.join(parent, "Notes App copy", "README.md"))).toBe(true);
  await page.getByRole("tab", { name: "Memory" }).click();
  await expect(memory.getByRole("list", { name: "Memory items" })).toContainText(
    "Notes are stored as Markdown files",
  );

  // Archive moves it out of the list; restore brings it back.
  await page.getByRole("tab", { name: "Project" }).click();
  await svc.hover();
  await svc.getByRole("button", { name: "Actions for Notes Service" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(projectsList(page)).not.toContainText("Notes Service");
  await page.getByRole("button", { name: /Archived \(1\)/ }).click();
  const archived = page.getByRole("list", { name: "Archived projects" });
  await expect(archived).toContainText("Notes Service");
  await archived.getByRole("listitem").hover();
  await archived.getByRole("button", { name: "Actions for Notes Service" }).click();
  await page.getByRole("menuitem", { name: "Restore from archive" }).click();
  await expect(projectsList(page)).toContainText("Notes Service");

  // Remove forgets the project but keeps its folder.
  const again = projectsList(page).getByRole("listitem").filter({ hasText: "Notes Service" });
  await again.hover();
  await again.getByRole("button", { name: "Actions for Notes Service" }).click();
  await page.getByRole("menuitem", { name: "Remove from Depo…" }).click();
  const confirm = page.getByRole("dialog", { name: /Remove Notes Service from Depo/ });
  await confirm.getByRole("button", { name: "Remove from Depo" }).click();
  await expect(confirm).toBeHidden();
  await expect(projectsList(page)).not.toContainText("Notes Service");
  expect(existsSync(path.join(root, "README.md"))).toBe(true);

  // The dashboard of the remaining copy passes an accessibility check.
  await openProject(page, "Notes App copy");
  await page.getByRole("tab", { name: "Project" }).click();
  await expect(page.getByRole("region", { name: "Project overview" })).toContainText("Notes App copy");
  expect(await seriousA11yViolations(page)).toEqual([]);
});
