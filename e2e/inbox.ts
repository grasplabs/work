import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// The Inbox lists what waits on the person, and other tests' items may
// wait in it too: a test opens the one it is about from its row, as a
// person would, and answers it on its approval in the panel beside the
// list (apps/web/src/inbox/inbox-page.tsx).

/** The Inbox's list of what waits. */
export const inboxList = (page: Page): Locator =>
  page.getByRole("list", { name: "What waits on you" });

/**
 * Opens the item whose row says `row`, and gives its approval, named by
 * its own sentence (`card`).
 */
export const toItem = async (
  page: Page,
  row: RegExp,
  card: RegExp
): Promise<Locator> => {
  await inboxList(page)
    .getByRole("link")
    .filter({ has: page.getByText(row) })
    .first()
    .click({ timeout: 20_000 });
  const opened = page.getByRole("region", { name: card });
  await expect(opened).toBeVisible();
  return opened;
};

/** What the Inbox said was done with an item, for a screen reader. */
export const saidOf = (page: Page): Locator => page.getByRole("status");
