import { test, expect, type Page } from "@playwright/test";

async function playableRecordingId(page: Page): Promise<number> {
  const res = await page.request.get("/api/search?q=pelican%20roof%20tiles");
  return (await res.json()).groups[0].interactionId as number;
}

test("edit a title inline and it persists", async ({ page }) => {
  const id = await playableRecordingId(page);
  await page.goto(`/r/${id}`);
  const title = page.getByTestId("title");
  await expect(title).toContainText("Pool house tile sample walkthrough");
  await title.click();
  const input = page.getByTestId("title-input");
  await input.fill("Pool house tiles — renamed in e2e");
  await input.press("Enter");
  await expect(page.getByTestId("title")).toContainText("renamed in e2e");
  await page.reload();
  await expect(page.getByTestId("title")).toContainText("Pool house tiles — renamed in e2e");
  // Put it back for the other tests.
  await page.getByTestId("title").click();
  await page.getByTestId("title-input").fill("Pool house tile sample walkthrough");
  await page.getByTestId("title-input").press("Enter");
  await expect(page.getByTestId("title")).toContainText("Pool house tile sample walkthrough");
});

test("approve a clip candidate", async ({ page }) => {
  const id = await playableRecordingId(page);
  // Both browser projects share the database: start from a known state.
  const me = await (await page.request.get("/api/auth/me")).json();
  const detail = await (await page.request.get(`/api/interactions/${id}`)).json();
  const seeded = detail.clips.find((c: { hook: string }) => c.hook.startsWith("Pelican tiles against stucco"));
  await page.request.patch(`/api/clips/${seeded.id}`, { data: { status: "new" }, headers: { "x-csrf-token": me.csrfToken } });
  await page.goto(`/r/${id}`);
  await page.getByRole("tab", { name: /Clips/ }).click();
  const clip = page.getByTestId("clip").filter({ hasText: "Pelican tiles against stucco" });
  await expect(clip).toHaveAttribute("data-status", "new");
  await clip.getByTestId("approve-clip").click();
  await expect(clip).toHaveAttribute("data-status", "approved");
  await expect(clip.getByTestId("clip-status")).toHaveText("approved");
  await page.reload();
  await page.getByRole("tab", { name: /Clips/ }).click();
  await expect(page.getByTestId("clip").filter({ hasText: "Pelican tiles against stucco" })).toHaveAttribute("data-status", "approved");
});

test("clicking a transcript line seeks the video; find-in-transcript counts matches", async ({ page }) => {
  const id = await playableRecordingId(page);
  await page.goto(`/r/${id}`);
  const video = page.getByTestId("video");
  await expect(video).toHaveAttribute("data-ready", "true");
  const line = page.locator("ol[aria-label=Transcript] li").filter({ hasText: "pelican roof tiles" });
  await line.getByRole("button").click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(41.5);
  await expect(page).toHaveURL(/t=42/);

  await page.getByTestId("find-open").click();
  await page.getByLabel("Find in transcript").fill("timeline");
  await expect(page.getByTestId("find-count")).toHaveText(/^[1-9]\d* \/ [1-9]\d*$/);
});

test("recording page has no horizontal overflow", async ({ page }) => {
  const id = await playableRecordingId(page);
  await page.goto(`/r/${id}?t=42`);
  await expect(page.getByTestId("video")).toBeVisible();
  for (const tab of ["People", "Facts", "Clips", "Details"]) {
    await page.getByRole("tab", { name: new RegExp(tab) }).click({ force: true });
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scrollWidth, tab).toBeLessThanOrEqual(clientWidth);
  }
});
