import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";
import { expectNoError } from "./said.ts";

// The inbox, from the nav: what waits on the person as a list, the item
// chosen beside it with its actions, and what was done. An admin also
// reads the latest of what Grasp and people did. What fills it is the
// held-write and approval journeys' (chat, activity, page approval).

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

test("an admin reads what Grasp and people did, with the way to the audit trail", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("inbox");
  const page = await pageOf(admin);
  await page.goto("/inbox");

  await page.getByRole("tab", { name: "Activity" }).click();
  // The trail records the roles the setup gave the cast, at least.
  const activity = page.getByRole("list", { name: "Latest activity" });
  await expect(activity.getByRole("listitem").first()).toBeVisible(pageRead);
  await page.getByRole("button", { name: "People" }).click();
  await expect(activity.getByRole("listitem").first()).toBeVisible();
  await page.getByRole("link", { name: "The full audit trail" }).click();
  await expect(page).toHaveURL(/\/settings\/audit$/u);
});

test("a person with nothing waiting finds their inbox from the nav, with nothing in it, no audit trail and no weekly report", async ({
  pageOf,
}) => {
  const { user } = peopleIn("inboxEmpty");
  const page = await pageOf(user);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Inbox", exact: true })
    .click();
  await expect(page).toHaveURL(/\/inbox$/u);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" })
  ).toContainText("Inbox", pageRead);
  await expect(page.getByRole("tab", { name: /^To do/u })).toHaveText(
    /^To do\s*0$/u
  );
  await expect(
    page
      .getByRole("region", { name: "What waits on you" })
      .getByText("Nothing waits on you.")
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveCount(0);
  // No plan for the interviews yet: no programme week, and no report (with
  // a plan, e2e/onboarding.e2e.ts, which runs after this file).
  await expect(page.getByText(/^Week \d/u)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export report" })).toHaveCount(
    0
  );
  await page.getByRole("tab", { name: /^Done/u }).click();
  await expect(page.getByText(/^Nothing dealt with yet\./u)).toBeVisible();
  await expectNoError(page);
});

/**
 * Where the page's card ends at `size`, and the inbox in it, on the
 * person's inbox: with the window's height, and how far the card would
 * scroll.
 */
const inboxFitAt = async (
  page: Page,
  size: { width: number; height: number }
) => {
  await page.setViewportSize(size);
  await page.goto("/inbox");
  await expect(page.getByRole("tab", { name: /^To do/u })).toBeVisible(
    pageRead
  );
  return await page.evaluate(() => {
    const card = document.querySelector('[data-slot="app-shell-page"]');
    const tabs = document.querySelector('[role="tablist"]');
    // What of the card holds the inbox's tabs: the inbox, under the bar.
    const inbox = [...(card?.children ?? [])].find(
      (child) => tabs !== null && child.contains(tabs)
    );
    if (card === null || inbox === undefined) {
      throw new Error("No page card, or no inbox in it");
    }
    return {
      window: innerHeight,
      card: card.getBoundingClientRect().bottom,
      inbox: inbox.getBoundingClientRect().bottom,
      overflow: card.scrollHeight - card.clientHeight,
    };
  });
};

test("the inbox fills the page's card under its bar, wide and on a phone, so its list and its item each scroll on their own", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("inbox");
  const page = await pageOf(admin);
  const wide = await inboxFitAt(page, { width: 1440, height: 900 });
  const phone = await inboxFitAt(page, { width: 390, height: 844 });
  for (const fit of [wide, phone]) {
    // The card reaches the window's foot, but for the frame's margin…
    expect(fit.card).toBeGreaterThan(fit.window - 24);
    // …and the inbox its card's, with nothing past it to scroll to.
    expect(Math.abs(fit.card - fit.inbox)).toBeLessThanOrEqual(1);
    expect(fit.overflow).toBeLessThanOrEqual(0);
  }
});
