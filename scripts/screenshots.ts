// Screenshots of every Phase 1 page at desktop (1440) and iPhone (390) widths.
//   npm run screenshots            (expects the dev server on BASE_URL, default http://localhost:3000)
// Credentials: SCREENSHOT_EMAIL / SCREENSHOT_PASSWORD (default: the dev login written by db:local).
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.SCREENSHOT_EMAIL ?? "dev@strout.local";
const PASSWORD = process.env.SCREENSHOT_PASSWORD ?? "vault-dev-password";
const PHASE = process.env.SCREENSHOT_PHASE ?? "phase-1";
const OUT = path.resolve(`docs/screenshots/${PHASE}`);
fs.mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: "1440", width: 1440, height: 900, mobile: false },
  { name: "390", width: 390, height: 844, mobile: true },
];

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function shoot(page: Page, name: string, size: (typeof SIZES)[number], opts: { fullPage?: boolean } = {}) {
  const file = path.join(OUT, `${name}-${size.name}.png`);
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  const flag = sw > size.width ? `  <-- horizontal overflow: scrollWidth ${sw}` : "";
  console.log(`${path.relative(process.cwd(), file)}${flag}`);
}

async function runPhase2(browser: Browser) {
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.mobile ? 2 : 1, isMobile: size.mobile, hasTouch: size.mobile });
    const page = await ctx.newPage();
    await login(page);
    await page.goto(`${BASE}/people`);
    await page.getByTestId("person-row").first().waitFor();
    await settle(page);
    await shoot(page, "people", size);
    await page.goto(`${BASE}/people?role=contractor`);
    await page.getByTestId("person-row").first().waitFor();
    await settle(page);
    await shoot(page, "people-filtered", size);
    const kevin = await (await page.request.get(`${BASE}/api/parties?q=Kevin`)).json();
    await page.goto(`${BASE}/p/${kevin.items[0].id}`);
    await page.getByTestId("person-name").waitFor();
    await settle(page);
    await shoot(page, "person", size);
    await page.goto(`${BASE}/projects`);
    await page.getByTestId("project-card").first().waitFor();
    await settle(page);
    await shoot(page, "projects", size);
    const heights = await (await page.request.get(`${BASE}/api/projects?q=Heights`)).json();
    await page.goto(`${BASE}/projects/${heights.items[0].id}`);
    await page.getByTestId("project-name").waitFor();
    await settle(page);
    await shoot(page, "project", size);
    await page.goto(`${BASE}/review`);
    await page.getByTestId("review-item").first().waitFor();
    await settle(page);
    await shoot(page, "review", size);
    const hit = (await (await page.request.get(`${BASE}/api/search?q=pelican%20roof%20tiles`)).json()).groups[0];
    await page.goto(`${BASE}/r/${hit.interactionId}`);
    await page.getByTestId("video").waitFor();
    await page.getByRole("tab", { name: /People/ }).click({ force: true });
    await settle(page);
    await shoot(page, "recording-people", size);
    await page.goto(`${BASE}/`);
    await page.getByTestId("recording-card").first().waitFor();
    await page.getByTestId("workspace-switcher").filter({ visible: true }).click();
    await page.getByRole("option", { name: "Strout Architecture" }).click();
    await page.getByTestId("recording-card").first().waitFor();
    await settle(page);
    await shoot(page, "library-workspace", size);
    await ctx.close();
  }
}

async function run(browser: Browser) {
  if (PHASE === "phase-2") return runPhase2(browser);
  // Find a playable recording and a search hit to link to.
  const ctx0 = await browser.newContext();
  const p0 = await ctx0.newPage();
  await login(p0);
  const search = await p0.request.get(`${BASE}/api/search?q=pelican%20roof%20tiles`);
  const hit = (await search.json()).groups[0];
  const recId = hit.interactionId as number;
  const t = Math.floor(hit.lines[0].startSec as number);
  const people = await (await p0.request.get(`${BASE}/api/parties?q=Kevin`)).json();
  const personId = people.items[0].id as number;
  await ctx0.close();

  for (const size of SIZES) {
    for (const dark of [false, true]) {
      if (dark && size.mobile) continue; // dark mode shown at desktop width only
      const suffix = dark ? "-dark" : "";
      const ctx = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.mobile ? 2 : 1,
        isMobile: size.mobile,
        hasTouch: size.mobile,
        colorScheme: dark ? "dark" : "light",
      });
      const page = await ctx.newPage();

      await page.goto(`${BASE}/login`);
      await settle(page);
      if (!dark) await shoot(page, "login", size);

      await login(page);
      await page.goto(`${BASE}/`);
      await page.getByTestId("recording-card").first().waitFor();
      await settle(page);
      await shoot(page, `library${suffix}`, size);

      if (!dark) {
        await page.goto(`${BASE}/?from=2024-01-01&to=2024-12-31&source=zoom`);
        await page.getByTestId("recording-card").first().waitFor();
        await settle(page);
        await shoot(page, "library-filtered", size);
      }

      await page.goto(`${BASE}/r/${recId}?t=${t}`);
      await page.getByTestId("video").waitFor();
      await page.locator("ol[aria-label=Transcript] li").first().waitFor();
      await settle(page);
      await shoot(page, `recording${suffix}`, size);

      if (!dark) {
        await page.getByRole("tab", { name: /Clips/ }).click({ force: true });
        await settle(page);
        await shoot(page, "recording-clips", size);
        await page.getByRole("tab", { name: /Details/ }).click({ force: true });
        await settle(page);
        await shoot(page, "recording-details", size);
      }

      await page.goto(`${BASE}/search?q=${encodeURIComponent('"copper gutters"')}`);
      await page.getByTestId("search-group").first().waitFor();
      await settle(page);
      await shoot(page, `search${suffix}`, size);

      if (!dark) {
        await page.goto(`${BASE}/`);
        await page.getByTestId("recording-card").first().waitFor();
        await page.getByTestId("upload-button").click();
        await page.getByRole("dialog").waitFor();
        await settle(page);
        await shoot(page, "upload", size);
        // With a file queued (uses the e2e fixture so the form fields show).
        await page.getByTestId("file-input").setInputFiles("tests/e2e/fixtures/upload-test.mp4");
        await page.getByTestId("upload-row").waitFor();
        await page.waitForFunction(() => document.querySelector('[data-testid=upload-row]')?.getAttribute("data-status") !== "hashing");
        await settle(page);
        await shoot(page, "upload-queued", size);

        await page.goto(`${BASE}/p/${personId}`);
        await page.getByRole("heading", { level: 1 }).waitFor();
        await settle(page);
        await shoot(page, "person", size);
      }
      await ctx.close();
    }
  }
}

const browser = await chromium.launch();
try {
  await run(browser);
} finally {
  await browser.close();
}
