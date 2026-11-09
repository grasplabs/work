import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// The inbox, at its address: what waits on the person as a list, the item
// chosen beside it with its actions, and what was done. An admin also
// reads the latest of what Grasp and people did. An empty inbox is the
// dashboard journey's (e2e/dashboard.e2e.ts).

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
