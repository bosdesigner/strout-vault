import { test, expect } from "@playwright/test";

test("search a seeded phrase, open the hit and land on the right second with the video seeked", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("recording-card").first()).toBeVisible(); // app mounted, key handler attached
  await page.keyboard.press("/");
  const box = page.getByRole("searchbox", { name: "Search transcripts" }).first();
  await expect(box).toBeFocused();
  await box.fill("pelican roof tiles");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=pelican/);

  const groups = page.getByTestId("search-group");
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toContainText("Pool house tile sample walkthrough");
  const line = page.getByTestId("search-line").first();
  await expect(line.locator("mark").first()).toHaveText(/pelican/i);
  await expect(line).toContainText("0:42");

  await line.click();
  await expect(page).toHaveURL(/\/r\/\d+\?t=42$/);

  const video = page.getByTestId("video");
  await expect(video).toHaveAttribute("data-ready", "true");
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThanOrEqual(41.5);
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(44);

  const active = page.locator("ol[aria-label=Transcript] li[data-active]");
  await expect(active).toHaveCount(1);
  await expect(active).toContainText("pelican roof tiles");
});

test("phrase, OR and exclusion syntax", async ({ page }) => {
  await page.goto(`/search?q=${encodeURIComponent('"gutters copper"')}`);
  await expect(page.getByText("No matches")).toBeVisible();
  await page.goto(`/search?q=${encodeURIComponent("skylight OR dormer")}`);
  await expect(page.getByTestId("search-group").first()).toBeVisible();
  await page.goto(`/search?q=${encodeURIComponent("shutters -cedar")}`);
  const groups = page.getByTestId("search-group");
  await expect(groups.first()).toBeVisible();
  const text = (await page.getByTestId("search-results").innerText()).toLowerCase();
  expect(text).not.toContain("cedar");
});
