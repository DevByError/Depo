import { expect, test } from "@playwright/test";
import { fixtureCopy, seriousA11yViolations, useFakeOllamaAsCoder } from "./helpers";

test.describe.configure({ mode: "serial" });

test("a pasted picture is read into colours with roles and shown under the message", async ({ page }) => {
  test.setTimeout(120_000);
  const project = fixtureCopy();

  await page.goto("");
  await expect(page.getByTestId("connection-status")).toHaveText(/Engine connected/);
  await useFakeOllamaAsCoder(page);
  // The scripted model also plays the vision role, chosen by hand (an Auto-Fit pick must look able to see).
  const vision = page
    .getByRole("region", { name: "Auto-Fit plan" })
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Vision", exact: true }) })
    .getByLabel("Use");
  await vision.selectOption({ label: "qwen2.5-coder:1.5b · ollama" });
  await expect(vision).toHaveValue(/qwen2\.5-coder/);
  await page.getByRole("button", { name: "Open a project folder", exact: true }).click();
  await page.getByLabel("Project folder path").fill(project);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("list", { name: "Projects", exact: true })).toContainText("fastapi-demo");

  // A small dark dashboard drawn in the page: background, a card, text lines and a teal button.
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 400;
    const g = c.getContext("2d") as CanvasRenderingContext2D;
    g.fillStyle = "#0b1220";
    g.fillRect(0, 0, 640, 400);
    g.fillStyle = "#111a2e";
    g.fillRect(300, 40, 300, 180);
    g.fillStyle = "#e5ecf6";
    for (let y = 60; y < 160; y += 20) g.fillRect(320, y, 200, 6);
    g.fillStyle = "#14b8a6";
    g.fillRect(320, 170, 110, 34);
    return c.toDataURL("image/png");
  });
  const buffer = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");

  await page.getByRole("tab", { name: "Chat" }).click();
  await page
    .getByLabel("Choose pictures")
    .setInputFiles({ name: "dashboard.png", mimeType: "image/png", buffer });
  await expect(page.getByRole("button", { name: "Remove dashboard.png" })).toBeVisible();
  await expect(page.getByLabel("Message the coding agent")).toHaveAttribute(
    "placeholder",
    "Say what to build with this look, or just send",
  );
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Remove dashboard.png" })).toHaveCount(0);

  // Under the message: the picture, then the measured colours once Depo has read it.
  const convo = page.getByRole("list", { name: "Conversation" });
  await expect(convo).toContainText("Use the same UI/UX and theme as the attached reference.");
  const refs = convo.getByRole("list", { name: "Design references" });
  const colours = refs.getByRole("list", { name: "Colours" });
  const swatch = (role: string) => colours.getByRole("listitem").filter({ hasText: role });
  await expect(swatch("Background")).toContainText("#0b1220", { timeout: 60_000 });
  await expect(swatch("Surface")).toContainText("#111a2e");
  await expect(swatch("Primary")).toContainText("#14b8a6");
  // The scripted model plays the vision role, so its notes are under "What Depo saw".
  const saw = refs.getByRole("button", { name: "What Depo saw" });
  await expect(saw).toHaveAttribute("aria-expanded", "false");
  await saw.click();
  await expect(refs).toContainText("Left sidebar navigation");

  const show = refs.getByRole("button", { name: "Show dashboard.png" });
  await expect(show).toBeEnabled();
  await show.click();
  await expect(page.getByRole("dialog", { name: "dashboard.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "dashboard.png" })).toHaveCount(0);

  // The scripted model answers, so the task ends before the next spec starts.
  await expect(convo).toContainText("I can only run the scripted /health demo", { timeout: 60_000 });
  expect(await seriousA11yViolations(page)).toEqual([]);
});
