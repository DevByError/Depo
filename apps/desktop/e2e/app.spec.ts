import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("connects to the engine and shows live heartbeats", async ({ page }) => {
  await page.goto("");
  await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
  const feed = page.getByRole("log", { name: "Activity feed" });
  await expect(feed).toContainText("Engine 0.1.0 started");
  await expect(feed).toContainText("UI client");

  const pulse = page.getByTestId("heartbeat").first();
  await expect(pulse).toContainText(/Heartbeat (just now|\ds ago)/);

  // Heartbeats keep arriving: the uptime in the Engine panel increases.
  const uptime = page.locator("text=Uptime").locator("..");
  const first = await uptime.textContent();
  await expect.poll(async () => uptime.textContent(), { timeout: 8000 }).not.toBe(first);

  // The heartbeat filter shows the raw heartbeat events in the feed.
  await page.getByRole("button", { name: "Heartbeats" }).click();
  await expect(feed.locator('[data-event-type="heartbeat"]').first()).toBeVisible();
});

test("theme is saved in the engine and survives a reload", async ({ page }) => {
  await page.goto("");
  await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("keyboard shortcuts toggle panels and tabs are keyboard reachable", async ({ page }) => {
  await page.goto("");
  await expect(page.getByRole("region", { name: "Bottom panel" })).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("region", { name: "Bottom panel" })).toBeHidden();
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("region", { name: "Bottom panel" })).toBeVisible();

  await page.getByRole("tab", { name: "Chat" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel").filter({ hasText: "Arrives in Phase 1" })).toBeVisible();

  await page.keyboard.press("Control+,");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  test(`has no serious accessibility violations (${theme})`, async ({ page }) => {
    await page.goto("");
    await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
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
