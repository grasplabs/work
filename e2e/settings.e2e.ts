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
// signed out one by one. Members, Models, AI spend and the audit trail have tests
// of their own (web, models, activity).

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
  const workspace = sectionOf(page, "Workspace");
  await expect(workspace.getByLabel("Name")).toBeEnabled();
  await expect(sectionOf(page, "Region")).toContainText("European Union");
  await expect(
    sectionOf(page, "Region").getByRole("combobox", { name: "Time zone" })
  ).toBeEnabled();

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
  // The billing details are the admin's to keep, as each field is left.
  const details = sectionOf(page, "Billing details");
  await details.getByLabel("VAT number").fill("nl123456789b01");
  await details.getByLabel("Billing email").fill("finance@acme.test");
  await details.getByLabel("VAT number").focus();
  // Each field is saved as it is left, one after the other: once core
  // keeps both, the page reads them again as saved.
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
  await page.reload();
  const saved = sectionOf(page, "Billing details");
  await expect(saved.getByLabel("VAT number")).toHaveValue("NL123456789B01");
  await expect(saved.getByLabel("Billing email")).toHaveValue(
    "finance@acme.test"
  );

  await nav.getByRole("link", { name: "Security" }).click();
  await expect(page).toHaveURL(/\/settings\/security$/u);
  await expect(sectionOf(page, "Sign-in")).toContainText(admin.email);
});

test("someone who isn't an admin opens Settings on their profile, with only their account's sections", async ({
  pageOf,
}) => {
  const { member } = peopleIn("settings");
  const page = await pageOf(member);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/profile$/u);
  await expect(
    page.getByRole("navigation", { name: "Settings" }).getByRole("link")
  ).toHaveText(["Packages", "Profile", "Security"]);
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
  await expect(sectionOf(page, "Roles")).toBeVisible();
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
  await expect(devices).toContainText("Signed in on 2 devices.");
  await expect(devices.getByText("This device", { exact: true })).toBeVisible();
  // This one signs out from the person menu, not here.
  await expect(signOuts).toHaveCount(1);

  await signOuts.click();
  await expect(devices).toContainText("Signed in on 1 device.");
  await expect(signOuts).toHaveCount(0);
  await expect(devices.getByText("This device", { exact: true })).toBeVisible();
  const { core, api } = apiOf({ cookie: elsewhere });
  try {
    await expect(api.whoami()).rejects.toThrow();
  } finally {
    core[Symbol.dispose]();
  }
});
