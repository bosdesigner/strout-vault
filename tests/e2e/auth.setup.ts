import { test as setup, expect } from "@playwright/test";

export const EMAIL = "e2e@strout.local";
export const PASSWORD = "e2e-password-123";

setup("log in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);

  // A wrong password is refused with a visible message.
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText(/wrong email or password/i);

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await page.context().storageState({ path: ".data/e2e-auth.json" });
});
