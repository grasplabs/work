import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// The inbox, at its address: what waits on the person as a list, the item
// chosen beside it with its actions, and what was done. Someone with
// nothing waiting sees that said; an admin also reads the latest of what
// Grasp and people did.

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

test("someone with nothing waiting sees that nothing waits, and no activity", async ({
  pageOf,
}) => {
  const { user } = peopleIn("inbox");
  const page = await pageOf(user);
  await page.goto("/inbox");

  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Inbox")
  ).toBeVisible(pageRead);
  await expect(page.getByRole("tab", { name: /^To do/u })).toHaveText(
    /^To do\s*0$/u
  );
  await expect(
    page
      .getByRole("region", { name: "What waits on you" })
      .getByText("Nothing waits on you.")
  ).toBeVisible();
  await expect(
    page.getByText("Nothing waits on you", { exact: true })
  ).toBeVisible();
  // The audit trail is for admins.
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveCount(0);

  await page.getByRole("tab", { name: /^Done/u }).click();
  await expect(page.getByText(/^Nothing dealt with yet\./u)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

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
