import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { pageOf, peopleIn } from "./people.ts";

// The Brain, end to end: a person opens it from the sidebar on its atlas,
// goes into a part of it there and opens a note, and finds the note on the
// atlas again; and goes into a part's page from the brain's navigation and
// opens the note there. Every deployment's brain has its Vision, whatever
// core holds yet, so that is the way in. What the brain is built from is
// core's test (apps/core/test/brain.test.ts); how it is built, and laid out
// as an atlas, the brain's own (apps/web/src/brain/*.test.ts).

/** How long a page of the brain may take to read the brain. */
const brainRead = { timeout: 15_000 };

test("a person opens the brain on its atlas, goes into a part of it, opens a note there and finds it on the atlas again", async ({
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
  const main = page.getByRole("main");
  const vision = main.getByRole("button", { name: /^Vision/u });
  await expect(vision).toBeVisible(brainRead);

  // A part of the brain, up close: its notes as neurons, and the way back.
  await vision.click();
  await expect(page).toHaveURL(/\/brain\?region=vision$/u);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" })
  ).toContainText("Vision");
  const trail = main.getByRole("navigation", {
    name: "Where you are in the brain",
  });
  await expect(trail).toContainText("Vision");

  // The note opens on its own page, its dots building the page.
  await main.getByRole("button", { name: "Vision page" }).click();
  await expect(page).toHaveURL(/\/brain\/vision$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "Vision page" })
  ).toBeVisible();

  // And back on the atlas where it sits, in hand.
  await page.getByRole("button", { name: "Show in the brain" }).click();
  await expect(page).toHaveURL(/\/brain\?note=vision$/u);
  await expect(trail).toContainText("Vision page");

  // Escape steps out: from the note to its part, from the part to the whole brain.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/brain\?region=vision$/u);
  // The part is open once the note is no longer in hand on its way back.
  await expect(trail).not.toContainText("Vision page");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/brain$/u);
  await expect(trail).toBeHidden();
});

test("a person opens a part's page from the brain's navigation, and a note in that part", async ({
  browser,
}) => {
  const { member } = peopleIn("brain");
  const page = await pageOf(browser, member);
  await page.goto("/brain");

  await page
    .getByRole("main")
    .getByRole("link", { name: /^Vision/u })
    .first()
    .click(brainRead);
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
