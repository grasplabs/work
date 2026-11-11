import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { signInStaff, signInTo } from "./people.ts";

// Grasp's staff in a client's workspace: they work from Grasp's admin,
// so the workspace sends them to a page that says so, with nothing of it.

test("Grasp's staff are sent to the admin dashboard, with nothing of the workspace", async ({
  page,
  cspViolations,
}) => {
  const staff = await signInStaff();
  await signInTo(page.context(), staff);
  await page.goto("/");
  await expect(page).toHaveURL(/\/staff$/u);
  await expect(
    page.getByRole("heading", {
      name: "Grasp staff work from the admin dashboard",
    })
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  // A saved link to the company's onboarding, a route of its own outside
  // the app, lands there too.
  await page.goto("/setup?step=welcome");
  await expect(page).toHaveURL(/\/staff$/u);
  expect(cspViolations).toStrictEqual([]);
});
