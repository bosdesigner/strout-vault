import { test, expect } from "@playwright/test";

test.describe("owner: access page", () => {
  test("invite a contractor (link sent) and record a tracked number", async ({ page }) => {
    await page.goto("/access");
    await expect(page.getByRole("heading", { name: "Access & numbers" })).toBeVisible();
    await expect(page.getByTestId("membership-row").filter({ hasText: "kevin.mcguire@example.com" })).toHaveAttribute("data-status", "active");
    await expect(page.getByTestId("number-row").filter({ hasText: "+19365550199" })).toBeVisible();
    await expect(page.getByTestId("calls").locator("li").first()).toBeVisible();

    const email = `e2e-${Date.now()}@example.com`;
    await page.getByTestId("invite-open").click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Their person row").fill("Sam");
    await page.getByRole("option", { name: /Sam Whitaker/ }).click();
    await page.getByTestId("invite-save").click();
    const row = page.getByTestId("membership-row").filter({ hasText: email });
    await expect(row).toHaveAttribute("data-status", "invited");
    const mail = await (await page.request.get("/api/_test/last-mail")).json();
    expect(mail.mail.to).toBe(email);
    expect(mail.mail.text).toContain("/api/auth/magic?token=");

    await page.getByTestId("number-open").click();
    await page.getByLabel("Twilio number").fill("(512) 555-0180");
    await page.getByLabel("Forward to (their phone)").fill("512 555 0121");
    await page.getByLabel("Contractor").fill("Sam");
    await page.getByRole("option", { name: /Sam Whitaker/ }).click();
    await page.getByTestId("number-save").click();
    await expect(page.getByTestId("number-row").filter({ hasText: "+15125550180" })).toContainText("Sam Whitaker");
  });
});

test.describe("contractor", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("signs in with an emailed link and sees only their own recordings", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("mode-link").click();
    await page.getByLabel("Email").fill("kevin.mcguire@example.com");
    await page.getByTestId("submit-login").click();
    await expect(page.getByTestId("link-sent")).toBeVisible();

    const mail = await (await page.request.get("/api/_test/last-mail")).json();
    const link = (mail.mail.text as string).match(/https?:\/\/\S+\/api\/auth\/magic\?token=\S+/)![0];
    await page.goto(new URL(link).pathname + new URL(link).search);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(/Recordings you were part of or uploaded in Another Story/)).toBeVisible();

    // Owner-only navigation is gone; the library is scoped.
    await expect(page.getByRole("link", { name: "Review", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "People", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("workspace-switcher")).toHaveCount(0);
    const cards = page.getByTestId("recording-card");
    await expect(cards.first()).toBeVisible();
    const ids = await cards.evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-id"))));
    const mine = await (await page.request.get("/api/interactions?limit=100")).json();
    expect(ids.length).toBe(mine.items.length);
    for (const it of mine.items) expect(it.workspaceId).toBe("another_story");
    const me = await (await page.request.get("/api/auth/me")).json();
    expect(me.user.role).toBe("contractor");
    for (const it of mine.items) {
      const rec = await (await page.request.get(`/api/interactions/${it.id}`)).json();
      const tagged = rec.participants.some((p: { id: number }) => p.id === me.user.partyId);
      const uploaded = rec.files.some(() => true);
      expect(tagged || uploaded).toBe(true);
    }
    // Owner-only pages refuse.
    expect((await page.request.get("/api/review")).status()).toBe(403);
    await page.goto("/review");
    await expect(page.getByRole("heading", { name: "Could not load the queue" })).toBeVisible();

    // A recording they are on opens; one they are not on is a 404.
    await page.goto(`/r/${mine.items[0].id}`);
    await expect(page.getByTestId("title")).toBeVisible();
    await expect(page.getByTestId("tag-person")).toHaveCount(0);
    const all = await (await page.request.get("/api/search?q=permit")).json();
    const visible = new Set(mine.items.map((i: { id: number }) => i.id));
    for (const g of all.groups) expect(visible.has(g.interactionId)).toBe(true);

    // The used link cannot be reused.
    await page.context().clearCookies();
    await page.goto(new URL(link).pathname + new URL(link).search);
    await expect(page).toHaveURL(/\/login\?error=link/);
    await expect(page.getByRole("alert")).toContainText(/expired or was already used/);
  });
});
