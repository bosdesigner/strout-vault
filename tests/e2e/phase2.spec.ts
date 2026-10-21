import { test, expect, type Page } from "@playwright/test";

async function csrf(page: Page): Promise<string> {
  return (await (await page.request.get("/api/auth/me")).json()).csrfToken as string;
}

test.describe("people", () => {
  test("list shows role chips per workspace and filters by role and workspace", async ({ page }) => {
    await page.goto("/people");
    const rows = page.getByTestId("person-row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(16);
    const kevin = rows.filter({ hasText: "Kevin McGuire" });
    await expect(kevin).toContainText("Another Story · contractor · Houston (Conroe)");

    await page.getByLabel("Role").click();
    await page.getByRole("option", { name: "contractor" }).click();
    await expect(page).toHaveURL(/role=contractor/);
    await expect.poll(() => rows.count()).toBe(3);

    // The workspace switcher scopes the list too.
    const switcher = page.getByTestId("workspace-switcher").filter({ visible: true });
    await switcher.click();
    await page.getByRole("option", { name: "Strout Architecture" }).click();
    await expect.poll(() => rows.count()).toBe(1);
    await expect(rows.first()).toContainText("Carlos Mendes");
    await switcher.click();
    await page.getByRole("option", { name: "All workspaces" }).click();
  });

  test("person page: edit contact fields, add a role, see timeline and open facts", async ({ page }) => {
    await page.goto("/people?q=Tom");
    await page.getByTestId("person-row").filter({ hasText: "Tom Ashworth" }).click();
    await expect(page).toHaveURL(/\/p\/\d+$/);
    await expect(page.getByTestId("person-name")).toContainText("Tom Ashworth");
    await expect(page.getByRole("heading", { name: /Timeline/ })).toBeVisible();

    await page.getByTestId("edit-contact").click();
    await page.getByLabel("Location").fill("The Woodlands, TX (edited)");
    await page.getByTestId("save-contact").click();
    await expect(page.getByText("The Woodlands, TX (edited)").first()).toBeVisible();
    await page.reload();
    await expect(page.getByText("The Woodlands, TX (edited)").first()).toBeVisible();

    await page.getByTestId("add-role").click();
    const roleForm = page.locator("form").filter({ has: page.getByTestId("save-role") });
    await roleForm.getByLabel("Workspace").click();
    await page.getByRole("option", { name: "Strout Architecture" }).click();
    await roleForm.getByLabel("Role", { exact: true }).click();
    await page.getByRole("option", { name: "prospect" }).click();
    await page.getByTestId("save-role").click();
    await expect(page.getByTestId("role-row").filter({ hasText: "Strout Architecture" })).toContainText("prospect");
  });
});

test.describe("projects", () => {
  test("list and detail with parties, recordings and facts", async ({ page }) => {
    await page.goto("/projects");
    const cards = page.getByTestId("project-card");
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(6);
    await cards.filter({ hasText: "Heights Bungalow Addition" }).click();
    await expect(page.getByTestId("project-name")).toContainText("Heights Bungalow Addition");
    await expect(page.getByRole("link", { name: "Maria Delgado" }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /Recordings/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Facts/ })).toBeVisible();
  });
});

test.describe("review queue", () => {
  test("approve with the keyboard applies the participant match", async ({ page }) => {
    await page.goto("/review");
    const items = page.getByTestId("review-item");
    await expect(items.first()).toBeVisible();
    const first = items.first();
    const reason = (await first.getByTestId("review-reason").innerText()).trim();
    expect(reason).toMatch(/^Speaker \d is probably .+ \(\d\.\d\d\)$/);
    const momentHref = await first.getByTestId("review-moment").getAttribute("href");
    expect(momentHref).toMatch(/^\/r\/\d+\?t=\d+$/);
    const interactionId = Number(momentHref!.match(/\/r\/(\d+)/)![1]);
    const personName = reason.match(/probably (.+) \(/)![1];
    const label = reason.match(/^(Speaker \d)/)![1];

    // j moves the selection down and k back up; a approves the selected item.
    await expect(first).toHaveAttribute("data-selected", "true");
    await page.keyboard.press("j");
    await expect(items.nth(1)).toHaveAttribute("data-selected", "true");
    await page.keyboard.press("k");
    await expect(first).toHaveAttribute("data-selected", "true");
    const before = await items.count();
    await page.keyboard.press("a");
    await expect.poll(() => items.count()).toBe(before - 1);
    await expect(page.getByTestId("review-reason").filter({ hasText: reason })).toHaveCount(0);

    const rec = await (await page.request.get(`/api/interactions/${interactionId}`)).json();
    expect(rec.participants.some((p: { name: string; speakerLabel: string | null }) => p.name === personName && p.speakerLabel === label)).toBe(true);
    const lines = (await (await page.request.get(`/api/interactions/${interactionId}/segments`)).json()).lines as Array<{ speaker: string; speakerPartyId: number | null }>;
    expect(lines.filter((l) => l.speaker === label).every((l) => l.speakerPartyId != null)).toBe(true);

    // r rejects the next one.
    const second = (await items.first().getByTestId("review-reason").innerText()).trim();
    await page.keyboard.press("r");
    await expect(page.getByTestId("review-reason").filter({ hasText: second })).toHaveCount(0);
  });
});

test.describe("recording page tagging", () => {
  test("tag a participant with a speaker label and link a project", async ({ page }) => {
    // Find a recording with an unassigned speaker label.
    const token = await csrf(page);
    const lib = await (await page.request.get("/api/interactions?source=upload&limit=50")).json();
    let target: { id: number; label: string } | null = null;
    for (const it of lib.items) {
      const sp = (await (await page.request.get(`/api/interactions/${it.id}/speakers`)).json()).items as Array<{ label: string; partyId: number | null }>;
      const free = sp.find((s) => s.partyId === null);
      if (free) {
        target = { id: it.id, label: free.label };
        break;
      }
    }
    expect(target).not.toBeNull();
    expect(token).toBeTruthy();
    // A fresh project in the recording's workspace, so there is always one to link.
    const rec = await (await page.request.get(`/api/interactions/${target!.id}`)).json();
    const projectName = `E2E link test ${Date.now()}`;
    const created = await page.request.post("/api/projects", { data: { workspaceId: rec.workspace?.id ?? "another_story", name: projectName }, headers: { "x-csrf-token": token } });
    expect(created.status()).toBe(201);

    await page.goto(`/r/${target!.id}`);
    await page.getByRole("tab", { name: /People/ }).click({ force: true });
    const form = page.getByTestId("tag-person");
    await form.getByRole("combobox", { name: /Who else/i }).fill("Rachel");
    await page.getByRole("option", { name: /Rachel Kim/ }).click();
    await form.getByLabel("Speaker label").click();
    await page.getByRole("option", { name: new RegExp(`^${target!.label} ·`) }).click();
    await page.getByTestId("tag-person-save").click();
    await expect(page.getByRole("link", { name: "Rachel Kim" }).first()).toBeVisible();
    await expect(form).toContainText(/\d+ transcript lines assigned/);

    await page.getByLabel("Project to link").click();
    await page.getByRole("option", { name: new RegExp(projectName) }).click();
    await page.getByTestId("link-project-save").click();
    await expect(page.getByTestId("linked-projects")).toContainText(projectName);
    await page.reload();
    await page.getByRole("tab", { name: /People/ }).click({ force: true });
    await expect(page.getByTestId("linked-projects")).toContainText(projectName);
  });
});
