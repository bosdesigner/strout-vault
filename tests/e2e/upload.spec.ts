import path from "node:path";
import { test, expect } from "@playwright/test";

const FIXTURE = path.resolve("tests/e2e/fixtures/upload-test.mp4");

test.describe.serial("upload", () => {
  test("upload a real video file and the rows exist", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("upload-button").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("file-input").setInputFiles(FIXTURE);
    const row = page.getByTestId("upload-row");
    await expect(row).toHaveAttribute("data-status", "ready");

    await dialog.getByLabel("Title").fill("E2E uploaded call");
    await dialog.getByLabel("Source").click();
    await page.getByRole("option", { name: "Phone call" }).click();
    await dialog.getByLabel("Workspace").click();
    await page.getByRole("option", { name: "Another Story" }).click();
    await dialog.getByLabel("People").fill("Kevin");
    await page.getByRole("option", { name: /Kevin McGuire/ }).click();

    await page.getByTestId("start-upload").click();
    await expect(row).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    const link = row.getByRole("link", { name: "Open" });
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/r\/\d+$/);
    const id = Number(href!.split("/").pop());

    const detail = await (await page.request.get(`/api/interactions/${id}`)).json();
    expect(detail.title).toBe("E2E uploaded call");
    expect(detail.source).toBe("iphone_call");
    expect(detail.pipelineStatus).toBe("queued");
    expect(detail.workspace.id).toBe("another_story");
    expect(detail.participants.map((p: { name: string }) => p.name)).toEqual(["Kevin McGuire"]);
    expect(detail.files).toHaveLength(1);
    expect(detail.files[0]).toMatchObject({ storage: "local", role: "original", status: "verified" });
    expect(detail.files[0].storageKey).toMatch(/^uploads\/\d{4}\/\d{2}\/[0-9a-f-]{36}\/upload-test\.mp4$/);
    expect(detail.jobs.map((j: { stage: string; status: string }) => `${j.stage}:${j.status}`).sort()).toEqual(["extract:pending", "transcribe:pending"]);

    // The new recording shows in the library with a status chip.
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/r/${id}$`));
    await page.goto("/");
    const card = page.getByTestId("recording-card").filter({ hasText: "E2E uploaded call" });
    await expect(card).toBeVisible();
    await expect(card.locator("[data-status=queued]")).toBeVisible();
  });

  test("re-uploading the same file is refused as a duplicate", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("upload-button").click();
    await page.getByTestId("file-input").setInputFiles(FIXTURE);
    const row = page.getByTestId("upload-row");
    await expect(row).toHaveAttribute("data-status", "duplicate");
    await expect(row.getByTestId("duplicate-notice")).toContainText("Already in the vault: E2E uploaded call");
    await expect(page.getByTestId("start-upload")).toBeDisabled();
    await row.getByTestId("duplicate-notice").getByRole("link").click();
    await expect(page).toHaveURL(/\/r\/\d+$/);
    await expect(page.getByTestId("title")).toContainText("E2E uploaded call");
  });
});
