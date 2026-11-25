import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn, signInAs } from "./people.ts";

// Settings, as in the prototype: the workspace's sections for admins, the
// account's for everyone, listed beside the section. Billing's details and
// emails are kept by core and changed here by the admin; what core has
// nothing for yet (a plan, a card, invoices) shows the prototype's empty
// state, and can't be changed. The devices a person is signed in on can be
// signed out one by one. Members, Models, AI spend and the audit trail have tests
// of their own (web, models, activity).

/** A section of the page, by its heading. */
const sectionOf = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("an admin opens Settings on the workspace, and each section from the sidebar", async ({
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

test("a chosen scene stands on night behind Chat, and draws again once the browser gives its context back", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("settings");
  const page = await pageOf(admin);
  await page.goto("/settings/appearance");
  // Chosen by sight: the tile's radio, in a row that scrolls sideways.
  await page.getByRole("radio", { name: "Cliffs" }).check({ force: true });
  await page.goto("/");
  const box = page.locator('[data-slot="backdrop"][data-backdrop="cliffs"]');
  const canvas = box.locator('[data-slot="backdrop-canvas"]');
  // Night is the box's own ground, so the light words read before the
  // scene has drawn, or where it can't.
  const ground = await box.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--damsko-brand-night)";
    element.append(probe);
    const night = getComputedStyle(probe).color;
    probe.remove();
    return { own: getComputedStyle(element).backgroundColor, night };
  });
  expect(ground.own).toBe(ground.night);

  const pictures = async () =>
    Number((await canvas.getAttribute("data-drawn")) ?? "0");
  await expect.poll(pictures).toBeGreaterThan(1);
  // The browser takes the context away: nothing more is drawn into it for
  // half a second; then it gives it back.
  const { atLoss, whileLost } = await canvas.evaluate(
    async (element: HTMLCanvasElement) => {
      const count = () => Number(element.dataset.drawn ?? "0");
      const lose = element
        .getContext("webgl")
        ?.getExtension("WEBGL_lose_context");
      lose?.loseContext();
      const lost = count();
      const { promise, resolve } = Promise.withResolvers<boolean>();
      setTimeout(() => {
        resolve(true);
      }, 500);
      await promise;
      const later = count();
      lose?.restoreContext();
      return { atLoss: lost, whileLost: later };
    }
  );
  expect(whileLost).toBe(atLoss);
  // Given back, it draws on.
  await expect.poll(pictures).toBeGreaterThan(atLoss);
});
