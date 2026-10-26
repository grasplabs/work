import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// The dashboard's pile of what waits on the person shows one card at a
// time, and other tests' cards may wait in it too: a test goes through it
// with the arrow, as a person would, to the card it is about.

/** The pile, named "To do". */
export const pileOf = (page: Page): Locator =>
  page.getByRole("region", { name: "To do" });

/**
 * How long a card has to be on top before a press counts: the pile ignores
 * one sooner as the second of a double press, meant for the card that left
 * (apps/web/src/dashboard/todo-pile.tsx, `guardMs`, 400 ms). A test that
 * pressed at once, as a fast machine does, pressed nothing.
 */
const pressGuardMs = 450;

/**
 * Goes on through the pile until the card named `name` is on top, and gives
 * it once a press on it counts (`pressGuardMs`).
 */
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
  // The pile's own clock, not a page state to wait for: it shows nothing
  // while the guard is on, by design.
  await page.waitForTimeout(pressGuardMs);
  return card;
};
