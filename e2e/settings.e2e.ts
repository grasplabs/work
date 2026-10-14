import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { pageOf, peopleIn } from "./people.ts";

// Settings, as in the prototype: the workspace's sections for admins, the
// account's for everyone, listed beside the section where the page has the
// room and as one control above it where it hasn't. The sections core
// keeps nothing for yet (the workspace's name, Pulse, billing, emails, the
// link for AI apps) show the prototype's empty state, and nothing in them
// can be changed. Members, Models, AI spend and the audit trail have tests
// of their own (web, models, activity).

/** A section of the page, by its heading. */
const sectionOf = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("an admin opens Settings on the workspace, and each section from the list beside it", async ({
  browser,
}) => {
  const { admin } = peopleIn("settings");
  const page = await pageOf(browser, admin);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/workspace$/u);
  const nav = page.getByRole("navigation", { name: "Settings" });

  const workspace = sectionOf(page, "Workspace");
  await expect(workspace.getByLabel("Name")).toBeDisabled();
  await expect(workspace.getByLabel("Company domain")).toBeDisabled();
  await expect(sectionOf(page, "Region")).toContainText("European Union");
  await expect(
    sectionOf(page, "Region").getByRole("combobox", { name: "Time zone" })
  ).toContainText("UTC");

  await nav.getByRole("link", { name: "Pulse" }).click();
  await expect(page).toHaveURL(/\/settings\/pulse$/u);
  await expect(sectionOf(page, "Pulse")).toContainText("0 of 0");
  await expect(sectionOf(page, "When Pulse may report")).toContainText(
    "Pulse never reports."
  );
  await expect(sectionOf(page, "People and devices")).toContainText(
    "Nobody matches."
  );

  await nav.getByRole("link", { name: "Billing" }).click();
  await expect(page).toHaveURL(/\/settings\/billing$/u);
  await expect(page.getByText("Stripe is not linked yet")).toBeVisible();
  await expect(
    sectionOf(page, "Plan").getByRole("button", { name: "Change plan" })
  ).toBeDisabled();
  await expect(sectionOf(page, "Payment method")).toContainText(
    "No card on file"
  );
  await expect(sectionOf(page, "Invoices")).toContainText("No invoices yet.");

  await nav.getByRole("link", { name: "Notifications" }).click();
  await expect(page).toHaveURL(/\/settings\/notifications$/u);
  const email = sectionOf(page, "Email");
  await expect(email.getByRole("switch")).toHaveCount(3);
  for (const toggle of await email.getByRole("switch").all()) {
    // oxlint-disable-next-line no-await-in-loop -- one switch at a time
    await expect(toggle).toBeDisabled();
  }

  await nav.getByRole("link", { name: "Security" }).click();
  await expect(page).toHaveURL(/\/settings\/security$/u);
  await expect(sectionOf(page, "Sign-in")).toContainText(admin.email);
  await expect(
    sectionOf(page, "AI apps").getByRole("switch", { name: "Link for AI apps" })
  ).not.toBeChecked();
});

test("someone who isn't an admin opens Settings on their profile, with only their account's sections", async ({
  browser,
}) => {
  const { member } = peopleIn("settings");
  const page = await pageOf(browser, member);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/profile$/u);
  await expect(
    page.getByRole("navigation", { name: "Settings" }).getByRole("link")
  ).toHaveText(["Profile", "Notifications", "Security"]);
  // Billing problems are told only to those who can fix them.
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "Notifications" })
    .click();
  await expect(sectionOf(page, "Email").getByRole("switch")).toHaveCount(2);
});

test("on a phone the sections are one control above the section", async ({
  browser,
}) => {
  const { admin } = peopleIn("settings");
  const page = await pageOf(browser, admin);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/profile");
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeHidden();
  const sections = page.getByRole("combobox", { name: "Settings" });
  await expect(sections).toContainText("Profile");
  await sections.click();
  await page.getByRole("option", { name: "Members and roles" }).click();
  await expect(page).toHaveURL(/\/settings\/members$/u);
  await expect(sectionOf(page, "Roles")).toBeVisible();
});
