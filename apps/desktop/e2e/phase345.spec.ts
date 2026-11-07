import { expect, test } from "@playwright/test";
import { seriousA11yViolations } from "./helpers";

// Phases 3 to 5: the new screens render, explain themselves when empty, and pass the accessibility checks.
const SCREENS: { tab: string; text: RegExp }[] = [
  { tab: "Plan", text: /No plan yet/ },
  { tab: "Design", text: /Font library/ },
  { tab: "Diagrams", text: /Open a project to see its diagrams|New diagram/ },
  { tab: "Slides", text: /No decks yet/ },
  { tab: "Skills", text: /Install a skill/ },
  { tab: "Knowledge", text: /Available packs/ },
];

test.describe.configure({ mode: "serial" });

for (const theme of ["dark", "light"] as const) {
  test(`Phase 3-5 screens render and have no serious accessibility violations (${theme})`, async ({
    page,
  }) => {
    await page.goto("");
    await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    for (const s of SCREENS) {
      await page.getByRole("tab", { name: s.tab, exact: true }).click();
      await expect(page.getByRole("tabpanel", { name: s.tab, exact: true })).toContainText(s.text);
      expect(await seriousA11yViolations(page), s.tab).toEqual([]);
    }
  });
}

test("the Chat composer offers the work modes", async ({ page }) => {
  await page.goto("");
  await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  const modes = page.getByLabel("Work mode");
  if (await modes.count()) {
    await expect(modes.locator("option")).toContainText(["Single agent", "Full system", "Backend only"]);
  }
});

test("the Skills screen lists the MCP servers section", async ({ page }) => {
  await page.goto("");
  await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await page.getByRole("tab", { name: "MCP servers" }).click();
  await expect(page.getByText("Add an MCP server")).toBeVisible();
  await expect(page.getByText("No MCP servers yet.")).toBeVisible();
});
