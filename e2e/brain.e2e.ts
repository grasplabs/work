import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { pageOf, peopleIn } from "./people.ts";

// The Brain, end to end: a person opens it from the sidebar, goes into a
// part of it and opens a note there. Every deployment's brain has its
// Vision, whatever core holds yet, so that is the way in. What the brain
// is built from is core's test (apps/core/test/brain.test.ts); how it is
// built, the brain's own (apps/web/src/brain/brain.test.ts).

/** How long a page of the brain may take to read the brain. */
const brainRead = { timeout: 15_000 };

test("a person opens the brain from the sidebar, a part of it, and a note in that part", async ({
  browser,
}) => {
  const { member } = peopleIn("brain");
  const page = await pageOf(browser, member);
  await page.goto("/");

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Brain", exact: true })
    .click();
  await expect(page).toHaveURL(/\/brain$/u);
  const home = page.getByRole("article");
  await expect(home.getByRole("link", { name: /^Vision/u })).toBeVisible(
    brainRead
  );

  await home.getByRole("link", { name: /^Vision/u }).click();
  await expect(page).toHaveURL(/\/brain\/sections\/vision$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "Vision" })
  ).toBeVisible();

  // The part's own block for the note, after the brain's navigation, which
  // lists it too.
  await page
    .getByRole("main")
    .getByRole("link", { name: /^Vision page/u })
    .last()
    .click();
  await expect(page).toHaveURL(/\/brain\/vision$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "Vision page" })
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" })
  ).toContainText("Vision");
});
