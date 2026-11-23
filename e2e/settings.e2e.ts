import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn, signInAs } from "./people.ts";

// Settings, as in the prototype: the workspace's sections for admins, the
// account's for everyone, listed beside the section where the page has the
// room and as one control above it where it hasn't. Billing's details and
// emails are kept by core and changed here by the admin; what core has
// nothing for yet (a plan, a card, invoices) shows the prototype's empty
// state, and can't be changed. The devices a person is signed in on can be
// signed out one by one. Members and the audit trail have tests of their
// own (web, activity).

/** A section of the page, by its heading. */
const sectionOf = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("an admin opens Settings on the workspace, and each section from the list beside it", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("settings");
  const page = await pageOf(admin);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/workspace$/u);
  const nav = page.getByRole("navigation", { name: "Settings" });

  // The name and time zone are the admin's to change (e2e/web.e2e.ts
  // changes them, so this test doesn't pin their values).
  const organization = sectionOf(page, "Organization");
  await expect(
    organization.getByRole("button", { name: "Edit the name" })
  ).toBeEnabled();
  await expect(organization).toContainText("European Union");
  await expect(
    sectionOf(page, "Settings").getByRole("combobox", { name: "Time zone" })
  ).toBeEnabled();

  await nav.getByRole("link", { name: "Billing" }).click();
  await expect(page).toHaveURL(/\/settings\/billing$/u);
  await expect(sectionOf(page, "Plan")).toContainText("Current plan");
  // The billing details are the admin's to keep, saved whole from their
  // card's dialog.
  const billing = sectionOf(page, "Billing information");
  await billing
    .getByRole("button", { name: "Edit billing information" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Billing information" });
  await dialog.getByLabel("VAT number").fill("nl123456789b01");
  await dialog.getByLabel("Billing email").fill("finance@acme.test");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  {
    const { core, api } = apiOf(admin);
    try {
      await expect
        .poll(async () => {
          const { email, vatNumber } = await api.orgSettings.billing();
          return { email, vatNumber };
        })
        .toStrictEqual({
          email: "finance@acme.test",
          vatNumber: "NL123456789B01",
        });
    } finally {
      core[Symbol.dispose]();
    }
  }
  // As core keeps them, on the card.
  await page.reload();
  await expect(billing).toContainText("NL123456789B01");
  await expect(billing).toContainText("finance@acme.test");

  await nav.getByRole("link", { name: "Security" }).click();
  await expect(page).toHaveURL(/\/settings\/security$/u);
  await expect(sectionOf(page, "Devices")).toContainText("This device");
});

test("someone who isn't an admin opens Settings on their profile, with only their account's sections", async ({
  pageOf,
}) => {
  const { member } = peopleIn("settings");
  const page = await pageOf(member);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/profile$/u);
  // Their own instruction file too, which every member writes.
  await expect(
    page.getByRole("navigation", { name: "Settings" }).getByRole("link")
  ).toHaveText(["Profile", "Appearance", "Instructions", "Security"]);
});

test("on a phone the sections are one control above the section", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("settings");
  const page = await pageOf(admin);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/profile");
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeHidden();
  const sections = page.getByRole("combobox", { name: "Settings" });
  await expect(sections).toContainText("Profile");
  await sections.click();
  await page.getByRole("option", { name: "Members and roles" }).click();
  await expect(page).toHaveURL(/\/settings\/members$/u);
  await expect(sectionOf(page, "Team members")).toBeVisible();
});

test("someone chooses dark in Appearance: the page turns dark at once, and stays so after a reload", async ({
  pageOf,
}) => {
  const { member } = peopleIn("settings");
  const page = await pageOf(member);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings/appearance");
  const theme = sectionOf(page, "Theme");
  await theme.getByRole("radio", { name: /^Dark/u }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expect(
    sectionOf(page, "Theme").getByRole("radio", { name: /^Dark/u })
  ).toBeChecked();
  // Back to the device's, where everyone starts.
  await sectionOf(page, "Theme")
    .getByRole("radio", { name: /^System/u })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "system");
});

test("someone signs out a device of theirs from Security, and its session ends", async ({
  pageOf,
}) => {
  const { member } = peopleIn("ownSessions");
  // Their other device: signed in again, from Node rather than this browser.
  const elsewhere = await signInAs(member.email);
  const page = await pageOf(member);
  await page.goto("/settings/security");
  const devices = sectionOf(page, "Devices");
  const signOuts = devices.getByRole("button", { name: /^Sign out/u });
  const rows = devices.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(devices.getByText("This device", { exact: true })).toBeVisible();
  // This one signs out from the person menu, not here.
  await expect(signOuts).toHaveCount(1);

  // It asks first.
  await signOuts.click();
  await page
    .getByRole("alertdialog", { name: "Sign out this device?" })
    .getByRole("button", { name: "Sign out" })
    .click();
  await expect(rows).toHaveCount(1);
  await expect(signOuts).toHaveCount(0);
  await expect(devices.getByText("This device", { exact: true })).toBeVisible();
  const { core, api } = apiOf({ cookie: elsewhere });
  try {
    await expect(api.whoami()).rejects.toThrow();
  } finally {
    core[Symbol.dispose]();
  }
});
