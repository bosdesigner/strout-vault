import { test, expect } from "@playwright/test";

test.describe("owner: clips", () => {
  test("reviews candidates with the keyboard and sees approved and finished tabs", async ({ page }) => {
    await page.goto("/clips");
    await expect(page.getByRole("heading", { name: "Clips" })).toBeVisible();

    // The seed ships candidates waiting for review, best score first. Counts are read rather than assumed:
    // the desktop and phone projects share one database, so an earlier run may already have reviewed some.
    const toReview = page.getByTestId("clips-tab-new");
    const items = page.getByTestId("clip-item");
    await expect(items.first()).toBeVisible();
    const initial = await items.count();
    expect(initial).toBeGreaterThanOrEqual(3);
    await expect(toReview).toContainText(String(initial));
    const approvedBefore = Number((await page.getByTestId("clips-tab-approved").textContent())?.replace(/\D/g, "") ?? "0");
    const scores = await items.locator("span", { hasText: /^score \d+$/ }).allTextContents();
    const nums = scores.map((s) => Number(s.replace("score ", "")));
    expect(nums).toEqual([...nums].sort((a, b) => b - a));
    await expect(items.first()).toContainText("“");

    // Approve the first with the keyboard: it leaves this list and the Approved count grows.
    const firstHook = await items.first().locator("p.font-medium").textContent();
    await page.keyboard.press("a");
    await expect(items).toHaveCount(initial - 1);
    await expect(toReview).toContainText(String(initial - 1));
    await expect(page.getByTestId("clips-tab-approved")).toContainText(String(approvedBefore + 1));

    await page.getByTestId("clips-tab-approved").click();
    await expect(page.getByTestId("clip-item").first()).toContainText("the worker renders it on its next run");
    // The seed repeats a hook across recordings, so "at least one" rather than exactly one.
    expect(await page.getByTestId("clip-item").filter({ hasText: firstHook ?? "" }).count()).toBeGreaterThanOrEqual(1);

    await page.getByTestId("clips-tab-cut").click();
    await expect(page.getByText("No finished clips yet")).toBeVisible();

    // Skipping from the review list moves one out as well.
    await page.getByTestId("clips-tab-new").click();
    await page.getByTestId("skip").first().click();
    await expect(page.getByTestId("clip-item")).toHaveCount(initial - 2);
  });

  test("the recording page shows candidates and the clips link opens the moment", async ({ page }) => {
    await page.goto("/clips");
    const link = page.getByTestId("clip-item").first().getByRole("link").first();
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/r\/\d+\?t=\d+$/);
    await link.click();
    await expect(page).toHaveURL(/\/r\/\d+\?t=\d+$/);
    await page.getByRole("tab", { name: /Clips/ }).click({ force: true });
    await expect(page.getByTestId("clip").first()).toBeVisible();
  });
});

test.describe("contractor", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("cannot read or change clips", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("mode-link").click();
    await page.getByLabel("Email").fill("kevin.mcguire@example.com");
    await page.getByTestId("submit-login").click();
    const mail = await (await page.request.get("/api/_test/last-mail")).json();
    const link = String(mail.mail.text).match(/https?:\/\/\S+\/api\/auth\/magic\?token=[^\s)]+/)?.[0];
    expect(link).toBeTruthy();
    await page.goto(new URL(link!).pathname + new URL(link!).search);
    await expect(page).toHaveURL(/\/$/);
    expect((await page.request.get("/api/clips")).status()).toBe(403);
    await expect(page.getByRole("link", { name: "Clips" })).toHaveCount(0);
  });
});
