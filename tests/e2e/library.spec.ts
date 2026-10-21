import { test, expect } from "@playwright/test";

test.describe("library", () => {
  test("shows recordings newest first and filters by year", async ({ page }) => {
    await page.goto("/");
    const cards = page.getByTestId("recording-card");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(12);

    const dates = await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-date") ?? ""));
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);

    // Generic titles show a preview line underneath.
    const generic = page.getByTestId("recording-card").filter({ hasText: "Personal Meeting Room" }).first();
    await expect(generic).toBeVisible();
    expect((await generic.innerText()).split("\n").length).toBeGreaterThan(3);

    // Filter by year through the Year select.
    await page.getByLabel("Year").click();
    await page.getByRole("option", { name: "2024" }).click();
    await expect(page).toHaveURL(/from=2024-01-01/);
    await expect(cards.first()).toBeVisible();
    const yearDates = await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-date") ?? ""));
    expect(yearDates.length).toBeGreaterThan(0);
    for (const d of yearDates) expect(d.startsWith("2024")).toBe(true);

    // Clearing filters brings everything back.
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(count);
  });

  test("never scrolls sideways", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("recording-card").first()).toBeVisible();
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
