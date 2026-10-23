import { test, expect } from "@playwright/test";

test.describe("owner: pipeline page", () => {
  test("shows the worker's status, the queue and what is waiting", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Pipeline" }).click();
    await expect(page).toHaveURL(/\/pipeline$/);
    await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();

    // A fresh database: the worker has never run, Zoom and Groq are not configured.
    await expect(page.getByText("No runs yet")).toBeVisible();
    await expect(page.getByText("not configured")).toBeVisible();
    await expect(page.getByTestId("queue-counts")).toContainText(/\d+ queued · \d+ transcribing/);

    // The seed carries demo recordings in every pipeline state.
    await expect(page.getByTestId("waiting-item").first()).toBeVisible();
    await expect(page.getByTestId("failed-item").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /Without an off-site copy/ })).toBeVisible();
  });
});

test.describe("contractor", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("cannot read the pipeline", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("mode-link").click();
    await page.getByLabel("Email").fill("kevin.mcguire@example.com");
    await page.getByTestId("submit-login").click();
    const mail = await (await page.request.get("/api/_test/last-mail")).json();
    const link = String(mail.mail.text).match(/https?:\/\/\S+\/api\/auth\/magic\?token=[^\s)]+/)?.[0];
    expect(link).toBeTruthy();
    await page.goto(new URL(link!).pathname + new URL(link!).search);
    await expect(page).toHaveURL(/\/$/);
    const res = await page.request.get("/api/pipeline");
    expect(res.status()).toBe(403);
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Pipeline" })).toHaveCount(0);
  });
});
