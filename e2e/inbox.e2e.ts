import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

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
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});
