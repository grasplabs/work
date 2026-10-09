import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { pageOf, peopleIn } from "./people.ts";

// What a page does when the files it needs can't be fetched. After a new
// release, the script files of a tab left open are gone: trying again
// loads Grasp anew, on the new release. When not even the words can be
// fetched, the start says so in English, with a way to try again.

/** Whether the tab still runs the document it had: false once it loaded anew. */
const sameDocument = async (page: Page): Promise<boolean> =>
  await page.evaluate(() => document.documentElement.dataset.marked === "yes");

test("a page whose file is gone after a release loads Grasp anew on Try again", async ({
  browser,
}) => {
  const { member } = peopleIn("pageRecovery");
  const page = await pageOf(browser, member);
  // What the app loads up front stays; a page's own file, fetched only
  // when the page is opened, is gone, as after a new release.
  const upFront = new Set<string>();
  page.on("request", (request) => {
    upFront.add(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  page.removeAllListeners("request");
  const knowledgeFiles = "**/assets/_shell.knowledge*.js";
  await page.route(knowledgeFiles, async (route) => {
    await (upFront.has(route.request().url())
      ? route.continue()
      : route.abort());
  });

  // The router loads Grasp anew once by itself; when the file is still
  // missing after that, the page says why and how to go on.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Knowledge", exact: true })
    .click();
  await expect(
    page.getByText(
      "Grasp was updated while this page was open. Try again to load the new version."
    )
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.marked = "yes";
  });

  // The new release's files are there: trying again loads Grasp anew.
  await page.unroute(knowledgeFiles);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Knowledge" })
  ).toBeVisible();
  expect(await sameDocument(page)).toBe(false);
});

test("a start without its words says so in English, and tries again", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "de-DE" });
  const page = await context.newPage();
  const words = "**/assets/messages-*.js";
  await page.route(words, async (route) => {
    await route.abort();
  });
  await page.goto("/sign-in");
  await expect(
    page.getByText("Grasp could not load. Check your connection and try again.")
  ).toBeVisible();

  await page.unroute(words);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText(
      "Melden Sie sich mit dem Konto Ihrer Organisation an, um fortzufahren."
    )
  ).toBeVisible();
  await context.close();
});
