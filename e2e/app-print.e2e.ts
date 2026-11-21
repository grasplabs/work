import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import { tallyFiles } from "./tally-app.ts";

// An App's page, printed: the page alone, without Grasp's bar over it
// (apps/web/src/pages/page-frame.tsx), its frame filling one sheet of A4,
// and in the light theme's colours, as paper is light, though printed
// from the dark theme.

/** A sheet of A4 in CSS pixels, as a PDF of it has no margins. */
const a4 = { width: 794, height: 1123 };

/** The pages in a PDF: its page objects, not the page tree (`/Pages`). */
const pageObject = /\/Type\s*\/Page(?![a-z])/gu;

test("someone prints an App's page: the page alone, on one sheet, in light colours", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("appPrint");
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({
      name: `Tally ${crypto.randomUUID().slice(0, 8)}`,
    }));
    await release(api, app, tallyFiles("in the App"));
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator('iframe[title="App"]');
  // The first open builds it, which takes a while on a loaded machine.
  await expect(appPage.getByRole("status")).toHaveText("0 in the App", {
    timeout: 30_000,
  });
  await expect(page.getByText("App page")).toBeVisible();

  await page.setViewportSize(a4);
  await page.emulateMedia({ media: "print" });
  await expect(page.getByText("App page")).toBeHidden();
  await expect(appPage.getByRole("status")).toBeVisible();
  const frame = page
    .frames()
    .find((each) => each.url().includes("/page-frame"));
  const fit = await frame?.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    room: window.innerHeight,
  }));
  expect(fit?.room).toBe(a4.height);
  expect(fit?.height).toBeLessThanOrEqual(a4.height);
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  expect(pdf.toString("latin1").match(pageObject)).toHaveLength(1);

  const colours = async () =>
    await frame?.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      background: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
    }));
  const light = await colours();
  await page.emulateMedia({ media: "print", colorScheme: "dark" });
  await expect
    .poll(async () => {
      const now = await colours();
      return now?.dark;
    })
    .toBeTruthy();
  expect(await colours()).toStrictEqual({ ...light, dark: true });
});
