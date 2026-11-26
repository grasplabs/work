import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// The Brain, end to end: a person opens it from the sidebar on its atlas,
// goes into a part of it there and opens a note, and finds the note on the
// atlas again. Every deployment's brain has its board in front, with its
// Vision, whatever core holds yet, so that is the way in. What the brain is built from is
// core's test (apps/core/test/brain.test.ts); how it is built, and laid out
// as an atlas, the brain's own (apps/web/src/brain/*.test.ts).

/** How long a page of the brain may take to read the brain. */
const brainRead = { timeout: 15_000 };

test("a person opens the brain on its atlas, goes into a part of it, opens a note there and finds it on the atlas again", async ({
  pageOf,
}) => {
  const { member } = peopleIn("brain");
  const page = await pageOf(member);
  await page.goto("/");

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Brain", exact: true })
    .click();
  await expect(page).toHaveURL(/\/brain$/u);
  const main = page.getByRole("main");
  const board = main.getByRole("button", { name: /^Board/u });
  await expect(board).toBeVisible(brainRead);

  // A region of the brain, up close: its notes as neurons.
  await board.click();
  await expect(page).toHaveURL(/\/brain\?region=frontal$/u);

  // The note opens on its own page, its dots building the page.
  await main.getByRole("button", { name: "Vision page" }).click();
  await expect(page).toHaveURL(/\/brain\/vision$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "Vision page" })
  ).toBeVisible();

  // And back on the atlas where it sits, in hand.
  await page.getByRole("button", { name: "More for this page" }).click();
  await page.getByRole("menuitem", { name: "View in map" }).click();
  await expect(page).toHaveURL(/\/brain\?note=vision$/u);

  // Escape steps out: from the note to its region, from the region to the whole brain.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/brain\?region=frontal$/u);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/brain$/u);

  // The mark in the sidebar is the way home: the chat's start.
  await page.getByRole("link", { name: "Grasp", exact: true }).click();
  await expect(page).toHaveURL(/\/$/u);
});
