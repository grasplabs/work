import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// The dashboard's pile of what waits on the person shows one card at a
// time, and other tests' cards may wait in it too: a test goes through it
// with the arrow, as a person would, to the card it is about.

/** The pile, named "To do". */
export const pileOf = (page: Page): Locator =>
  page.getByRole("region", { name: "To do" });

/** Goes on through the pile until the card named `name` is on top, and gives it. */
export const toCard = async (
  page: Page,
  name: string | RegExp
): Promise<Locator> => {
  const pile = pileOf(page);
  const card = pile.getByRole("article", {
    name,
    exact: typeof name === "string",
  });
  await expect(async () => {
    if ((await card.count()) === 0) {
      await pile
        .getByRole("button", { name: "The next one" })
        .click({ timeout: 1000 });
    }
    await expect(card).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 30_000 });
  return card;
};
