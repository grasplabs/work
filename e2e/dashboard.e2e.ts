import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { pageOf, peopleIn } from "./people.ts";

// The dashboard, from the nav: what waits on the person, what could be
// better (only for someone with signals), and, for admins, the latest of
// the audit trail. What fills To do is the failed-run, held-write and
// approval journeys' (notifications, chat, activity).

test("someone with nothing waiting is told so, and sees no signals or activity", async ({
  browser,
}) => {
  const { user } = peopleIn("dashboard");
  const page = await pageOf(browser, user);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Dashboard", exact: true })
    .click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" })
  ).toBeVisible();
  const toDo = page.getByRole("region", { name: "To do" });
  await expect(toDo.getByText("Nothing waits on you.")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Could be better" })
  ).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Activity" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an admin sees the latest activity, with the way to the audit trail", async ({
  browser,
}) => {
  const { admin } = peopleIn("dashboard");
  const page = await pageOf(browser, admin);
  await page.goto("/dashboard");

  const activity = page.getByRole("region", { name: "Activity" });
  // The trail records the roles the setup gave the cast, at least.
  await expect(
    activity
      .getByRole("list", { name: "Latest activity" })
      .getByRole("listitem")
  ).not.toHaveCount(0);
  await activity.getByRole("link", { name: "The full audit trail" }).click();
  await expect(page).toHaveURL(/\/settings\/audit$/u);
});
