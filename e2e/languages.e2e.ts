import { expect } from "@playwright/test";
import type { Locator } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// The product speaks the browser's language until the person picks one,
// and keeps their pick in this browser. Every catalog having every message
// is a unit test (apps/web/src/locales/locales.test.ts).

test("follows the browser's language, then the one the person picks", async ({
  pageOf,
}) => {
  const { member } = peopleIn("languages");
  const page = await pageOf(member, { locale: "de-DE" });

  await page.goto("/projects");
  const nav = page.getByRole("navigation", { name: "Hauptmenü" });
  await expect(nav.getByRole("link", { name: "Gehirn" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");

  // The language is in the person menu, at the sidebar's foot.
  await page.getByRole("button", { name: "Person", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Sprache/u }).click();
  await page.getByRole("menuitemradio", { name: "Nederlands" }).click();
  await expect(
    page.getByRole("navigation", { name: "Hoofdmenu" }).getByRole("link", {
      name: "Brein",
    })
  ).toBeVisible();

  // Kept for this browser, over its own language.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Projecten", exact: true })
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");

  // And in Settings → Profile, which the person menu's Settings opens.
  await page.getByRole("button", { name: "Person", exact: true }).click();
  await page.getByRole("menuitem", { name: "Instellingen" }).click();
  await expect(page).toHaveURL(/\/settings\/profile$/u);
  await page.getByRole("combobox", { name: "Taal" }).click();
  await page.getByRole("option", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

/** Presses `option` where it stands, once it is seen whole in a window 390px across. */
const chosen = async (option: Locator): Promise<void> => {
  const box = await option.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  await option.click();
};

test("on a phone the person menu holds the languages and the themes, each within the window", async ({
  pageOf,
}) => {
  const { member } = peopleIn("languages");
  const page = await pageOf(member, {
    viewport: { width: 390, height: 844 },
  });
  await page.goto("/projects");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true })
  ).toBeVisible({ timeout: 20_000 });
  const menu = page.getByRole("menu");
  /** The person menu, from the sidebar's sheet, named in the page's language. */
  const opened = async (sidebar: string, toggle: string) => {
    if (await menu.isVisible()) {
      return;
    }
    const sheet = page.getByRole("dialog", { name: sidebar });
    if (!(await sheet.isVisible())) {
      await page
        .getByRole("main")
        .getByRole("button", { name: toggle })
        .click();
    }
    await sheet.getByRole("button", { name: "Person", exact: true }).click();
  };

  // Under their names in the menu itself, no submenu off the window's edge.
  await opened("Sidebar", "Show or hide the sidebar");
  // Opened at its top, the person's name whole, once it has come in.
  await expect
    .poll(
      async () =>
        await menu.evaluate(async (element) => {
          await Promise.all(
            element.getAnimations().map(async (each) => await each.finished)
          );
          return element.scrollTop;
        })
    )
    .toBe(0);
  await chosen(menu.getByRole("menuitemradio", { name: "Nederlands" }));
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");

  await opened("Zijbalk", "Zijbalk tonen of verbergen");
  await expect(
    menu.getByRole("menuitemradio", { name: "Nederlands" })
  ).toHaveAttribute("aria-checked", "true");
  await chosen(menu.getByRole("menuitemradio", { name: "Donker" }));
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
});

test("signing in speaks the browser's language", async ({ newContext }) => {
  const context = await newContext({ locale: "fr-FR" });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await expect(
    page.getByRole("heading", { level: 1, name: "Se connecter" })
  ).toBeVisible();
});
